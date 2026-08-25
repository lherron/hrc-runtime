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
  cliEnv,
  runCli,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  testProjectScope,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('hrc session resolve', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
  })

  it('outputs JSON with hostSessionId, generation, created to stdout', async () => {
    const result = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('clitest'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.hostSessionId).toBeString()
    expect(body.generation).toBe(1)
    expect(body.created).toBe(true)
    expect(body.session).toBeDefined()
  })

  it('uses lane "main" when --lane is omitted', async () => {
    const result = await runCli(
      ['session', 'resolve', '--scope', testProjectScope('nolane')],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.found).toBe(false)
    expect(body.created).toBe(false)
    expect(body.hostSessionId).toBeNull()
    expect(body.generation).toBeNull()
    expect(body.session).toBeNull()
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
    setServer(await createHrcServer(serverOpts()))
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
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('listcli'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )

    const result = await runCli(['session', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.length).toBe(1)
    expect(body[0].scopeRef).toBe(testProjectScope('listcli'))
  })

  it('supports --scope filter', async () => {
    await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('filterA'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('filterB'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )

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
    setServer(await createHrcServer(serverOpts()))
  })

  it('outputs session JSON for a known hostSessionId', async () => {
    const resolveResult = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('getcli'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim())

    const result = await runCli(['session', 'get', resolved.hostSessionId], cliEnv())
    expect(result.exitCode).toBe(0)
    const session = JSON.parse(result.stdout.trim())
    expect(session.hostSessionId).toBe(resolved.hostSessionId)
  })

  it('exits 2 for unknown hostSessionId', async () => {
    const result = await runCli(['session', 'get', 'nonexistent-hsid'], cliEnv())
    expect(result.exitCode).toBe(2)
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
