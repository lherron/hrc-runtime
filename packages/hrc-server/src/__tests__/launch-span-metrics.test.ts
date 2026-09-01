/**
 * T-07706: launch phase spans must land in the durable metrics store, not only
 * in hrc-server.err.log.
 *
 * The log is a human breadcrumb and it ROTATES, so any p50/p95 computed by
 * grepping it is a lossy sample of an unknown window. These records are the
 * population `hrc admin metrics report` aggregates.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPrecompileLaunchTimingContext,
  observePrecompileLaunchSpan,
} from '../precompile-launch-timing'
import type { PrecompileLaunchTimingContext } from '../precompile-launch-timing'
import { recordLaunchSpan } from '../request-metrics'

let stateRoot: string
let originalStateDir: string | undefined
let originalMetrics: string | undefined

async function readServerRecords(): Promise<Record<string, unknown>[]> {
  const metricsDir = join(stateRoot, 'metrics')
  const names = await readdir(metricsDir).catch(() => [] as string[])
  const records: Record<string, unknown>[] = []
  for (const name of names) {
    const text = await readFile(join(metricsDir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      records.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return records
}

beforeEach(async () => {
  originalStateDir = process.env['HRC_STATE_DIR']
  originalMetrics = process.env['HRC_METRICS']
  stateRoot = await mkdtemp(join(tmpdir(), 'hrc-launch-span-'))
  process.env['HRC_STATE_DIR'] = stateRoot
  process.env['HRC_METRICS'] = '1'
})

afterEach(async () => {
  if (originalStateDir === undefined) Reflect.deleteProperty(process.env, 'HRC_STATE_DIR')
  else process.env['HRC_STATE_DIR'] = originalStateDir
  if (originalMetrics === undefined) Reflect.deleteProperty(process.env, 'HRC_METRICS')
  else process.env['HRC_METRICS'] = originalMetrics
  await rm(stateRoot, { recursive: true, force: true })
})

describe('launch span metrics', () => {
  test('keeps the owning server state root when ambient state changes before emission', async () => {
    const ambientRoot = await mkdtemp(join(tmpdir(), 'hrc-launch-span-ambient-'))
    const timing = createPrecompileLaunchTimingContext('preview', 'rt-owned-root', stateRoot)
    process.env['HRC_STATE_DIR'] = ambientRoot

    try {
      await observePrecompileLaunchSpan('precompile-facade-spawn', timing, async () =>
        Promise.resolve('done')
      )

      const spans = (await readServerRecords()).filter((row) => row['kind'] === 'launch_span')
      expect(spans).toHaveLength(1)
      expect(spans[0]).toMatchObject({
        phase: 'precompile-facade-spawn',
        transport: 'preview',
        runtimeId: 'rt-owned-root',
      })
      expect(await readdir(join(ambientRoot, 'metrics')).catch(() => [])).toEqual([])
    } finally {
      await rm(ambientRoot, { recursive: true, force: true })
    }
  })

  test('records a phase span with its transport', async () => {
    recordLaunchSpan(
      {
        phase: 'precompile-compile-rpc',
        runtimeId: 'rt-1',
        ms: 6463,
        transport: 'interactive',
      },
      stateRoot
    )
    const records = await readServerRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      v: 1,
      kind: 'launch_span',
      phase: 'precompile-compile-rpc',
      transport: 'interactive',
      runtimeId: 'rt-1',
      ms: 6463,
    })
  })

  test('observePrecompileLaunchSpan emits both the log line and one metric record', async () => {
    const logged: { level: string; fields: Record<string, unknown> }[] = []
    const timing: PrecompileLaunchTimingContext = {
      transport: 'interactive',
      runtimeId: 'rt-2',
      stateRoot,
      // A bound that cannot trip, so this exercises the ordinary path.
      boundMs: 60_000,
      logger: {
        info: (_message, fields) => logged.push({ level: 'info', fields }),
        warn: (_message, fields) => logged.push({ level: 'warn', fields }),
      },
    }

    const result = await observePrecompileLaunchSpan('precompile-facade-hello', timing, async () =>
      Promise.resolve('done')
    )
    expect(result).toBe('done')

    // The always-emitted info line is the one the existing log population is
    // counted from; it must survive the metrics addition.
    const info = logged.filter((entry) => entry.level === 'info')
    expect(info).toHaveLength(1)
    expect(info[0]?.fields).toMatchObject({
      phase: 'precompile-facade-hello',
      transport: 'interactive',
      runtimeId: 'rt-2',
    })

    const spans = (await readServerRecords()).filter((row) => row['kind'] === 'launch_span')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      phase: 'precompile-facade-hello',
      transport: 'interactive',
      runtimeId: 'rt-2',
    })
    expect(typeof spans[0]?.['ms']).toBe('number')
  })

  test('a failing operation still records its span', async () => {
    const timing: PrecompileLaunchTimingContext = {
      transport: 'headless',
      runtimeId: 'rt-3',
      stateRoot,
      boundMs: 60_000,
      logger: { info: () => undefined, warn: () => undefined },
    }
    await expect(
      observePrecompileLaunchSpan('precompile-facade-spawn', timing, async () => {
        throw new Error('spawn failed')
      })
    ).rejects.toThrow('spawn failed')

    const spans = (await readServerRecords()).filter((row) => row['kind'] === 'launch_span')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ phase: 'precompile-facade-spawn', transport: 'headless' })
  })
})
