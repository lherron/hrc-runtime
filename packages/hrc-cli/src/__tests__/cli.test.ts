/**
 * RED/GREEN tests for hrc-cli (T-00957)
 *
 * These tests validate the CLI arg parsing, command dispatch, and output
 * formatting for the `hrc` operator CLI. The CLI is a thin wrapper over
 * hrc-sdk; these tests verify the wrapper layer specifically.
 *
 * Pass conditions for Curly (T-00957):
 *   1. `hrc` with no args prints help text to stderr and exits 1
 *   2. `hrc unknowncmd` prints error to stderr and exits 1
 *   3. `hrc turn send` and `hrc session clear-context` validate args and dispatch
 *      through hrc-sdk
 *      to stderr and exit 1
 *   4. `hrc server` starts the daemon (tested via createHrcServer delegation)
 *   5. `hrc session resolve --scope <scopeRef>` outputs JSON to stdout
 *   6. `hrc session list` outputs JSON array to stdout
 *   7. `hrc session get <hostSessionId>` outputs JSON to stdout
 *   8. `hrc events` outputs NDJSON events to stdout
 *   9. All structured output is valid JSON on stdout; all errors on stderr
 *  10. Exit code 0 on success, 1 on error
 *
 * Reference: T-00946 (parent), T-00957 (CLI implementation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot, StatusResponse } from 'hrc-core'

// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { main } from '../cli'
import { attachOpenAiRuntime, selectLatestUsableRuntime } from '../cli'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

type UnifiedStatusSessionView = {
  session: {
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
  }
  activeRuntime?: {
    runtime: {
      runtimeId: string
      transport: string
      status: string
    }
    tmux?: {
      sessionId?: string
      windowId?: string
      paneId?: string
    }
    surfaceBindings: Array<{
      surfaceKind: string
      surfaceId: string
    }>
  }
}

type UnifiedStatusResponse = StatusResponse & {
  sessions: UnifiedStatusSessionView[]
}

/**
 * Run the CLI as a subprocess and capture output.
 * Uses `bun run` to execute the TypeScript CLI entry point directly.
 */
async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  if (shouldUseSubprocess(args)) {
    return runCliSubprocess(args, env)
  }
  return runCliInProcess(args, env)
}

function shouldUseSubprocess(args: string[]): boolean {
  const command = args[0]
  if (!command || command === '--help' || command === '-h' || command === 'info') {
    return false
  }

  if (command === 'events' && args.includes('--pretty')) {
    return true
  }

  switch (command) {
    case 'server':
      return shouldUseServerSubprocess(args.slice(1))
    case 'start':
      return false
    case 'run':
      return !(args.includes('--no-attach') || args.includes('--dry-run'))
    case 'attach':
      return !(args.includes('--dry-run') || args[1]?.startsWith('rt-'))
    default:
      return false
  }
}

function shouldUseServerSubprocess(args: string[]): boolean {
  const subcommand = args[0]
  return subcommand === undefined || subcommand === 'start' || subcommand === 'restart'
}

async function runCliSubprocess(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env,
    },
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, chunks: string[]): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

async function runCliInProcess(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env ?? {})) {
    originalEnv.set(key, process.env[key])
    process.env[key] = value
  }

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdoutChunks)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderrChunks)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args)
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: error.code,
      }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function testProjectScope(projectId: string): string {
  return `agent:test:project:${projectId}`
}

// ---------------------------------------------------------------------------
// Test harness for commands that need a running server
// ---------------------------------------------------------------------------

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | null = null
let agentsRoot: string
let projectsRoot: string
let originalPath: string | undefined
let originalClaudePath: string | undefined

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CLAUDE_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'claude-shim')
const CODEX_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'codex-shim')

function serverOpts(): HrcServerOptions {
  return { runtimeRoot, stateRoot, socketPath, lockPath, spoolDir, dbPath, tmuxSocketPath }
}

/** Env vars that point the CLI's discoverSocket at our test server */
function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    ...extra,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cli-test-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  agentsRoot = join(tmpDir, 'agents')
  projectsRoot = join(tmpDir, 'projects')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
  await mkdir(agentsRoot, { recursive: true })
  await mkdir(projectsRoot, { recursive: true })

  originalPath = process.env.PATH
  originalClaudePath = process.env.ASP_CLAUDE_PATH
  process.env.PATH = `${CLAUDE_SHIM_DIR}:${CODEX_SHIM_DIR}:${originalPath ?? ''}`
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  } else {
    await runCli(['server', 'stop', '--force'], cliEnv()).catch(() => undefined)
  }
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine when no tmux server was created
  }
  process.env.PATH = originalPath
  process.env.ASP_CLAUDE_PATH = originalClaudePath
  await rm(tmpDir, { recursive: true, force: true })
})

async function seedRunRoots(agentId: string, projectId: string): Promise<void> {
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await mkdir(join(projectsRoot, projectId), { recursive: true })
}

async function createTmuxAttachShim(): Promise<string> {
  const shimDir = join(tmpDir, 'tmux-attach-shim')
  const shimPath = join(shimDir, 'tmux')
  const logPath = join(shimDir, 'tmux-attach.json')

  await mkdir(shimDir, { recursive: true })
  await writeFile(
    shimPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "${logPath}"
exit 0
`,
    { mode: 0o755 }
  )

  return shimDir
}

async function installFakeCodex(
  dirName: string,
  behavior: {
    execDelayMs?: number
    execThreadId?: string
    interactiveBanner?: string
    interactiveDelayMs?: number
    resumeDelayMs?: number
  } = {}
): Promise<{ binDir: string; logPath: string; resumePath: string }> {
  const binDir = join(tmpDir, dirName)
  const logPath = join(binDir, 'codex.log')
  const resumePath = join(binDir, 'resume.log')
  await mkdir(binDir, { recursive: true })
  const scriptPath = join(binDir, 'codex')
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
cmd="\${1:-}"
log_path=${JSON.stringify(logPath)}
resume_path=${JSON.stringify(resumePath)}
if [ "$cmd" = "exec" ]; then
  printf 'exec\\n' >> "$log_path"
  /bin/sleep ${((behavior.execDelayMs ?? 0) / 1000).toFixed(3)}
  printf '{"type":"thread.started","thread_id":"${behavior.execThreadId ?? 'thread-123'}"}\\n'
  exit 0
fi
if [ "$cmd" = "resume" ]; then
  printf 'resume:%s\\n' "\${2:-}" >> "$resume_path"
  /bin/sleep ${((behavior.resumeDelayMs ?? 0) / 1000).toFixed(3)}
  exit 0
fi
printf 'interactive:%s\\n' "$*" >> "$log_path"
printf '%s\\n' ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
/bin/sleep ${((behavior.interactiveDelayMs ?? 1_500) / 1000).toFixed(3)}
exit 0
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  return { binDir, logPath, resumePath }
}

async function installFakeClaude(
  dirName: string,
  behavior: {
    interactiveBanner?: string
    interactiveDelayMs?: number
  } = {}
): Promise<{ binDir: string; logPath: string }> {
  const binDir = join(tmpDir, dirName)
  const logPath = join(binDir, 'claude.log')
  await mkdir(binDir, { recursive: true })
  const scriptPath = join(binDir, 'claude')
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
log_path=${JSON.stringify(logPath)}
printf 'interactive:%s\\n' "$*" >> "$log_path"
printf '%s\\n' ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
/bin/sleep ${((behavior.interactiveDelayMs ?? 1_500) / 1000).toFixed(3)}
exit 0
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  return { binDir, logPath }
}

async function writeCodexAgentProfile(agentId: string): Promise<void> {
  await writeFile(
    join(agentsRoot, agentId, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[identity]\ndisplay = "Codex Agent"\nrole = "worker"\nharness = "codex"\n',
    'utf8'
  )
}

async function readServerLog(): Promise<string> {
  return await readFile(join(runtimeRoot, 'server.log'), 'utf8')
}

async function waitForContinuation(
  hostSessionId: string,
  runtimeId: string,
  env: Record<string, string>
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listResult = await runCli(['runtime', 'list', '--host-session-id', hostSessionId], env)
    expect(listResult.exitCode).toBe(0)
    const runtimes = JSON.parse(listResult.stdout.trim()) as Array<{
      runtimeId: string
      continuation?: { key?: string | undefined } | null
    }>
    const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId)
    if (runtime?.continuation?.key) {
      return
    }
    await Bun.sleep(100)
  }

  throw new Error(`runtime ${runtimeId} did not persist a continuation in time`)
}

// ===========================================================================
// 1. No args / help
// ===========================================================================
describe('no args / help', () => {
  it('prints help text to stderr and exits 1 when invoked with no args', async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
    // Should mention available commands or usage
    expect(result.stderr.toLowerCase()).toMatch(/usage|help|commands/i)
  })

  it('prints help when --help flag is passed', async () => {
    const result = await runCli(['--help'])
    // --help should exit 0 and print to stdout or stderr
    const output = result.stdout + result.stderr
    expect(output.toLowerCase()).toMatch(/usage|help|commands/i)
  })

  it('prints first-contact orientation for info', async () => {
    const result = await runCli(['info'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ABOUT')
    expect(result.stdout).toContain('ADDRESSING TARGETS')
    expect(result.stdout).toContain('COMMON CONTROL FLOWS')
    expect(result.stdout).toContain('Use hrcchat to semantically message agents.')
    expect(result.stdout).toContain('cody@agent-spaces~repair')
    expect(result.stdout).not.toContain('\n  info              ')
    expect(result.stderr).toBe('')
  })
})

// ===========================================================================
// 2. Unknown command
// ===========================================================================
describe('unknown command', () => {
  it('prints error to stderr and exits 1 for unknown command', async () => {
    const result = await runCli(['nonexistent-command'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(result.stderr.toLowerCase()).toMatch(/unknown|unrecognized|invalid/i)
  })
})

// ===========================================================================
// 2b. server/tmux admin lifecycle
// ===========================================================================
describe('server/tmux admin lifecycle', () => {
  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(['session', 'resolve', '--scope', scope], cliEnv())
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  async function ensureTmuxRuntime(scope: string): Promise<{
    hostSessionId: string
    runtimeId: string
  }> {
    const hostSessionId = await resolveHostSessionId(scope)
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)
    const runtime = JSON.parse(ensureResult.stdout.trim()) as { runtimeId: string }
    return { hostSessionId, runtimeId: runtime.runtimeId }
  }

  it('server start --daemon boots the daemon and server status reports it running', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    expect(startResult.stderr).toMatch(/daemon started/i)

    // The daemon must survive after the launcher process exits.
    await Bun.sleep(250)

    const statusResult = await runCli(['server', 'status', '--json'], cliEnv())
    expect(statusResult.exitCode).toBe(0)
    const status = JSON.parse(statusResult.stdout.trim()) as {
      running: boolean
      socketResponsive: boolean
      pid?: number
    }
    expect(status.running).toBe(true)
    expect(status.socketResponsive).toBe(true)
    expect(status.pid).toBeNumber()
  })

  it('server log includes timestamped lifecycle entries', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    await Bun.sleep(250)
    const log = await readServerLog()
    expect(log).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[hrc-server\] INFO server\.start\.begin /m
    )
    expect(log).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[hrc-server\] INFO server\.listening /m
    )
  })

  it('server log records codex launch execution JSON and CODEX_HOME', async () => {
    const aspHome = join(tmpDir, 'asp-home')
    await mkdir(aspHome, { recursive: true })
    const env = cliEnv({ ASP_HOME: aspHome })

    const startResult = await runCli(['server', 'start', '--daemon'], env)
    expect(startResult.exitCode).toBe(0)

    const hostSessionId = await resolveHostSessionId(testProjectScope('codex-launch-logging'))
    const ensureResult = await runCli(
      ['runtime', 'ensure', hostSessionId, '--provider', 'openai'],
      env
    )
    expect(ensureResult.exitCode).toBe(0)

    const sendResult = await runCli(
      ['turn', 'send', hostSessionId, '--prompt', 'log codex launch', '--provider', 'openai'],
      env
    )
    expect(sendResult.exitCode).toBe(0)

    await Bun.sleep(250)
    const log = await readServerLog()
    expect(log).toContain('launch.dispatch.prepared')
    expect(log).toContain('"execution"')
    expect(log).toContain('"codexHome"')
    expect(log).toContain(`${aspHome}/codex-homes/`)
  })

  it('server stop shuts down only the daemon and leaves the HRC tmux server running', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    await ensureTmuxRuntime(testProjectScope('server-stop-preserves-tmux'))

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessionCount: number
      sessions: string[]
    }
    expect(before.running).toBe(true)
    expect(before.sessionCount).toBeGreaterThan(0)

    const stopResult = await runCli(['server', 'stop'], cliEnv())
    expect(stopResult.exitCode).toBe(0)
    expect(stopResult.stderr).toMatch(/daemon stopped/i)

    const daemonStatus = await runCli(['server', 'status', '--json'], cliEnv())
    expect(daemonStatus.exitCode).toBe(0)
    const serverState = JSON.parse(daemonStatus.stdout.trim()) as { running: boolean }
    expect(serverState.running).toBe(false)

    const afterTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(afterTmux.exitCode).toBe(0)
    const after = JSON.parse(afterTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(after.running).toBe(true)
    expect(after.sessions).toEqual(before.sessions)
  })

  it('server restart preserves the existing tmux session and interactive runtime', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    const seeded = await ensureTmuxRuntime(testProjectScope('server-restart-preserves-runtime'))

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(before.running).toBe(true)

    const restartResult = await runCli(['server', 'restart'], cliEnv())
    expect(restartResult.exitCode).toBe(0)
    expect(restartResult.stderr).toMatch(/daemon restarted/i)

    const afterTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(afterTmux.exitCode).toBe(0)
    const after = JSON.parse(afterTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(after.running).toBe(true)
    expect(after.sessions).toEqual(before.sessions)

    const statusResult = await runCli(['status', '--json'], cliEnv())
    expect(statusResult.exitCode).toBe(0)
    const status = JSON.parse(statusResult.stdout.trim()) as UnifiedStatusResponse
    const joined = status.sessions.find(
      (entry) => entry.session.hostSessionId === seeded.hostSessionId
    )
    expect(joined?.activeRuntime?.runtime.runtimeId).toBe(seeded.runtimeId)
    expect(joined?.activeRuntime?.runtime.transport).toBe('tmux')
  })

  it('tmux kill requires --yes and then kills the HRC tmux server explicitly', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    await ensureTmuxRuntime(testProjectScope('tmux-kill-cli'))

    const unsafeResult = await runCli(['server', 'tmux', 'kill'], cliEnv())
    expect(unsafeResult.exitCode).toBe(1)
    expect(unsafeResult.stderr).toMatch(/--yes/i)

    const killResult = await runCli(['server', 'tmux', 'kill', '--yes'], cliEnv())
    expect(killResult.exitCode).toBe(0)
    expect(killResult.stderr).toMatch(/tmux server killed/i)

    const statusResult = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(statusResult.exitCode).toBe(0)
    const status = JSON.parse(statusResult.stdout.trim()) as { running: boolean }
    expect(status.running).toBe(false)
  })
})

// ===========================================================================
// 3. turn send / session clear-context
// ===========================================================================
describe('turn send / session clear-context', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(['session', 'resolve', '--scope', scope], cliEnv())
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  it('turn send exits 1 when hostSessionId is missing', async () => {
    const result = await runCli(['turn', 'send'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toLowerCase()).toContain('missing required argument')
  })

  it('turn send outputs run JSON for a known hostSessionId', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('turncli'))
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)

    const result = await runCli(
      ['turn', 'send', hostSessionId, '--prompt', 'hello from cli'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.runId).toBeString()
    expect(body.hostSessionId).toBe(hostSessionId)
    expect(body.status).toBe('started')
  })

  it('session clear-context exits 1 when hostSessionId is missing', async () => {
    const result = await runCli(['session', 'clear-context'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toLowerCase()).toContain('missing required argument')
  })

  it('session clear-context outputs rotation JSON for a known hostSessionId', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('clearctxcli'))
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)

    const result = await runCli(['session', 'clear-context', hostSessionId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBeString()
    expect(body.hostSessionId).not.toBe(hostSessionId)
    expect(body.priorHostSessionId).toBe(hostSessionId)
    expect(body.generation).toBeGreaterThan(1)
  })
})

// ===========================================================================
// 4. hrc runtime ensure / capture / attach / runtime interrupt / runtime terminate
// ===========================================================================
describe('runtime lifecycle commands', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(['session', 'resolve', '--scope', scope], cliEnv())
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  async function ensureRuntime(scope: string): Promise<string> {
    const hostSessionId = await resolveHostSessionId(scope)
    const result = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout.trim()).runtimeId as string
  }

  it('runtime ensure outputs runtime JSON for a known hostSessionId', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('runtimecli'))
    const result = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBe(hostSessionId)
    expect(body.transport).toBe('tmux')
    expect(body.status).toBe('ready')
    expect(body.runtimeId).toBeString()
  })

  it('capture prints pane text for a runtimeId', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('capturecli'))
    const result = await runCli(['capture', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(typeof result.stdout).toBe('string')
  })

  it('runtime capture prints pane text for a runtimeId', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('runtime-capturecli'))
    const result = await runCli(['runtime', 'capture', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(typeof result.stdout).toBe('string')
  })

  it('attach prints descriptor JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('attachcli'))
    const result = await runCli(['attach', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.transport).toBe('tmux')
    expect(body.argv).toContain('attach-session')
  })

  it('attach auto-binds Ghostty when GHOSTTY_SURFACE_UUID is present', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('attach-ghostty-cli'))
    const result = await runCli(
      ['attach', runtimeId],
      cliEnv({ GHOSTTY_SURFACE_UUID: 'ghostty-cli-attach-1' })
    )

    expect(result.exitCode).toBe(0)

    const listResult = await runCli(['surface', 'list', runtimeId], cliEnv())
    expect(listResult.exitCode).toBe(0)
    const listed = JSON.parse(listResult.stdout.trim())
    expect(listed).toHaveLength(1)
    expect(listed[0].surfaceId).toBe('ghostty-cli-attach-1')
  })

  it('runtime interrupt prints JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('interruptcli'))
    const result = await runCli(['runtime', 'interrupt', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('runtime terminate prints JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('terminatecli'))
    const result = await runCli(['runtime', 'terminate', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('surface bind/list/unbind commands manage runtime bindings', async () => {
    const runtimeId = await ensureRuntime(testProjectScope('surfacecli'))

    const bindResult = await runCli(
      ['surface', 'bind', runtimeId, '--kind', 'ghostty', '--id', 'ghostty-cli-2'],
      cliEnv()
    )
    expect(bindResult.exitCode).toBe(0)
    const bound = JSON.parse(bindResult.stdout.trim())
    expect(bound.surfaceId).toBe('ghostty-cli-2')

    const listResult = await runCli(['surface', 'list', runtimeId], cliEnv())
    expect(listResult.exitCode).toBe(0)
    const listed = JSON.parse(listResult.stdout.trim())
    expect(listed).toHaveLength(1)
    expect(listed[0].surfaceId).toBe('ghostty-cli-2')

    const unbindResult = await runCli(
      ['surface', 'unbind', '--kind', 'ghostty', '--id', 'ghostty-cli-2', '--reason', 'done'],
      cliEnv()
    )
    expect(unbindResult.exitCode).toBe(0)
    const unbound = JSON.parse(unbindResult.stdout.trim())
    expect(unbound.reason).toBe('done')

    const emptyListResult = await runCli(['surface', 'list', runtimeId], cliEnv())
    expect(emptyListResult.exitCode).toBe(0)
    expect(JSON.parse(emptyListResult.stdout.trim())).toEqual([])
  })
})

// ===========================================================================
// 5. hrc run convenience command (T-01019)
// ===========================================================================
describe('hrc start', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
    await seedRunRoots('rex', 'agent-spaces')
  })

  it('prints a local plan preview for detached startup without mutating server state', async () => {
    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain('hrc start rex@agent-spaces --dry-run')
    expect(result.stdout).toContain('sessionRef:   agent:rex:project:agent-spaces/lane:main')
    expect(result.stdout).toContain('restartStyle: reuse_pty')

    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const sessions = db.sessions.listByScopeRef('agent:rex:project:agent-spaces')
      expect(sessions.length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('creates a session and runtime without attaching', async () => {
    const tmuxShimDir = await createTmuxAttachShim()
    const result = await runCli(
      ['start', 'rex@agent-spaces:T-00123'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
        PATH: `${tmuxShimDir}:${process.env.PATH ?? ''}`,
      })
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:main')
    expect(body.hostSessionId).toBeDefined()
    expect(body.created).toBe(true)
    expect(body.runtime.runtimeId).toBeDefined()
    // Anthropic start with preferredMode=headless now creates a headless SDK runtime
    expect(body.runtime.transport).toBe('headless')
    expect(existsSync(join(tmuxShimDir, 'tmux-attach.json'))).toBe(false)
  })

  it('uses detached codex exec for start previews when the agent harness is codex', async () => {
    await writeCodexAgentProfile('rex')

    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider:     openai')
    expect(result.stdout).toContain('argv:     codex exec')
    expect(result.stdout).toContain('--json')
  })

  it('rotates to a fresh headless session when start uses --new-session', async () => {
    await writeCodexAgentProfile('rex')

    const firstCodex = await installFakeCodex('fake-codex-start-new-session-1', {
      execThreadId: 'thread-111',
    })
    process.env.PATH = `${firstCodex.binDir}:${process.env.PATH ?? ''}`
    const firstEnv = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECTS_ROOT: projectsRoot,
      PATH: `${firstCodex.binDir}:${process.env.PATH ?? ''}`,
    })
    const firstStart = await runCli(
      ['start', 'rex@agent-spaces', '-p', 'seed first session'],
      firstEnv
    )
    expect(firstStart.exitCode).toBe(0)
    const firstBody = JSON.parse(firstStart.stdout.trim()) as {
      hostSessionId: string
      created: boolean
      runtime: { runtimeId: string; transport: string }
    }
    expect(firstBody.created).toBe(true)
    expect(firstBody.runtime.transport).toBe('headless')
    await waitForContinuation(firstBody.hostSessionId, firstBody.runtime.runtimeId, firstEnv)

    const secondCodex = await installFakeCodex('fake-codex-start-new-session-2', {
      execThreadId: 'thread-222',
    })
    process.env.PATH = `${secondCodex.binDir}:${process.env.PATH ?? ''}`
    const secondEnv = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECTS_ROOT: projectsRoot,
      PATH: `${secondCodex.binDir}:${process.env.PATH ?? ''}`,
    })
    const secondStart = await runCli(
      ['start', 'rex@agent-spaces', '--new-session', '-p', 'seed second session'],
      secondEnv
    )
    expect(secondStart.exitCode).toBe(0)
    const secondBody = JSON.parse(secondStart.stdout.trim()) as {
      hostSessionId: string
      created: boolean
      runtime: { runtimeId: string; transport: string }
    }
    expect(secondBody.created).toBe(true)
    expect(secondBody.hostSessionId).not.toBe(firstBody.hostSessionId)
    expect(secondBody.runtime.transport).toBe('headless')
    await waitForContinuation(secondBody.hostSessionId, secondBody.runtime.runtimeId, secondEnv)

    const db = openHrcDatabase(dbPath)
    try {
      const firstSession = db.sessions.getByHostSessionId(firstBody.hostSessionId)
      const secondSession = db.sessions.getByHostSessionId(secondBody.hostSessionId)
      expect(firstSession?.status).toBe('archived')
      expect(firstSession?.continuation).toEqual({
        provider: 'openai',
        key: 'thread-111',
      })
      expect(secondSession?.status).toBe('active')
      expect(secondSession?.continuation).toEqual({
        provider: 'openai',
        key: 'thread-222',
      })
    } finally {
      db.close()
    }
  }, 10000)
})

describe('hrc attach <scope>', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
    await seedRunRoots('rex', 'agent-spaces')
  })

  async function waitForContinuation(
    hostSessionId: string,
    runtimeId: string,
    env: Record<string, string>
  ) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listResult = await runCli(['runtime', 'list', '--host-session-id', hostSessionId], env)
      expect(listResult.exitCode).toBe(0)
      const runtimes = JSON.parse(listResult.stdout.trim()) as Array<{
        runtimeId: string
        continuation?: { key?: string | undefined } | null
      }>
      const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId)
      if (runtime?.continuation?.key) {
        return
      }
      await Bun.sleep(100)
    }

    throw new Error(`runtime ${runtimeId} did not persist a continuation in time`)
  }

  it('prints a local runtime lookup plan without mutating server state', async () => {
    const result = await runCli(
      ['attach', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain('runtimeLookup: latest non-unavailable runtime')
    expect(result.stdout).toContain(
      'recovery:      detached OpenAI sessions materialize a fresh tmux runtime on attach'
    )
    expect(result.stdout).toContain('POST /v1/runtimes/attach')

    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const sessions = db.sessions.listByScopeRef('agent:rex:project:agent-spaces')
      expect(sessions.length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('headless anthropic start creates resumable runtime that attach can rematerialize', async () => {
    const fakeClaude = await installFakeClaude('fake-claude-cli-attach', {
      interactiveDelayMs: 200,
    })
    process.env.ASP_CLAUDE_PATH = join(fakeClaude.binDir, 'claude')
    const tmuxShimDir = await createTmuxAttachShim()
    const env = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECTS_ROOT: projectsRoot,
      PATH: `${tmuxShimDir}:${fakeClaude.binDir}:${process.env.PATH ?? ''}`,
    })

    const startResult = await runCli(['start', 'rex@agent-spaces:T-00123'], env)
    expect(startResult.exitCode).toBe(0)
    const startBody = JSON.parse(startResult.stdout.trim())
    expect(startBody.runtime.transport).toBe('headless')

    // Anthropic headless start creates a resumable runtime with continuation;
    // attach should find it and rematerialize to tmux
    const attachResult = await runCli(['attach', 'rex@agent-spaces:T-00123'], env)
    expect(attachResult.exitCode).toBe(0)
  })

  it('materializes tmux and resumes codex when only a detached session exists', async () => {
    await writeCodexAgentProfile('rex')
    const fakeCodex = await installFakeCodex('fake-codex-cli-attach-recovery')
    process.env.PATH = `${fakeCodex.binDir}:${process.env.PATH ?? ''}`

    const tmuxShimDir = await createTmuxAttachShim()
    const env = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECTS_ROOT: projectsRoot,
      PATH: `${tmuxShimDir}:${process.env.PATH ?? ''}`,
    })

    const startResult = await runCli(['start', 'rex@agent-spaces:T-00123'], env)
    expect(startResult.exitCode).toBe(0)

    const started = JSON.parse(startResult.stdout.trim()) as {
      hostSessionId: string
      runtime: { runtimeId: string; transport: string }
    }
    expect(started.runtime.transport).toBe('headless')
    await waitForContinuation(started.hostSessionId, started.runtime.runtimeId, env)

    const attachResult = await runCli(['attach', 'rex@agent-spaces:T-00123'], env)
    expect(attachResult.exitCode).toBe(0)
    expect(attachResult.stdout.trim()).toBe('')
    expect(attachResult.stderr.trim()).toBe('')

    let attachArtifact:
      | {
          argv?: string[]
          lifecycleAction?: string
        }
      | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const launchFiles = await readdir(join(runtimeRoot, 'launches'))
        for (const file of launchFiles) {
          const parsed = JSON.parse(await Bun.file(join(runtimeRoot, 'launches', file)).text()) as {
            argv?: string[]
            lifecycleAction?: string
          }
          if (parsed.lifecycleAction === 'attach') {
            attachArtifact = parsed
            break
          }
        }
      } catch {
        attachArtifact = undefined
      }
      if (attachArtifact?.lifecycleAction === 'attach') {
        break
      }
      await Bun.sleep(100)
    }
    expect(attachArtifact?.lifecycleAction).toBe('attach')
    expect(attachArtifact?.argv?.[0]).toBe('codex')
    expect(attachArtifact?.argv).toContain('resume')
    expect(attachArtifact?.argv).toContain('thread-123')

    const loggedArgs = await Bun.file(join(tmuxShimDir, 'tmux-attach.json')).text()
    expect(loggedArgs).toContain('attach-session')
  }, 15_000)

  it('prefers a detached headless runtime over a newer idle tmux runtime', () => {
    const hostSessionId = 'hsid-test-attach-priority'
    const runtimes: HrcRuntimeSnapshot[] = [
      {
        runtimeId: 'rt-headless',
        hostSessionId,
        scopeRef: 'agent:rex:project:agent-spaces:task:T-00999',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        continuation: {
          provider: 'openai',
          key: 'thread-123',
        },
        supportsInflightInput: false,
        adopted: false,
        createdAt: '2026-04-15T21:25:32.416Z',
        updatedAt: '2026-04-15T21:25:32.416Z',
      },
      {
        runtimeId: 'rt-idle-tmux',
        hostSessionId,
        scopeRef: 'agent:rex:project:agent-spaces:task:T-00999',
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        tmuxJson: {
          sessionId: '$12',
          windowId: '@12',
          paneId: '%12',
        },
        supportsInflightInput: false,
        adopted: false,
        createdAt: '2026-04-15T21:27:16.883Z',
        updatedAt: '2026-04-15T21:27:16.883Z',
      },
    ]

    expect(selectLatestUsableRuntime(runtimes)?.runtimeId).toBe('rt-headless')
  })

  it('retries attach with a refreshed headless runtime when the initial tmux runtime is stale', async () => {
    const initialRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-dead-tmux',
      hostSessionId: 'hsid-test-attach-retry',
      scopeRef: 'agent:rex:project:agent-spaces:task:T-01000',
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      tmuxJson: {
        sessionId: '$14',
        windowId: '@14',
        paneId: '%14',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
    }
    const fallbackRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-headless-fallback',
      hostSessionId: initialRuntime.hostSessionId,
      scopeRef: initialRuntime.scopeRef,
      laneRef: initialRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      continuation: {
        provider: 'openai',
        key: 'thread-123',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:00:01.000Z',
      updatedAt: '2026-04-16T00:00:01.000Z',
    }

    let listCalls = 0
    const client = {
      async attachRuntime({ runtimeId }: { runtimeId: string }) {
        if (runtimeId === initialRuntime.runtimeId) {
          throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'runtime is dead')
        }
        expect(runtimeId).toBe(fallbackRuntime.runtimeId)
        return {
          kind: 'exec',
          argv: ['tmux', 'attach-session', '-t', '$15'],
          bindingFence: {
            hostSessionId: initialRuntime.hostSessionId,
            runtimeId,
            generation: 1,
          },
        }
      },
      async listRuntimes() {
        listCalls += 1
        return [initialRuntime, fallbackRuntime]
      },
    } as unknown as import('hrc-sdk').HrcClient

    const descriptor = await attachOpenAiRuntime(
      client,
      initialRuntime.hostSessionId,
      initialRuntime
    )

    expect(descriptor.argv).toContain('attach-session')
    expect(descriptor.bindingFence.runtimeId).toBe(fallbackRuntime.runtimeId)
    expect(listCalls).toBe(1)
  })

  it('retries attach when runtime_unavailable is shaped like a domain error but fails instanceof', async () => {
    const initialRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-dead-tmux-structural',
      hostSessionId: 'hsid-test-attach-structural',
      scopeRef: 'agent:rex:project:agent-spaces:task:T-01001',
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      tmuxJson: {
        sessionId: '$16',
        windowId: '@16',
        paneId: '%16',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:10:00.000Z',
      updatedAt: '2026-04-16T00:10:00.000Z',
    }
    const fallbackRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-headless-structural-fallback',
      hostSessionId: initialRuntime.hostSessionId,
      scopeRef: initialRuntime.scopeRef,
      laneRef: initialRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      continuation: {
        provider: 'openai',
        key: 'thread-456',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:10:01.000Z',
      updatedAt: '2026-04-16T00:10:01.000Z',
    }

    let listCalls = 0
    const client = {
      async attachRuntime({ runtimeId }: { runtimeId: string }) {
        if (runtimeId === initialRuntime.runtimeId) {
          throw {
            code: HrcErrorCode.RUNTIME_UNAVAILABLE,
            message: 'runtime is dead',
            detail: { runtimeId },
          }
        }
        expect(runtimeId).toBe(fallbackRuntime.runtimeId)
        return {
          kind: 'exec',
          argv: ['tmux', 'attach-session', '-t', '$17'],
          bindingFence: {
            hostSessionId: initialRuntime.hostSessionId,
            runtimeId,
            generation: 1,
          },
        }
      },
      async listRuntimes() {
        listCalls += 1
        return [initialRuntime, fallbackRuntime]
      },
    } as unknown as import('hrc-sdk').HrcClient

    const descriptor = await attachOpenAiRuntime(
      client,
      initialRuntime.hostSessionId,
      initialRuntime
    )

    expect(descriptor.argv).toContain('attach-session')
    expect(descriptor.bindingFence.runtimeId).toBe(fallbackRuntime.runtimeId)
    expect(listCalls).toBe(1)
  })
})

describe('hrc run', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
    await seedRunRoots('rex', 'agent-spaces')
  })

  it('creates a canonical harness session from a shorthand scope handle with --no-attach', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces:T-00123', '--no-attach'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:main')
    expect(body.hostSessionId).toBeDefined()
    expect(body.created).toBe(true)
    expect(body.runtime.runtimeId).toBeDefined()
    expect(body.runtime.transport).toBe('tmux')
  })

  it('accepts canonical ScopeRef input and dispatches a prompt', async () => {
    const prompt = 'Fix the bug'
    const result = await runCli(
      ['run', 'agent:rex:project:agent-spaces:task:T-00123', prompt, '--no-attach'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:main')
    expect(body.created).toBe(true)
    expect(body.runtime.runtimeId).toBeDefined()
  })

  it('maps ~lane handles onto distinct sessionRefs and replaces the runtime on --force-restart', async () => {
    const first = await runCli(
      ['run', 'rex@agent-spaces:T-00123~repair', '--no-attach'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )
    expect(first.exitCode).toBe(0)
    const firstBody = JSON.parse(first.stdout.trim())
    expect(firstBody.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:repair')
    const firstRuntimeId = firstBody.runtime.runtimeId

    const second = await runCli(
      ['run', 'rex@agent-spaces:T-00123~repair', '--force-restart', '--no-attach'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(second.exitCode).toBe(0)
    const secondBody = JSON.parse(second.stdout.trim())
    expect(secondBody.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:repair')
    // Same session, but fresh_pty replaces the runtime.
    expect(secondBody.hostSessionId).toBe(firstBody.hostSessionId)
    expect(secondBody.runtime.runtimeId).not.toBe(firstRuntimeId)
    expect(secondBody.created).toBe(false)
  })

  // hrc run must pass canonical sessionRef when resolving the session. The
  // resulting host session row must carry the canonical scopeRef/laneRef,
  // not a synthetic app-session identifier.
  it('passes canonical sessionRef on the resolveSession request', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces:T-00123', '--no-attach'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())

    const hostSessionId = body.hostSessionId
    expect(hostSessionId).toBeDefined()

    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const session = db.sessions.findByHostSessionId(hostSessionId)
      expect(session).toBeDefined()
      expect(session!.scopeRef).toBe('agent:rex:project:agent-spaces:task:T-00123')
      expect(session!.laneRef).toBe('main')
    } finally {
      db.close()
    }
  })

  it('attaches by default instead of printing JSON when --no-attach is omitted', async () => {
    const tmuxShimDir = await createTmuxAttachShim()
    const result = await runCli(
      ['run', 'rex@agent-spaces:T-00123'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
        PATH: `${tmuxShimDir}:${process.env.PATH ?? ''}`,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('')

    const loggedArgs = await Bun.file(join(tmuxShimDir, 'tmux-attach.json')).text()
    expect(loggedArgs).toContain('attach-session')
  })
})

// ===========================================================================
// 5a. hrc run --dry-run
// ===========================================================================
describe('hrc run --dry-run', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
    await seedRunRoots('rex', 'agent-spaces')
  })

  it('prints a local plan preview with sessionRef and default restartStyle', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain('sessionRef:   agent:rex:project:agent-spaces/lane:main')
    expect(result.stdout).toContain('restartStyle: reuse_pty')
    expect(result.stdout).toContain('provider:     anthropic')
  })

  it('reflects --force-restart as restartStyle fresh_pty in the preview', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run', '--force-restart'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('restartStyle: fresh_pty')
  })

  it('does not mutate server state', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')

    // Confirm no session was persisted — dry-run is client-side only.
    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const sessions = db.sessions.listByScopeRef('agent:rex:project:agent-spaces')
      expect(sessions.length).toBe(0)
    } finally {
      db.close()
    }

    const result2 = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )
    expect(result2.exitCode).toBe(0)
    expect(result2.stdout).toContain('local plan preview')
  })

  it('accepts -p <text> as an initial prompt source', async () => {
    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run', '-p', 'hello from flag'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('initialPrompt: 15 chars')
  })

  it('accepts --prompt-file <path> as an initial prompt source', async () => {
    const promptPath = join(tmpDir, 'prompt.txt')
    await writeFile(promptPath, 'hello from file', 'utf-8')
    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run', '--prompt-file', promptPath],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('initialPrompt: 15 chars')
  })

  it('infers openai provider from agent profile harness', async () => {
    await writeFile(
      join(agentsRoot, 'rex', 'agent-profile.toml'),
      'schemaVersion = 2\n\n[identity]\ndisplay = "Rex"\nrole = "worker"\nharness = "codex"\n',
      'utf8'
    )

    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider:     openai')
  })

  it('prefers project target harness over agent profile harness for provider inference', async () => {
    await writeFile(
      join(agentsRoot, 'rex', 'agent-profile.toml'),
      'schemaVersion = 2\n\n[identity]\ndisplay = "Rex"\nrole = "worker"\nharness = "claude-code"\n',
      'utf8'
    )
    await writeFile(
      join(projectsRoot, 'agent-spaces', 'asp-targets.toml'),
      'schema = 1\n\n[targets.rex]\nharness = "codex"\ncompose = []\n',
      'utf8'
    )

    const result = await runCli(
      ['run', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECTS_ROOT: projectsRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider:     openai')
  })
})

// ===========================================================================
// 6. hrc session resolve — JSON output
// ===========================================================================
describe('hrc session resolve', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs JSON with hostSessionId, generation, created to stdout', async () => {
    const result = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('clitest'), '--lane', 'default'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBeString()
    expect(body.generation).toBe(1)
    expect(body.created).toBe(true)
    expect(body.session).toBeDefined()
  })

  it('uses lane "default" when --lane is omitted', async () => {
    const result = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('nolane')],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.session.laneRef).toBe('default')
  })

  it('exits 1 when --scope is missing', async () => {
    const result = await runCli(['session', 'resolve'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 6. hrc session list — JSON array output
// ===========================================================================
describe('hrc session list', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs an empty JSON array when no sessions exist', async () => {
    const result = await runCli(['session', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body).toEqual([])
  })

  it('outputs sessions after resolve', async () => {
    // First create a session via CLI
    await runCli(
      ['session', 'resolve', '--scope', testProjectScope('listcli'), '--lane', 'default'],
      cliEnv()
    )

    const result = await runCli(['session', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].scopeRef).toBe(testProjectScope('listcli'))
  })

  it('supports --scope filter', async () => {
    await runCli(['session', 'resolve', '--scope', testProjectScope('filterA')], cliEnv())
    await runCli(['session', 'resolve', '--scope', testProjectScope('filterB')], cliEnv())

    const result = await runCli(
      ['session', 'list', '--scope', testProjectScope('filterA')],
      cliEnv()
    )
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].scopeRef).toBe(testProjectScope('filterA'))
  })
})

// ===========================================================================
// 7. hrc session get — JSON output
// ===========================================================================
describe('hrc session get', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs session JSON for a known hostSessionId', async () => {
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('getcli')],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim())

    const result = await runCli(['session', 'get', resolved.hostSessionId], cliEnv())
    expect(result.exitCode).toBe(0)
    const session = JSON.parse(result.stdout.trim())
    expect(session.hostSessionId).toBe(resolved.hostSessionId)
  })

  it('exits 1 for unknown hostSessionId', async () => {
    const result = await runCli(['session', 'get', 'nonexistent-hsid'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('exits 1 when hostSessionId argument is missing', async () => {
    const result = await runCli(['session', 'get'], cliEnv())
    expect(result.exitCode).toBe(1)
  })
})

// ===========================================================================
// 8. hrc events — NDJSON output
// ===========================================================================
describe('hrc events', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs NDJSON events to stdout (non-follow mode)', async () => {
    // Create events first
    await runCli(['session', 'resolve', '--scope', testProjectScope('watchcli')], cliEnv())

    // Watch without follow — should return events and exit
    const result = await runCli(['events'], cliEnv())
    expect(result.exitCode).toBe(0)

    const lines = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    // Each line must be valid JSON
    for (const line of lines) {
      const event = JSON.parse(line)
      expect(typeof event.hrcSeq).toBe('number')
      expect(typeof event.streamSeq).toBe('number')
      expect(typeof event.eventKind).toBe('string')
    }
  })

  it('supports --from-seq flag', async () => {
    // Create multiple events
    await runCli(['session', 'resolve', '--scope', testProjectScope('fromseqcli1')], cliEnv())
    await runCli(['session', 'resolve', '--scope', testProjectScope('fromseqcli2')], cliEnv())

    // Get all events
    const allResult = await runCli(['events'], cliEnv())
    const allLines = allResult.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(allLines.length).toBeGreaterThanOrEqual(2)

    const allEvents = allLines.map((l) => JSON.parse(l))
    const fromSeq = allEvents[1].hrcSeq

    // Watch from second event's seq
    const result = await runCli(['events', '--from-seq', String(fromSeq)], cliEnv())
    expect(result.exitCode).toBe(0)

    const filteredLines = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    const filteredEvents = filteredLines.map((l) => JSON.parse(l))
    for (const ev of filteredEvents) {
      expect(ev.hrcSeq).toBeGreaterThanOrEqual(fromSeq)
    }
  })

  it('shows only hrc lifecycle rows on /v1/events', async () => {
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('watchfilter')],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim()) as {
      hostSessionId: string
      generation: number
    }

    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    try {
      db.hrcEvents.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchfilter'),
        laneRef: 'default',
        generation: resolved.generation,
        category: 'runtime',
        transport: 'tmux',
        eventKind: 'runtime.created',
        payload: {
          harness: 'claude-code',
        },
      })
      db.events.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchfilter'),
        laneRef: 'default',
        generation: resolved.generation,
        source: 'hook',
        eventKind: 'hook.ingested',
        eventJson: {
          hookData: { kind: 'PreToolUse' },
        },
      })
      db.events.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchfilter'),
        laneRef: 'default',
        generation: resolved.generation,
        source: 'hook',
        eventKind: 'tool_execution_start',
        eventJson: {
          type: 'tool_execution_start',
          toolUseId: 'toolu_visible',
          toolName: 'Bash',
          input: { command: 'pwd' },
        },
      })
      db.events.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchfilter'),
        laneRef: 'default',
        generation: resolved.generation,
        source: 'otel',
        eventKind: 'codex.conversation.message',
        eventJson: {
          otel: {
            logRecord: {
              body: {
                stringValue: 'assistant response',
              },
            },
          },
        },
      })
      db.events.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchfilter'),
        laneRef: 'default',
        generation: resolved.generation,
        source: 'otel',
        eventKind: 'notice',
        eventJson: {
          type: 'notice',
          level: 'info',
          message: 'Codex conversation started',
        },
      })
    } finally {
      db.close()
    }

    const result = await runCli(['events'], cliEnv())
    expect(result.exitCode).toBe(0)

    const events = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))

    expect(events.some((event) => event.eventKind === 'runtime.created')).toBe(true)
    expect(events.every((event) => event.category)).toBe(true)
    expect(events.every((event) => event.hrcSeq >= 1)).toBe(true)
    expect(events.some((event) => event.eventKind === 'hook.ingested')).toBe(false)
    expect(events.some((event) => event.eventKind === 'tool_execution_start')).toBe(false)
    expect(events.some((event) => event.eventKind === 'notice')).toBe(false)
  })

  it('supports --pretty with colored human-readable output and hides hostSessionId', async () => {
    await runCli(['session', 'resolve', '--scope', testProjectScope('watchpretty')], cliEnv())

    const result = await runCli(['events', '--pretty'], cliEnv({ FORCE_COLOR: '1' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('test@watchpretty')
    expect(result.stdout).toContain('SESSION')
    expect(result.stdout).toContain('created')
    expect(result.stdout).not.toContain('hostSessionId')
    expect(result.stdout).toContain('\u001b[')
  })

  it('supports pretty rendering for lifecycle event metadata and payload', async () => {
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('watchprettybridge')],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim()) as {
      hostSessionId: string
      generation: number
    }

    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    try {
      db.hrcEvents.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchprettybridge'),
        laneRef: 'default',
        generation: resolved.generation,
        category: 'bridge',
        runtimeId: 'rt-pretty',
        transport: 'tmux',
        eventKind: 'bridge.delivered',
        payload: {
          bridgeId: 'bridge-pretty',
          target: 'smokey-pane@test',
          payloadLength: 3,
          enter: true,
        },
      })
    } finally {
      db.close()
    }

    const result = await runCli(['events', '--pretty'], cliEnv({ FORCE_COLOR: '1' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('BRIDGE')
    expect(result.stdout).toContain('delivered')
    expect(result.stdout).toContain('bridgeId')
    expect(result.stdout).toContain('bridge-pretty')
    expect(result.stdout).toContain('smokey-pane@test')
  })

  it('keeps multiline pretty output aligned inside the gutter', async () => {
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('watchprettymultiline')],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim()) as {
      hostSessionId: string
      generation: number
    }

    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    try {
      db.hrcEvents.append({
        ts: now,
        hostSessionId: resolved.hostSessionId,
        scopeRef: testProjectScope('watchprettymultiline'),
        laneRef: 'default',
        generation: resolved.generation,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {
          success: false,
          result: {
            content: [
              {
                type: 'text',
                text: 'Chunk ID: 384f38\nWall time: 0.0000 seconds\nProcess exited with code 3',
              },
            ],
          },
        },
      })
    } finally {
      db.close()
    }

    const result = await runCli(['events', '--pretty'], cliEnv({ FORCE_COLOR: '0' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Chunk ID: 384f38')
    expect(result.stdout).toContain('| text : Chunk ID: 384f38')
    expect(result.stdout).toContain('|        Wall time: 0.0000 seconds')
    expect(result.stdout).toContain('|        Process exited with code 3')
  })
})

// ===========================================================================
// 9. Phase 6 diagnostics CLI commands (T-00973 / T-00974)
//
// RED GATE: These tests call CLI commands that do not exist yet:
//   hrc server health, hrc status, hrc runtime list, hrc launch list, hrc runtime adopt
//
// Pass conditions for Curly (T-00973):
//   1. `hrc server health` → exit 0, stdout JSON with { ok: true }
//   2. `hrc status` → exit 0, stdout JSON with uptime (number), startedAt, socketPath, dbPath
//   3. `hrc runtime list` → exit 0, stdout JSON array
//   4. `hrc runtime list --host-session-id <id>` → exit 0, filtered JSON array
//   5. `hrc launch list` → exit 0, stdout JSON array
//   6. `hrc launch list --runtime-id <id>` → exit 0, filtered JSON array
//   7. `hrc runtime adopt <runtimeId>` on dead runtime → exit 0, stdout JSON with status='adopted'
//   8. `hrc runtime adopt <runtimeId>` on active runtime → exit 1 (CONFLICT)
//   9. `hrc runtime adopt <unknownId>` → exit 1 (UNKNOWN_RUNTIME)
// ===========================================================================
describe('Phase 6 diagnostics CLI', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('hrc server health prints { ok: true } and exits 0', async () => {
    const result = await runCli(['server', 'health'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body).toEqual({ ok: true })
  })

  it('hrc status --json prints status JSON with uptime and exits 0', async () => {
    // Updated for T-00998: default output is now human-readable; --json for raw JSON
    const result = await runCli(['status', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(typeof body.startedAt).toBe('string')
    expect(typeof body.socketPath).toBe('string')
    expect(typeof body.dbPath).toBe('string')
    expect(typeof body.sessionCount).toBe('number')
    expect(typeof body.runtimeCount).toBe('number')
  })

  it('hrc runtime list prints empty JSON array and exits 0', async () => {
    // RED: 'runtime list' subcommand does not exist in CLI dispatch
    const result = await runCli(['runtime', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
  })

  it('hrc runtime list with --host-session-id filter', async () => {
    // Seed a session + runtime
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('diag-rt-list')],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    await runCli(['runtime', 'ensure', hostSessionId], cliEnv())

    // RED: 'runtime list' subcommand does not exist
    const result = await runCli(['runtime', 'list', '--host-session-id', hostSessionId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].hostSessionId).toBe(hostSessionId)
  })

  it('hrc launch list prints JSON array and exits 0', async () => {
    // RED: 'launch' command does not exist in CLI dispatch
    const result = await runCli(['launch', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
  })

  it('hrc launch list with --runtime-id filter', async () => {
    // Seed a runtime to get launches
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('diag-launch-list')],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    const runtimeId = JSON.parse(ensureResult.stdout.trim()).runtimeId as string

    // RED: 'launch list' command does not exist
    const result = await runCli(['launch', 'list', '--runtime-id', runtimeId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    for (const launch of body) {
      expect(launch.runtimeId).toBe(runtimeId)
    }
  })

  it('hrc runtime adopt on dead runtime prints adopted JSON and exits 0', async () => {
    // Seed a dead runtime
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('diag-adopt-cli')],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim())
    const runtimeId = `rt-adopt-cli-${randomUUID()}`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    db.runtimes.insert({
      runtimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: testProjectScope('diag-adopt-cli'),
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'dead',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: 'hrc-adopt-cli',
        windowName: 'main',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    const result = await runCli(['runtime', 'adopt', runtimeId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.status).toBe('adopted')
    expect(body.adopted).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('hrc runtime adopt on active runtime exits 1', async () => {
    const resolveResult = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('diag-adopt-active-cli')],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    const runtimeId = JSON.parse(ensureResult.stdout.trim()).runtimeId as string

    const result = await runCli(['runtime', 'adopt', runtimeId], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('hrc runtime adopt on unknown runtime exits 1', async () => {
    const result = await runCli(['runtime', 'adopt', 'nonexistent-runtime-id'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 10. Status capability display (T-00998)
//
// RED GATE: These tests will fail until:
//   - Larry lands HrcCapabilityStatus in hrc-core and server returns capabilities
//   - Curly updates cmdStatus() to render a human-readable capabilities section
//   - CLI adds --json flag for raw JSON backwards compatibility
//
// Pass conditions:
//   1. `hrc status` exits 0 and stdout includes a "Capabilities" section
//   2. Capabilities section lists backend.tmux with available status
//   3. Unimplemented capabilities (appOwnedSessions, etc.) show as unavailable
//   4. `hrc status --json` outputs raw JSON with capabilities object (backwards compat)
//   5. JSON output includes apiVersion field
// ===========================================================================
describe('status capability display (T-00998)', () => {
  it('hrc status displays human-readable Capabilities section', async () => {
    server = await createHrcServer(serverOpts())
    // RED: cmdStatus() currently just calls printJson(result) — no capability display
    const result = await runCli(['status'], cliEnv())
    expect(result.exitCode).toBe(0)
    // Output must include a "Capabilities" header/section (not just raw JSON)
    expect(result.stdout).toMatch(/[Cc]apabilit/i)
  })

  it('hrc status shows tmux backend as available', async () => {
    server = await createHrcServer(serverOpts())
    // RED: no capability rendering in CLI
    const result = await runCli(['status'], cliEnv())
    expect(result.exitCode).toBe(0)
    // Should display tmux availability in the capabilities section
    expect(result.stdout).toMatch(/tmux/i)
    // Should indicate it's available (not "unavailable" or "false")
    expect(result.stdout).toMatch(/tmux.*(?:available|true|yes|✓)/i)
  })

  it('hrc status shows unimplemented capabilities as unavailable', async () => {
    server = await createHrcServer(serverOpts())
    // RED: no capability rendering in CLI
    const result = await runCli(['status'], cliEnv())
    expect(result.exitCode).toBe(0)
    // Phase 1 canonical capabilities — all unimplemented, should appear in output
    expect(result.stdout).toMatch(
      /appOwnedSessions|appHarnessSessions|commandSessions|literalInput|surfaceBindings|legacyLocalBridges/i
    )
  })

  it('hrc status --json outputs raw JSON with capabilities object', async () => {
    server = await createHrcServer(serverOpts())
    // RED: --json flag does not exist on status command yet
    const result = await runCli(['status', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.capabilities).toBeDefined()
    expect(typeof body.capabilities).toBe('object')
    expect(typeof body.apiVersion).toBe('string')
  })

  it('hrc status --json preserves all existing fields for backwards compat', async () => {
    server = await createHrcServer(serverOpts())
    // RED: --json flag does not exist on status command yet
    const result = await runCli(['status', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    // All pre-existing fields must still be present
    expect(body.ok).toBe(true)
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.startedAt).toBe('string')
    expect(typeof body.socketPath).toBe('string')
    expect(typeof body.dbPath).toBe('string')
    expect(typeof body.sessionCount).toBe('number')
    expect(typeof body.runtimeCount).toBe('number')
    // Plus new capability fields
    expect(body.apiVersion).toBeDefined()
    expect(body.capabilities).toBeDefined()
  })
})

// ===========================================================================
// 11. Unified status session/runtime/surface view (T-01025)
//
// RED GATE for wrkq T-01025:
//   `hrc status` still renders aggregate server state only, and `/v1/status`
//   still returns counts/capabilities without a joined per-session view.
//
// Pass conditions:
//   1. Default `hrc status` renders session-centric blocks, not counts only
//   2. Session blocks join session -> active runtime -> tmux -> active surfaces
//   3. `hrc status --json` exposes a machine-readable `sessions[]` joined view
//   4. Sessions with no active runtime render explicitly
//   5. Active runtimes with no active surfaces render explicitly
// ===========================================================================
describe('unified status session/runtime/surface view (T-01025)', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  async function resolveSession(scope: string): Promise<{
    hostSessionId: string
    generation: number
    scopeRef: string
    laneRef: string
  }> {
    const resolveResult = await runCli(['session', 'resolve', '--scope', scope], cliEnv())
    expect(resolveResult.exitCode).toBe(0)
    const { hostSessionId } = JSON.parse(resolveResult.stdout.trim()) as { hostSessionId: string }
    const sessionResult = await runCli(['session', 'get', hostSessionId], cliEnv())
    expect(sessionResult.exitCode).toBe(0)
    const session = JSON.parse(sessionResult.stdout.trim()) as {
      hostSessionId: string
      generation: number
      scopeRef: string
      laneRef: string
    }
    return {
      hostSessionId,
      generation: session.generation,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
    }
  }

  async function ensureTmuxRuntime(scope: string): Promise<{
    hostSessionId: string
    runtimeId: string
    paneId?: string
  }> {
    const session = await resolveSession(scope)
    const ensureResult = await runCli(['runtime', 'ensure', session.hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)
    const runtime = JSON.parse(ensureResult.stdout.trim()) as {
      runtimeId: string
      tmuxJson?: {
        paneId?: string
      }
    }
    return {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      paneId: runtime.tmuxJson?.paneId,
    }
  }

  it('hrc status renders session-centric human output with joined runtime/tmux/surface details', async () => {
    const seeded = await ensureTmuxRuntime(testProjectScope('status-human-joined'))
    const bindResult = await runCli(
      ['surface', 'bind', seeded.runtimeId, '--kind', 'ghostty', '--id', 'ghostty-status-human-1'],
      cliEnv()
    )
    expect(bindResult.exitCode).toBe(0)

    const result = await runCli(['status'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(seeded.hostSessionId)
    expect(result.stdout).toContain(testProjectScope('status-human-joined'))
    expect(result.stdout).toContain(seeded.runtimeId)
    expect(result.stdout).toMatch(/tmux/i)
    if (seeded.paneId) {
      expect(result.stdout).toContain(seeded.paneId)
    }
    expect(result.stdout).toContain('ghostty-status-human-1')
  })

  it('hrc status renders explicit no-runtime and no-surface states without overfitting spacing', async () => {
    await resolveSession(testProjectScope('status-no-runtime'))
    await ensureTmuxRuntime(testProjectScope('status-no-surfaces'))

    const result = await runCli(['status'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(testProjectScope('status-no-runtime'))
    expect(result.stdout).toContain(testProjectScope('status-no-surfaces'))
    expect(result.stdout).toMatch(/no active runtime/i)
    expect(result.stdout).toMatch(/no active surfaces/i)
  })

  it('hrc status --json exposes joined sessions with activeRuntime tmux and activeSurfaces', async () => {
    const seeded = await ensureTmuxRuntime(testProjectScope('status-json-joined'))
    const bindResult = await runCli(
      ['surface', 'bind', seeded.runtimeId, '--kind', 'ghostty', '--id', 'ghostty-status-json-1'],
      cliEnv()
    )
    expect(bindResult.exitCode).toBe(0)

    const result = await runCli(['status', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim()) as UnifiedStatusResponse
    expect(Array.isArray(body.sessions)).toBe(true)

    const joined = body.sessions.find(
      (session) => session.session.hostSessionId === seeded.hostSessionId
    )
    expect(joined).toBeDefined()
    expect(joined?.session.scopeRef).toBe(testProjectScope('status-json-joined'))
    expect(joined?.activeRuntime?.runtime.runtimeId).toBe(seeded.runtimeId)
    expect(joined?.activeRuntime?.runtime.transport).toBe('tmux')
    expect(joined?.activeRuntime?.tmux?.paneId).toBeString()
    expect(Array.isArray(joined?.activeRuntime?.surfaceBindings)).toBe(true)
    expect(joined?.activeRuntime?.surfaceBindings).toHaveLength(1)
    expect(joined?.activeRuntime?.surfaceBindings[0]?.surfaceKind).toBe('ghostty')
    expect(joined?.activeRuntime?.surfaceBindings[0]?.surfaceId).toBe('ghostty-status-json-1')
  })
})

// ===========================================================================
// 12. Error output format
// ===========================================================================
describe('error output', () => {
  it('errors go to stderr, not stdout', async () => {
    const result = await runCli(['nonexistent'])
    expect(result.exitCode).toBe(1)
    // stdout should be empty or minimal; error text on stderr
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
