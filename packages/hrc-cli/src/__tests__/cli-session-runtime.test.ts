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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'

import {
  BROKER_LIFECYCLE_TEST_TIMEOUT_MS,
  cliEnv,
  dbPath,
  runCli,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  testProjectScope,
} from './fixtures/cli.fixture'
import { seedLiveTmuxRuntime } from './fixtures/seed-live-tmux-runtime'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('session rotate', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
  })

  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(
      ['session', 'resolve', '--scope', scope, '--lane', 'default', '--create'],
      cliEnv()
    )
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  it('session rotate exits 2 when hostSessionId is missing', async () => {
    const result = await runCli(['session', 'rotate'], cliEnv())
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toLowerCase()).toContain('missing required argument')
  })

  it(
    'session rotate outputs rotation JSON for a known hostSessionId',
    async () => {
      const hostSessionId = await resolveHostSessionId(testProjectScope('clearctxcli'))

      const result = await runCli(['session', 'rotate', hostSessionId], cliEnv())

      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(body.hostSessionId).toBeString()
      expect(body.hostSessionId).not.toBe(hostSessionId)
      expect(body.priorHostSessionId).toBe(hostSessionId)
      expect(body.generation).toBeGreaterThan(1)
    },
    BROKER_LIFECYCLE_TEST_TIMEOUT_MS
  )
})

// ===========================================================================
// 4. runtime capture / attach / runtime interrupt / runtime terminate
// ===========================================================================
describe('runtime lifecycle commands', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
  })

  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(
      ['session', 'resolve', '--scope', scope, '--lane', 'default', '--create'],
      cliEnv()
    )
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  // T-08596: births refuse on nodes without an aspd endpoint, so action
  // tests seed a live tmux runtime row (real pane) instead of ensuring one.
  const seeded: Array<{ cleanup: () => Promise<void> }> = []
  async function seedRuntime(scope: string): Promise<string> {
    const hostSessionId = await resolveHostSessionId(scope)
    const seededRuntime = await seedLiveTmuxRuntime(dbPath, hostSessionId)
    seeded.push(seededRuntime)
    return seededRuntime.runtimeId
  }
  afterEach(async () => {
    await Promise.all(seeded.splice(0).map((entry) => entry.cleanup()))
  })

  it('runtime capture prints pane text for a runtimeId', async () => {
    const runtimeId = await seedRuntime(testProjectScope('runtime-capturecli'))
    const result = await runCli(['runtime', 'capture', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    expect(typeof result.stdout).toBe('string')
  })

  it('attach prints descriptor JSON for a runtimeId', async () => {
    const runtimeId = await seedRuntime(testProjectScope('attachcli'))
    const result = await runCli(['attach', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.transport).toBe('tmux')
    expect(body.argv).toContain('attach-session')
  })

  it('runtime interrupt prints JSON for a runtimeId', async () => {
    const runtimeId = await seedRuntime(testProjectScope('interruptcli'))
    const result = await runCli(['runtime', 'interrupt', runtimeId], cliEnv())

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.ok).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it(
    'runtime terminate prints JSON for a runtimeId',
    async () => {
      const runtimeId = await seedRuntime(testProjectScope('terminatecli'))
      const result = await runCli(['runtime', 'terminate', runtimeId], cliEnv())

      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(true)
      expect(body.runtimeId).toBe(runtimeId)
    },
    BROKER_LIFECYCLE_TEST_TIMEOUT_MS
  )
})

// ===========================================================================
// 5. hrc run convenience command (T-01019)
// ===========================================================================
