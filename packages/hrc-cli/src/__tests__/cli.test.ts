/**
 * RED/GREEN tests for hrc-cli (T-00957)
 *
 * These tests validate the CLI arg parsing, command dispatch, and output
 * formatting for the `hrc` operator CLI. The CLI is a thin wrapper over
 * hrc-sdk; these tests verify the wrapper layer specifically.
 *
 * Pass conditions for Curly (T-00957):
 *   1. `hrc` with no args prints help text to stderr and exits 1
 *   2. `hrc unknowncmd` prints error to stderr and exits 2
 *   3. `hrc turn send` and `hrc session clear-context` validate args and dispatch
 *      through hrc-sdk
 *      to stderr and exit 2
 *   4. `hrc server` starts the daemon (tested via createHrcServer delegation)
 *   5. `hrc session resolve --scope <scopeRef>` outputs JSON to stdout
 *   6. `hrc session list` outputs JSON array to stdout
 *   7. `hrc session get <hostSessionId>` outputs JSON to stdout
 *   8. monitor commands expose snapshots and event streams
 *   9. All structured output is valid JSON on stdout; all errors on stderr
 *  10. Exit code 0 on success, 1 on error
 *
 * Reference: T-00946 (parent), T-00957 (CLI implementation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'

// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { main } from '../cli'
import { attachOpenAiRuntime, selectLatestUsableRuntime } from '../cli'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const describeDaemonLifecycle =
  process.env.HRC_RUN_DAEMON_LIFECYCLE_TESTS === '1' ? describe : describe.skip

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
  process.env.HRC_ALLOW_HARNESS_SHIM = '1'
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
  // Write a marker so the project dir is recognized by the walk-up resolver.
  await writeFile(join(projectsRoot, projectId, 'asp-targets.toml'), 'schema = 1\n', 'utf8')
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
if [ "$cmd" = "--version" ]; then
  printf 'codex-cli 0.124.0\\n'
  exit 0
fi
if [ "$cmd" = "app-server" ] && [ "\${2:-}" = "--help" ]; then
  printf 'Usage: codex app-server\\n'
  exit 0
fi
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

async function waitForServerStatus(
  predicate: (status: { running: boolean; socketResponsive?: boolean | undefined }) => boolean,
  env: Record<string, string>,
  attempts = 40
): Promise<{ running: boolean; socketResponsive?: boolean | undefined; pid?: number | undefined }> {
  let lastStatus: {
    running: boolean
    socketResponsive?: boolean | undefined
    pid?: number | undefined
  } = {
    running: false,
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const statusResult = await runCli(['server', 'status', '--json'], env)
    if (statusResult.exitCode === 0) {
      lastStatus = JSON.parse(statusResult.stdout.trim()) as {
        running: boolean
        socketResponsive?: boolean | undefined
        pid?: number | undefined
      }
      if (predicate(lastStatus)) {
        return lastStatus
      }
    }

    await Bun.sleep(100)
  }

  return lastStatus
}

async function waitForServerLog(attempts = 40): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(join(runtimeRoot, 'server.log'))) {
      return await readServerLog()
    }
    await Bun.sleep(100)
  }

  return await readServerLog()
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
// 1b½. server group commander help (Phase 6 T1, T-01280)
// ===========================================================================
describe('server group commander help', () => {
  it('hrc server --help exits 0 with Usage and lists all subcommands', async () => {
    const result = await runCli(['server', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('start')
    expect(output).toContain('stop')
    expect(output).toContain('restart')
    expect(output).toContain('status')
    expect(output).not.toMatch(/\n\s+health\b/)
    expect(output).toContain('tmux')
  })

  it('hrc server start --help exits 0 with Usage and --timeout-ms', async () => {
    const result = await runCli(['server', 'start', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('--timeout-ms')
  })

  it('hrc server tmux --help exits 0 with Usage', async () => {
    const result = await runCli(['server', 'tmux', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
  })
})

describe('legacy monitor command removal', () => {
  it('top-level help lists monitor group and omits removed status/events entries', async () => {
    const result = await runCli(['--help'])
    const output = result.stdout + result.stderr
    expect(result.exitCode).toBe(0)
    expect(output).toContain('monitor')
    expect(output).not.toMatch(/\n\s+status\s/)
    expect(output).not.toMatch(/\n\s+events\s/)
  })

  it('removed legacy hrc commands exit as unknown commands', async () => {
    for (const args of [['status'], ['events'], ['server', 'health']]) {
      const result = await runCli(args, cliEnv())
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/unknown command/i)
    }
  })

  it('monitor subcommand help covers show, watch, and wait', async () => {
    const result = await runCli(['monitor', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('show')
    expect(result.stdout).toContain('watch')
    expect(result.stdout).toContain('wait')
  })
})

// ===========================================================================
// 1b¾. nested group commander help (Phase 6 T2, T-01281)
// ===========================================================================
describe('nested group commander help (Phase 6 T2)', () => {
  // -- session group --
  it('hrc session --help exits 0 with Usage and lists all subcommands', async () => {
    const result = await runCli(['session', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('resolve')
    expect(output).toContain('list')
    expect(output).toContain('get')
    expect(output).toContain('clear-context')
    expect(output).toContain('drop-continuation')
  })

  it('hrc session resolve --help exits 0 with Usage', async () => {
    const result = await runCli(['session', 'resolve', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--scope')
  })

  // -- runtime group --
  it('hrc runtime --help exits 0 with Usage and lists all subcommands', async () => {
    const result = await runCli(['runtime', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('ensure')
    expect(output).toContain('list')
    expect(output).toContain('inspect')
    expect(output).toContain('sweep')
    expect(output).toContain('capture')
    expect(output).toContain('interrupt')
    expect(output).toContain('terminate')
    expect(output).toContain('adopt')
  })

  it('hrc runtime sweep --help exits 0 with Usage and flags', async () => {
    const result = await runCli(['runtime', 'sweep', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('--transport')
  })

  // -- launch group --
  it('hrc launch --help exits 0 with Usage and lists subcommands', async () => {
    const result = await runCli(['launch', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('list')
  })

  it('hrc launch list --help exits 0 with Usage', async () => {
    const result = await runCli(['launch', 'list', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
  })

  // -- turn group --
  it('hrc turn --help exits 0 with Usage and lists subcommands', async () => {
    const result = await runCli(['turn', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('send')
  })

  it('hrc turn send --help exits 0 with Usage', async () => {
    const result = await runCli(['turn', 'send', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--prompt')
  })

  // -- inflight group --
  it('hrc inflight --help exits 0 with Usage and lists subcommands', async () => {
    const result = await runCli(['inflight', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('send')
  })

  it('hrc inflight send --help exits 0 with Usage', async () => {
    const result = await runCli(['inflight', 'send', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--run-id')
  })

  // -- surface group --
  it('hrc surface --help exits 0 with Usage and lists subcommands', async () => {
    const result = await runCli(['surface', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('bind')
    expect(output).toContain('unbind')
    expect(output).toContain('list')
  })

  it('hrc surface bind --help exits 0 with Usage', async () => {
    const result = await runCli(['surface', 'bind', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--kind')
  })

  // -- bridge group --
  it('hrc bridge --help exits 0 with Usage and lists all subcommands', async () => {
    const result = await runCli(['bridge', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('target')
    expect(output).toContain('deliver-text')
    expect(output).toContain('register')
    expect(output).toContain('deliver')
    expect(output).toContain('list')
    expect(output).toContain('close')
  })

  it('hrc bridge deliver-text --help exits 0 with Usage', async () => {
    const result = await runCli(['bridge', 'deliver-text', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--bridge')
    expect(result.stdout).toContain('--text')
  })

  // -- runtime terminate negated-flag conflict --
  it('hrc runtime terminate with both --drop-continuation and --no-drop-continuation exits non-zero', async () => {
    const result = await runCli([
      'runtime',
      'terminate',
      'rt-x',
      '--drop-continuation',
      '--no-drop-continuation',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('mutually exclusive')
  })
})

// ===========================================================================
// 1b⅞. top-level commander help (Phase 6 T2b, T-01282)
// ===========================================================================
describe('top-level commander help (Phase 6 T2b)', () => {
  it('hrc start --help exits 0 with Usage', async () => {
    const result = await runCli(['start', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--force-restart')
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('--project-id')
  })

  it('hrc run --help exits 0 with Usage', async () => {
    const result = await runCli(['run', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--force-restart')
    expect(result.stdout).toContain('--no-attach')
    expect(result.stdout).toContain('--dry-run')
  })

  it('hrc capture --help exits 0 with Usage', async () => {
    const result = await runCli(['capture', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
  })

  it('hrc attach --help exits 0 with Usage', async () => {
    const result = await runCli(['attach', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--dry-run')
  })

  it('hrc start (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['start'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc start/i)
  })

  it('hrc run (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['run'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc run/i)
  })

  it('hrc attach (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['attach'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc attach/i)
  })
})

// ===========================================================================
describe('unknown command', () => {
  it('prints error to stderr and exits 2 for unknown command', async () => {
    const result = await runCli(['nonexistent-command'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(result.stderr.toLowerCase()).toMatch(/unknown|unrecognized|invalid/i)
  })
})

// ===========================================================================
// 2b. server/tmux admin lifecycle
// ===========================================================================
describeDaemonLifecycle('server/tmux admin lifecycle', () => {
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

    const status = await waitForServerStatus(
      (value) => value.running === true && value.socketResponsive === true,
      cliEnv()
    )
    expect(status.running).toBe(true)
    expect(status.socketResponsive).toBe(true)
    expect(status.pid).toBeNumber()
  })

  it('server log includes timestamped lifecycle entries', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)
    const log = await waitForServerLog()
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
    const status = await waitForServerStatus((value) => value.running === true, env)
    expect(status.running).toBe(true)

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

    const log = await waitForServerLog()
    expect(log).toContain('launch.dispatch.prepared')
    expect(log).toContain('"execution"')
    expect(log).toContain('"codexHome"')
    expect(log).toContain(`${aspHome}/codex-homes/`)
  })

  it('server stop shuts down only the daemon and leaves the HRC tmux server running', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

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
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

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

    const monitorResult = await runCli(
      ['monitor', 'show', testProjectScope('server-restart-preserves-runtime'), '--json'],
      cliEnv()
    )
    expect(monitorResult.exitCode).toBe(0)
    const monitor = JSON.parse(monitorResult.stdout.trim()) as {
      session?: { hostSessionId: string }
      runtime?: { runtimeId: string; transport: string }
    }
    expect(monitor.session?.hostSessionId).toBe(seeded.hostSessionId)
    expect(monitor.runtime?.runtimeId).toBe(seeded.runtimeId)
    expect(monitor.runtime?.transport).toBe('tmux')
  })

  it('tmux kill requires --yes and then kills the HRC tmux server explicitly', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

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

  it('turn send exits 2 when hostSessionId is missing', async () => {
    const result = await runCli(['turn', 'send'], cliEnv())
    expect(result.exitCode).toBe(2)
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

  it('session clear-context exits 2 when hostSessionId is missing', async () => {
    const result = await runCli(['session', 'clear-context'], cliEnv())
    expect(result.exitCode).toBe(2)
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider:     openai')
    expect(result.stdout).toContain('── command ──')
    expect(result.stdout).toContain('codex exec')
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
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
    expect(attachArtifact?.argv?.[0]?.split('/').pop()).toBe('codex')
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
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

  it('exits 2 when --scope is missing', async () => {
    const result = await runCli(['session', 'resolve'], cliEnv())
    expect(result.exitCode).toBe(2)
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

  it('exits 2 when hostSessionId argument is missing', async () => {
    const result = await runCli(['session', 'get'], cliEnv())
    expect(result.exitCode).toBe(2)
  })
})

// ===========================================================================
// 9. Phase 6 diagnostics CLI commands (T-00973 / T-00974)
// ===========================================================================
describe('Phase 6 diagnostics CLI', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  describe('T-01292 server status acceptance', () => {
    beforeEach(async () => {
      if (server) {
        await server.stop()
        server = null
      }
    })

    afterEach(async () => {
      if (server) {
        await server.stop()
        server = null
      }
    })

    it('exits 0 when healthy and --json reports the full diagnostic shape', async () => {
      server = await createHrcServer(serverOpts())

      const result = await runCli(['server', 'status', '--json'], cliEnv())
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(true)
      expect(body.status).toBe('healthy')
      expect(body.exitCode).toBe(0)
      expect(body.daemon.running).toBe(true)
      expect(typeof body.daemon.pidAlive).toBe('boolean')
      expect(body.daemon.pidPath).toBe(join(runtimeRoot, 'server.pid'))
      expect(body.socket.path).toBe(socketPath)
      expect(body.socket.responsive).toBe(true)
      expect(body.apiHealth).toEqual({ ok: true })
      expect(typeof body.api.startedAt).toBe('string')
      expect(typeof body.api.uptime).toBe('number')
      expect(body.tmux.socketPath).toBe(tmuxSocketPath)
    })

    it('exits 1 and reports not-running when the daemon is down', async () => {
      const result = await runCli(['server', 'status', '--json'], cliEnv())
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('')

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(false)
      expect(body.status).toBe('not-running')
      expect(body.exitCode).toBe(1)
      expect(body.daemon.running).toBe(false)
      expect(body.socket.path).toBe(socketPath)
      expect(body.socket.responsive).toBe(false)
      expect(body.apiHealth).toEqual({ ok: false, error: 'daemon not running' })
    })

    it('exits 2 for usage errors before probing daemon state', async () => {
      const result = await runCli(['server', 'status', '--bogus-flag'], cliEnv())
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/unknown option|bogus-flag/i)
    })

    it('exits 2 and reports degraded when a socket responds but the API health probe fails', async () => {
      const fakeDaemon = createServer((conn) => {
        conn.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        fakeDaemon.once('error', reject)
        fakeDaemon.listen(socketPath, resolve)
      })

      try {
        const result = await runCli(['server', 'status', '--json'], cliEnv())
        expect(result.exitCode).toBe(2)

        const body = JSON.parse(result.stdout.trim())
        expect(body.ok).toBe(false)
        expect(body.status).toBe('degraded')
        expect(body.exitCode).toBe(2)
        expect(body.socket.responsive).toBe(true)
        expect(body.apiHealth.ok).toBe(false)
        expect(body.apiHealth.error).toMatch(/health|api|status|socket/i)
      } finally {
        await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()))
        await rm(socketPath, { force: true })
      }
    })

    it('exits 3 when local filesystem diagnostics fail', async () => {
      const runtimeFile = join(tmpDir, 'runtime-as-file')
      await writeFile(runtimeFile, 'not a directory', 'utf8')

      const result = await runCli(['server', 'status', '--json'], {
        HRC_RUNTIME_DIR: runtimeFile,
        HRC_STATE_DIR: stateRoot,
      })
      expect(result.exitCode).toBe(3)

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(false)
      expect(body.status).toBe('probe-failed')
      expect(body.exitCode).toBe(3)
      expect(body.error).toMatch(/ENOTDIR|not a directory|diagnostic/i)
    })

    it('includes API health output in server status JSON and human output', async () => {
      server = await createHrcServer(serverOpts())

      const statusJson = await runCli(['server', 'status', '--json'], cliEnv())
      expect(statusJson.exitCode).toBe(0)
      const statusBody = JSON.parse(statusJson.stdout.trim())
      expect(statusBody.apiHealth).toEqual({ ok: true })

      const statusHuman = await runCli(['server', 'status'], cliEnv())
      expect(statusHuman.exitCode).toBe(0)
      expect(statusHuman.stdout).toContain('HRC Daemon Status')
      expect(statusHuman.stdout).toMatch(/api health:\s+ok/i)
      expect(statusHuman.stdout).toMatch(/running:\s+yes/i)
    })
  })

  it('hrc monitor show --json prints snapshot JSON with daemon status and exits 0', async () => {
    const result = await runCli(['monitor', 'show', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.kind).toBe('monitor.snapshot')
    expect(body.daemon.status).toBe('healthy')
    expect(typeof body.daemon.uptime).toBe('number')
    expect(body.daemon.uptime).toBeGreaterThanOrEqual(0)
    expect(typeof body.daemon.startedAt).toBe('string')
    expect(typeof body.daemon.socketPath).toBe('string')
    expect(typeof body.counts.sessions).toBe('number')
    expect(typeof body.counts.runtimes).toBe('number')
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
describe('error output', () => {
  it('errors go to stderr, not stdout', async () => {
    const result = await runCli(['nonexistent'])
    expect(result.exitCode).toBe(2)
    // stdout should be empty or minimal; error text on stderr
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
