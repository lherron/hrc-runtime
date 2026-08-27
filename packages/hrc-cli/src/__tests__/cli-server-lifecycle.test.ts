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
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CLI_PATH,
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
    expect(result.stdout).not.toContain('--no-attach')
    expect(result.stdout).toContain('--attach-only')
    expect(result.stdout).toContain('--dry-run')
  })

  it('hrc run from a non-TTY fails before resolving or starting a runtime', async () => {
    const result = await runCli(['run', 'rex@agent-spaces', '--dry-run'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('hrc run is interactive-only (no TTY detected)')
    expect(result.stderr).toContain('hrc start <scope> [-p <prompt>]')
  })

  it('hrc capture --help exits nonzero with the runtime capture pointer', async () => {
    const result = await runCli(['capture', '--help'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('hrc runtime capture')
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

    // `hrc turn` now re-execs `hrcchat turn`; provider comes from the target
    // intent set up by `runtime ensure --provider openai` above.
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

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessionCount: number
      sessions: string[]
    }
    expect(before.running).toBe(true)
    expect(before.sessionCount).toBeGreaterThan(0)

    const stopResult = await runCli(['server', 'stop'], cliEnv())
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

    const beforeTmux = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
    expect(beforeTmux.exitCode).toBe(0)
    const before = JSON.parse(beforeTmux.stdout.trim()) as {
      running: boolean
      sessions: string[]
    }
    expect(before.running).toBe(true)

    const restartResult = await runCli(['server', 'restart'], cliEnv())
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

  it('server restart --wait returns only after a healthy new process answers', async () => {
    const primaryScope = 'agent:test:project:hrc-runtime:task:primary'
    const isolatedEnv = cliEnv({
      HRC_LAUNCHD_LABEL: 'com.praesidium.hrc-T-07157-isolated',
      HRC_SESSION_REF: `${primaryScope}/lane:main`,
      ASP_SCOPE_REF: primaryScope,
      ASP_TASK_ID: 'primary',
      ASP_DEFAULT_TASK: 'primary',
    })
    try {
      const startResult = await runCli(['server', 'start', '--daemon'], isolatedEnv)
      expect(startResult.exitCode).toBe(0)

      const before = await waitForServerStatus((value) => value.running === true, isolatedEnv)
      const beforeStartedAt = before.release?.processStartedAt as string | undefined
      expect(beforeStartedAt).toBeString()

      const restartResult = await runCli(
        [
          'server',
          'restart',
          '--wait',
          '--timeout-ms',
          '5000',
          '--reason',
          'T-07157 isolated restart proof',
        ],
        isolatedEnv
      )
      expect(restartResult.exitCode).toBe(0)
      expect(restartResult.stderr).toContain('restart proven')

      const after = await waitForServerStatus(
        (value) => value.running === true && value.release?.processStartedAt !== beforeStartedAt,
        isolatedEnv
      )
      expect(after.release?.processStartedAt).toBeString()
      expect(after.release?.processStartedAt).not.toBe(beforeStartedAt)
    } finally {
      await runCli(
        ['server', 'stop', '--force', '--reason', 'T-07157 isolated test cleanup'],
        isolatedEnv
      ).catch(() => undefined)
    }
  })

  it.if(process.platform === 'darwin')(
    'server restart --drain keeps proving after the actuation timeout while a new daemon starts slowly',
    async () => {
      const isolatedLabel = 'com.praesidium.hrc-T-07216-slow-start'
      const primaryScope = 'agent:test:project:hrc-runtime:task:primary'
      const isolatedEnv = cliEnv({
        HRC_LAUNCHD_LABEL: isolatedLabel,
        HRC_SESSION_REF: `${primaryScope}/lane:main`,
        ASP_SCOPE_REF: primaryScope,
        ASP_TASK_ID: 'primary',
        ASP_DEFAULT_TASK: 'primary',
      })
      try {
        const startResult = await runCli(['server', 'start', '--daemon'], isolatedEnv)
        expect(startResult.exitCode).toBe(0)

        const before = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        const beforeStartedAt = before.release?.processStartedAt as string | undefined
        expect(beforeStartedAt).toBeString()

        const shimDir = join(tmpDir, 'launchctl-slow-start')
        await mkdir(shimDir, { recursive: true })
        await writeFile(
          join(shimDir, 'launchctl'),
          `#!/bin/sh
if [ "$1" = "print" ]; then
  exit 0
fi
if [ "$1" = "kickstart" ]; then
  (
    sleep 0.25
    if [ -f "$HRC_RUNTIME_DIR/server.pid" ]; then
      old_pid="$(sed -n '1p' "$HRC_RUNTIME_DIR/server.pid")"
      kill "$old_pid" 2>/dev/null || true
      while kill -0 "$old_pid" 2>/dev/null; do sleep 0.01; done
    fi
    exec "$HRC_TEST_BUN_PATH" "$HRC_TEST_CLI_PATH" server serve
  ) </dev/null >>"$HRC_RUNTIME_DIR/slow-launch.log" 2>&1 &
  exit 0
fi
exit 1
`
        )
        await chmod(join(shimDir, 'launchctl'), 0o755)

        const restartResult = await runCli(
          [
            'server',
            'restart',
            '--drain',
            '--timeout-ms',
            '100',
            '--reason',
            'T-07216 simulated slow-start proof',
          ],
          {
            ...isolatedEnv,
            HRC_TEST_BUN_PATH: process.execPath,
            HRC_TEST_CLI_PATH: CLI_PATH,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          }
        )
        expect(restartResult.exitCode).toBe(0)
        expect(restartResult.stderr).toContain('restart proven')

        const after = await waitForServerStatus(
          (value) => value.running === true && value.release?.processStartedAt !== beforeStartedAt,
          isolatedEnv
        )
        expect(after.release?.processStartedAt).toBeString()
        expect(after.release?.processStartedAt).not.toBe(beforeStartedAt)
      } finally {
        await runCli(
          ['server', 'stop', '--force', '--reason', 'T-07216 isolated test cleanup'],
          isolatedEnv
        ).catch(() => undefined)
      }
    }
  )

  it.if(process.platform === 'darwin')(
    'server restart --wait rejects a launchctl success that did not replace the process',
    async () => {
      const isolatedLabel = 'com.praesidium.hrc-T-07157-noop'
      const primaryScope = 'agent:test:project:hrc-runtime:task:primary'
      const isolatedEnv = cliEnv({
        HRC_LAUNCHD_LABEL: isolatedLabel,
        HRC_SESSION_REF: `${primaryScope}/lane:main`,
        ASP_SCOPE_REF: primaryScope,
        ASP_TASK_ID: 'primary',
        ASP_DEFAULT_TASK: 'primary',
      })
      try {
        const startResult = await runCli(['server', 'start', '--daemon'], isolatedEnv)
        expect(startResult.exitCode).toBe(0)

        const before = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        const beforeStartedAt = before.release?.processStartedAt as string | undefined
        expect(beforeStartedAt).toBeString()

        const shimDir = join(tmpDir, 'launchctl-noop')
        await mkdir(shimDir, { recursive: true })
        await writeFile(join(shimDir, 'launchctl'), '#!/bin/sh\nexit 0\n')
        await chmod(join(shimDir, 'launchctl'), 0o755)

        const restartResult = await runCli(
          [
            'server',
            'restart',
            '--wait',
            '--proof-timeout-ms',
            '100',
            '--reason',
            'T-07157 launchctl no-op proof',
          ],
          {
            ...isolatedEnv,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          }
        )
        expect(restartResult.exitCode).toBe(1)
        expect(restartResult.stderr).toContain('[restart_unproven]')
        expect(restartResult.stderr).toContain(`before pid=${before.pid}`)
        expect(restartResult.stderr).toContain(`observed pid=${before.pid}`)
        expect(restartResult.stderr).toContain('old pid alive=yes')
        expect(restartResult.stderr).toContain('socket responsive=yes')

        const after = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        expect(after.release?.processStartedAt).toBe(beforeStartedAt)
      } finally {
        await runCli(
          ['server', 'stop', '--force', '--reason', 'T-07157 isolated test cleanup'],
          isolatedEnv
        ).catch(() => undefined)
      }
    }
  )

  // Regression (T-07580). Observed live during the T-07575 activation restart:
  // `launchctl kickstart -k` raced launchd's own in-flight restart of the job
  // and returned EALREADY (37). The actuation had happened and the daemon came
  // back on the new build, but hrc treated the non-zero status as fatal, exited
  // 1 before requireRestartProof ever ran, and reported a hard failure for a
  // restart that worked. The danger is the false RED, not the noise: the
  // operator's next move is a retry or --force against a healthy daemon that
  // has already taken live turns.
  it.if(process.platform === 'darwin')(
    'server restart proves the outcome when launchctl reports EALREADY but the job did restart',
    async () => {
      const isolatedLabel = 'com.praesidium.hrc-T-07580-ealready'
      const primaryScope = 'agent:test:project:hrc-runtime:task:primary'
      const isolatedEnv = cliEnv({
        HRC_LAUNCHD_LABEL: isolatedLabel,
        HRC_SESSION_REF: `${primaryScope}/lane:main`,
        ASP_SCOPE_REF: primaryScope,
        ASP_TASK_ID: 'primary',
        ASP_DEFAULT_TASK: 'primary',
      })
      try {
        const startResult = await runCli(['server', 'start', '--daemon'], isolatedEnv)
        expect(startResult.exitCode).toBe(0)

        const before = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        const beforeStartedAt = before.release?.processStartedAt as string | undefined
        expect(beforeStartedAt).toBeString()

        // Actuates a real restart, then exits 37 — exactly what launchd did.
        const shimDir = join(tmpDir, 'launchctl-ealready')
        await mkdir(shimDir, { recursive: true })
        await writeFile(
          join(shimDir, 'launchctl'),
          `#!/bin/sh
if [ "$1" = "print" ]; then
  exit 0
fi
if [ "$1" = "kickstart" ]; then
  (
    if [ -f "$HRC_RUNTIME_DIR/server.pid" ]; then
      old_pid="$(sed -n '1p' "$HRC_RUNTIME_DIR/server.pid")"
      kill "$old_pid" 2>/dev/null || true
      while kill -0 "$old_pid" 2>/dev/null; do sleep 0.01; done
    fi
    exec "$HRC_TEST_BUN_PATH" "$HRC_TEST_CLI_PATH" server serve
  ) </dev/null >>"$HRC_RUNTIME_DIR/ealready-launch.log" 2>&1 &
  exit 37
fi
exit 1
`
        )
        await chmod(join(shimDir, 'launchctl'), 0o755)

        const restartResult = await runCli(
          [
            'server',
            'restart',
            '--wait',
            '--timeout-ms',
            '5000',
            '--reason',
            'T-07580 EALREADY proof',
          ],
          {
            ...isolatedEnv,
            HRC_TEST_BUN_PATH: process.execPath,
            HRC_TEST_CLI_PATH: CLI_PATH,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          }
        )

        // The proof, not launchctl's status, decides the verdict.
        expect(restartResult.exitCode).toBe(0)
        expect(restartResult.stderr).toContain('restart proven')
        // ...and the benign race is still surfaced rather than swallowed.
        expect(restartResult.stderr).toContain('already in progress')
        expect(restartResult.stderr).not.toContain('launchctl kickstart failed')

        const after = await waitForServerStatus(
          (value) => value.running === true && value.release?.processStartedAt !== beforeStartedAt,
          isolatedEnv
        )
        expect(after.release?.processStartedAt).toBeString()
        expect(after.release?.processStartedAt).not.toBe(beforeStartedAt)
      } finally {
        await runCli(
          ['server', 'stop', '--force', '--reason', 'T-07580 isolated test cleanup'],
          isolatedEnv
        ).catch(() => undefined)
      }
    }
  )

  // Guards the fix against over-correction: EALREADY must not become a blanket
  // pass. If the job did NOT come back, the restart is still unproven.
  it.if(process.platform === 'darwin')(
    'server restart still fails unproven when launchctl reports EALREADY and nothing restarted',
    async () => {
      const isolatedLabel = 'com.praesidium.hrc-T-07580-ealready-noop'
      const primaryScope = 'agent:test:project:hrc-runtime:task:primary'
      const isolatedEnv = cliEnv({
        HRC_LAUNCHD_LABEL: isolatedLabel,
        HRC_SESSION_REF: `${primaryScope}/lane:main`,
        ASP_SCOPE_REF: primaryScope,
        ASP_TASK_ID: 'primary',
        ASP_DEFAULT_TASK: 'primary',
      })
      try {
        const startResult = await runCli(['server', 'start', '--daemon'], isolatedEnv)
        expect(startResult.exitCode).toBe(0)

        const before = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        const beforeStartedAt = before.release?.processStartedAt as string | undefined
        expect(beforeStartedAt).toBeString()

        const shimDir = join(tmpDir, 'launchctl-ealready-noop')
        await mkdir(shimDir, { recursive: true })
        await writeFile(
          join(shimDir, 'launchctl'),
          '#!/bin/sh\nif [ "$1" = "print" ]; then\n exit 0\nfi\nexit 37\n'
        )
        await chmod(join(shimDir, 'launchctl'), 0o755)

        const restartResult = await runCli(
          [
            'server',
            'restart',
            '--wait',
            '--proof-timeout-ms',
            '100',
            '--reason',
            'T-07580 EALREADY no-op proof',
          ],
          {
            ...isolatedEnv,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          }
        )
        expect(restartResult.exitCode).toBe(1)
        expect(restartResult.stderr).toContain('[restart_unproven]')

        const after = await waitForServerStatus((value) => value.running === true, isolatedEnv)
        expect(after.release?.processStartedAt).toBe(beforeStartedAt)
      } finally {
        await runCli(
          ['server', 'stop', '--force', '--reason', 'T-07580 isolated test cleanup'],
          isolatedEnv
        ).catch(() => undefined)
      }
    }
  )

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
