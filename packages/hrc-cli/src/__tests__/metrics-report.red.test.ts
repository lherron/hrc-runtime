/**
 * T-06512 red bar: the offline metrics reader aggregates frozen v1 CLI/server
 * records and joins rpc ids into handler, transport, and render time buckets.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { readMetricsReport } from '../metrics-report'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const HRC_ENTRY = join(REPO_ROOT, 'packages', 'hrc-cli', 'src', 'cli.ts')
const NOW = new Date('2026-07-17T12:00:00.000Z')

type CliRecordOptions = {
  ts?: string
  bin?: 'hrc' | 'hrcchat'
  cmd?: string
  durMs: number
  stdoutBytes?: number
  rpc?: Array<{
    id: string
    path: string
    method: string
    ms: number
    status: number
    bytes: number
  }>
}

type ServerRecordOptions = {
  ts?: string
  route?: string
  method?: string
  ms: number
  status?: number
  bytes?: number
  stream?: true
  reqId?: string
}

let stateRoot: string
let originalStateDir: string | undefined
let originalMetrics: string | undefined

function cliRecord(options: CliRecordOptions): Record<string, unknown> {
  return {
    v: 1,
    kind: 'cli',
    ts: options.ts ?? NOW.toISOString(),
    bin: options.bin ?? 'hrc',
    cmd: options.cmd ?? 'runtime list',
    flags: [],
    exitCode: 0,
    durMs: options.durMs,
    stdoutBytes: options.stdoutBytes ?? 0,
    tty: false,
    pid: 123,
    rpc: options.rpc ?? [],
  }
}

function serverRecord(options: ServerRecordOptions): Record<string, unknown> {
  return {
    v: 1,
    kind: 'server',
    ts: options.ts ?? NOW.toISOString(),
    route: options.route ?? '/v1/runtimes',
    method: options.method ?? 'GET',
    ms: options.ms,
    status: options.status ?? 200,
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
    ...(options.stream ? { stream: true } : {}),
    ...(options.reqId === undefined ? {} : { reqId: options.reqId }),
  }
}

async function writeMetrics(
  cli: Array<Record<string, unknown>>,
  server: Array<Record<string, unknown>>,
  malformed = false
): Promise<void> {
  const metricsDir = join(stateRoot, 'metrics')
  await mkdir(metricsDir, { recursive: true })
  const cliLines = cli.map((record) => JSON.stringify(record))
  const serverLines = server.map((record) => JSON.stringify(record))
  if (malformed) {
    cliLines.splice(1, 0, '{not-json')
    serverLines.splice(1, 0, 'null')
  }
  await writeFile(join(metricsDir, 'cli-2026-07-17.ndjson'), `${cliLines.join('\n')}\n`)
  await writeFile(join(metricsDir, 'server-2026-07-17.ndjson'), `${serverLines.join('\n')}\n`)
}

beforeEach(async () => {
  originalStateDir = process.env['HRC_STATE_DIR']
  originalMetrics = process.env['HRC_METRICS']
  stateRoot = await mkdtemp(join(tmpdir(), 'hrc-metrics-report-'))
  process.env['HRC_STATE_DIR'] = stateRoot
  process.env['HRC_METRICS'] = '1'
})

afterEach(async () => {
  process.env['HRC_STATE_DIR'] = originalStateDir
  process.env['HRC_METRICS'] = originalMetrics
  await rm(stateRoot, { recursive: true, force: true })
})

describe.serial('metrics report reader', () => {
  test('uses nearest-rank p50/p95/max and honors the since cutoff', async () => {
    const samples = [1, 2, 3, 4, 100]
    await writeMetrics(
      [
        ...samples.map((durMs) => cliRecord({ durMs })),
        cliRecord({
          ts: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
          durMs: 999,
        }),
      ],
      samples.map((ms) => serverRecord({ ms }))
    )

    const report = await readMetricsReport({ since: '7d', slowest: 10, largest: 10, now: NOW })
    const command = report.commands.find((group) => group.command === 'hrc runtime list')
    const route = report.routes.find((group) => group.route === 'GET /v1/runtimes')
    expect(command).toMatchObject({ count: 5, durMs: { p50: 3, p95: 100, max: 100 } })
    expect(route).toMatchObject({ count: 5, ms: { p50: 3, p95: 100, max: 100 } })
  })

  test('returns a stable empty report and skips malformed NDJSON lines', async () => {
    await mkdir(join(stateRoot, 'metrics'), { recursive: true })
    expect(await readMetricsReport({ since: '7d', now: NOW })).toEqual({
      commands: [],
      routes: [],
      slowest: [],
      largest: { cli: [], server: [] },
      uncorrelatedServerCount: 0,
    })

    await writeMetrics([cliRecord({ durMs: 8 })], [serverRecord({ ms: 3 })], true)
    const report = await readMetricsReport({ since: '7d', now: NOW })
    expect(report.commands).toHaveLength(1)
    expect(report.routes).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain('NaN')
  })

  test('joins rpc ids into exact server, transport, and render buckets', async () => {
    await writeMetrics(
      [
        cliRecord({
          durMs: 100,
          rpc: [
            {
              id: 'matched-rpc',
              path: '/v1/runtimes',
              method: 'GET',
              ms: 60,
              status: 200,
              bytes: 30,
            },
            {
              id: 'missing-rpc',
              path: '/v1/health',
              method: 'GET',
              ms: 20,
              status: 200,
              bytes: 10,
            },
          ],
        }),
      ],
      [serverRecord({ ms: 30, reqId: 'matched-rpc' })]
    )

    const report = await readMetricsReport({ since: '7d', slowest: 1, now: NOW })
    expect(report.slowest).toHaveLength(1)
    expect(report.slowest[0]).toMatchObject({
      command: 'hrc runtime list',
      durMs: 100,
      serverMs: 30,
      transportMs: 50,
      renderMs: 20,
    })
  })

  test('keeps unmatched server callers in route stats and counts them as uncorrelated', async () => {
    await writeMetrics(
      [
        cliRecord({
          durMs: 20,
          rpc: [
            {
              id: 'correlated-rpc',
              path: '/v1/health',
              method: 'GET',
              ms: 10,
              status: 200,
              bytes: 2,
            },
          ],
        }),
      ],
      [
        serverRecord({ route: '/v1/health', ms: 4, reqId: 'correlated-rpc' }),
        serverRecord({ route: '/v1/health', ms: 5 }),
        serverRecord({ route: '/v1/health', ms: 6, reqId: 'other-caller' }),
      ]
    )

    const report = await readMetricsReport({ since: '7d', now: NOW })
    expect(report.routes.find((group) => group.route === 'GET /v1/health')?.count).toBe(3)
    expect(report.uncorrelatedServerCount).toBe(2)
  })

  test('aggregates payload bytes and excludes streaming server records from largest', async () => {
    await writeMetrics(
      [cliRecord({ durMs: 10, stdoutBytes: 10 }), cliRecord({ durMs: 20, stdoutBytes: 50 })],
      [
        serverRecord({ ms: 1, bytes: 7 }),
        serverRecord({ ms: 2, bytes: 100 }),
        serverRecord({ ms: 3, stream: true }),
      ]
    )

    const report = await readMetricsReport({ since: '7d', largest: 2, now: NOW })
    expect(report.commands[0]?.stdoutBytes).toEqual({ total: 60, max: 50 })
    expect(report.routes[0]?.bytes).toEqual({ total: 107, max: 100 })
    expect(report.routes[0]?.count).toBe(3)
    expect(report.largest.cli.map((row) => row.stdoutBytes)).toEqual([50, 10])
    expect(report.largest.server.map((row) => row.bytes)).toEqual([100, 7])
  })

  test('runs hrc metrics report offline and rejects conflicting output modes', async () => {
    await mkdir(join(stateRoot, 'metrics'), { recursive: true })
    const env = {
      ...process.env,
      HRC_METRICS: '0',
      HRC_STATE_DIR: stateRoot,
      HRC_RUNTIME_DIR: join(stateRoot, 'missing-runtime'),
      NO_COLOR: '1',
    }
    const jsonProc = Bun.spawn(['bun', HRC_ENTRY, 'metrics', 'report', '--json'], {
      cwd: REPO_ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [jsonOutput, jsonError, jsonExit] = await Promise.all([
      new Response(jsonProc.stdout).text(),
      new Response(jsonProc.stderr).text(),
      jsonProc.exited,
    ])
    expect(jsonExit).toBe(0)
    expect(jsonError).toBe('')
    expect(JSON.parse(jsonOutput)).toMatchObject({ commands: [], routes: [] })

    const conflictProc = Bun.spawn(['bun', HRC_ENTRY, 'metrics', 'report', '--json', '--ndjson'], {
      cwd: REPO_ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await Promise.all([
      new Response(conflictProc.stdout).text(),
      new Response(conflictProc.stderr).text(),
    ])
    expect(await conflictProc.exited).not.toBe(0)
  })
})
