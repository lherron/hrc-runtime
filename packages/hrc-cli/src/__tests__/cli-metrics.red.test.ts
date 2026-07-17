/**
 * T-06511 red bar: every real hrc/hrcchat process must append one bounded CLI
 * metrics record from its exit handler, including failures and SDK RPC spans.
 *
 * These are subprocess tests by design. Mocking process.exit would skip the
 * process.on('exit') contract that this task exists to establish.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const HRC_ENTRY = join(REPO_ROOT, 'packages', 'hrc-cli', 'src', 'cli.ts')
const HRCCHAT_ENTRY = join(REPO_ROOT, 'packages', 'hrcchat-cli', 'src', 'main.ts')
const MANY_RPC_PRELOAD = join(import.meta.dir, 'fixtures', 'cli-metrics-many-rpc.preload.ts')
const STDOUT_PRELOAD = join(import.meta.dir, 'fixtures', 'cli-metrics-stdout.preload.ts')
const METRICS_AGENT = 'metrics-red-agent'
const METRICS_PROJECT = 'metrics-red-project'

type TestSandbox = {
  root: string
  runtimeRoot: string
  stateRoot: string
}

type RunResult = {
  exitCode: number
  stdout: Uint8Array
  stdoutText: string
  stderrText: string
}

type RpcMetric = {
  id: string
  path: string
  method: string
  ms: number
  status: number
  bytes: number
}

type CliMetric = {
  v: number
  kind: string
  ts: string
  bin: string
  cmd: string
  flags: string[]
  exitCode: number
  durMs: number
  stdoutBytes: number
  tty: boolean
  agent?: string
  project?: string
  pid: number
  rpc: RpcMetric[]
}

type MetricLine = {
  raw: string
  record: CliMetric
}

const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function createSandbox(prefix = 'hrc-cli-metrics-'): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanupRoots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const stateRoot = join(root, 'state')
  await mkdir(runtimeRoot, { recursive: true })
  return { root, runtimeRoot, stateRoot }
}

async function runBun(
  bunArgs: string[],
  sandbox: TestSandbox,
  env: Record<string, string> = {}
): Promise<RunResult> {
  const proc = Bun.spawn(['bun', ...bunArgs], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HRC_METRICS: '1',
      HRC_RUNTIME_DIR: sandbox.runtimeRoot,
      HRC_STATE_DIR: sandbox.stateRoot,
      ASP_AGENT_ID: METRICS_AGENT,
      ASP_PROJECT: METRICS_PROJECT,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...env,
    },
  })

  const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const stdout = new Uint8Array(stdoutBuffer)
  return {
    exitCode,
    stdout,
    stdoutText: new TextDecoder().decode(stdout),
    stderrText,
  }
}

function runEntry(
  entry: string,
  args: string[],
  sandbox: TestSandbox,
  options: { env?: Record<string, string>; preload?: string } = {}
): Promise<RunResult> {
  return runBun(
    [...(options.preload ? ['--preload', options.preload] : []), entry, ...args],
    sandbox,
    options.env
  )
}

async function metricFiles(stateRoot: string): Promise<string[]> {
  const metricsDir = join(stateRoot, 'metrics')
  if (!existsSync(metricsDir)) return []
  return (await readdir(metricsDir))
    .filter((name) => /^cli-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort()
}

async function readMetricLines(stateRoot: string): Promise<MetricLine[]> {
  const files = await metricFiles(stateRoot)
  const lines: MetricLine[] = []
  for (const file of files) {
    const content = await readFile(join(stateRoot, 'metrics', file), 'utf8')
    for (const raw of content.split('\n').filter(Boolean)) {
      lines.push({ raw, record: JSON.parse(raw) as CliMetric })
    }
  }
  return lines
}

async function readOnlyMetric(stateRoot: string): Promise<MetricLine> {
  const lines = await readMetricLines(stateRoot)
  expect(lines).toHaveLength(1)
  const line = lines[0]
  if (!line) throw new Error('expected one CLI metrics line')
  return line
}

function expectBaseMetric(
  line: MetricLine,
  expected: {
    bin: 'hrc' | 'hrcchat'
    cmd: string
    exitCode: number
    stdoutBytes: number
  }
): void {
  const { record, raw } = line
  expect(record.v).toBe(1)
  expect(record.kind).toBe('cli')
  expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
  expect(record.bin).toBe(expected.bin)
  expect(record.cmd).toBe(expected.cmd)
  expect(record.exitCode).toBe(expected.exitCode)
  expect(record.durMs).toBeGreaterThanOrEqual(0)
  expect(record.stdoutBytes).toBe(expected.stdoutBytes)
  expect(record.tty).toBe(false)
  expect(record.agent).toBe(METRICS_AGENT)
  expect(record.project).toBe(METRICS_PROJECT)
  expect(Number.isInteger(record.pid)).toBe(true)
  expect(record.pid).toBeGreaterThan(0)
  expect(Array.isArray(record.flags)).toBe(true)
  expect(Array.isArray(record.rpc)).toBe(true)
  expect(raw.includes('\n')).toBe(false)
}

async function startStubServer(
  sandbox: TestSandbox,
  handler: (request: Request) => Response | Promise<Response>
): Promise<ReturnType<typeof Bun.serve>> {
  const socketPath = join(sandbox.runtimeRoot, 'hrc.sock')
  await mkdir(dirname(socketPath), { recursive: true })
  return Bun.serve({ unix: socketPath, fetch: handler })
}

function dateStamp(daysAgo: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

describe('T-06511 CLI metrics recorder [RED]', () => {
  test('imports of both bin modules remain side-effect-free', async () => {
    for (const entry of [HRC_ENTRY, HRCCHAT_ENTRY]) {
      const sandbox = await createSandbox()
      const result = await runBun(
        ['-e', `await import(${JSON.stringify(pathToFileURL(entry).href)})`],
        sandbox
      )

      expect(result.exitCode).toBe(0)
      expect(await metricFiles(sandbox.stateRoot)).toEqual([])
    }
  })

  test('records successful zero-RPC invocations for hrc and hrcchat', async () => {
    for (const [entry, bin] of [
      [HRC_ENTRY, 'hrc'],
      [HRCCHAT_ENTRY, 'hrcchat'],
    ] as const) {
      const sandbox = await createSandbox()
      const result = await runEntry(entry, ['info'], sandbox)
      const line = await readOnlyMetric(sandbox.stateRoot)

      expect(result.exitCode).toBe(0)
      expectBaseMetric(line, {
        bin,
        cmd: 'info',
        exitCode: 0,
        stdoutBytes: result.stdout.byteLength,
      })
      expect(line.record.flags).toEqual([])
      expect(line.record.rpc).toEqual([])
    }
  })

  test('records commander usage errors without leaking an unknown positional', async () => {
    const sandbox = await createSandbox()
    const positionalMarker = 'marker-one'
    const result = await runEntry(HRC_ENTRY, [positionalMarker], sandbox)
    const line = await readOnlyMetric(sandbox.stateRoot)

    expect(result.exitCode).toBeGreaterThan(0)
    expectBaseMetric(line, {
      bin: 'hrc',
      cmd: '',
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.byteLength,
    })
    expect(line.raw).not.toContain(positionalMarker)
  })

  test('records bare hrc exiting through printUsage', async () => {
    const sandbox = await createSandbox()
    const result = await runEntry(HRC_ENTRY, [], sandbox)
    const line = await readOnlyMetric(sandbox.stateRoot)

    expect(result.exitCode).toBe(1)
    expectBaseMetric(line, {
      bin: 'hrc',
      cmd: '',
      exitCode: 1,
      stdoutBytes: result.stdout.byteLength,
    })
    expect(line.record.rpc).toEqual([])
  })

  test('records HrcDomainError with its failed RPC span', async () => {
    const sandbox = await createSandbox()
    const errorBody = {
      error: {
        code: 'runtime_unavailable',
        message: 'metrics domain sentinel',
      },
    }
    let requestId: string | null = null
    const server = await startStubServer(sandbox, (request) => {
      requestId = request.headers.get('x-hrc-request-id')
      return Response.json(errorBody, { status: 503 })
    })

    try {
      const result = await runEntry(HRC_ENTRY, ['runtime', 'list', '--json'], sandbox)
      const line = await readOnlyMetric(sandbox.stateRoot)

      expect(result.exitCode).toBeGreaterThan(0)
      expectBaseMetric(line, {
        bin: 'hrc',
        cmd: 'runtime list',
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.byteLength,
      })
      expect(line.record.flags).toEqual(['--json'])
      expect(line.record.rpc).toHaveLength(1)
      expect(line.record.rpc[0]).toMatchObject({
        id: requestId,
        path: '/v1/runtimes',
        method: 'GET',
        status: 503,
        bytes: Buffer.byteLength(JSON.stringify(errorBody)),
      })
      expect(line.record.rpc[0]?.ms).toBeGreaterThanOrEqual(0)
    } finally {
      server.stop(true)
    }
  })

  test('records CliStatusExit and MonitorWaitExit with exact nonzero codes', async () => {
    const statusSandbox = await createSandbox()
    const statusResult = await runEntry(HRC_ENTRY, ['server', 'status', '--json'], statusSandbox)
    const statusLine = await readOnlyMetric(statusSandbox.stateRoot)

    expect(statusResult.exitCode).toBe(1)
    expectBaseMetric(statusLine, {
      bin: 'hrc',
      cmd: 'server status',
      exitCode: 1,
      stdoutBytes: statusResult.stdout.byteLength,
    })

    const waitSandbox = await createSandbox()
    const selectorMarker = 'session:marker-two'
    const conditionMarker = 'marker-three'
    const waitResult = await runEntry(
      HRC_ENTRY,
      ['monitor', 'wait', selectorMarker, '--until', conditionMarker, '--json'],
      waitSandbox
    )
    const waitLine = await readOnlyMetric(waitSandbox.stateRoot)

    expect(waitResult.exitCode).toBe(2)
    expectBaseMetric(waitLine, {
      bin: 'hrc',
      cmd: 'monitor wait',
      exitCode: 2,
      stdoutBytes: waitResult.stdout.byteLength,
    })
    expect(waitLine.record.flags).toEqual(['--until', '--json'])
    expect(waitLine.raw).not.toContain(selectorMarker)
    expect(waitLine.raw).not.toContain(conditionMarker)
  }, 15_000)

  test('records hrcchat RPC latency, status, bytes, and request ID', async () => {
    const sandbox = await createSandbox()
    const responseBody = { messages: [] }
    let requestId: string | null = null
    const server = await startStubServer(sandbox, (request) => {
      requestId = request.headers.get('x-hrc-request-id')
      return Response.json(responseBody)
    })

    try {
      const result = await runEntry(HRCCHAT_ENTRY, ['--json', 'messages'], sandbox)
      const line = await readOnlyMetric(sandbox.stateRoot)

      expect(result.exitCode).toBe(0)
      expectBaseMetric(line, {
        bin: 'hrcchat',
        cmd: 'messages',
        exitCode: 0,
        stdoutBytes: result.stdout.byteLength,
      })
      expect(line.record.flags).toEqual(['--json'])
      expect(line.record.rpc).toHaveLength(1)
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(line.record.rpc[0]).toMatchObject({
        id: requestId,
        path: '/v1/messages/query',
        method: 'POST',
        status: 200,
        bytes: Buffer.byteLength(JSON.stringify(responseBody)),
      })
      expect(line.record.rpc[0]?.ms).toBeGreaterThanOrEqual(0)
    } finally {
      server.stop(true)
    }
  })

  test('kill switch writes no file and stamps no request ID header', async () => {
    const sandbox = await createSandbox()
    let requestId: string | null | undefined
    const server = await startStubServer(sandbox, (request) => {
      requestId = request.headers.get('x-hrc-request-id')
      return Response.json([])
    })

    try {
      const result = await runEntry(HRC_ENTRY, ['runtime', 'list'], sandbox, {
        env: { HRC_METRICS: '0' },
      })

      expect(result.exitCode).toBe(0)
      expect(requestId).toBeNull()
      expect(await metricFiles(sandbox.stateRoot)).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test('flags contain names only and stdoutBytes matches the real pipe byte count', async () => {
    const sandbox = await createSandbox()
    const flagValueMarker = 'marker-four'
    let requestId: string | null = null
    const server = await startStubServer(sandbox, (request) => {
      requestId = request.headers.get('x-hrc-request-id')
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
    })

    try {
      const result = await runEntry(
        HRC_ENTRY,
        ['runtime', 'list', '--host-session-id', flagValueMarker, '--json'],
        sandbox
      )
      const line = await readOnlyMetric(sandbox.stateRoot)

      expect(result.exitCode).toBe(0)
      expect(line.record.flags).toEqual(['--host-session-id', '--json'])
      expect(line.raw).not.toContain(flagValueMarker)
      expect(line.record.stdoutBytes).toBe(result.stdout.byteLength)
      expect(line.record.rpc[0]).toMatchObject({
        id: requestId,
        path: '/v1/runtimes',
        bytes: 2,
      })
    } finally {
      server.stop(true)
    }
  })

  test('stdout wrapper preserves backpressure return and callback semantics', async () => {
    const sandbox = await createSandbox()
    const result = await runEntry(HRC_ENTRY, ['info'], sandbox, { preload: STDOUT_PRELOAD })
    const line = await readOnlyMetric(sandbox.stateRoot)

    expect(result.exitCode).toBe(0)
    expect(result.stdoutText.endsWith('µ')).toBe(true)
    expect(line.record.stdoutBytes).toBe(result.stdout.byteLength)
  })

  test('many RPC spans are truncated to one NDJSON line under 4KB', async () => {
    const sandbox = await createSandbox()
    let requests = 0
    const server = await startStubServer(sandbox, () => {
      requests += 1
      return Response.json([])
    })

    try {
      const result = await runEntry(HRC_ENTRY, ['runtime', 'list'], sandbox, {
        preload: MANY_RPC_PRELOAD,
      })
      const line = await readOnlyMetric(sandbox.stateRoot)

      expect(result.exitCode).toBe(0)
      expect(requests).toBe(64)
      expect(line.record.rpc.length).toBeGreaterThan(0)
      expect(line.record.rpc.length).toBeLessThan(requests)
      expect(Buffer.byteLength(line.raw)).toBeLessThan(4096)
      expect(line.raw.includes('\n')).toBe(false)
    } finally {
      server.stop(true)
    }
  }, 15_000)

  test('prunes only metrics files older than 14 days and preserves today', async () => {
    const sandbox = await createSandbox()
    const metricsDir = join(sandbox.stateRoot, 'metrics')
    await mkdir(metricsDir, { recursive: true })

    const oldFile = join(metricsDir, `cli-${dateStamp(15)}.ndjson`)
    const recentFile = join(metricsDir, `cli-${dateStamp(13)}.ndjson`)
    const todayFile = join(metricsDir, `cli-${dateStamp(0)}.ndjson`)
    const unrelatedFile = join(metricsDir, 'server-history.ndjson')
    const seed = `${JSON.stringify({ seeded: true })}\n`
    await Promise.all([
      writeFile(oldFile, seed),
      writeFile(recentFile, seed),
      writeFile(todayFile, seed),
      writeFile(unrelatedFile, seed),
    ])
    const oldTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    const recentTime = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, oldTime, oldTime)
    await utimes(recentFile, recentTime, recentTime)
    await utimes(unrelatedFile, oldTime, oldTime)

    const result = await runEntry(HRC_ENTRY, ['info'], sandbox)

    expect(result.exitCode).toBe(0)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)
    expect(existsSync(todayFile)).toBe(true)
    expect(existsSync(unrelatedFile)).toBe(true)
    expect((await stat(todayFile)).size).toBeGreaterThan(Buffer.byteLength(seed))
  })

  test('metrics directory failures are best-effort and do not fail the command', async () => {
    const sandbox = await createSandbox()
    await mkdir(dirname(sandbox.stateRoot), { recursive: true })
    await writeFile(sandbox.stateRoot, 'not a directory')

    const result = await runEntry(HRC_ENTRY, ['info'], sandbox)

    expect(result.exitCode).toBe(0)
    expect(result.stdoutText.length).toBeGreaterThan(0)
  })
})
