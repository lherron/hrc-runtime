import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot, HrcTargetRuntimeView, InspectRuntimeResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { IsoTimestamp, TurnId } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { handleInspectRuntime } from '../runtime-inspect-handlers'
import type { ServerContext } from '../server-context'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import {
  type DurableBrokerReattachDeps,
  reconcileDurableBrokerRuntimeReattach,
} from '../startup-reconcile'
import { markRuntimeStale } from '../startup-reconcile/runtime-mutations'
import { cleanupIdleClaudeGhosttyRuntimes, reconcileActiveRunsOnce } from '../sweep-reconcile'
import { toTargetRuntimeView } from '../target-view'
import { type TmuxPaneState, createTmuxManager } from '../tmux'
import {
  RUNTIME_ID as MAPPER_RUNTIME_ID,
  envelope,
  makeSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

const OLD_ACTIVITY = '2026-07-17T16:00:00.000Z'
const RECENT_MUTATION = '2026-07-18T16:00:00.000Z'

async function withDatabase<T>(prefix: string, fn: (db: HrcDatabase, dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  try {
    return await fn(db, dir)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

function seedSession(db: HrcDatabase, hostSessionId: string, scopeRef: string): void {
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: OLD_ACTIVITY,
    updatedAt: OLD_ACTIVITY,
    ancestorScopeRefs: [],
  })
}

function seedRuntime(
  db: HrcDatabase,
  input: {
    runtimeId: string
    hostSessionId: string
    scopeRef: string
    transport?: 'sdk' | 'tmux' | 'headless' | 'ghostty'
    status?: string
    activeRunId?: string | undefined
    controllerKind?: 'harness-broker' | undefined
    tmuxJson?: Record<string, unknown> | undefined
    surfaceJson?: Record<string, unknown> | undefined
    runtimeStateJson?: Record<string, unknown> | undefined
    updatedAt?: string | undefined
  }
): HrcRuntimeSnapshot {
  db.runtimes.insert({
    runtimeId: input.runtimeId,
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: input.transport ?? 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: input.status ?? 'ready',
    supportsInflightInput: input.transport === 'tmux',
    adopted: false,
    activeRunId: input.activeRunId,
    controllerKind: input.controllerKind,
    tmuxJson: input.tmuxJson,
    surfaceJson: input.surfaceJson,
    runtimeStateJson: input.runtimeStateJson,
    lastActivityAt: OLD_ACTIVITY,
    createdAt: OLD_ACTIVITY,
    updatedAt: input.updatedAt ?? OLD_ACTIVITY,
  })
  const runtime = db.runtimes.getByRuntimeId(input.runtimeId)
  if (!runtime) throw new Error(`failed to seed runtime ${input.runtimeId}`)
  return runtime
}

function durableBrokerState(
  runtimeId: string,
  hostSessionId: string,
  brokerWindow: TmuxPaneState,
  tuiWindow: TmuxPaneState = brokerWindow
): Record<string, unknown> {
  return {
    schemaVersion: 'runtime-state/v1',
    kind: 'harness-broker',
    runtimeId,
    hostSessionId,
    generation: 1,
    status: 'busy',
    broker: {
      protocolVersion: 'harness-broker/0.2',
      endpoint: {
        kind: 'unix-jsonrpc-ndjson',
        socketPath: `${brokerWindow.socketPath}.broker`,
        attachTokenRef: {
          kind: 'file',
          path: `${brokerWindow.socketPath}.token`,
          redacted: true,
        },
      },
      generation: 1,
      brokerWindow,
      tuiWindow,
    },
  }
}

function seedActiveRun(
  db: HrcDatabase,
  input: {
    runId: string
    runtimeId: string
    hostSessionId: string
    scopeRef: string
    transport: 'sdk' | 'tmux'
  }
): void {
  db.runs.insert({
    runId: input.runId,
    hostSessionId: input.hostSessionId,
    runtimeId: input.runtimeId,
    scopeRef: input.scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: input.transport,
    status: 'started',
    acceptedAt: OLD_ACTIVITY,
    startedAt: OLD_ACTIVITY,
    updatedAt: OLD_ACTIVITY,
  })
}

describe('lastActivityAt is qualifying agent/turn activity, not row mutation time', () => {
  it('restart degraded and mark-stale housekeeping advance updatedAt without touching lastActivityAt', async () => {
    await withDatabase('hrc-last-activity-reconcile-', async (db) => {
      const hostSessionId = 'hsid-last-activity-reconcile'
      const scopeRef = 'agent:room-tester:project:hrc-runtime:task:last-activity'
      seedSession(db, hostSessionId, scopeRef)

      const tuiWindow: TmuxPaneState = {
        socketPath: '/tmp/hrc-last-activity-degraded.sock',
        sessionName: 'hrc-last-activity-degraded',
        windowName: 'tui',
        sessionId: '$1',
        windowId: '@2',
        paneId: '%3',
      }
      const brokerWindow: TmuxPaneState = {
        ...tuiWindow,
        windowName: 'broker',
        windowId: '@1',
        paneId: '%2',
      }
      const degraded = seedRuntime(db, {
        runtimeId: 'rt-degraded-housekeeping',
        hostSessionId,
        scopeRef,
        status: 'busy',
        controllerKind: 'harness-broker',
        tmuxJson: tuiWindow,
        runtimeStateJson: durableBrokerState(
          'rt-degraded-housekeeping',
          hostSessionId,
          brokerWindow,
          tuiWindow
        ),
      })
      const stale = seedRuntime(db, {
        runtimeId: 'rt-stale-housekeeping',
        hostSessionId,
        scopeRef,
        status: 'busy',
      })

      const deps = {
        controller: {
          attachAndReplay: async () => {
            throw new Error('degraded path must not attach')
          },
        },
        brokerUnixClientFactory: async () => {
          throw new Error('degraded path must not open broker IPC')
        },
        resolveAttachToken: async () => undefined,
        probeBrokerLease: async () => ({
          brokerSocketLive: false,
          brokerWindow,
          tuiWindow,
        }),
      } as unknown as DurableBrokerReattachDeps

      const degradedOutcome = await reconcileDurableBrokerRuntimeReattach(db, degraded, deps)
      markRuntimeStale(db, db.sessions.getByHostSessionId(hostSessionId)!, stale, {
        reason: 'restart_housekeeping',
      })

      const degradedAfter = db.runtimes.getByRuntimeId(degraded.runtimeId)!
      const staleAfter = db.runtimes.getByRuntimeId(stale.runtimeId)!
      expect(degradedOutcome.state).toBe('direct-tmux-degraded')
      expect(degradedAfter.updatedAt).not.toBe(OLD_ACTIVITY)
      expect(staleAfter.updatedAt).not.toBe(OLD_ACTIVITY)
      expect(degradedAfter.lastActivityAt).toBe(OLD_ACTIVITY)
      expect(staleAfter.lastActivityAt).toBe(OLD_ACTIVITY)
    })
  })

  it('broker turn replay advances activity to the event occurrence timestamp, not replay processing time', async () => {
    const fixture = await makeSeededFixture()
    try {
      const occurrenceTs = ts(4)
      const processingTs = ts(100)
      const mapper = new BrokerEventMapper({ db: fixture.db, now: () => processingTs })
      const turnId = 'turn-last-activity-replay' as TurnId

      mapper.apply(
        envelope('turn.started', 4, { turnId }, { turnId, time: occurrenceTs as IsoTimestamp })
      )

      const runtime = fixture.db.runtimes.getByRuntimeId(MAPPER_RUNTIME_ID)!
      const run = fixture.db.runs.listByRuntimeId(MAPPER_RUNTIME_ID)[0]!
      expect(runtime.lastActivityAt).toBe(occurrenceTs)
      expect(run.startedAt).toBe(occurrenceTs)
      expect(runtime.lastActivityAt).not.toBe(processingTs)
    } finally {
      await fixture.cleanup()
    }
  })

  it('a recent housekeeping updatedAt cannot postpone ghostty cleanup keyed to lastActivityAt', async () => {
    await withDatabase('hrc-last-activity-ghostty-', async (db) => {
      const hostSessionId = 'hsid-last-activity-ghostty'
      const scopeRef = 'agent:room-tester:project:hrc-runtime:task:last-activity-ghostty'
      const runtimeId = 'rt-last-activity-ghostty'
      seedSession(db, hostSessionId, scopeRef)
      seedRuntime(db, {
        runtimeId,
        hostSessionId,
        scopeRef,
        transport: 'ghostty',
        status: 'ready',
        surfaceJson: { surfaceId: 'surface-last-activity' },
        updatedAt: new Date().toISOString(),
      })

      const calls: string[] = []
      const ctx = {
        db,
        tmux: {},
        ghostmux: {
          sendKeys: async () => {
            calls.push('sendKeys')
          },
          terminate: async () => {
            calls.push('terminate')
          },
          inspectSurface: async () => null,
        },
        notifyEvent: () => undefined,
      } as unknown as ServerContext
      const previousCleanupMinutes = process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES']
      process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = '15'
      try {
        await cleanupIdleClaudeGhosttyRuntimes(ctx)
      } finally {
        if (previousCleanupMinutes === undefined) {
          process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = undefined
        } else {
          process.env['HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_MINUTES'] = previousCleanupMinutes
        }
      }

      expect(calls).toEqual(['sendKeys', 'terminate'])
      expect(db.runtimes.getByRuntimeId(runtimeId)?.status).toBe('terminated')
    })
  })

  it('concrete liveness spares an old live runtime while a recent mutation cannot spare a stale row', async () => {
    await withDatabase('hrc-last-activity-liveness-', async (db, dir) => {
      const leaseSocket = join(dir, 'live-lease.sock')
      const defaultSocket = join(dir, 'default.sock')
      const lease = createTmuxManager({ socketPath: leaseSocket })
      const brokerWindow = await lease.createWindowWithCommand({
        sessionName: 'hrc-last-activity-live',
        windowName: 'broker',
        command: '/bin/sleep 300',
      })

      try {
        const liveSession = 'hsid-last-activity-live'
        const liveScope = 'agent:room-tester:project:hrc-runtime:task:last-activity-live'
        const liveRuntimeId = 'rt-last-activity-live'
        const liveRunId = 'run-last-activity-live'
        seedSession(db, liveSession, liveScope)
        seedRuntime(db, {
          runtimeId: liveRuntimeId,
          hostSessionId: liveSession,
          scopeRef: liveScope,
          status: 'busy',
          activeRunId: liveRunId,
          controllerKind: 'harness-broker',
          tmuxJson: brokerWindow,
          runtimeStateJson: durableBrokerState(liveRuntimeId, liveSession, brokerWindow),
        })
        seedActiveRun(db, {
          runId: liveRunId,
          runtimeId: liveRuntimeId,
          hostSessionId: liveSession,
          scopeRef: liveScope,
          transport: 'tmux',
        })

        const staleSession = 'hsid-last-activity-stale'
        const staleScope = 'agent:room-tester:project:hrc-runtime:task:last-activity-stale'
        const staleRuntimeId = 'rt-last-activity-stale'
        const staleRunId = 'run-last-activity-stale'
        seedSession(db, staleSession, staleScope)
        seedRuntime(db, {
          runtimeId: staleRuntimeId,
          hostSessionId: staleSession,
          scopeRef: staleScope,
          transport: 'sdk',
          status: 'stale',
          activeRunId: staleRunId,
          updatedAt: RECENT_MUTATION,
        })
        seedActiveRun(db, {
          runId: staleRunId,
          runtimeId: staleRuntimeId,
          hostSessionId: staleSession,
          scopeRef: staleScope,
          transport: 'sdk',
        })

        const ctx = {
          db,
          tmux: createTmuxManager({ socketPath: defaultSocket }),
          ghostmux: {},
          notifyEvent: () => undefined,
        } as unknown as ServerContext
        const result = await reconcileActiveRunsOnce(ctx, {
          olderThanMs: 30 * 60_000,
          dryRun: false,
          thresholdSeconds: 30 * 60,
        })

        expect(result.summary).toMatchObject({ suspect: 1, reaped: 1, errors: 0 })
        expect(result.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ runId: liveRunId, status: 'suspect' }),
            expect.objectContaining({ runId: staleRunId, status: 'reaped' }),
          ])
        )
        expect(db.runtimes.getByRuntimeId(liveRuntimeId)?.activeRunId).toBe(liveRunId)
        expect(db.runs.getByRunId(liveRunId)?.status).toBe('started')
        expect(db.runtimes.getByRuntimeId(staleRuntimeId)?.activeRunId).toBeUndefined()
        expect(db.runs.getByRunId(staleRunId)?.status).toBe('failed')
      } finally {
        await lease.killServer()
      }
    })
  })

  it('target and inspect expose corrected lastActivityAt through the unchanged public shapes', async () => {
    await withDatabase('hrc-last-activity-projection-', async (db) => {
      const hostSessionId = 'hsid-last-activity-projection'
      const scopeRef = 'agent:room-tester:project:hrc-runtime:task:last-activity-projection'
      const runtimeId = 'rt-last-activity-projection'
      seedSession(db, hostSessionId, scopeRef)
      const runtime = seedRuntime(db, {
        runtimeId,
        hostSessionId,
        scopeRef,
        transport: 'sdk',
        status: 'ready',
        updatedAt: RECENT_MUTATION,
      })

      const target = toTargetRuntimeView(runtime) satisfies HrcTargetRuntimeView | undefined
      expect(target).toEqual({
        runtimeId,
        transport: 'sdk',
        status: 'ready',
        supportsLiteralSend: false,
        supportsCapture: true,
        activeRunId: undefined,
        lastActivityAt: OLD_ACTIVITY,
        operatorAttachable: false,
      })

      const response = await handleInspectRuntime.call(
        {
          db,
          staleGenerationEnabled: true,
          staleGenerationThresholdSec: 24 * 60 * 60,
        } as unknown as HrcServerInstanceForHandlers,
        new Request('http://localhost/v1/runtimes/inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtimeId }),
        })
      )
      const inspect = (await response.json()) as InspectRuntimeResponse
      expect(inspect.lastActivityAt).toBe(OLD_ACTIVITY)
      expect(typeof inspect.lastActivityAgeSec).toBe('number')
      expect(Object.keys(inspect).sort()).toEqual(
        [
          'activeInvocationId',
          'activeOperationId',
          'activeRunId',
          'childPid',
          'continuation',
          'continuationKey',
          'continuationStale',
          'controllerKind',
          'createdAgeSec',
          'createdAt',
          'generation',
          'harness',
          'hostSessionId',
          'laneRef',
          'lastActivityAgeSec',
          'lastActivityAt',
          'provider',
          'runtimeId',
          'scopeRef',
          'status',
          'transport',
          'wrapperPid',
        ].sort()
      )
    })
  })
})
