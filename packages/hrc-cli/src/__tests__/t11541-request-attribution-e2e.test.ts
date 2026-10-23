/**
 * T-11541 — caller-attributed request metrics end to end, against a scratch
 * daemon: a real `hrc server serve` process on isolated roots. Requests from
 * the real CLI, a named SDK client, a header-less raw caller and the event
 * ingest listener must each land in the existing server metric stream under
 * their own `client` (and `listener`), and `hrc admin metrics routes` must
 * report them with weighted counts that match both the raw file and the truth.
 * Never the live daemon.
 *
 * Failure modes: var/wrkq-artifacts/T-11541/failure-modes.md.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { openSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { HrcClient } from 'hrc-sdk'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const IDENTITY_KEY = /^(HRC_|ASP_|AGENT_|WRKQ_|CLAUDE|CODEX_)/

/** Requests the named SDK client sends to one route: past the 10/minute unsampled head. */
const SDK_REQUESTS = 250

type Scratch = { root: string; runtimeRoot: string; stateRoot: string; env: Record<string, string> }
const scratches: Scratch[] = []

afterEach(async () => {
  for (const scratch of scratches.splice(0)) {
    const pid = readPid(scratch)
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await rm(scratch.root, { recursive: true, force: true })
  }
})

function readPid(scratch: Scratch): number | undefined {
  try {
    const pid = Number(readFileSync(join(scratch.runtimeRoot, 'server.pid'), 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function makeScratch(): Promise<Scratch> {
  const root = await mkdtemp('/tmp/hrc-t11541-')
  const runtimeRoot = join(root, 'run')
  const stateRoot = join(root, 'state')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || IDENTITY_KEY.test(key)) continue
    env[key] = value
  }
  const scratch: Scratch = {
    root,
    runtimeRoot,
    stateRoot,
    env: {
      ...env,
      HRC_RUNTIME_DIR: runtimeRoot,
      HRC_STATE_DIR: stateRoot,
      HRC_LAUNCHD_LABEL: 'com.praesidium.hrc-t11541-scratch',
      HRC_SHADOW_TEARDOWN_ENABLED: '0',
      HRC_WRKQ_DB: 'rpc://127.0.0.1:1',
    },
  }
  scratches.push(scratch)
  return scratch
}

const socketOf = (scratch: Scratch) => join(scratch.runtimeRoot, 'hrc.sock')

async function startDaemon(scratch: Scratch): Promise<number> {
  const log = join(scratch.runtimeRoot, 'server.log')
  const child = Bun.spawn([process.execPath, CLI_PATH, 'server', 'serve'], {
    cwd: scratch.root,
    env: scratch.env,
    stdout: openSync(log, 'a'),
    stderr: openSync(log, 'a'),
    stdin: 'ignore',
  })
  child.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (readPid(scratch) === child.pid) {
      try {
        const response = await fetch('http://hrc/v1/health', {
          unix: socketOf(scratch),
          headers: { 'x-hrc-client': 'test-readiness' },
          signal: AbortSignal.timeout(1_000),
        })
        if (response.ok) return child.pid
      } catch {}
    }
    await Bun.sleep(50)
  }
  throw new Error(`scratch daemon did not come up:\n${readFileSync(log, 'utf8')}`)
}

async function hrc(
  scratch: Scratch,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: scratch.root,
    env: scratch.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

type RawRecord = {
  kind: string
  route: string
  method: string
  status: number
  client?: string
  listener?: string
  sampleWeight?: number
}

function rawServerRecords(scratch: Scratch): RawRecord[] {
  const dir = join(scratch.stateRoot, 'metrics')
  return readdirSync(dir)
    .filter((name) => /^server-.*\.ndjson$/.test(name))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RawRecord)
    )
    .filter((record) => record.kind === 'server')
}

/** Metric lines are flushed on a 1s timer; wait until `predicate` holds over the raw file. */
async function waitForRecords(scratch: Scratch, predicate: (records: RawRecord[]) => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      if (predicate(rawServerRecords(scratch))) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(
    `metrics never satisfied predicate:\n${JSON.stringify(rawServerRecords(scratch))}`
  )
}

type RollupRow = {
  listener?: string
  method?: string
  route?: string
  client?: string
  count: number
  records: number
  errors: number
}

describe('T-11541 caller-attributed request metrics (scratch daemon)', () => {
  it('attributes CLI, SDK, raw and ingest callers and rolls them up with weighted counts', async () => {
    const scratch = await makeScratch()
    await startDaemon(scratch)

    // 1. The real CLI: its transport names itself after its package.
    const status = await hrc(scratch, ['server', 'status', '--json'])
    expect(status.exitCode).toBe(0)

    // 2. A named SDK client, hot enough on one route to cross into sampling.
    const sdk = new HrcClient({ socketPath: socketOf(scratch), clientName: 't11541-sdk' })
    for (let index = 0; index < SDK_REQUESTS; index += 1) await sdk.getHealth()

    // 3. A raw caller with neither header: attributed by its UA product.
    const raw = await fetch('http://hrc/v1/health', { unix: socketOf(scratch) })
    expect(raw.status).toBe(200)

    // 4. A pattern route that used to be counted as `unmatched`.
    const seat = await fetch('http://hrc/v1/runtimes/rt-none/seat', {
      unix: socketOf(scratch),
      headers: { 'x-hrc-client': 't11541-raw' },
    })
    expect(seat.status).toBeGreaterThanOrEqual(400)

    // 5. The event-ingest listener lands in the same stream, response intact.
    const ingest = await fetch('http://hrc/v1/ingest', {
      unix: join(scratch.runtimeRoot, 'ingest', 'events.sock'),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hrc-client': 'hrc-forwarder/t11541' },
      body: JSON.stringify({ feed: 'hrc_events', sourceRef: 'hrc:t11541', events: [] }),
    })
    expect(ingest.headers.get('content-type')).toContain('json')
    expect(await ingest.json()).toHaveProperty('ok')

    await waitForRecords(scratch, (records) =>
      records.some((record) => record.listener === 'ingest')
    )
    const records = rawServerRecords(scratch)

    // Every record carries a client; main-listener records omit `listener`.
    for (const record of records) expect(record.client).toBeString()
    const clients = new Set(records.map((record) => record.client))
    expect(clients).toContain('hrc-cli')
    expect(clients).toContain('t11541-sdk')
    expect(clients).toContain('ua:Bun')
    expect(clients).toContain('hrc-forwarder/t11541')

    const cliRoutes = records.filter((record) => record.client === 'hrc-cli')
    expect(cliRoutes.map((record) => record.route)).toContain('/v1/status')
    expect(records.some((record) => record.route === 'unmatched')).toBe(false)
    expect(records.find((record) => record.client === 't11541-raw')?.route).toBe(
      '/v1/runtimes/:runtimeId/seat'
    )
    const ingestRecord = records.find((record) => record.listener === 'ingest')
    expect(ingestRecord?.route).toBe('/v1/ingest')
    expect(ingestRecord?.client).toBe('hrc-forwarder/t11541')

    const sdkRecords = records.filter(
      (record) => record.client === 't11541-sdk' && record.route === '/v1/health'
    )
    const sdkWeight = sdkRecords.reduce((sum, record) => sum + (record.sampleWeight ?? 1), 0)
    // Sampling must actually have happened, and weights stand in for the truth.
    expect(sdkRecords.some((record) => (record.sampleWeight ?? 1) > 1)).toBe(true)
    expect(sdkRecords.length).toBeLessThan(SDK_REQUESTS)
    expect(sdkWeight).toBeLessThanOrEqual(SDK_REQUESTS)
    expect(sdkWeight).toBeGreaterThan(SDK_REQUESTS - 20)

    // The rollup reads the same day files and reports the same weighted counts.
    const rollup = await hrc(scratch, [
      'admin',
      'metrics',
      'routes',
      '--since',
      '1h',
      '--by',
      'route,client',
      '--json',
    ])
    expect(rollup.stderr).toBe('')
    expect(rollup.exitCode).toBe(0)
    const report = JSON.parse(rollup.stdout) as { rows: RollupRow[]; by: string[] }
    expect(report.by).toEqual(['route', 'client'])
    const row = (client: string, route: string, listener = 'main') =>
      report.rows.find(
        (candidate) =>
          candidate.client === client &&
          candidate.route === route &&
          candidate.listener === listener
      )
    expect(row('t11541-sdk', '/v1/health')?.count).toBe(sdkWeight)
    expect(row('t11541-sdk', '/v1/health')?.records).toBe(sdkRecords.length)
    expect(row('hrc-cli', '/v1/status')?.count).toBeGreaterThanOrEqual(1)
    expect(row('ua:Bun', '/v1/health')?.count).toBe(1)
    expect(row('t11541-raw', '/v1/runtimes/:runtimeId/seat')?.errors).toBe(1)
    expect(row('hrc-forwarder/t11541', '/v1/ingest', 'ingest')?.count).toBe(1)

    // By client alone: one row per caller, summed over its routes.
    const byClient = await hrc(scratch, [
      'admin',
      'metrics',
      'routes',
      '--since',
      '1h',
      '--by',
      'client',
      '--json',
    ])
    expect(byClient.exitCode).toBe(0)
    const clientRows = (JSON.parse(byClient.stdout) as { rows: RollupRow[] }).rows
    const sdkTotal = records
      .filter((record) => record.client === 't11541-sdk')
      .reduce((sum, record) => sum + (record.sampleWeight ?? 1), 0)
    expect(clientRows.find((candidate) => candidate.client === 't11541-sdk')?.count).toBe(sdkTotal)
    expect(clientRows.every((candidate) => candidate.route === undefined)).toBe(true)

    // --idle lists registered routes nobody called; a called route is not idle.
    const idle = await hrc(scratch, [
      'admin',
      'metrics',
      'routes',
      '--since',
      '1h',
      '--idle',
      '--json',
    ])
    expect(idle.exitCode).toBe(0)
    const idleRows = (
      JSON.parse(idle.stdout) as { idle: { listener: string; route: string; method: string }[] }
    ).idle
    expect(idleRows).toContainEqual({
      listener: 'main',
      method: 'POST',
      route: '/v1/runtimes/sweep',
    })
    expect(idleRows).toContainEqual({
      listener: 'peer',
      method: 'POST',
      route: '/v1/federation/locate',
    })
    expect(
      idleRows.some(
        (candidate) => candidate.listener === 'main' && candidate.route === '/v1/health'
      )
    ).toBe(false)
  }, 60_000)
})
