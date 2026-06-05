/**
 * Regression (T-01941): the active-run reaper must NOT condemn a LIVE durable
 * harness-broker runtime.
 *
 * `planActiveRunReconcile`'s tmux branch probed `inspectSession` on the DEFAULT
 * hrc tmux socket. A durable broker lives in a PER-RUNTIME leased tmux server
 * (its own socket), so that probe always reported "missing" and reaped the run
 * with `nextRuntimeStatus: 'dead'` — while the broker pid + tmux session +
 * attached viewer kept running. That false-dead row is invisible to dispatch
 * (selectDispatchInteractiveRuntime / getDurableHeadlessRuntimeForReattach skip
 * unavailable-status rows), so the next DM forked a parallel headless broker +
 * a "headless …" ghostmux viewer pane instead of delivering into the live TUI.
 *
 * Daedalus ruling (architecture): substrate liveness and run ownership are
 * SEPARATE authorities. A live leased pane proves the broker surface is up, NOT
 * that the active turn is complete; 30m of HRC-event silence + a live pane is
 * missing observability, not proof the run is detachable. So when the per-runtime
 * leased pane is alive, the reaper must return `suspect` and mutate NOTHING (no
 * active_run_id clear, no runtime status change). Only when the pane is genuinely
 * dead/missing on the runtime's OWN socket does it reap + mark the runtime dead
 * (and tear down the defunct lease server so it does not create a new orphan).
 *
 * Run with TMPDIR=/tmp (tmux socket path length).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
const leaseSockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-run-active-broker-live-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  for (const socketPath of leaseSockets.splice(0)) {
    try {
      const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      await exited
    } catch {
      // fine when no server exists
    }
  }
  await fixture.cleanup()
})

async function spawnTmux(args: string[]): Promise<number> {
  const { exited } = Bun.spawn(['tmux', ...args], { stdout: 'ignore', stderr: 'ignore' })
  return exited
}

async function sessionExists(socketPath: string, sessionName: string): Promise<boolean> {
  const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'has-session', '-t', `=${sessionName}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await exited) === 0
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

type LeasePaneIdentity = {
  sessionId: string
  windowId: string
  paneId: string
}

type SeedBrokerRunOptions = {
  runId: string
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  leaseSocket: string
  sessionName: string
  /** The live (or synthesized) leased pane the durable broker is hosted in. */
  pane: LeasePaneIdentity
  runtimeStatus?: string | undefined
}

/**
 * Seed a durable broker-tmux runtime (controllerKind harness-broker, leased-tmux
 * substrate via runtimeStateJson.broker so `hasLeasedBrokerSubstrate` is true) and
 * a stale active run it owns. The runtime's tmuxJson points at `leaseSocket` +
 * `pane.paneId` — the PER-RUNTIME socket the reaper must probe.
 */
function seedBrokerRun(options: SeedBrokerRunOptions): void {
  const scopeRef = options.scopeRef.startsWith('agent:')
    ? options.scopeRef
    : `agent:${options.scopeRef}`
  fixture.seedSession(options.hostSessionId, scopeRef)

  const db = openHrcDatabase(fixture.dbPath)
  const stale = isoMinutesAgo(60)
  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: options.runtimeStatus ?? 'busy',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeInvocationId: `inv-${options.runtimeId}`,
      activeRunId: options.runId,
      tmuxJson: {
        socketPath: options.leaseSocket,
        sessionName: options.sessionName,
        windowName: 'tui',
        sessionId: options.pane.sessionId,
        windowId: options.pane.windowId,
        paneId: options.pane.paneId,
        brokerDriver: 'claude-code-tmux',
      },
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: options.runtimeId,
        hostSessionId: options.hostSessionId,
        generation: 1,
        status: options.runtimeStatus ?? 'busy',
        broker: {
          protocolVersion: 'harness-broker/0.2',
          generation: 1,
          endpoint: {
            kind: 'unix-jsonrpc-ndjson',
            socketPath: `${options.leaseSocket}.broker`,
            attachTokenRef: {
              kind: 'file',
              path: `${options.leaseSocket}.token`,
              redacted: true,
            },
          },
          brokerWindow: {
            socketPath: options.leaseSocket,
            sessionName: options.sessionName,
            sessionId: options.pane.sessionId,
            windowId: options.pane.windowId,
            paneId: options.pane.paneId,
          },
        },
      },
      lastActivityAt: stale,
      createdAt: stale,
      updatedAt: stale,
    })

    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      runtimeId: options.runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'started',
      acceptedAt: stale,
      startedAt: stale,
      updatedAt: stale,
    })
  } finally {
    db.close()
  }
}

function getRun(runId: string): HrcRunRecord | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.getByRunId(runId)
  } finally {
    db.close()
  }
}

function getRuntime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function listEvents(eventKind: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((event) => event.eventKind === eventKind)
  } finally {
    db.close()
  }
}

async function reconcile(
  body: ReconcileActiveRunsRequest = {}
): Promise<ReconcileActiveRunsResponse> {
  const res = await fixture.postJson('/v1/runs/reconcile-active', body)
  expect(res.status).toBe(200)
  return (await res.json()) as ReconcileActiveRunsResponse
}

/** Allocate a REAL leased tmux session+window with a non-shell (`sleep`) foreground. */
async function allocateLivePane(
  leaseSocket: string,
  sessionName: string
): Promise<LeasePaneIdentity> {
  // Durable topology: a 'broker' + 'tui' window, NO 'main'. The 'tui' pane runs a
  // non-shell foreground so inspectPaneLiveness reads it as a live harness.
  expect(
    await spawnTmux(['-S', leaseSocket, 'new-session', '-d', '-s', sessionName, '-n', 'broker', 'sleep 600'])
  ).toBe(0)
  expect(
    await spawnTmux(['-S', leaseSocket, 'new-window', '-d', '-t', `=${sessionName}:`, '-n', 'tui', 'sleep 600'])
  ).toBe(0)
  const mgr = createTmuxManager({ socketPath: leaseSocket })
  const pane = await mgr.inspectWindow({ sessionName, windowName: 'tui' })
  if (!pane) throw new Error('failed to allocate live leased tui pane fixture')
  return { sessionId: pane.sessionId, windowId: pane.windowId, paneId: pane.paneId }
}

describe('T-01941: active-run reaper + durable broker per-runtime liveness probe', () => {
  it('leaves a LIVE durable broker as suspect — does not clear the run or mark it dead', async () => {
    const leaseSocket = join(fixture.runtimeRoot, 'lease-live.sock')
    leaseSockets.push(leaseSocket)
    const sessionName = 'hrc-claude-code-tmux-rt-live'
    const pane = await allocateLivePane(leaseSocket, sessionName)

    seedBrokerRun({
      runId: 'run-broker-live',
      hostSessionId: 'hsid-broker-live',
      scopeRef: 'reconcile-broker-live',
      runtimeId: 'rt-broker-live',
      leaseSocket,
      sessionName,
      pane,
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    // The reaper must NOT condemn a live durable broker.
    expect(body.summary).toMatchObject({ reaped: 0, suspect: 1, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runId: 'run-broker-live',
      status: 'suspect',
      reason: 'runtime_may_still_be_live',
    })

    // Run ownership untouched: the run is still active and the runtime still owns
    // it at its prior status (NOT dead) — so dispatch can reuse the live TUI.
    expect(getRun('run-broker-live')?.status).toBe('started')
    expect(getRun('run-broker-live')?.completedAt ?? null).toBeNull()
    expect(getRuntime('rt-broker-live')?.status).toBe('busy')
    expect(getRuntime('rt-broker-live')?.activeRunId).toBe('run-broker-live')

    // The live lease server is left alive, and no reap audit event is recorded.
    expect(await sessionExists(leaseSocket, sessionName)).toBe(true)
    expect(listEvents('turn.reaped')).toHaveLength(0)
  })

  it('reaps a durable broker whose leased pane is gone on its OWN socket (marks dead)', async () => {
    // No live session is created — the recorded leased pane is absent on the
    // runtime's own socket, so the broker is genuinely gone.
    const leaseSocket = join(fixture.runtimeRoot, 'lease-dead.sock')
    leaseSockets.push(leaseSocket)
    const sessionName = 'hrc-claude-code-tmux-rt-dead'

    seedBrokerRun({
      runId: 'run-broker-dead',
      hostSessionId: 'hsid-broker-dead',
      scopeRef: 'reconcile-broker-dead',
      runtimeId: 'rt-broker-dead',
      leaseSocket,
      sessionName,
      pane: { sessionId: '$0', windowId: '@0', paneId: '%0' },
    })

    const body = await reconcile({ olderThan: '30m', yes: true })

    expect(body.summary).toMatchObject({ reaped: 1, suspect: 0, errors: 0 })
    expect(body.results[0]).toMatchObject({
      runId: 'run-broker-dead',
      status: 'reaped',
      reason: 'runtime_unavailable_with_active_run',
      nextRuntimeStatus: 'dead',
    })
    expect(getRun('run-broker-dead')?.status).toBe('failed')
    expect(getRun('run-broker-dead')?.errorCode).toBe('runtime_unavailable_with_active_run')
    expect(getRuntime('rt-broker-dead')?.status).toBe('dead')
    expect(getRuntime('rt-broker-dead')?.activeRunId ?? null).toBeNull()
    expect(listEvents('turn.reaped')).toHaveLength(1)
  })
})
