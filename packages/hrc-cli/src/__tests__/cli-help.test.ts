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
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'

import {
  cliEnv,
  createRawTmuxSession,
  rawTmuxSessionAlive,
  runCli,
  runtimeRoot,
  seedBrokerClaimingRuntime,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  tmuxSocketPath,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('no args / help', () => {
  it('prints help text to stderr and exits 2 when invoked with no args', async () => {
    const result = await runCli([])
    expect(result.exitCode).toBe(2)
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

  it('prints the agent runbook for info in an agent environment', async () => {
    const result = await runCli(['info', '--agent'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('VIEW: agent')
    expect(result.stdout).toContain('RUNBOOK')
    expect(result.stdout).toContain(
      'Monitor conditions NEVER evaluate the broker invocation ledger.'
    )
    expect(result.stdout).toContain('continuation-only recovery')
    expect(result.stderr).toBe('')
  })

  it('prints parseable first-contact orientation for info --json', async () => {
    const result = await runCli(['info', '--agent', '--json'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'hrc',
      view: 'agent',
      text: expect.stringContaining('RUNBOOK'),
    })
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
    expect(output).toContain('broker-tmux')
  })
})

describe('nested group commander help', () => {
  const cases = [
    {
      args: ['admin', 'runs', '--help'],
      usage: 'Usage: hrc admin runs',
      child: 'sweep-zombies',
    },
    {
      args: ['server', 'tmux', '--help'],
      usage: 'Usage: hrc server tmux',
      child: 'status',
    },
    {
      args: ['federation', 'outbox', '--help'],
      usage: 'Usage: hrc federation outbox',
      child: 'replay',
    },
    {
      args: ['admin', 'broker-verify', '--help'],
      usage: 'Usage: hrc admin broker-verify',
      child: 'candidates',
    },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.args.slice(0, -1).join(' ')} renders its own help instead of root help`, async () => {
      const result = await runCli([...testCase.args])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(testCase.usage)
      expect(result.stdout).toContain(testCase.child)
      expect(result.stdout).not.toContain('HRC operator CLI')
    })
  }

  it('rejects an invalid segment before --help can mask it', async () => {
    const result = await runCli(['runtime', 'lst', '--help'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown command: lst')
    expect(result.stderr).toContain("did you mean 'list'")
  })
})

describe('server tmux kill broker leases', () => {
  it('reaps unclaimed broker-tmux lease servers through the daemon and reports both counts', async () => {
    setServer(await createHrcServer(serverOpts()))

    await createRawTmuxSession(tmuxSocketPath, 'hrc-default-kill-test')
    const btmuxDir = join(runtimeRoot, 'btmux')
    await mkdir(btmuxDir, { recursive: true })
    const unclaimedSocket = join(btmuxDir, 'cc-a.sock')
    const claimedSocket = join(btmuxDir, 'cx-b.sock')
    await createRawTmuxSession(unclaimedSocket, 'hrc-cc-a', true)
    await createRawTmuxSession(claimedSocket, 'hrc-cx-b', true)
    seedBrokerClaimingRuntime('cx', 'b', claimedSocket)

    const killResult = await runCli(['server', 'tmux', 'kill', '--yes'], cliEnv())
    expect(killResult.exitCode).toBe(0)
    expect(killResult.stderr).toMatch(
      /broker-tmux lease server\(s\) reaped: 1 killed, 0 dead socket file\(s\) removed/i
    )
    expect(killResult.stderr).toMatch(/tmux server killed \(1 session\(s\)\)/i)

    expect(await rawTmuxSessionAlive(unclaimedSocket, 'hrc-cc-a')).toBe(false)
    expect(await rawTmuxSessionAlive(claimedSocket, 'hrc-cx-b')).toBe(true)
    expect(await rawTmuxSessionAlive(tmuxSocketPath, 'hrc-default-kill-test')).toBe(false)
  })
})

describe('legacy monitor command removal', () => {
  it('human help lists the seven noun groups while omitting moved top-level groups', async () => {
    const result = await runCli(['--human', '--help'])
    const output = result.stdout + result.stderr
    expect(result.exitCode).toBe(0)
    expect(output).toContain('monitor')
    expect(output).toMatch(/\n\s+admin\s/)
    expect(output).not.toMatch(/\n\s+events\s/)
    expect(output).not.toMatch(/\n\s+status\s/)
  })

  it('removed legacy hrc commands exit as unknown commands', async () => {
    for (const args of [['status'], ['server', 'health']]) {
      const result = await runCli(args, cliEnv())
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/unknown command/i)
    }
  })

  it('admin events exposes only the dead-ledger drain recovery command', async () => {
    const result = await runCli(['admin', 'events', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('drain')
    expect(result.stdout).not.toContain('follow')
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
    expect(output).toContain('rotate')
    expect(output).not.toContain('clear-context')
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
    expect(output).toContain('list')
    expect(output).toContain('inspect')
    expect(output).toContain('sweep')
    expect(output).toContain('capture')
    expect(output).toContain('interrupt')
    expect(output).toContain('terminate')
    expect(output).toContain('send')
    expect(output).not.toContain('ensure')
    expect(output).not.toContain('adopt')
  })

  it('hrc runtime sweep --help exits 0 with Usage and flags', async () => {
    const result = await runCli(['runtime', 'sweep', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('--transport')
  })

  it('describes runtime sweep as ready/busy aging and directs stale-row GC to prune', async () => {
    const help = await runCli(['runtime', 'sweep', '--help'])
    const helpText = help.stdout.toLowerCase()
    const handlersSource = await readFile(
      join(import.meta.dir, '..', 'cli', 'handlers-runtime.ts'),
      'utf8'
    )

    expect(help.exitCode).toBe(0)
    for (const token of ['ready', 'busy', 'stale', 'prune']) {
      expect(helpText).toContain(token)
    }
    expect(handlersSource).not.toContain('terminates live processes/tmux')
  })

  it('hrc run sweep-zombies --help exits nonzero with the replacement pointer', async () => {
    const result = await runCli(['run', 'sweep-zombies', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc admin runs sweep-zombies')
  })

  it('hrc run reconcile-active --help exits nonzero with the replacement pointer', async () => {
    const result = await runCli(['run', 'reconcile-active', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc admin runs reconcile-active')
  })

  // -- launch migration fence --
  it('hrc launch --help exits nonzero with the ls pointer', async () => {
    const result = await runCli(['launch', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc ls launches')
  })

  it('hrc launch list --help exits nonzero with the ls pointer', async () => {
    const result = await runCli(['launch', 'list', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc ls launches')
  })

  // -- turn (alias for `hrcchat turn`) --
  it('hrc turn --help forwards to hrcchat turn and exits 0', async () => {
    const result = await runCli(['turn', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    // hrcchat turn-specific flag — proves we re-execed, not echoed our own help
    expect(output).toContain('--stacked')
  })

  // -- runtime send --
  it('hrc runtime send --help exposes active-run input flags', async () => {
    const result = await runCli(['runtime', 'send', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--run-id')
    expect(result.stdout).toContain('--input')
  })

  it('hrc inflight --help exits nonzero with the runtime send pointer', async () => {
    const result = await runCli(['inflight', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc runtime send')
  })

  it('hrc inflight send --help exits nonzero with the runtime send pointer', async () => {
    const result = await runCli(['inflight', 'send', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc runtime send')
  })

  // -- admin surface group --
  it('hrc admin surface --help exits 0 with Usage and lists subcommands', async () => {
    const result = await runCli(['admin', 'surface', '--help'])
    expect(result.exitCode).toBe(0)
    const output = result.stdout
    expect(output).toMatch(/Usage:/)
    expect(output).toContain('bind')
    expect(output).toContain('unbind')
    expect(output).toContain('list')
  })

  it('hrc admin surface bind --help exits 0 with Usage', async () => {
    const result = await runCli(['admin', 'surface', 'bind', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--kind')
  })

  // -- admin bridge group --
  it('hrc admin bridge --help exits 0 with Usage and lists all subcommands', async () => {
    const result = await runCli(['admin', 'bridge', '--help'])
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

  it('hrc admin bridge deliver-text --help exits 0 with Usage', async () => {
    const result = await runCli(['admin', 'bridge', 'deliver-text', '--help'])
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
