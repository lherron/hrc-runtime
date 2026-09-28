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
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  cliEnv,
  describeDaemonLifecycle,
  runCli,
  setupCliFixture,
  teardownCliFixture,
  testProjectScope,
  tmpDir,
  waitForServerLog,
  waitForServerStatus,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('top-level commander help (Phase 6 T2b)', () => {
  it('hrc start --help exits 0 with Usage', async () => {
    const result = await runCli(['start', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--force-restart')
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('--project-id')
  })

  it('hrc run --help exits 0 with Usage', async () => {
    const result = await runCli(['run', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--force-restart')
    expect(result.stdout).toContain('preserve the conversation')
    expect(result.stdout).toContain('--new-session')
    expect(result.stdout).not.toContain('--no-attach')
    expect(result.stdout).toContain('--attach-only')
    expect(result.stdout).toContain('--dry-run')
    expect(result.stdout).toContain('-v, --verbose')
  })

  it('hrc run from a non-TTY fails before resolving or starting a runtime', async () => {
    const result = await runCli(['run', 'rex@agent-spaces'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('hrc run is interactive-only (no TTY detected)')
    expect(result.stderr).toContain('hrc start <scope> [-p <prompt>]')
  })

  // The matching case — `--dry-run` is exempt from this gate — is asserted in
  // cli-start.test.ts, where the fixture supplies a resolvable agent and a
  // hermetic agents root. Asserting it here would depend on whether an agent
  // happens to exist under the ambient root, which varies by environment.

  it('hrc capture --help exposes broker capture control', async () => {
    const result = await runCli(['capture', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('status')
    expect(result.stdout).toContain('release')
  })

  it('hrc attach --help exits 0 with Usage', async () => {
    const result = await runCli(['attach', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Usage:/)
    expect(result.stdout).toContain('--dry-run')
  })

  it('hrc start (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['start'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc start/i)
  })

  it('hrc run (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['run'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc run/i)
  })

  it('hrc attach (no args) exits 0 with usage banner', async () => {
    const result = await runCli(['attach'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+hrc attach/i)
  })
})

// ===========================================================================
describe('unknown command', () => {
  it('prints error to stderr and exits 2 for unknown command', async () => {
    const result = await runCli(['nonexistent-command'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(result.stderr.toLowerCase()).toMatch(/unknown|unrecognized|invalid/i)
  })
})

// ===========================================================================
// 2b. server/tmux admin lifecycle
// ===========================================================================
describeDaemonLifecycle('server/tmux admin lifecycle', () => {
  // T-09861: only a Mable primary holding a daemon-minted credential may stop
  // or restart; the runtime's credential file is located by HRC_RUNTIME_ID.
  const MABLE_PRIMARY_SCOPE = 'agent:mable:project:hrc-runtime:task:primary'
  function mableEnv(runtimeId: string): Record<string, string> {
    return cliEnv({
      HRC_RUNTIME_ID: runtimeId,
      HRC_SESSION_REF: `${MABLE_PRIMARY_SCOPE}/lane:default`,
    })
  }

  async function resolveHostSessionId(scope: string): Promise<string> {
    const result = await runCli(
      ['session', 'resolve', '--scope', scope, '--lane', 'default', '--create'],
      cliEnv()
    )
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout.trim()).hostSessionId as string
  }

  async function ensureTmuxRuntime(scope: string): Promise<{
    hostSessionId: string
    runtimeId: string
  }> {
    const hostSessionId = await resolveHostSessionId(scope)
    const ensureResult = await runCli(['admin', 'runtime', 'ensure', hostSessionId], cliEnv())
    expect(ensureResult.exitCode).toBe(0)
    const runtime = JSON.parse(ensureResult.stdout.trim()) as { runtimeId: string }
    return { hostSessionId, runtimeId: runtime.runtimeId }
  }

  it('server start --daemon boots the daemon and server status reports it running', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    expect(startResult.stderr).toMatch(/daemon started/i)

    const status = await waitForServerStatus(
      (value) => value.running === true && value.socketResponsive === true,
      cliEnv()
    )
    expect(status.running).toBe(true)
    expect(status.socketResponsive).toBe(true)
    expect(status.pid).toBeNumber()
  })

  it('server log includes timestamped lifecycle entries', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)

    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)
    const log = await waitForServerLog()
    expect(log).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[hrc-server\] INFO server\.start\.begin /m
    )
    expect(log).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[hrc-server\] INFO server\.listening /m
    )
  })

  it('server log records codex launch execution JSON and CODEX_HOME', async () => {
    const aspHome = join(tmpDir, 'asp-home')
    await mkdir(aspHome, { recursive: true })
    const env = cliEnv({ ASP_HOME: aspHome })

    const startResult = await runCli(['server', 'start', '--daemon'], env)
    expect(startResult.exitCode).toBe(0)
    const status = await waitForServerStatus((value) => value.running === true, env)
    expect(status.running).toBe(true)

    const scope = testProjectScope('codex-launch-logging')
    const hostSessionId = await resolveHostSessionId(scope)
    const ensureResult = await runCli(
      ['admin', 'runtime', 'ensure', hostSessionId, '--provider', 'openai'],
      env
    )
    expect(ensureResult.exitCode).toBe(0)

    // The native `hrc turn` provider comes from the target intent set up by
    // `runtime ensure --provider openai` above.
    const sendResult = await runCli(['turn', scope, 'log codex launch'], env)
    expect(sendResult.exitCode).toBe(0)

    const log = await waitForServerLog()
    expect(log).toContain('launch.dispatch.prepared')
    expect(log).toContain('"execution"')
    expect(log).toContain('"codexHome"')
    expect(log).toContain(`${aspHome}/codex-homes/`)
  })

  it('server stop shuts down only the daemon and leaves the HRC tmux server running', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

    await ensureTmuxRuntime(testProjectScope('server-stop-preserves-tmux'))
    const mable = await ensureTmuxRuntime(MABLE_PRIMARY_SCOPE)

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessionCount: number
      sessions: string[]
    }
    expect(before.running).toBe(true)
    expect(before.sessionCount).toBeGreaterThan(0)

    const stopResult = await runCli(
      ['server', 'stop', '--reason', 'tmux preservation'],
      mableEnv(mable.runtimeId)
    )
    expect(stopResult.exitCode).toBe(0)
    expect(stopResult.stderr).toMatch(/daemon stopped/i)

    const daemonStatus = await runCli(['server', 'status', '--json'], cliEnv())
    expect(daemonStatus.exitCode).toBe(0)
    const serverState = JSON.parse(daemonStatus.stdout.trim()) as { running: boolean }
    expect(serverState.running).toBe(false)

    const afterTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(afterTmux.exitCode).toBe(0)
    const after = JSON.parse(afterTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(after.running).toBe(true)
    expect(after.sessions).toEqual(before.sessions)
  })

  it('server restart preserves the existing tmux session and interactive runtime', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

    const seeded = await ensureTmuxRuntime(testProjectScope('server-restart-preserves-runtime'))
    const mable = await ensureTmuxRuntime(MABLE_PRIMARY_SCOPE)

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(before.running).toBe(true)

    const restartResult = await runCli(
      ['server', 'restart', '--reason', 'tmux preservation'],
      mableEnv(mable.runtimeId)
    )
    expect(restartResult.exitCode).toBe(0)
    expect(restartResult.stderr).toMatch(/daemon restarted/i)

    const afterTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(afterTmux.exitCode).toBe(0)
    const after = JSON.parse(afterTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(after.running).toBe(true)
    expect(after.sessions).toEqual(before.sessions)

    const monitorResult = await runCli(
      ['monitor', 'show', testProjectScope('server-restart-preserves-runtime'), '--json'],
      cliEnv()
    )
    expect(monitorResult.exitCode).toBe(0)
    const monitor = JSON.parse(monitorResult.stdout.trim()) as {
      session?: { hostSessionId: string }
      runtime?: { runtimeId: string; transport: string }
    }
    expect(monitor.session?.hostSessionId).toBe(seeded.hostSessionId)
    expect(monitor.runtime?.runtimeId).toBe(seeded.runtimeId)
    expect(monitor.runtime?.transport).toBe('tmux')
  })

  // T-09861: restart/stop proof, refusals and the retired launchctl-kill path
  // are covered against scratch daemons in t09861-server-lifecycle-e2e.test.ts.

  it('tmux kill requires --yes and then kills the HRC tmux server explicitly', async () => {
    const startResult = await runCli(['server', 'start', '--daemon'], cliEnv())
    expect(startResult.exitCode).toBe(0)
    const readyStatus = await waitForServerStatus((value) => value.running === true, cliEnv())
    expect(readyStatus.running).toBe(true)

    await ensureTmuxRuntime(testProjectScope('tmux-kill-cli'))

    const unsafeResult = await runCli(['server', 'tmux', 'kill'], cliEnv())
    expect(unsafeResult.exitCode).toBe(1)
    expect(unsafeResult.stderr).toMatch(/--yes/i)

    const killResult = await runCli(['server', 'tmux', 'kill', '--yes'], cliEnv())
    expect(killResult.exitCode).toBe(0)
    expect(killResult.stderr).toMatch(/tmux server killed/i)

    const statusResult = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(statusResult.exitCode).toBe(0)
    const status = JSON.parse(statusResult.stdout.trim()) as { running: boolean }
    expect(status.running).toBe(false)
  })
})

// ===========================================================================
// 3. session rotate
// ===========================================================================
