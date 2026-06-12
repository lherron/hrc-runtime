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
 * #4  `hrc ls <noun>` — new top-level command; `list` is a hidden alias.
 *     • Nouns: runtimes | sessions | launches | messages
 *     • JSON array output (same shape as existing runtime/session/launch list)
 *     • Existing `hrc runtime list`, `hrc session list`, `hrc launch list` UNCHANGED
 *
 * #5  Admin relocation.
 *     • NEW: `hrc admin runs sweep-zombies | reconcile-active` — works
 *     • OLD: `hrc run sweep-zombies | reconcile-active` — still performs the action
 *       AND emits deprecation guidance to stderr (exit 0, not a failing pointer)
 *
 * #6  Lifecycle additions.
 *     • NEW: `hrc run --attach-only` — present in --help; behaves like attach
 *     • NEW: `hrc resume` — alias of `run`; --help names start/reuse/attach semantics
 *       and points to `--attach-only` / `run --attach-only`
 *     • PRESERVED: `hrc start --new-session` — still accepted and still rotates session
 *     • PRESERVED: `hrc run --no-attach`, `hrc attach`, `hrc start` — unchanged
 *
 * ─── RED failure modes (before implementation) ────────────────────────────────
 *
 *  #3  `hrc show <runtimeId>` → exits 2, "unknown command: show"
 *  #4  `hrc ls runtimes` → exits 2, "unknown command: ls"
 *      `hrc list runtimes` → exits 2, "unknown command: list"
 *  #5  `hrc admin runs sweep-zombies --help` → exits 2, "unknown command: admin"
 *      `hrc run sweep-zombies --help` output has no deprecation guidance
 *  #6  `hrc run --help` does not contain `--attach-only`
 *      `hrc resume` → exits 2, "unknown command: resume"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

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
      return !(
        args.includes('--no-attach') ||
        args.includes('--dry-run') ||
        args.includes('--attach-only')
      )
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
  await rm(tmpDir, { recursive: true, force: true })
})

async function seedRunRoots(agentId: string, projectId: string): Promise<void> {
  await mkdir(join(agentsRoot, agentId), { recursive: true })
  await mkdir(join(projectsRoot, projectId), { recursive: true })
  await writeFile(
    join(agentsRoot, agentId, 'agent-profile.toml'),
    'schemaVersion = 2\n\n[brain]\nenabled = false\n',
    'utf8'
  )
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
  const resolved = JSON.parse(resolveResult.stdout.trim()) as { hostSessionId: string }
  const hostSessionId = resolved.hostSessionId

  const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
  expect(ensureResult.exitCode).toBe(0)
  const ensured = JSON.parse(ensureResult.stdout.trim()) as { runtimeId: string }
  const runtimeId = ensured.runtimeId

  return { hostSessionId, runtimeId, scopeRef }
}

// ===========================================================================
// §3: `hrc show <selector>` — daedalus REQUIRED #3
// ===========================================================================

describe('hrc show — §3 (RED: command does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc show --help exits 0 with Usage', async () => {
    const result = await runCli(['show', '--help'])
    // RED: exits 2 with "unknown command: show" until implemented
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  it('hrc show --help mentions <selector> argument', async () => {
    const result = await runCli(['show', '--help'])
    // RED: command not registered yet
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/selector/i)
  })

  it('hrc show --help mentions --json flag for stable JSON output', async () => {
    const result = await runCli(['show', '--help'])
    // RED: command not registered yet
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--json')
  })

  // ── server-required: runtime selector forms ──

  describe('runtime selector forms (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
    })

    it('resolves a raw runtimeId and emits JSON with kind=runtime + runtimeId', async () => {
      const { runtimeId } = await seedSessionAndRuntime('show-raw-rt')

      const result = await runCli(['show', runtimeId, '--json'], cliEnv())
      // RED: exits 2 "unknown command: show"
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      // MUST include kind + the concrete identifier
      expect(body.kind).toBe('runtime')
      expect(body.runtimeId).toBe(runtimeId)
    })

    it('resolves runtime: prefix and emits JSON with kind=runtime + runtimeId', async () => {
      const { runtimeId } = await seedSessionAndRuntime('show-pfx-rt')

      const result = await runCli(['show', `runtime:${runtimeId}`, '--json'], cliEnv())
      // RED: exits 2 "unknown command: show"
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      expect(body.kind).toBe('runtime')
      expect(body.runtimeId).toBe(runtimeId)
    })

    it('resolves scope: selector to a runtime and emits kind=runtime', async () => {
      const { runtimeId, scopeRef } = await seedSessionAndRuntime('show-scope-rt')

      const result = await runCli(['show', `scope:${scopeRef}`, '--json'], cliEnv())
      // RED: exits 2 "unknown command: show"
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      expect(body.kind).toBe('runtime')
      expect(body.runtimeId).toBe(runtimeId)
    })

    it('JSON shape is stable: kind + runtimeId always present for runtime selector', async () => {
      const { runtimeId } = await seedSessionAndRuntime('show-shape-rt')

      const result = await runCli(['show', runtimeId, '--json'], cliEnv())
      // RED: command missing
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      // Stable contract: these keys must be present (no optional/undefined for kind/id)
      expect(typeof body.kind).toBe('string')
      expect(typeof body.runtimeId).toBe('string')
    })
  })

  // ── server-required: session selector forms ──

  describe('session selector forms (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
    })

    it('resolves a raw hostSessionId and emits JSON with kind=host-session + hostSessionId', async () => {
      const { hostSessionId } = await seedSessionAndRuntime('show-raw-sess')

      const result = await runCli(['show', hostSessionId, '--json'], cliEnv())
      // RED: command missing; also this selector form needs disambiguation
      // The implementation must infer whether a raw ID is a runtimeId or hostSessionId
      // Daedalus INVARIANT: exact native raw ID match for the command's expected type wins.
      // `hrc show` must default to trying runtime first, then session.
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      // For a hostSessionId not matching any runtimeId, kind must be host-session
      expect(body.kind).toBe('host-session')
      expect(body.hostSessionId).toBe(hostSessionId)
    })

    it('resolves host: prefix and emits JSON with kind=host-session + hostSessionId', async () => {
      const { hostSessionId } = await seedSessionAndRuntime('show-pfx-sess')

      const result = await runCli(['show', `host:${hostSessionId}`, '--json'], cliEnv())
      // RED: command missing
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      expect(body.kind).toBe('host-session')
      expect(body.hostSessionId).toBe(hostSessionId)
    })
  })

  // ── server-required: message selector forms ──

  describe('message selector forms (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
    })

    it('resolves msg: selector and emits JSON with kind=message + messageId', async () => {
      // Seed a message via the SDK
      const { HrcClient } = await import('hrc-sdk')
      const client = new HrcClient(socketPath)
      const created = await client.createMessage({
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${testScope('show-msg')}/lane:default` },
        body: 'hello show test',
        kind: 'dm',
        phase: 'oneway',
      })
      const messageId = created.messageId

      const result = await runCli(['show', `msg:${messageId}`, '--json'], cliEnv())
      // RED: command missing
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      expect(body.kind).toBe('message')
      expect(body.messageId).toBe(messageId)
    })

    it('resolves seq: selector and emits JSON with kind=message + seq', async () => {
      // Seed a message to get a sequence number
      const { HrcClient } = await import('hrc-sdk')
      const client = new HrcClient(socketPath)
      await client.createMessage({
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${testScope('show-seq')}/lane:default` },
        body: 'hello seq test',
        kind: 'dm',
        phase: 'oneway',
      })

      // Use seq:1 — first message in the stream
      const result = await runCli(['show', 'seq:1', '--json'], cliEnv())
      // RED: command missing
      expect(result.exitCode).toBe(0)

      const body = JSON.parse(result.stdout.trim())
      expect(body.kind).toBe('message')
      // seq resolution must include the seq number or the resolved messageId
      expect(typeof body.seq === 'number' || typeof body.messageId === 'string').toBe(true)
    })
  })
})

// ===========================================================================
// §4: `hrc ls <noun>` + `list` alias — daedalus REQUIRED #4
// ===========================================================================

describe('hrc ls — §4 (RED: command does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc ls --help exits 0 with Usage', async () => {
    const result = await runCli(['ls', '--help'])
    // RED: exits 2 "unknown command: ls"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  it('hrc ls --help lists the accepted nouns', async () => {
    const result = await runCli(['ls', '--help'])
    // RED: command not registered
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/runtimes/i)
    expect(output).toMatch(/sessions/i)
    expect(output).toMatch(/launches/i)
    expect(output).toMatch(/messages/i)
  })

  it('hrc list --help exits 0 (list is a hidden alias of ls)', async () => {
    const result = await runCli(['list', '--help'])
    // RED: exits 2 "unknown command: list"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  // ── server-required: functional listing ──

  describe('listing nouns (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
    })

    it('hrc ls runtimes exits 0 and returns a JSON array', async () => {
      const result = await runCli(['ls', 'runtimes'], cliEnv())
      // RED: exits 2 "unknown command: ls"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc ls sessions exits 0 and returns a JSON array', async () => {
      const result = await runCli(['ls', 'sessions'], cliEnv())
      // RED: exits 2 "unknown command: ls"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc ls launches exits 0 and returns a JSON array', async () => {
      const result = await runCli(['ls', 'launches'], cliEnv())
      // RED: exits 2 "unknown command: ls"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc ls messages exits 0 and returns a JSON array', async () => {
      const result = await runCli(['ls', 'messages'], cliEnv())
      // RED: exits 2 "unknown command: ls"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc list runtimes (hidden alias) exits 0 and returns a JSON array', async () => {
      const result = await runCli(['list', 'runtimes'], cliEnv())
      // RED: exits 2 "unknown command: list"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc list sessions (hidden alias) exits 0 and returns a JSON array', async () => {
      const result = await runCli(['list', 'sessions'], cliEnv())
      // RED: exits 2 "unknown command: list"
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(Array.isArray(body)).toBe(true)
    })

    it('hrc ls runtimes returns same data as hrc runtime list', async () => {
      const { runtimeId } = await seedSessionAndRuntime('ls-vs-runtime-list')

      const lsResult = await runCli(['ls', 'runtimes'], cliEnv())
      const legacyResult = await runCli(['runtime', 'list'], cliEnv())

      // RED: ls command missing
      expect(lsResult.exitCode).toBe(0)
      // Legacy must still work (regression guard)
      expect(legacyResult.exitCode).toBe(0)

      const lsBody = JSON.parse(lsResult.stdout.trim()) as Array<{ runtimeId: string }>
      const legacyBody = JSON.parse(legacyResult.stdout.trim()) as Array<{ runtimeId: string }>

      // Both must return the seeded runtime
      expect(lsBody.some((r) => r.runtimeId === runtimeId)).toBe(true)
      expect(legacyBody.some((r) => r.runtimeId === runtimeId)).toBe(true)

      // Shape must match
      const lsItem = lsBody.find((r) => r.runtimeId === runtimeId)
      const legacyItem = legacyBody.find((r) => r.runtimeId === runtimeId)
      expect(Object.keys(lsItem ?? {})).toEqual(Object.keys(legacyItem ?? {}))
    })

    it('hrc ls sessions returns same data as hrc session list', async () => {
      const { hostSessionId } = await seedSessionAndRuntime('ls-vs-session-list')

      const lsResult = await runCli(['ls', 'sessions'], cliEnv())
      const legacyResult = await runCli(['session', 'list'], cliEnv())

      // RED: ls command missing
      expect(lsResult.exitCode).toBe(0)
      expect(legacyResult.exitCode).toBe(0)

      const lsBody = JSON.parse(lsResult.stdout.trim()) as Array<{ hostSessionId: string }>
      const legacyBody = JSON.parse(legacyResult.stdout.trim()) as Array<{ hostSessionId: string }>

      expect(lsBody.some((s) => s.hostSessionId === hostSessionId)).toBe(true)
      expect(legacyBody.some((s) => s.hostSessionId === hostSessionId)).toBe(true)
    })

    // ── Regression: existing noun list commands must be UNCHANGED ──

    it('[regression] hrc runtime list still exits 0 and returns JSON array', async () => {
      const result = await runCli(['runtime', 'list'], cliEnv())
      expect(result.exitCode).toBe(0)
      expect(Array.isArray(JSON.parse(result.stdout.trim()))).toBe(true)
    })

    it('[regression] hrc session list still exits 0 and returns JSON array', async () => {
      const result = await runCli(['session', 'list'], cliEnv())
      expect(result.exitCode).toBe(0)
      expect(Array.isArray(JSON.parse(result.stdout.trim()))).toBe(true)
    })

    it('[regression] hrc launch list still exits 0 and returns JSON array', async () => {
      const result = await runCli(['launch', 'list'], cliEnv())
      expect(result.exitCode).toBe(0)
      expect(Array.isArray(JSON.parse(result.stdout.trim()))).toBe(true)
    })
  })
})

// ===========================================================================
// §5: admin relocation — daedalus REQUIRED #5
// ===========================================================================

describe('hrc admin runs — §5 (RED: command does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc admin --help exits 0 with Usage', async () => {
    const result = await runCli(['admin', '--help'])
    // RED: exits 2 "unknown command: admin"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  it('hrc admin --help lists the runs subgroup', async () => {
    const result = await runCli(['admin', '--help'])
    // RED: command not registered
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/runs/i)
  })

  it('hrc admin runs --help exits 0 with Usage', async () => {
    const result = await runCli(['admin', 'runs', '--help'])
    // RED: exits 2 "unknown command: admin"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  it('hrc admin runs --help lists sweep-zombies and reconcile-active', async () => {
    const result = await runCli(['admin', 'runs', '--help'])
    // RED: command not registered
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sweep-zombies')
    expect(result.stdout).toContain('reconcile-active')
  })

  it('hrc admin runs sweep-zombies --help exits 0 and includes --older-than and --dry-run', async () => {
    const result = await runCli(['admin', 'runs', 'sweep-zombies', '--help'])
    // RED: exits 2 "unknown command: admin"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
    expect(result.stdout).toContain('--older-than')
    expect(result.stdout).toContain('--dry-run')
  })

  it('hrc admin runs reconcile-active --help exits 0 and includes --older-than and --dry-run', async () => {
    const result = await runCli(['admin', 'runs', 'reconcile-active', '--help'])
    // RED: exits 2 "unknown command: admin"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
    expect(result.stdout).toContain('--older-than')
    expect(result.stdout).toContain('--dry-run')
  })

  // ── Deprecation guidance in OLD `hrc run sweep-zombies` help ──

  it('hrc run sweep-zombies --help mentions the replacement admin path', async () => {
    const result = await runCli(['run', 'sweep-zombies', '--help'])
    // Currently exits 0 but does NOT mention "admin runs" in help text.
    // RED: the description/help must include deprecation guidance pointing to
    // `hrc admin runs sweep-zombies`.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/admin runs sweep-zombies|deprecated/i)
  })

  it('hrc run reconcile-active --help mentions the replacement admin path', async () => {
    const result = await runCli(['run', 'reconcile-active', '--help'])
    // RED: help must include deprecation guidance pointing to
    // `hrc admin runs reconcile-active`.
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/admin runs reconcile-active|deprecated/i)
  })

  // ── server-required: new admin path works ──

  describe('admin runs functional (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
    })

    it('hrc admin runs sweep-zombies --dry-run exits 0 and produces output', async () => {
      const result = await runCli(['admin', 'runs', 'sweep-zombies', '--dry-run'], cliEnv())
      // RED: command not registered → exits 2
      expect(result.exitCode).toBe(0)
      // Output should describe the sweep (even if empty — but "summary" line present)
      expect(result.stdout.length).toBeGreaterThan(0)
    })

    it('hrc admin runs reconcile-active --dry-run exits 0 and produces output', async () => {
      const result = await runCli(['admin', 'runs', 'reconcile-active', '--dry-run'], cliEnv())
      // RED: command not registered → exits 2
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(0)
    })

    // ── Deprecation guidance in OLD `hrc run sweep-zombies` on execution ──

    it('hrc run sweep-zombies --dry-run still exits 0 (backward compat)', async () => {
      const result = await runCli(['run', 'sweep-zombies', '--dry-run'], cliEnv())
      // OLD path must still perform the action (no failing pointer)
      expect(result.exitCode).toBe(0)
    })

    it('hrc run sweep-zombies --dry-run emits deprecation guidance to stderr', async () => {
      const result = await runCli(['run', 'sweep-zombies', '--dry-run'], cliEnv())
      // RED: currently stderr is empty; after P2 it must contain the replacement path
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(/admin runs sweep-zombies|deprecated/i)
    })

    it('hrc run reconcile-active --dry-run still exits 0 (backward compat)', async () => {
      const result = await runCli(['run', 'reconcile-active', '--dry-run'], cliEnv())
      expect(result.exitCode).toBe(0)
    })

    it('hrc run reconcile-active --dry-run emits deprecation guidance to stderr', async () => {
      const result = await runCli(['run', 'reconcile-active', '--dry-run'], cliEnv())
      // RED: stderr currently empty; must emit replacement path after P2
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(/admin runs reconcile-active|deprecated/i)
    })

    it('hrc run sweep-zombies --json --dry-run output is identical to admin runs equivalent', async () => {
      // Both old and new paths must produce the same action result (deprecation is only on stderr)
      const oldResult = await runCli(['run', 'sweep-zombies', '--json', '--dry-run'], cliEnv())
      const newResult = await runCli(
        ['admin', 'runs', 'sweep-zombies', '--json', '--dry-run'],
        cliEnv()
      )
      // RED: new command doesn't exist yet
      expect(oldResult.exitCode).toBe(0)
      expect(newResult.exitCode).toBe(0)
      // stdout should contain the same JSON result (both hit the same API)
      expect(oldResult.stdout.trim()).toBe(newResult.stdout.trim())
    })
  })
})

// ===========================================================================
// §6: lifecycle additions — daedalus REQUIRED #6
// ===========================================================================

describe('hrc run --attach-only — §6 lifecycle (RED: flag does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc run --help includes --attach-only flag', async () => {
    const result = await runCli(['run', '--help'])
    // RED: --attach-only is not yet registered; currently absent from help
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--attach-only')
  })

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

    it('hrc run --attach-only rex@agent-spaces --dry-run exits 0 and shows attach plan', async () => {
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
    })

    it('hrc run --attach-only plan does NOT start a new session', async () => {
      const result = await runCli(
        ['run', '--attach-only', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      // RED: flag not registered
      expect(result.exitCode).toBe(0)
      // Dry-run must NOT report a new session start
      expect(result.stdout).not.toMatch(/start|ensure/i)
    })
  })
})

describe('hrc resume — §6 lifecycle (RED: command does not exist yet)', () => {
  // ── no-server: --help ──

  it('hrc resume --help exits 0 with Usage', async () => {
    const result = await runCli(['resume', '--help'])
    // RED: exits 2 "unknown command: resume"
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/i)
  })

  it('hrc resume --help states start/reuse/attach semantics', async () => {
    const result = await runCli(['resume', '--help'])
    // RED: command not registered
    expect(result.exitCode).toBe(0)
    // Help text must state exact semantics: "may start, reuse, or attach"
    // (daedalus D4: help text must state exact semantics, not promise attach-only)
    expect(result.stdout).toMatch(/start|reuse|attach/i)
  })

  it('hrc resume --help points to --attach-only or run --attach-only', async () => {
    const result = await runCli(['resume', '--help'])
    // RED: command not registered
    expect(result.exitCode).toBe(0)
    // Daedalus D4: help must point to `attach` / `run --attach-only`
    expect(result.stdout).toMatch(/--attach-only|hrc attach/i)
  })

  it('hrc resume (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['resume'])
    // RED: exits 2 "unknown command: resume"
    // When implemented, resume with no args should print the same usage as `hrc run`
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc resume/i)
  })

  // ── server-required: resume is an exact alias of run ──

  describe('resume as exact alias of run (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc resume rex@agent-spaces --dry-run exits 0 (same as run --dry-run)', async () => {
      const runResult = await runCli(
        ['run', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      const resumeResult = await runCli(
        ['resume', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      // RED: resume command not registered
      expect(runResult.exitCode).toBe(0)
      expect(resumeResult.exitCode).toBe(0)
      // Both produce plan preview output
      expect(resumeResult.stdout).toContain('local plan preview')
    })

    it('hrc resume supports --no-attach (same flags as run)', async () => {
      const result = await runCli(['resume', '--help'])
      // RED: command not registered
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--no-attach')
    })

    it('hrc resume supports --force-restart (same flags as run)', async () => {
      const result = await runCli(['resume', '--help'])
      // RED: command not registered
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--force-restart')
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

  it('hrc start --help still contains --force-restart flag', async () => {
    const result = await runCli(['start', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--force-restart')
  })

  // ── server-required: --new-session dry-run shows the flag is accepted ──

  describe('start --new-session dry-run (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc start rex@agent-spaces --new-session --dry-run exits 0', async () => {
      const result = await runCli(
        ['start', 'rex@agent-spaces', '--new-session', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      // Must remain GREEN: --new-session is already accepted; pin it doesn't break under P2
      expect(result.exitCode).toBe(0)
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

  it('hrc run --help still contains --no-attach (unchanged)', async () => {
    const result = await runCli(['run', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--no-attach')
  })

  it('hrc run --help still contains --force-restart (unchanged)', async () => {
    const result = await runCli(['run', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--force-restart')
  })

  it('hrc attach --help still exits 0 with --dry-run flag (unchanged)', async () => {
    const result = await runCli(['attach', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--dry-run')
  })

  // ── server-required ──

  describe('regression: existing lifecycle commands work (needs live server)', () => {
    beforeEach(async () => {
      server = await createHrcServer(serverOpts())
      await seedRunRoots('rex', 'agent-spaces')
    })

    it('hrc start rex@agent-spaces --dry-run still exits 0 (unchanged)', async () => {
      const result = await runCli(
        ['start', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('local plan preview')
    })

    it('hrc run --no-attach rex@agent-spaces --dry-run still exits 0 (unchanged)', async () => {
      const result = await runCli(
        ['run', 'rex@agent-spaces', '--no-attach', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('local plan preview')
    })

    it('hrc attach rex@agent-spaces --dry-run still exits 0 (unchanged)', async () => {
      const result = await runCli(
        ['attach', 'rex@agent-spaces', '--dry-run'],
        cliEnv({
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        })
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('local plan preview')
    })
  })
})
