/**
 * RED/GREEN tests for hrc-cli app-session subcommand group (T-01004 / Phase 4)
 *
 * Tests the CLI `app-session` subcommand dispatch and argument parsing:
 *   - hrc app-session ensure --app <appId> --key <key> --spec <json>
 *   - hrc app-session list --app <appId> [--kind <kind>]
 *   - hrc app-session get --app <appId> --key <key>
 *   - hrc app-session remove --app <appId> --key <key>
 *   - hrc app-session capture --app <appId> --key <key>
 *   - hrc app-session literal-input --app <appId> --key <key> --text <text>
 *   - hrc app-session interrupt --app <appId> --key <key>
 *   - hrc app-session terminate --app <appId> --key <key>
 *
 * Pass conditions for Curly (T-01004):
 *   1.  `hrc app-session` with no subcommand prints usage and exits 1
 *   2.  `hrc app-session ensure` creates a managed session (JSON output)
 *   3.  `hrc app-session list` lists sessions (JSON array output)
 *   4.  `hrc app-session get` gets a session by key (JSON output)
 *   5.  `hrc app-session remove` removes a session (JSON output)
 *   6.  `hrc app-session capture` captures command PTY output
 *   7.  `hrc app-session literal-input` sends text to command PTY
 *   8.  `hrc app-session terminate` terminates command runtime
 *
 * Test strategy:
 *   - Spins up a real hrc-server on a temp socket
 *   - Runs the CLI as a subprocess via `bun run`
 *   - Validates stdout JSON and exit codes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

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

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
    ...extra,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cli-appsess-'))
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

// ---------------------------------------------------------------------------
// 1. app-session subcommand group existence
// ---------------------------------------------------------------------------
describe('hrc app-session — subcommand dispatch', () => {
  it('prints usage and exits 1 when no subcommand given', async () => {
    // RED GATE: `hrc app-session` command group does not exist in CLI dispatch
    const result = await runCli(['app-session'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
    // Should mention available subcommands
    expect(result.stderr.toLowerCase()).toMatch(/subcommand|ensure|list|remove/)
  })

  it('exits 1 for unknown app-session subcommand', async () => {
    const result = await runCli(['app-session', 'nonexistent'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toLowerCase()).toMatch(/unknown/)
  })
})

// ---------------------------------------------------------------------------
// 2. app-session ensure
// ---------------------------------------------------------------------------
describe('hrc app-session ensure', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('creates a managed command session and outputs JSON', async () => {
    const spec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['sleep', '60'] },
    })

    // RED GATE: `hrc app-session ensure` subcommand does not exist
    const result = await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'test-cmd', '--spec', spec],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.session).toBeDefined()
    expect(body.session.appId).toBe('workbench')
    expect(body.session.appSessionKey).toBe('test-cmd')
    expect(body.session.kind).toBe('command')
  })
})

// ---------------------------------------------------------------------------
// 3. app-session list
// ---------------------------------------------------------------------------
describe('hrc app-session list', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('lists managed sessions as JSON array', async () => {
    // RED GATE: `hrc app-session list` subcommand does not exist
    const result = await runCli(['app-session', 'list', '--app', 'workbench'], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. app-session get
// ---------------------------------------------------------------------------
describe('hrc app-session get', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('gets a managed session by key and outputs JSON', async () => {
    // Seed a session first via ensure
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'get-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session get` subcommand does not exist
    const result = await runCli(
      ['app-session', 'get', '--app', 'workbench', '--key', 'get-test'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.appId).toBe('workbench')
    expect(body.appSessionKey).toBe('get-test')
  })
})

// ---------------------------------------------------------------------------
// 5. app-session remove
// ---------------------------------------------------------------------------
describe('hrc app-session remove', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('removes a managed session and outputs JSON', async () => {
    // Seed
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'rm-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session remove` subcommand does not exist
    const result = await runCli(
      ['app-session', 'remove', '--app', 'workbench', '--key', 'rm-test'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.removed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. app-session capture
// ---------------------------------------------------------------------------
describe('hrc app-session capture', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('captures command session PTY output by selector', async () => {
    // Seed a command session
    const spec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['/bin/echo', 'hello'] },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'cap-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session capture` subcommand does not exist
    const result = await runCli(
      ['app-session', 'capture', '--app', 'workbench', '--key', 'cap-test'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    // Capture should output text to stdout
    expect(result.stdout.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 7. app-session literal-input
// ---------------------------------------------------------------------------
describe('hrc app-session literal-input', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('sends literal text to command session PTY', async () => {
    // Seed a command session
    const spec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['/bin/cat'] },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'lit-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session literal-input` subcommand does not exist
    const result = await runCli(
      [
        'app-session',
        'literal-input',
        '--app',
        'workbench',
        '--key',
        'lit-test',
        '--text',
        'hello world',
      ],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.delivered).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. app-session terminate
// ---------------------------------------------------------------------------
describe('hrc app-session terminate', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('terminates a command session runtime by selector', async () => {
    // Seed a command session
    const spec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['sleep', '300'] },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'term-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session terminate` subcommand does not exist
    const result = await runCli(
      ['app-session', 'terminate', '--app', 'workbench', '--key', 'term-test'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
  })
})

// ===========================================================================
// Phase 5 — App-owned harness dispatch, in-flight input, clear-context CLI
// (T-01005)
//
// RED GATE: These 3 CLI subcommands do not exist yet.
// Pass conditions for Curly (T-01005):
//   9.  `hrc app-session turn` dispatches a harness turn via selector
//  10.  `hrc app-session inflight` sends in-flight input via selector (--text flag per spec)
//  11.  `hrc app-session clear-context` rotates context and increments generation
// ===========================================================================

// ---------------------------------------------------------------------------
// 9. app-session turn (Phase 5)
// ---------------------------------------------------------------------------
describe('hrc app-session turn', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('dispatches a harness turn via selector and outputs JSON', async () => {
    // Seed a harness session
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'turn-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session turn` subcommand does not exist
    const result = await runCli(
      ['app-session', 'turn', '--app', 'workbench', '--key', 'turn-test', '--text', 'List files'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.runId).toBeDefined()
    expect(body.hostSessionId).toBeDefined()
    expect(body.runtimeId).toBeDefined()
  })

  it('rejects dispatch on command session with exit code 1', async () => {
    // Seed a command session
    const spec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['sleep', '60'] },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'turn-cmd', '--spec', spec],
      cliEnv()
    )

    const result = await runCli(
      ['app-session', 'turn', '--app', 'workbench', '--key', 'turn-cmd', '--text', 'Should fail'],
      cliEnv()
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toLowerCase()).toMatch(/kind|mismatch/)
  })
})

// ---------------------------------------------------------------------------
// 10. app-session inflight (Phase 5)
// ---------------------------------------------------------------------------
describe('hrc app-session inflight', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('sends in-flight input to an active harness run and outputs JSON', async () => {
    // Seed a harness session
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'ifl-test', '--spec', spec],
      cliEnv()
    )

    // First dispatch a turn to get an active run
    const turnResult = await runCli(
      ['app-session', 'turn', '--app', 'workbench', '--key', 'ifl-test', '--text', 'Start task'],
      cliEnv()
    )
    const turnBody = JSON.parse(turnResult.stdout.trim())

    // RED GATE: `hrc app-session inflight` subcommand must use --text flag per spec
    const result = await runCli(
      [
        'app-session',
        'inflight',
        '--app',
        'workbench',
        '--key',
        'ifl-test',
        '--text',
        'Also do X',
        '--run-id',
        turnBody.runId,
      ],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(typeof body.accepted).toBe('boolean')
    expect(body.runId).toBe(turnBody.runId)
  })
})

// ---------------------------------------------------------------------------
// 11. app-session clear-context (Phase 5)
// ---------------------------------------------------------------------------
describe('hrc app-session clear-context', () => {
  beforeEach(async () => {
    server = await createHrcServer(serverOpts())
  })

  it('rotates context and increments generation', async () => {
    // Seed a harness session
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'cc-test', '--spec', spec],
      cliEnv()
    )

    // RED GATE: `hrc app-session clear-context` subcommand does not exist
    const result = await runCli(
      ['app-session', 'clear-context', '--app', 'workbench', '--key', 'cc-test'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.generation).toBe(2)
    expect(body.hostSessionId).toBeDefined()
    expect(body.priorHostSessionId).toBeDefined()
    expect(body.hostSessionId).not.toBe(body.priorHostSessionId)
  })

  it('supports --relaunch flag', async () => {
    // Seed a harness session
    const spec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    await runCli(
      ['app-session', 'ensure', '--app', 'workbench', '--key', 'cc-relaunch', '--spec', spec],
      cliEnv()
    )

    const result = await runCli(
      ['app-session', 'clear-context', '--app', 'workbench', '--key', 'cc-relaunch', '--relaunch'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.generation).toBe(2)
  })
})
