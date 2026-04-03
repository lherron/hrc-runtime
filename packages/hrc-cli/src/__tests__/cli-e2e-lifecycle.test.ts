/**
 * RED/GREEN tests for CLI E2E lifecycle chains (T-01006 / Phase 6)
 *
 * These tests validate connected command and harness session flows through
 * the CLI — not isolated subcommand dispatch, but the full lifecycle:
 *
 *   P6-CLI-1. Command session lifecycle:
 *             ensure(command) → literal-input → capture → terminate
 *   P6-CLI-2. Harness session lifecycle:
 *             ensure(harness) → turn → verify dispatch output
 *   P6-CLI-3. Status command reports Phase 6 capabilities
 *
 * Test strategy:
 *   - Spins up a real hrc-server on a temp socket
 *   - Runs CLI as a subprocess for each step
 *   - Each describe block runs the full chain sequentially
 *   - Validates that state transitions are observable across CLI calls
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

function cliEnv(): Record<string, string> {
  return {
    HRC_RUNTIME_DIR: runtimeRoot,
    HRC_STATE_DIR: stateRoot,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-cli-e2e-'))
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
    // fine
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ===========================================================================
// P6-CLI-1. Command session E2E lifecycle
// ===========================================================================
describe('CLI command session E2E: ensure → literal-input → capture → terminate', () => {
  it('runs the full command session lifecycle through CLI', async () => {
    server = await createHrcServer(serverOpts())

    // Step 1: ensure a command session (cat will hold stdin open)
    const ensureSpec = JSON.stringify({
      kind: 'command',
      command: { launchMode: 'exec', argv: ['/bin/cat'] },
    })
    const ensureResult = await runCli(
      ['app-session', 'ensure', '--app', 'lifecycle', '--key', 'cmd-e2e', '--spec', ensureSpec],
      cliEnv()
    )
    expect(ensureResult.exitCode).toBe(0)
    const ensureBody = JSON.parse(ensureResult.stdout.trim())
    expect(ensureBody.session.kind).toBe('command')
    expect(ensureBody.session.appId).toBe('lifecycle')
    expect(ensureBody.session.appSessionKey).toBe('cmd-e2e')
    expect(ensureBody.runtimeId).toBeDefined()

    // Give the PTY a moment to initialize
    await Bun.sleep(300)

    // Step 2: send literal input
    const inputResult = await runCli(
      [
        'app-session',
        'literal-input',
        '--app',
        'lifecycle',
        '--key',
        'cmd-e2e',
        '--text',
        'LIFECYCLE_MARKER',
        '--enter',
      ],
      cliEnv()
    )
    expect(inputResult.exitCode).toBe(0)
    const inputBody = JSON.parse(inputResult.stdout.trim())
    expect(inputBody.delivered).toBe(true)

    // Give cat a moment to echo
    await Bun.sleep(300)

    // Step 3: capture output — should contain our marker
    const captureResult = await runCli(
      ['app-session', 'capture', '--app', 'lifecycle', '--key', 'cmd-e2e'],
      cliEnv()
    )
    expect(captureResult.exitCode).toBe(0)
    // The captured text should contain our marker that was echoed by cat
    expect(captureResult.stdout).toContain('LIFECYCLE_MARKER')

    // Step 4: terminate
    const termResult = await runCli(
      ['app-session', 'terminate', '--app', 'lifecycle', '--key', 'cmd-e2e'],
      cliEnv()
    )
    expect(termResult.exitCode).toBe(0)
    const termBody = JSON.parse(termResult.stdout.trim())
    expect(termBody.ok).toBe(true)

    // Step 5: verify the session is gone — get should still return but
    // the runtime should be terminated
    const getResult = await runCli(
      ['app-session', 'get', '--app', 'lifecycle', '--key', 'cmd-e2e'],
      cliEnv()
    )
    expect(getResult.exitCode).toBe(0)
  })
})

// ===========================================================================
// P6-CLI-2. Harness session E2E lifecycle
// ===========================================================================
describe('CLI harness session E2E: ensure → turn dispatch', () => {
  it('ensures a harness session and dispatches a turn through CLI', async () => {
    server = await createHrcServer(serverOpts())

    // Step 1: ensure a harness session (non-interactive to avoid tmux)
    const ensureSpec = JSON.stringify({
      kind: 'harness',
      runtimeIntent: {
        placement: 'workspace',
        harness: { provider: 'anthropic', interactive: false },
      },
    })
    const ensureResult = await runCli(
      ['app-session', 'ensure', '--app', 'lifecycle', '--key', 'harness-e2e', '--spec', ensureSpec],
      cliEnv()
    )
    expect(ensureResult.exitCode).toBe(0)
    const ensureBody = JSON.parse(ensureResult.stdout.trim())
    expect(ensureBody.session.kind).toBe('harness')
    expect(ensureBody.session.appId).toBe('lifecycle')

    // Step 2: dispatch a turn
    const turnResult = await runCli(
      [
        'app-session',
        'turn',
        '--app',
        'lifecycle',
        '--key',
        'harness-e2e',
        '--text',
        'List the files',
      ],
      cliEnv()
    )
    expect(turnResult.exitCode).toBe(0)
    const turnBody = JSON.parse(turnResult.stdout.trim())
    expect(turnBody.runId).toBeDefined()
    expect(turnBody.hostSessionId).toBeDefined()
    expect(turnBody.runtimeId).toBeDefined()
  })
})

// ===========================================================================
// P6-CLI-3. Status command reports capabilities
// ===========================================================================
describe('CLI status command — Phase 6 capabilities', () => {
  it('reports appOwnedSessions and appHarnessSessions capabilities', async () => {
    server = await createHrcServer(serverOpts())

    const result = await runCli(['status', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)

    const status = JSON.parse(result.stdout.trim())
    expect(status.capabilities).toBeDefined()
    expect(status.capabilities.platform.appOwnedSessions).toBe(true)
    expect(status.capabilities.platform.appHarnessSessions).toBe(true)
  })
})
