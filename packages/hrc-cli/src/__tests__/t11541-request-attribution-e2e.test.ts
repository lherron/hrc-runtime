/**
 * T-11541 — caller-attributed request metrics and the L3 request line end to
 * end, against a scratch daemon: a real `hrc server serve` process on isolated
 * roots. Requests from the real CLI, a named SDK client, a header-less raw
 * caller and the event ingest listener must each land in the server metric
 * stream AND the daemon log under the same `client` (`<name>/<version>` from
 * User-Agent) and `listener`; every completed non-stream request writes
 * a line and streams log open/close. (The `hrc admin metrics routes` rollup is
 * native since T-13047: crates/hrc-cli/e2e/metrics_report.py.)
 * Never the live daemon.
 *
 * Failure modes: var/wrkq-artifacts/T-11541/failure-modes.md.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { openSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { HrcClient } from 'hrc-sdk'

import { parseServerLog } from '../../../hrc-server/src/__tests__/fixtures/server-log'

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
          headers: { 'user-agent': 'test-readiness/1' },
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

describe('T-11541 caller-attributed request metrics (scratch daemon)', () => {
  it('attributes CLI, SDK, raw and ingest callers with weighted counts', async () => {
    const scratch = await makeScratch()
    await startDaemon(scratch)

    // 1. The real CLI: its transport names itself after its package.
    const status = await hrc(scratch, ['server', 'status', '--json'])
    expect(status.exitCode).toBe(0)

    // 2. A named SDK client, hot enough on one route to cross into sampling.
    const sdk = new HrcClient({ socketPath: socketOf(scratch), userAgent: 't11541-sdk/1.0' })
    for (let index = 0; index < SDK_REQUESTS; index += 1) await sdk.getHealth()

    // 3. A raw caller with neither header: attributed by its UA product.
    const raw = await fetch('http://hrc/v1/health', { unix: socketOf(scratch) })
    expect(raw.status).toBe(200)

    // 4. A pattern route that used to be counted as `unmatched`.
    const seat = await fetch('http://hrc/v1/runtimes/rt-none/seat', {
      unix: socketOf(scratch),
      headers: { 'user-agent': 't11541-raw/1 (probe)' },
    })
    expect(seat.status).toBeGreaterThanOrEqual(400)

    // 4b. A failing request is logged; so is an unknown path.
    const badPoll = await fetch('http://hrc/v1/runtimes?limit=0', {
      unix: socketOf(scratch),
      headers: { 'user-agent': 't11541-raw/1' },
    })
    expect(badPoll.status).toBe(400)
    const unknownPath = await fetch('http://hrc/v1/nonesuch/abc?secret=1', {
      unix: socketOf(scratch),
      headers: { 'user-agent': 't11541-raw/1' },
    })
    expect(unknownPath.status).toBe(404)

    // 4c. A stream logs its open and close.
    const abort = new AbortController()
    const stream = await fetch('http://hrc/v1/events?follow=true', {
      unix: socketOf(scratch),
      headers: { 'user-agent': 't11541-stream/1' },
      signal: abort.signal,
    })
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    await reader?.read()
    abort.abort()
    await reader?.cancel().catch(() => undefined)

    // 5. The event-ingest listener lands in the same stream, response intact.
    const ingest = await fetch('http://hrc/v1/ingest', {
      unix: join(scratch.runtimeRoot, 'ingest', 'events.sock'),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'hrc-server/t11541' },
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
    const cliClient = [...clients].find((client) => client?.startsWith('hrc-cli/'))
    expect(cliClient).toMatch(/^hrc-cli\/\d+\.\d+\.\d+/)
    expect(clients).toContain('t11541-sdk/1.0')
    expect(clients).toContain(`Bun/${Bun.version}`)
    expect(clients).toContain('hrc-server/t11541')

    const cliRoutes = records.filter((record) => record.client === cliClient)
    expect(cliRoutes.map((record) => record.route)).toContain('/v1/status')
    expect(records.find((record) => record.client === 't11541-raw/1')?.route).toBe(
      '/v1/runtimes/:runtimeId/seat'
    )
    const ingestRecord = records.find((record) => record.listener === 'ingest')
    expect(ingestRecord?.route).toBe('/v1/ingest')
    expect(ingestRecord?.client).toBe('hrc-server/t11541')

    const sdkRecords = records.filter(
      (record) => record.client === 't11541-sdk/1.0' && record.route === '/v1/health'
    )
    const sdkWeight = sdkRecords.reduce((sum, record) => sum + (record.sampleWeight ?? 1), 0)
    // Sampling must actually have happened, and weights stand in for the truth.
    expect(sdkRecords.some((record) => (record.sampleWeight ?? 1) > 1)).toBe(true)
    expect(sdkRecords.length).toBeLessThan(SDK_REQUESTS)
    expect(sdkWeight).toBeLessThanOrEqual(SDK_REQUESTS)
    expect(sdkWeight).toBeGreaterThan(SDK_REQUESTS - 20)

    // The L3 request line: same listener/route/client as the metric, every request.
    const log = parseServerLog(readFileSync(join(scratch.runtimeRoot, 'server.log'), 'utf8'))
    const http = log.filter((line) => line.component === 'http')
    const requestLines = http.filter((line) => line.event === 'http.request')
    const lines = (client: string) =>
      requestLines.filter((line) => line.data?.['client'] === client)
    const sdkLines = lines('t11541-sdk/1.0')
    expect(sdkLines).toHaveLength(SDK_REQUESTS)
    expect(sdkLines[0]).toMatchObject({
      level: 'info',
      data: {
        listener: 'main',
        method: 'GET',
        route: '/v1/health',
        path: '/v1/health',
        status: 200,
      },
    })
    expect(typeof sdkLines[0]?.data?.['durationMs']).toBe('number')
    expect(sdkLines[0]?.data).not.toHaveProperty('remote')
    // Successful status requests are counted and logged like health requests.
    const cliLines = lines(cliClient ?? '')
    expect(cliLines.map((line) => line.data?.['path'])).toContain('/v1/health')
    expect(cliLines.map((line) => line.data?.['path'])).toContain('/v1/status')
    expect(
      cliLines.find((line) => line.data?.['path'] === '/v1/health')?.data?.['requestId']
    ).toBeString()
    const rawLines = lines('t11541-raw/1')
    expect(
      rawLines.find((line) => line.data?.['route'] === '/v1/runtimes/:runtimeId/seat')
    ).toMatchObject({
      level: 'warn',
      data: { path: '/v1/runtimes/rt-none/seat', status: 404 },
    })
    expect(rawLines.find((line) => line.data?.['route'] === '/v1/runtimes')).toMatchObject({
      level: 'warn',
      data: { path: '/v1/runtimes', status: 400 },
    })
    expect(rawLines.find((line) => line.data?.['route'] === 'unmatched')).toMatchObject({
      level: 'warn',
      data: { path: '/v1/nonesuch/abc', status: 404 },
    })
    expect(JSON.stringify(http)).not.toContain('secret=1')
    expect(lines('hrc-server/t11541')[0]).toMatchObject({
      data: { listener: 'ingest', route: '/v1/ingest', path: '/v1/ingest' },
    })
    expect(lines(`Bun/${Bun.version}`).map((line) => line.data?.['path'])).toContain('/v1/health')
    const streamLines = http.filter((line) => line.data?.['client'] === 't11541-stream/1')
    expect(streamLines.map((line) => line.event)).toEqual(['http.stream.open', 'http.stream.close'])
    expect(streamLines[1]?.data).toMatchObject({ route: '/v1/events', outcome: 'cancel' })
    // Log and metrics name the same callers.
    const loggedClients = new Set(requestLines.map((line) => line.data?.['client']))
    for (const client of ['t11541-sdk/1.0', 't11541-raw/1', 'hrc-server/t11541', cliClient]) {
      expect(loggedClients).toContain(client)
      expect(clients).toContain(client)
    }
  }, 60_000)
})
