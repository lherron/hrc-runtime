/**
 * T-07706: `hrc run` startup must be a durable, reportable number.
 *
 * The failure this guards is subtle: an attached interactive run's `cli` record
 * carries a `durMs` of HOURS (how long the operator left the TUI open), so any
 * startup figure read off that field is really session length. Startup is
 * therefore recorded as its own `launch` record, written at the attach handoff
 * rather than at process exit — which for an interactive run is hours later,
 * and is lost entirely if the process dies in between.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordCliLaunch } from '../cli-metrics'

let stateRoot: string
let originalStateDir: string | undefined
let originalMetrics: string | undefined

async function readLaunchRecords(): Promise<Record<string, unknown>[]> {
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
  stateRoot = await mkdtemp(join(tmpdir(), 'hrc-cli-launch-'))
  process.env['HRC_STATE_DIR'] = stateRoot
  process.env['HRC_METRICS'] = '1'
})

afterEach(async () => {
  process.env['HRC_STATE_DIR'] = originalStateDir
  process.env['HRC_METRICS'] = originalMetrics
  await rm(stateRoot, { recursive: true, force: true })
})

describe('cli launch metrics', () => {
  test('writes a durable launch record carrying end-to-end startup and its phases', async () => {
    recordCliLaunch({
      bin: 'hrc',
      cmd: 'run',
      startupMs: 7512.4,
      phases: [
        { phase: 'resolveSession', ms: 12 },
        { phase: 'prepareAttachedRun', ms: 6463 },
        { phase: 'total(pre-attach)', ms: 7512.4 },
      ],
    })

    const records = await readLaunchRecords()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      v: 1,
      kind: 'launch',
      bin: 'hrc',
      cmd: 'run',
      startupMs: 7512.4,
      phases: [
        { phase: 'resolveSession', ms: 12 },
        { phase: 'prepareAttachedRun', ms: 6463 },
        { phase: 'total(pre-attach)', ms: 7512.4 },
      ],
    })
    // Written into the cli-dated file the report reader already scans.
    const names = await readdir(join(stateRoot, 'metrics'))
    expect(names.every((name) => /^cli-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))).toBe(true)
  })

  test('honors HRC_METRICS=0', async () => {
    process.env['HRC_METRICS'] = '0'
    recordCliLaunch({ bin: 'hrc', cmd: 'run', startupMs: 1, phases: [] })
    expect(await readLaunchRecords()).toEqual([])
  })

  test('never throws when the metrics root is unwritable', async () => {
    process.env['HRC_STATE_DIR'] = '/proc/definitely-not-writable/hrc'
    expect(() =>
      recordCliLaunch({ bin: 'hrc', cmd: 'run', startupMs: 1, phases: [] })
    ).not.toThrow()
  })
})
