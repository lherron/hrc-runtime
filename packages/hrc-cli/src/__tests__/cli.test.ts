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
 *   3. `hrc turn send` and `hrc clear-context` validate args and dispatch
 *      through hrc-sdk
 *      to stderr and exit 1
 *   4. `hrc server` starts the daemon (tested via createHrcServer delegation)
 *   5. `hrc session resolve --scope <scopeRef>` outputs JSON to stdout
 *   6. `hrc session list` outputs JSON array to stdout
 *   7. `hrc session get <hostSessionId>` outputs JSON to stdout
 *   8. `hrc watch` outputs NDJSON events to stdout
 *   9. All structured output is valid JSON on stdout; all errors on stderr
 *  10. Exit code 0 on success, 1 on error
 *
 * Reference: T-00946 (parent), T-00957 (CLI implementation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run the CLI as a subprocess and capture output.
 * Uses `bun run` to execute the TypeScript CLI entry point directly.
 */
async function runCli(args: string[], env?: Record<string, string>): Promise<CliResult> {
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
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
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
  await rm(tmpDir, { recursive: true, force: true })
})

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
// 3. turn send / clear-context
// ===========================================================================
describe('turn send / clear-context', () => {
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
    const hostSessionId = await resolveHostSessionId('project:turncli')
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

  it('clear-context exits 1 when hostSessionId is missing', async () => {
    const result = await runCli(['clear-context'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toLowerCase()).toContain('missing required argument')
  })

  it('clear-context outputs rotation JSON for a known hostSessionId', async () => {
    const hostSessionId = await resolveHostSessionId('project:clearctxcli')
    const ensureResult = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)

    const result = await runCli(['clear-context', hostSessionId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBeString()
    expect(body.hostSessionId).not.toBe(hostSessionId)
    expect(body.priorHostSessionId).toBe(hostSessionId)
    expect(body.generation).toBeGreaterThan(1)
  })
})

// ===========================================================================
// 4. hrc runtime ensure / capture / attach / interrupt / terminate
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

  async function seedAttachableRuntime(scope: string): Promise<string> {
    const hostSessionId = await resolveHostSessionId(scope)
    const session = JSON.parse(
      (await runCli(['session', 'get', hostSessionId], cliEnv())).stdout.trim()
    ) as { generation: number; scopeRef: string; laneRef: string }
    const runtimeId = `rt-test-${randomUUID()}`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    db.runtimes.create({
      runtimeId,
      hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: `hrc-${hostSessionId.slice(0, 12)}`,
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
    return runtimeId
  }

  it('runtime ensure outputs runtime JSON for a known hostSessionId', async () => {
    const hostSessionId = await resolveHostSessionId('project:runtimecli')
    const result = await runCli(['runtime', 'ensure', hostSessionId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBe(hostSessionId)
    expect(body.transport).toBe('tmux')
    expect(body.status).toBe('ready')
    expect(body.runtimeId).toBeString()
  })

  it('capture prints pane text for a runtimeId', async () => {
    const runtimeId = await ensureRuntime('project:capturecli')
    const result = await runCli(['capture', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(typeof result.stdout).toBe('string')
  })

  it('attach prints descriptor JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime('project:attachcli')
    const result = await runCli(['attach', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.transport).toBe('tmux')
    expect(body.argv).toContain('attach-session')
  })

  it('attach auto-binds Ghostty when GHOSTTY_SURFACE_UUID is present', async () => {
    const runtimeId = await seedAttachableRuntime('project:attach-ghostty-cli')
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

  it('interrupt prints JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime('project:interruptcli')
    const result = await runCli(['interrupt', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('terminate prints JSON for a runtimeId', async () => {
    const runtimeId = await ensureRuntime('project:terminatecli')
    const result = await runCli(['terminate', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('surface bind/list/unbind commands manage runtime bindings', async () => {
    const runtimeId = await seedAttachableRuntime('project:surfacecli')

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
// 5. hrc session resolve — JSON output
// ===========================================================================
describe('hrc session resolve', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs JSON with hostSessionId, generation, created to stdout', async () => {
    const result = await runCli(
      ['session', 'resolve', '--scope', 'project:clitest', '--lane', 'default'],
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
    const result = await runCli(['session', 'resolve', '--scope', 'project:nolane'], cliEnv())

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
      ['session', 'resolve', '--scope', 'project:listcli', '--lane', 'default'],
      cliEnv()
    )

    const result = await runCli(['session', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].scopeRef).toBe('project:listcli')
  })

  it('supports --scope filter', async () => {
    await runCli(['session', 'resolve', '--scope', 'project:filterA'], cliEnv())
    await runCli(['session', 'resolve', '--scope', 'project:filterB'], cliEnv())

    const result = await runCli(['session', 'list', '--scope', 'project:filterA'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].scopeRef).toBe('project:filterA')
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
      ['session', 'resolve', '--scope', 'project:getcli'],
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
// 8. hrc watch — NDJSON output
// ===========================================================================
describe('hrc watch', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('outputs NDJSON events to stdout (non-follow mode)', async () => {
    // Create events first
    await runCli(['session', 'resolve', '--scope', 'project:watchcli'], cliEnv())

    // Watch without follow — should return events and exit
    const result = await runCli(['watch'], cliEnv())
    expect(result.exitCode).toBe(0)

    const lines = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    // Each line must be valid JSON
    for (const line of lines) {
      const event = JSON.parse(line)
      expect(typeof event.seq).toBe('number')
      expect(typeof event.eventKind).toBe('string')
    }
  })

  it('supports --from-seq flag', async () => {
    // Create multiple events
    await runCli(['session', 'resolve', '--scope', 'project:fromseqcli1'], cliEnv())
    await runCli(['session', 'resolve', '--scope', 'project:fromseqcli2'], cliEnv())

    // Get all events
    const allResult = await runCli(['watch'], cliEnv())
    const allLines = allResult.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    expect(allLines.length).toBeGreaterThanOrEqual(2)

    const allEvents = allLines.map((l) => JSON.parse(l))
    const fromSeq = allEvents[1].seq

    // Watch from second event's seq
    const result = await runCli(['watch', '--from-seq', String(fromSeq)], cliEnv())
    expect(result.exitCode).toBe(0)

    const filteredLines = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    const filteredEvents = filteredLines.map((l) => JSON.parse(l))
    for (const ev of filteredEvents) {
      expect(ev.seq).toBeGreaterThanOrEqual(fromSeq)
    }
  })
})

// ===========================================================================
// 9. Error output format
// ===========================================================================
describe('error output', () => {
  it('errors go to stderr, not stdout', async () => {
    const result = await runCli(['nonexistent'])
    expect(result.exitCode).toBe(1)
    // stdout should be empty or minimal; error text on stderr
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
