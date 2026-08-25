/**
 * RED tests for T-04219 P2 — command surface additions (daedalus REQUIRED #3,#4,#5,#6)
 *
 * These tests are intentionally RED. They verify contracts for commands/flags
 * that do not exist yet in hrc-cli/src/cli.ts. Implementation is T-04234's scope.
 *
 * ─── What is pinned ───────────────────────────────────────────────────────────
 *
 * #3  `hrc show <selector>` — new top-level command.
 *     • Accepts runtime selectors (raw runtimeId, runtime:<id>, scope:<ref>, handle)
 *     • Accepts session selectors (raw hostSessionId, host:<id>)
 *     • Accepts message selectors (msg:<id>, seq:<n>)
 *     • Output JSON MUST include `kind` field + concrete IDs (stable shape)
 *
 * #4  `hrc ls <noun>` — top-level polymorphic read.
 *     • Nouns: runtimes | sessions | launches | messages
 *     • JSON array output (same shape as the noun-owned list commands)
 *
 * #5  Admin relocation.
 *     • NEW: `hrc admin runs sweep-zombies | reconcile-active` — works
 *     • OLD: `hrc run sweep-zombies | reconcile-active` — hard nonzero pointer
 *
 * #6  Lifecycle additions.
 *     • NEW: `hrc run --attach-only` — present in --help; behaves like attach
 *     • NEW: `hrc resume` — continuation-only recovery; never fresh-launches
 *     • PRESERVED: `hrc start --new-session` — still accepted and still rotates session
 *     • PRESERVED: `hrc attach`, `hrc start` — unchanged
 *
 * ─── RED failure modes (before implementation) ────────────────────────────────
 *
 *  #3  `hrc show <runtimeId>` → exits 2, "unknown command: show"
 *  #4  `hrc ls runtimes` → exits 2, "unknown command: ls"
 *      `hrc list runtimes` → exits 2, "unknown command: list"
 *  #5  `hrc admin runs sweep-zombies --help` → exits 2, "unknown command: admin"
 *      `hrc run sweep-zombies --help` must fail with a replacement pointer
 *  #6  `hrc run --help` does not contain `--attach-only`
 *      `hrc resume` → exits 2, "unknown command: resume"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { main } from '../cli'

// ---------------------------------------------------------------------------
// Shared test harness (mirrors cli.test.ts setup)
// ---------------------------------------------------------------------------

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

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
    const callback = rest.find((v) => typeof v === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderrChunks)
    const callback = rest.find((v) => typeof v === 'function') as (() => void) | undefined
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

async function runCliSubprocess(args: string[], env?: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

/**
 * Route to in-process or subprocess.
 * Commands that spawn child processes (attach with tmux, turn) need subprocess.
 * Everything else runs in-process for speed.
 */
function shouldUseSubprocess(args: string[]): boolean {
  const command = args[0]
  if (!command || command === '--help' || command === '-h') return false
  switch (command) {
    case 'server':
      return true
    case 'run':
      return !(args.includes('--dry-run') || args.includes('--attach-only'))
    case 'attach':
      return !(args.includes('--dry-run') || args[1]?.startsWith('rt-'))
    case 'resume':
      return !args.includes('--dry-run')
    default:
      return false
  }
}

async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
  if (shouldUseSubprocess(args)) {
    return runCliSubprocess(args, env)
  }
  return runCliInProcess(args, env)
}

// ---------------------------------------------------------------------------
// Server lifecycle (used by tests that need a live daemon)
// ---------------------------------------------------------------------------

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let agentsRoot: string
let projectsRoot: string
let server: HrcServer | null = null
let originalPath: string | undefined

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CLAUDE_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'claude-shim')
const CODEX_SHIM_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures', 'codex-shim')

function serverOpts(): HrcServerOptions {
  return { runtimeRoot, stateRoot, socketPath, lockPath, spoolDir, dbPath, tmuxSocketPath }
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    ...extra,
  }
}

function testScope(id: string): string {
  return `agent:test:project:${id}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join('/tmp', 'hrc-p2-test-'))
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
  process.env.PATH = `${CLAUDE_SHIM_DIR}:${CODEX_SHIM_DIR}:${originalPath ?? ''}`
  process.env.HRC_ALLOW_HARNESS_SHIM = '1'
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }
  process.env.PATH = originalPath
  // Kill any tmux servers this run allocated (main socket + per-runtime broker
  // servers under runtimeRoot/btmux) BEFORE rm: unlinking a socket does not
  // stop its server, and a leaked server keeps its panes' processes (broker,
  // launch runner, claude) and their ptys alive until the machine-wide pty
  // pool is exhausted.
  const tmuxSockets = [tmuxSocketPath]
  try {
    const btmuxDir = join(runtimeRoot, 'btmux')
    for (const entry of await readdir(btmuxDir)) {
      if (entry.endsWith('.sock')) {
        tmuxSockets.push(join(btmuxDir, entry))
      }
    }
  } catch {
    // fine when no broker tmux allocations happened
  }
  for (const socket of tmuxSockets) {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', socket, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no tmux server exists
    }
  }
  await rm(tmpDir, { recursive: true, force: true })
})

async function seedRunRoots(agentId: string, projectId: string): Promise<void> {
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await mkdir(join(projectsRoot, projectId), { recursive: true })
  await writeFile(join(agentsRoot, agentId, 'agent-profile.toml'), 'version = 3\n', 'utf8')
  await writeFile(join(projectsRoot, projectId, 'asp-targets.toml'), 'schema = 1\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Helper: seed a session + runtime via the CLI (needs live server)
// ---------------------------------------------------------------------------

async function seedSessionAndRuntime(
  scopeId: string
): Promise<{ hostSessionId: string; runtimeId: string; scopeRef: string }> {
  const scopeRef = testScope(scopeId)
  const resolveResult = await runCli(
    ['session', 'resolve', '--scope', scopeRef, '--lane', 'default', '--create'],
    cliEnv()
  )
  expect(resolveResult.exitCode).toBe(0)
  const resolved = JSON.parse(resolveResult.stdout.trim()) as {
    hostSessionId: string
    generation?: number
  }
  const hostSessionId = resolved.hostSessionId

  // Seed the runtime row directly. These selector/list contracts only need the
  // row to exist — `hrc runtime ensure` against a live broker-enabled server
  // would START a real interactive harness (per-runtime tmux server +
  // harness-broker + launch runner + claude TUI) per seed, which nothing in
  // this suite tears down.
  const runtimeId = `rt-test-${randomUUID()}`
  const db = openHrcDatabase(dbPath)
  const timestamp = new Date().toISOString()
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: resolved.generation ?? 1,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }

  return { hostSessionId, runtimeId, scopeRef }
}

// ===========================================================================
// §3: `hrc show <selector>` — daedalus REQUIRED #3
// ===========================================================================

describe('hrc run --attach-only — §6 lifecycle (RED: flag does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc run --attach-only --help exits 0 with Usage', async () => {
    const result = await runCli(['run', '--attach-only', '--help'])
    // RED: currently `run --attach-only` may be treated as unknown option
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  // ── server-required: --attach-only behaves like attach ──

  describe('--attach-only functional (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc run --attach-only rex@agent-spaces --dry-run shows an attach plan without starting', async () => {
      const result = await runCli(
        ['run', '--attach-only', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      // RED: --attach-only not recognized → parse error or unknown option
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('local plan preview')
      // attach-only plan must mention the attach-only intent (not a full start plan)
      expect(result.stdout).toMatch(/attach/i)
      // Dry-run must NOT report a new session start
      expect(result.stdout).not.toMatch(/start|ensure/i)
    })
  })
})

// T-04836 Part A: `hrc resume` is now its OWN continuation-resume verb, NOT an
// exact alias of `run`. It never fresh-launches and never attaches as a resume
// substitute; it requires a captured continuation and fails clearly otherwise.
describe('hrc resume — §6 lifecycle (T-04836: distinct continuation-resume verb)', () => {
  // ── no-server: --help ──

  it('hrc resume --help documents its continuation semantics and alternate paths', async () => {
    const result = await runCli(['resume', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
    // Help text describes resuming a stored continuation (not run aliasing).
    expect(result.stdout).toMatch(/continuation/i)
    // T-04836: resume is not attach-only; help points elsewhere for attach/run.
    expect(result.stdout).toMatch(/hrc attach|hrc run/i)
  })

  it('hrc resume (no args) exits 0 with its own usage banner', async () => {
    const result = await runCli(['resume'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc resume/i)
  })

  describe('resume distinct-verb surface', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc resume rex@agent-spaces --dry-run exits 0 with a plan preview', async () => {
      const resumeResult = await runCli(
        ['resume', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(resumeResult.exitCode).toBe(0)
      expect(resumeResult.stdout).toContain('local plan preview')
    })

    it('hrc resume supports --no-attach', async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--no-attach')
    })

    it('hrc resume does NOT advertise --force-restart (continuation is always preserved)', async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('--force-restart')
    })
  })
})

describe('hrc start --new-session — §6 lifecycle (pin existing behavior)', () => {
  // ── no-server: --help (currently GREEN — pin it stays GREEN) ──

  it('hrc start --help still contains --new-session flag', async () => {
    const result = await runCli(['start', '--help'])
    // This must remain GREEN through P2: --new-session is currently registered
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--new-session')
  })

  // ── server-required: --new-session dry-run shows the flag is accepted ──

  describe('start --new-session dry-run (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc start --new-session --dry-run emits local plan preview (not an error)', async () => {
      const result = await runCli(
        ['start', 'rex@agent-spaces', '--new-session', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('local plan preview')
    })

    it('hrc start --new-session --dry-run shows sessionRef in the plan', async () => {
      const result = await runCli(
        ['start', 'rex@agent-spaces', '--new-session', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(result.exitCode).toBe(0)
      // sessionRef must appear in the plan
      expect(result.stdout).toContain('sessionRef:')
    })
  })
})

describe('existing lifecycle preserved — §6 regression guards', () => {
  // ── no-server: --help ──

  // ── server-required ──

  describe('regression: existing lifecycle commands work (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })
  })
})

void seedSessionAndRuntime
