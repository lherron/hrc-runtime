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

describe('session retitle', () => {
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

  it('requires exactly one title action', async () => {
    const missing = await runCli(['session', 'retitle', 'hsid-missing'], cliEnv())
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('exactly one')

    const conflicting = await runCli(
      ['session', 'retitle', 'hsid-missing', '--title', 'Title', '--regenerate'],
      cliEnv()
    )
    expect(conflicting.exitCode).toBe(2)
    expect(conflicting.stderr).toContain('mutually exclusive')
  })

  it('sets api title metadata, preserves list outputs, and clears it for regeneration', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('retitlecli'))
    const set = await runCli(
      ['session', 'retitle', hostSessionId, '--title', 'Implement title routes'],
      cliEnv()
    )
    expect(set.exitCode).toBe(0)
    expect(JSON.parse(set.stdout.trim())).toMatchObject({
      metadata: { title: 'Implement title routes' },
      metadataSources: { title: { source: 'api' } },
    })

    expect(set.stderr).toContain('deprecated')

    const jsonList = await runCli(['session', 'list', '--json'], cliEnv())
    expect(jsonList.exitCode).toBe(0)
    const sessions = JSON.parse(jsonList.stdout.trim()) as Array<{
      hostSessionId: string
      title?: string
    }>
    expect(sessions.find((session) => session.hostSessionId === hostSessionId)?.title).toBe(
      'Implement title routes'
    )

    const porcelain = await runCli(['session', 'list', '--porcelain'], cliEnv())
    expect(porcelain.exitCode).toBe(0)
    expect(porcelain.stdout.trimEnd().split('\t')).toHaveLength(7)

    const cleared = await runCli(['session', 'retitle', hostSessionId, '--regenerate'], cliEnv())
    expect(cleared.exitCode).toBe(0)
    expect(JSON.parse(cleared.stdout.trim())).toEqual({ metadata: {}, metadataSources: {} })
    const after = JSON.parse(
      (await runCli(['session', 'list', '--json'], cliEnv())).stdout.trim()
    ) as Array<{ hostSessionId: string; title?: string }>
    expect(after.find((session) => session.hostSessionId === hostSessionId)?.title).toBeUndefined()
  })

  it('uses last api title write and accepts force as an ignored compatibility option', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('retitleforce'))
    const first = await runCli(['session', 'retitle', hostSessionId, '--title', 'First'], cliEnv())
    expect(first.exitCode).toBe(0)

    const replaced = await runCli(
      ['session', 'retitle', hostSessionId, '--title', 'Second'],
      cliEnv()
    )
    expect(replaced.exitCode).toBe(0)
    const current = await runCli(['session', 'get', hostSessionId], cliEnv())
    expect(JSON.parse(current.stdout.trim())).toMatchObject({ metadata: { title: 'Second' } })

    const forced = await runCli(
      ['session', 'retitle', hostSessionId, '--title', 'Second', '--force'],
      cliEnv()
    )
    expect(forced.exitCode).toBe(0)
    expect(JSON.parse(forced.stdout.trim())).toMatchObject({
      metadata: { title: 'Second' },
      metadataSources: { title: { source: 'api' } },
    })

    // Exercises session_index_title_update — the projection path that has no
    // other reachable caller.
    const listed = JSON.parse(
      (await runCli(['session', 'list', '--json'], cliEnv())).stdout.trim()
    ) as Array<{ hostSessionId: string; title?: string }>
    expect(listed.find((session) => session.hostSessionId === hostSessionId)?.title).toBe('Second')

    const misused = await runCli(
      ['session', 'retitle', hostSessionId, '--regenerate', '--force'],
      cliEnv()
    )
    expect(misused.exitCode).toBe(0)
    expect(JSON.parse(misused.stdout.trim()).metadata.title).toBeUndefined()
  })

  it('rejects titles that are oversized or carry control characters', async () => {
    const hostSessionId = await resolveHostSessionId(testProjectScope('retitleguard'))
    const long = await runCli(
      ['session', 'retitle', hostSessionId, '--title', 'x'.repeat(201)],
      cliEnv()
    )
    expect(long.exitCode).not.toBe(0)
    expect(long.stderr).toContain('at most 200 characters')

    const control = await runCli(
      ['session', 'retitle', hostSessionId, '--title', 'break\u001b[2Jrow'],
      cliEnv()
    )
    expect(control.exitCode).not.toBe(0)
    expect(control.stderr).toContain('control characters')

    const trimmed = await runCli(
      ['session', 'retitle', hostSessionId, '--title', '  Padded title  '],
      cliEnv()
    )
    expect(trimmed.exitCode).toBe(0)
    expect(JSON.parse(trimmed.stdout.trim())).toMatchObject({ metadata: { title: 'Padded title' } })
  })
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
