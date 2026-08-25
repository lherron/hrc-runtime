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
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { type Socket, createServer } from 'node:net'
import { join } from 'node:path'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  cliEnv,
  dbPath,
  runCli,
  runtimeRoot,
  server,
  serverOpts,
  setServer,
  setupCliFixture,
  socketPath,
  stateRoot,
  teardownCliFixture,
  testProjectScope,
  tmpDir,
  tmuxSocketPath,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('Phase 6 diagnostics CLI', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
  })

  describe('T-01292 server status acceptance', () => {
    beforeEach(async () => {
      if (server) {
        await server.stop()
        setServer(null)
      }
    })

    afterEach(async () => {
      if (server) {
        await server.stop()
        setServer(null)
      }
    })

    it('exits 0 when healthy and --json reports the full diagnostic shape', async () => {
      setServer(await createHrcServer(serverOpts()))

      const result = await runCli(['server', 'status', '--json'], cliEnv())
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(true)
      expect(body.status).toBe('healthy')
      expect(body.exitCode).toBe(0)
      expect(body.runtimeRoot).toBe(runtimeRoot)
      expect(body.stateRoot).toBe(stateRoot)
      expect(body.cwd).toBe(process.cwd())
      expect(existsSync(body.binaryPath)).toBe(true)
      expect(body.packagePath).toEndWith('/packages/hrc-server')
      expect(body.daemon.running).toBe(true)
      expect(typeof body.daemon.pidAlive).toBe('boolean')
      expect(body.daemon.pidPath).toBe(join(runtimeRoot, 'server.pid'))
      expect(body.socket.path).toBe(socketPath)
      expect(body.socket.responsive).toBe(true)
      expect(body.apiHealth).toEqual({ ok: true })
      expect(typeof body.api.startedAt).toBe('string')
      expect(typeof body.api.uptime).toBe('number')
      expect(body.api.runtimeRoot).toBe(runtimeRoot)
      expect(body.api.stateRoot).toBe(stateRoot)
      expect(body.api.cwd).toBe(process.cwd())
      expect(body.api.binaryPath).toBe(body.binaryPath)
      expect(body.api.packagePath).toBe(body.packagePath)
      expect(body.release).toEqual(body.api.release)
      expect(body.release).toMatchObject({
        mode: 'unmanaged',
        runningEqualsInstalled: false,
      })
      expect(body.tmux.socketPath).toBe(tmuxSocketPath)
    })

    it('exits 1 and reports not-running when the daemon is down', async () => {
      const result = await runCli(['server', 'status', '--json'], cliEnv())
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBe('')

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(false)
      expect(body.status).toBe('not-running')
      expect(body.exitCode).toBe(1)
      expect(body.runtimeRoot).toBe(runtimeRoot)
      expect(body.stateRoot).toBe(stateRoot)
      expect(body.daemon.running).toBe(false)
      expect(body.socket.path).toBe(socketPath)
      expect(body.socket.responsive).toBe(false)
      expect(body.apiHealth).toEqual({ ok: false, error: 'daemon not running' })
    })

    it('does not probe btmux lease sockets during server status', async () => {
      const btmuxDir = join(runtimeRoot, 'btmux')
      await mkdir(btmuxDir, { recursive: true })
      const badLeaseSocket = join(btmuxDir, 'codex-app-server-renderer-control.test.sock')
      const acceptedSockets = new Set<Socket>()
      const fakeLease = createServer((socket) => {
        acceptedSockets.add(socket)
        socket.once('close', () => acceptedSockets.delete(socket))
      })
      await new Promise<void>((resolve, reject) => {
        fakeLease.once('error', reject)
        fakeLease.listen(badLeaseSocket, resolve)
      })

      try {
        const startedAt = performance.now()
        const result = await runCli(['server', 'status', '--json'], cliEnv())
        const elapsedMs = performance.now() - startedAt

        expect(elapsedMs).toBeLessThan(1_000)
        expect(result.exitCode).toBe(1)
        const body = JSON.parse(result.stdout.trim())
        expect(body.status).toBe('not-running')
        expect(body.tmux.leases).toEqual([])
        expect(body.tmux.leaseDiagnostics).toEqual({ total: 0, probed: 0, skipped: 0 })
        expect(acceptedSockets.size).toBe(0)
      } finally {
        for (const socket of acceptedSockets) socket.destroy()
        await new Promise<void>((resolve) => fakeLease.close(() => resolve()))
        await rm(badLeaseSocket, { force: true })
      }
    })

    it('caps explicit btmux lease diagnostics', async () => {
      const btmuxDir = join(runtimeRoot, 'btmux')
      await mkdir(btmuxDir, { recursive: true })
      for (let i = 0; i < 70; i += 1) {
        await writeFile(join(btmuxDir, `zz-stale-${String(i).padStart(3, '0')}.sock`), '')
      }

      const result = await runCli(['server', 'tmux', 'status', '--json'], cliEnv())
      expect(result.exitCode).toBe(0)
      const body = JSON.parse(result.stdout.trim())
      expect(body.leaseDiagnostics).toEqual({ total: 70, probed: 64, skipped: 6 })
      expect(body.leases).toHaveLength(64)
    })

    it('exits 2 for usage errors before probing daemon state', async () => {
      const result = await runCli(['server', 'status', '--bogus-flag'], cliEnv())
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/unknown option|bogus-flag/i)
    })

    it('exits 2 and reports degraded when a socket responds but the API health probe fails', async () => {
      const fakeDaemon = createServer((conn) => {
        conn.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        fakeDaemon.once('error', reject)
        fakeDaemon.listen(socketPath, resolve)
      })

      try {
        const result = await runCli(['server', 'status', '--json'], cliEnv())
        expect(result.exitCode).toBe(2)

        const body = JSON.parse(result.stdout.trim())
        expect(body.ok).toBe(false)
        expect(body.status).toBe('degraded')
        expect(body.exitCode).toBe(2)
        expect(body.socket.responsive).toBe(true)
        expect(body.apiHealth.ok).toBe(false)
        expect(body.apiHealth.error).toMatch(/health|api|status|socket/i)
      } finally {
        await new Promise<void>((resolve) => fakeDaemon.close(() => resolve()))
        await rm(socketPath, { force: true })
      }
    })

    it('exits 3 when local filesystem diagnostics fail', async () => {
      const runtimeFile = join(tmpDir, 'runtime-as-file')
      await writeFile(runtimeFile, 'not a directory', 'utf8')

      const result = await runCli(['server', 'status', '--json'], {
        HRC_RUNTIME_DIR: runtimeFile,
        HRC_STATE_DIR: stateRoot,
      })
      expect(result.exitCode).toBe(3)

      const body = JSON.parse(result.stdout.trim())
      expect(body.ok).toBe(false)
      expect(body.status).toBe('probe-failed')
      expect(body.exitCode).toBe(3)
      expect(body.error).toMatch(/ENOTDIR|not a directory|diagnostic/i)
    })

    it('includes API health output in server status JSON and human output', async () => {
      setServer(await createHrcServer(serverOpts()))

      const statusJson = await runCli(['server', 'status', '--json'], cliEnv())
      expect(statusJson.exitCode).toBe(0)
      const statusBody = JSON.parse(statusJson.stdout.trim())
      expect(statusBody.apiHealth).toEqual({ ok: true })

      const statusHuman = await runCli(['server', 'status'], cliEnv())
      expect(statusHuman.exitCode).toBe(0)
      expect(statusHuman.stdout).toContain('HRC Daemon Status')
      expect(statusHuman.stdout).toMatch(/api health:\s+ok/i)
      expect(statusHuman.stdout).toContain(`runtime root: ${runtimeRoot}`)
      expect(statusHuman.stdout).toContain(`state root:   ${stateRoot}`)
      expect(statusHuman.stdout).toContain(`cwd:          ${process.cwd()}`)
      expect(statusHuman.stdout).toContain('binary:')
      expect(statusHuman.stdout).toContain('package:')
      expect(statusHuman.stdout).toContain('release:      unmanaged')
      expect(statusHuman.stdout).toMatch(/running:\s+yes/i)
    })
  })

  it('hrc monitor show --json prints snapshot JSON with daemon status and exits 0', async () => {
    const result = await runCli(['monitor', 'show', '--json'], cliEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const body = JSON.parse(result.stdout.trim())
    expect(body.kind).toBe('monitor.snapshot')
    expect(body.daemon.status).toBe('healthy')
    expect(typeof body.daemon.uptime).toBe('number')
    expect(body.daemon.uptime).toBeGreaterThanOrEqual(0)
    expect(typeof body.daemon.startedAt).toBe('string')
    expect(typeof body.daemon.socketPath).toBe('string')
    expect(typeof body.counts.sessions).toBe('number')
    expect(typeof body.counts.runtimes).toBe('number')
  })

  it('hrc monitor wait resolves a recent hrcchat message beyond the monitor history cap', async () => {
    const messageId = 'msg-f596049d-a688-4832-8296-9e7b23de31fb'
    const hostSessionId = 'hsid-monitor-message-cap'
    const runtimeId = 'rt-monitor-message-cap'
    const scopeRef = testProjectScope('monitor-message-cap')
    const sessionRef = `${scopeRef}/lane:main`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      db.sqlite.exec(`
        WITH RECURSIVE counter(n) AS (
          SELECT 1
          UNION ALL
          SELECT n + 1 FROM counter WHERE n < 10000
        )
        INSERT INTO messages (
          message_id, created_at, kind, phase,
          from_kind, from_ref, to_kind, to_ref,
          reply_to_message_id, root_message_id,
          body, body_format, execution_state
        )
        SELECT
          printf('msg-decoy-%05d', n), datetime('now'), 'dm', 'request',
          'entity', 'human', 'entity', 'system',
          NULL, printf('msg-decoy-%05d', n),
          'decoy', 'text/plain', 'not_applicable'
        FROM counter
      `)
      db.messages.insert({
        messageId,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'entity', entity: 'system' },
        body: 'monitor this request',
        execution: {
          state: 'started',
          mode: 'headless',
          sessionRef,
          hostSessionId,
          generation: 1,
          runtimeId,
          transport: 'headless',
        },
      })
      db.messages.insert({
        messageId: 'msg-response-to-f596',
        kind: 'dm',
        phase: 'response',
        from: { kind: 'entity', entity: 'system' },
        to: { kind: 'entity', entity: 'human' },
        replyToMessageId: messageId,
        rootMessageId: messageId,
        body: 'done',
        execution: {
          state: 'completed',
          mode: 'headless',
          sessionRef,
          hostSessionId,
          generation: 1,
          runtimeId,
          transport: 'headless',
        },
      })
    } finally {
      db.close()
    }

    const result = await runCli(
      ['monitor', 'wait', `msg:${messageId}`, '--until', 'response', '--timeout', '50ms', '--json'],
      cliEnv()
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      selector: `msg:${messageId}`,
      conditions: ['response'],
      result: 'matched',
      matchedCondition: 'response',
    })
  })

  it('hrc runtime list prints empty JSON array and exits 0', async () => {
    // RED: 'runtime list' subcommand does not exist in CLI dispatch
    const result = await runCli(['runtime', 'list'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
  })

  it('hrc runtime list with --host-session-id filter', async () => {
    // Seed a session + runtime
    const resolveResult = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('diag-rt-list'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    await runCli(['admin', 'runtime', 'ensure', hostSessionId], cliEnv())

    // RED: 'runtime list' subcommand does not exist
    const result = await runCli(['runtime', 'list', '--host-session-id', hostSessionId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0].hostSessionId).toBe(hostSessionId)
  })

  it('hrc ls launches prints JSON array and exits 0', async () => {
    const result = await runCli(['ls', 'launches'], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
  })

  it('hrc launch list with --runtime-id filter', async () => {
    // Seed a runtime to get launches
    const resolveResult = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('diag-launch-list'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    const ensureResult = await runCli(['admin', 'runtime', 'ensure', hostSessionId], cliEnv())
    const runtimeId = JSON.parse(ensureResult.stdout.trim()).runtimeId as string

    const result = await runCli(['ls', 'launches', '--runtime-id', runtimeId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(Array.isArray(body)).toBe(true)
    for (const launch of body) {
      expect(launch.runtimeId).toBe(runtimeId)
    }
  })

  it('hrc admin runtime adopt on dead runtime prints adopted JSON and exits 0', async () => {
    // Seed a dead runtime
    const resolveResult = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('diag-adopt-cli'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    const resolved = JSON.parse(resolveResult.stdout.trim())
    const runtimeId = `rt-adopt-cli-${randomUUID()}`
    const now = new Date().toISOString()
    const db = openHrcDatabase(dbPath)
    db.runtimes.insert({
      runtimeId,
      hostSessionId: resolved.hostSessionId,
      scopeRef: testProjectScope('diag-adopt-cli'),
      laneRef: 'default',
      generation: resolved.generation,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'dead',
      tmuxJson: {
        socketPath: tmuxSocketPath,
        sessionName: 'hrc-adopt-cli',
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

    const result = await runCli(['admin', 'runtime', 'adopt', runtimeId], cliEnv())
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.status).toBe('adopted')
    expect(body.adopted).toBe(true)
    expect(body.runtimeId).toBe(runtimeId)
  })

  it('hrc admin runtime adopt on active runtime exits 1', async () => {
    const resolveResult = await runCli(
      [
        'session',
        'resolve',
        '--scope',
        testProjectScope('diag-adopt-active-cli'),
        '--lane',
        'default',
        '--create',
      ],
      cliEnv()
    )
    const hostSessionId = JSON.parse(resolveResult.stdout.trim()).hostSessionId as string
    const ensureResult = await runCli(['admin', 'runtime', 'ensure', hostSessionId], cliEnv())
    const runtimeId = JSON.parse(ensureResult.stdout.trim()).runtimeId as string

    const result = await runCli(['admin', 'runtime', 'adopt', runtimeId], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('hrc admin runtime adopt on unknown runtime exits 1', async () => {
    const result = await runCli(['admin', 'runtime', 'adopt', 'nonexistent-runtime-id'], cliEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
