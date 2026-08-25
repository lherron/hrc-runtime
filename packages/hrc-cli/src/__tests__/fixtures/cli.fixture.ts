/**
 * RED/GREEN tests for hrc-cli (T-00957)
 *
 * These tests validate the CLI arg parsing, command dispatch, and output
 * formatting for the `hrc` operator CLI. The CLI is a thin wrapper over
 * hrc-sdk; these tests verify the wrapper layer specifically.
 *
 * Pass conditions for Curly (T-00957):
 *   1. `hrc` with no args prints help text to stderr and exits 2
 *   2. `hrc unknowncmd` prints error to stderr and exits 2
 *   3. `hrc session rotate` validates args and dispatches through
 *      hrc-sdk; `hrc turn` is a passthrough alias for `hrcchat turn`
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
import { describe, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { main } from '../../cli'

export const CLI_PATH = join(import.meta.dir, '..', '..', 'cli.ts')
export const describeDaemonLifecycle =
  process.env.HRC_RUN_DAEMON_LIFECYCLE_TESTS === '1' ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

/**
 * Run the CLI as a subprocess and capture output.
 * Uses `bun run` to execute the TypeScript CLI entry point directly.
 */
export async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  if (shouldUseSubprocess(args)) {
    return runCliSubprocess(args, env)
  }
  return runCliInProcess(args, env)
}

export function shouldUseSubprocess(args: string[]): boolean {
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
      return !args.includes('--dry-run')
    case 'attach':
      return !(args.includes('--dry-run') || args[1]?.startsWith('rt-'))
    case 'turn':
      // turn re-execs `hrcchat turn` with inherited stdio; must run as
      // subprocess so the grandchild's output flows through pipes to the test
      return true
    default:
      return false
  }
}

export function shouldUseServerSubprocess(args: string[]): boolean {
  const subcommand = args[0]
  return subcommand === undefined || subcommand === 'start' || subcommand === 'restart'
}

export async function runCliSubprocess(
  args: string[],
  env?: Record<string, string>
): Promise<CliResult> {
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

export function captureChunk(
  chunk: string | ArrayBufferView | ArrayBuffer,
  chunks: string[]
): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

export async function runCliInProcess(
  args: string[],
  env?: Record<string, string>
): Promise<CliResult> {
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
      restoreEnvValue(key, value)
    }
  }
}

export function testProjectScope(projectId: string): string {
  return `agent:test:project:${projectId}`
}

// ---------------------------------------------------------------------------
// Test harness for commands that need a running server
// ---------------------------------------------------------------------------

export let tmpDir: string
export let runtimeRoot: string
export let stateRoot: string
export let socketPath: string
export let lockPath: string
export let spoolDir: string
export let dbPath: string
export let tmuxSocketPath: string
export let server: HrcServer | null = null

export function setServer(value: HrcServer | null): void {
  server = value
}
export let agentsRoot: string
export let projectsRoot: string
export let originalPath: string | undefined
export let originalClaudePath: string | undefined
export let originalAllowHarnessShim: string | undefined
const leaseSockets: string[] = []

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const CLAUDE_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'claude-shim')
const CODEX_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'codex-shim')
export const BROKER_LIFECYCLE_TEST_TIMEOUT_MS = 30_000

export function serverOpts(): HrcServerOptions {
  return { runtimeRoot, stateRoot, socketPath, lockPath, spoolDir, dbPath, tmuxSocketPath }
}

/** Env vars that point the CLI's discoverSocket at our test server */
export function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    ...extra,
  }
}

export function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

export async function setupCliFixture(): Promise<void> {
  tmpDir = await mkdtemp(join('/tmp', 'hrc-cli-test-'))
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
  originalAllowHarnessShim = process.env.HRC_ALLOW_HARNESS_SHIM
  process.env.PATH = `${CLAUDE_SHIM_DIR}:${CODEX_SHIM_DIR}:${originalPath ?? ''}`
  process.env.HRC_ALLOW_HARNESS_SHIM = '1'
}

export async function teardownCliFixture(): Promise<void> {
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
  for (const leaseSocketPath of leaseSockets.splice(0)) {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', leaseSocketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no lease server was created
    }
  }
  // Kill the per-runtime broker tmux servers under runtimeRoot/btmux too:
  // every broker dispatch (e.g. via `runtime ensure`) allocates one, and the
  // rm below only unlinks the sockets — a leaked server keeps its panes
  // (broker, launch runner, harness) and their ptys alive until the
  // machine-wide pty pool is exhausted.
  try {
    const btmuxDir = join(runtimeRoot, 'btmux')
    for (const entry of await readdir(btmuxDir)) {
      if (!entry.endsWith('.sock')) continue
      try {
        const { exited } = Bun.spawn(['tmux', '-S', join(btmuxDir, entry), 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {
        // fine when no server is on this socket
      }
    }
  } catch {
    // fine when no broker tmux allocations happened
  }
  restoreEnvValue('PATH', originalPath)
  restoreEnvValue('ASP_CLAUDE_PATH', originalClaudePath)
  restoreEnvValue('HRC_ALLOW_HARNESS_SHIM', originalAllowHarnessShim)
  await rm(tmpDir, { recursive: true, force: true })
}

export async function seedRunRoots(agentId: string, projectId: string): Promise<void> {
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await mkdir(join(projectsRoot, projectId), { recursive: true })
  await writeFile(join(agentsRoot, agentId, 'agent-profile.toml'), 'version = 3\n', 'utf8')
  // Write a marker so the project dir is recognized by the walk-up resolver.
  await writeFile(join(projectsRoot, projectId, 'asp-targets.toml'), 'schema = 1\n', 'utf8')
}

export async function createRawTmuxSession(
  socketPath: string,
  sessionName: string,
  trackAsLease = false
): Promise<void> {
  if (trackAsLease) {
    leaseSockets.push(socketPath)
  }
  const { exited } = Bun.spawn(
    ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await exited).toBe(0)
}

export async function rawTmuxSessionAlive(
  socketPath: string,
  sessionName: string
): Promise<boolean> {
  const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'has-session', '-t', `=${sessionName}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await exited) === 0
}

export function seedBrokerClaimingRuntime(
  driver: string,
  runtimeId: string,
  socketPath: string
): void {
  const db = openHrcDatabase(dbPath)
  const now = new Date().toISOString()
  const hostSessionId = `hs_${runtimeId}`
  const scopeRef = testProjectScope(`tmux-kill-claimed-${runtimeId}`)
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      tmuxJson: {
        socketPath,
        sessionName: `hrc-${driver}-${runtimeId}`,
        windowName: 'main',
        brokerDriver: driver,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
  } finally {
    db.close()
  }
}

export async function createTmuxAttachShim(): Promise<string> {
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

export async function installFakeCodex(
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
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const logPath = ${JSON.stringify(logPath)}
const resumePath = ${JSON.stringify(resumePath)}
const execDelayMs = ${JSON.stringify(behavior.execDelayMs ?? 0)}
const execThreadId = ${JSON.stringify(behavior.execThreadId ?? 'thread-123')}
const interactiveBanner = ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
const interactiveDelayMs = ${JSON.stringify(behavior.interactiveDelayMs ?? 1_500)}
const resumeDelayMs = ${JSON.stringify(behavior.resumeDelayMs ?? 0)}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function stripRootFlags(input) {
  const args = [...input]
  while (args.length > 0) {
    const flag = args[0]
    if (flag === '--enable' || flag === '--disable' || flag === '--model' || flag === '-m' || flag === '-c') {
      args.splice(0, 2)
      continue
    }
    break
  }
  return args
}

export function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

export function emitTurn() {
  const turnId = 'turn-123'
  const item = { id: 'msg-123', type: 'agentMessage', text: 'ok' }
  write({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId } } })
  write({ jsonrpc: '2.0', method: 'item/completed', params: { turnId, item } })
  write({
    jsonrpc: '2.0',
    method: 'thread/tokenUsage/updated',
    params: { threadId: execThreadId, turnId, tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } } },
  })
  write({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { threadId: execThreadId, turn: { id: turnId, status: 'completed', items: [item] } },
  })
}

if (args[0] === '--version') {
  console.log('codex-cli 0.124.0')
  process.exit(0)
}

const commandArgs = stripRootFlags(args)
const cmd = commandArgs[0] ?? ''

if (cmd === 'app-server' && commandArgs[1] === '--help') {
  console.log('Usage: codex app-server')
  process.exit(0)
}

if (cmd === 'app-server') {
  appendFileSync(logPath, 'app-server:' + commandArgs.join(' ') + '\\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const message = JSON.parse(line)
    if (!('id' in message)) return
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: execThreadId } } })
      return
    }
    if (message.method === 'thread/resume') {
      const threadId = message.params?.threadId ?? execThreadId
      appendFileSync(resumePath, 'resume:' + threadId + '\\n')
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId } } })
      return
    }
    if (message.method === 'turn/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-123' } } })
      setTimeout(emitTurn, execDelayMs)
      return
    }
  })
  rl.on('close', () => process.exit(0))
  setTimeout(() => {}, 60_000)
} else if (cmd === 'exec') {
  appendFileSync(logPath, 'exec\\n')
  await sleep(execDelayMs)
  write({ type: 'thread.started', thread_id: execThreadId })
} else if (cmd === 'resume') {
  const resumeArgs = stripRootFlags(commandArgs.slice(1))
  appendFileSync(resumePath, 'resume:' + (resumeArgs[0] ?? '') + '\\n')
  await sleep(resumeDelayMs)
} else {
  appendFileSync(logPath, 'interactive:' + args.join(' ') + '\\n')
  console.log(interactiveBanner)
  await sleep(interactiveDelayMs)
}
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  return { binDir, logPath, resumePath }
}

export async function installFakeClaude(
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

export async function writeCodexAgentProfile(agentId: string): Promise<void> {
  await writeFile(
    join(agentsRoot, agentId, 'agent-profile.toml'),
    'version = 3\n\n[identity]\ndisplay = "Codex Agent"\nrole = "worker"\n\n[provisioning]\nharness = "codex"\n',
    'utf8'
  )
}

export async function readServerLog(): Promise<string> {
  return await readFile(join(runtimeRoot, 'server.log'), 'utf8')
}

export async function waitForServerStatus(
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

export async function waitForServerLog(attempts = 40): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(join(runtimeRoot, 'server.log'))) {
      return await readServerLog()
    }
    await Bun.sleep(100)
  }

  return await readServerLog()
}

export async function waitForContinuation(
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
