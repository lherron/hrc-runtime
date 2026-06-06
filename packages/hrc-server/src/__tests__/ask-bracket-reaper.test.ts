/**
 * T-01946 — ask-bracket reaper / zombie-sweep / corrupt-state tests.
 *
 * Validates the guards introduced in T-01946:
 *  1. A run with an OPEN ask bracket is never reaped by the active-run reconcile pass
 *     (returns suspect, mutates nothing).
 *  2. A CLOSED bracket no longer guards the run — the normal ready-with-active-run
 *     reap fires.
 *  3. The headless zombie sweep skips a run that has an open ask bracket.
 *  4. A corrupt `awaiting_input` runtime (status set but no activeRunId) is surfaced
 *     as suspect with actionable identity — never silently healed.
 *
 * Run with TMPDIR=/tmp (tmux socket path length).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-ask-bracket-reaper-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

type SeedReadyRunOptions = {
  runId: string
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  runtimeStatus?: string
}

/**
 * Seed a plain tmux runtime with status 'ready' (default) and an active stale run.
 * We use `transport: 'tmux'` with no broker substrate so the open-bracket guard
 * fires before the runtime_ready_with_active_run reap branch.
 * `activeInvocationId` is set to `inv-<runtimeId>` — the convention used by the
 * broker-live template tests.
 */
function seedReadyRun(options: SeedReadyRunOptions): void {
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
      status: options.runtimeStatus ?? 'ready',
      supportsInflightInput: true,
      adopted: false,
      activeInvocationId: `inv-${options.runtimeId}`,
      activeRunId: options.runId,
      tmuxJson: {
        socketPath: fixture.tmuxSocketPath,
        sessionName: 'hrc-missing-session',
        windowName: 'main',
        sessionId: '$dead',
        windowId: '@dead',
        paneId: '%dead',
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

/**
 * Seed a headless run + runtime pair for the zombie-sweep tests.
 * The runtime carries `activeInvocationId` so ask brackets can be appended.
 */
function seedHeadlessRun(options: {
  runId: string
  hostSessionId: string
  scopeRef: string
  runtimeId: string
}): void {
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
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'busy',
      supportsInflightInput: false,
      adopted: false,
      activeInvocationId: `inv-${options.runtimeId}`,
      activeRunId: options.runId,
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
      transport: 'headless',
      status: 'started',
      acceptedAt: stale,
      startedAt: stale,
      updatedAt: stale,
    })
  } finally {
    db.close()
  }
}

/**
 * Append an OPEN ask bracket (tool.call.started with AskUserQuestion) to the
 * broker_invocation_events ledger for the given runtime's invocation.
 */
function appendOpenAskBracket(options: {
  runtimeId: string
  runId: string
  toolCallId: string
  seq: number
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId: `inv-${options.runtimeId}`,
      seq: options.seq,
      time: isoMinutesAgo(55),
      type: 'tool.call.started',
      runtimeId: options.runtimeId,
      runId: options.runId,
      payload: {
        toolCallId: options.toolCallId,
        name: 'AskUserQuestion',
      },
    })
  } finally {
    db.close()
  }
}

/**
 * Append a tool.call.completed row (closing the bracket).
 */
function appendCloseBracket(options: {
  runtimeId: string
  runId: string
  toolCallId: string
  seq: number
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.brokerInvocationEvents.appendEvent({
      invocationId: `inv-${options.runtimeId}`,
      seq: options.seq,
      time: isoMinutesAgo(50),
      type: 'tool.call.completed',
      runtimeId: options.runtimeId,
      runId: options.runId,
      payload: {
        toolCallId: options.toolCallId,
        name: 'AskUserQuestion',
      },
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

async function sweep(body: SweepZombieRunsRequest = {}): Promise<SweepZombieRunsResponse> {
  const res = await fixture.postJson('/v1/runs/sweep-zombies', body)
  expect(res.status).toBe(200)
  return (await res.json()) as SweepZombieRunsResponse
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-01946: ask-bracket reaper / zombie-sweep / corrupt-state', () => {
  describe('active-run reconcile: open ask bracket blocks reap', () => {
    it('1. AWAITING NON-REAPABLE: open bracket → suspect, run and runtime unchanged, no turn.reaped', async () => {
      seedReadyRun({
        runId: 'run-ask-guard',
        hostSessionId: 'hsid-ask-guard',
        scopeRef: 'ask-bracket-guard',
        runtimeId: 'rt-ask-guard',
      })
      appendOpenAskBracket({
        runtimeId: 'rt-ask-guard',
        runId: 'run-ask-guard',
        toolCallId: 'tc-ask-1',
        seq: 1,
      })

      const body = await reconcile({ olderThan: '30m', yes: true })

      // The open bracket guard fires before any reap branch — 0 reaped, 1 suspect.
      expect(body.summary).toMatchObject({ reaped: 0, suspect: 1 })
      expect(body.results[0]).toMatchObject({
        status: 'suspect',
        reason: 'runtime_awaiting_user_input',
        runId: 'run-ask-guard',
      })

      // Run is still active.
      expect(getRun('run-ask-guard')?.status).toBe('started')
      expect(getRun('run-ask-guard')?.completedAt ?? null).toBeNull()

      // Runtime is unchanged.
      expect(getRuntime('rt-ask-guard')?.status).toBe('ready')
      expect(getRuntime('rt-ask-guard')?.activeRunId).toBe('run-ask-guard')

      // No reap audit event emitted.
      expect(listEvents('turn.reaped')).toHaveLength(0)
    })

    it('2. CLOSED BRACKET STILL REAPS: closing the bracket lifts the guard → runtime_ready_with_active_run reaped', async () => {
      seedReadyRun({
        runId: 'run-ask-closed',
        hostSessionId: 'hsid-ask-closed',
        scopeRef: 'ask-bracket-closed',
        runtimeId: 'rt-ask-closed',
      })
      // Open bracket at seq 1, then close at seq 2.
      appendOpenAskBracket({
        runtimeId: 'rt-ask-closed',
        runId: 'run-ask-closed',
        toolCallId: 'tc-ask-2',
        seq: 1,
      })
      appendCloseBracket({
        runtimeId: 'rt-ask-closed',
        runId: 'run-ask-closed',
        toolCallId: 'tc-ask-2',
        seq: 2,
      })

      const body = await reconcile({ olderThan: '30m', yes: true })

      // Guard no longer blocks — normal ready-with-active-run reap fires.
      expect(body.summary).toMatchObject({ reaped: 1, suspect: 0 })
      expect(body.results[0]).toMatchObject({
        status: 'reaped',
        reason: 'runtime_ready_with_active_run',
        runId: 'run-ask-closed',
      })

      // Run and runtime have been mutated by the reap.
      expect(getRun('run-ask-closed')?.status).toBe('failed')
      expect(getRuntime('rt-ask-closed')?.activeRunId ?? null).toBeNull()
    })
  })

  describe('zombie sweep: open ask bracket skips the run', () => {
    it('3. ZOMBIE SWEEP SKIP: headless run with open ask bracket is skipped; same run without bracket is zombied', async () => {
      // Seed the run that should be protected by an open bracket.
      seedHeadlessRun({
        runId: 'run-zombie-guarded',
        hostSessionId: 'hsid-zombie-guarded',
        scopeRef: 'zombie-sweep-guarded',
        runtimeId: 'rt-zombie-guarded',
      })
      appendOpenAskBracket({
        runtimeId: 'rt-zombie-guarded',
        runId: 'run-zombie-guarded',
        toolCallId: 'tc-zombie-ask',
        seq: 1,
      })

      // Control: a second headless run with NO bracket — should be zombied.
      seedHeadlessRun({
        runId: 'run-zombie-control',
        hostSessionId: 'hsid-zombie-control',
        scopeRef: 'zombie-sweep-control',
        runtimeId: 'rt-zombie-control',
      })

      const body = await sweep({ olderThan: '30m', yes: true })

      // The guarded run must NOT appear in the zombied results.
      const zombiedIds = body.results.filter((r) => r.status === 'zombied').map((r) => r.runId)
      expect(zombiedIds).not.toContain('run-zombie-guarded')

      // The control run should be zombied.
      expect(zombiedIds).toContain('run-zombie-control')

      // The guarded run stays active.
      expect(getRun('run-zombie-guarded')?.status).toBe('started')
      expect(getRun('run-zombie-guarded')?.completedAt ?? null).toBeNull()

      // Control run is zombie.
      expect(getRun('run-zombie-control')?.status).toBe('zombie')
    })
  })

  describe('active-run reconcile: corrupt awaiting_input runtime surfaced', () => {
    it('4. CORRUPT SURFACE: awaiting_input runtime with no activeRunId → suspect with identity, runtime unchanged', async () => {
      // Seed a runtime in awaiting_input status but with NO activeRunId and NO active run row.
      const scopeRef = 'agent:ask-corrupt-awaiting'
      fixture.seedSession('hsid-corrupt', scopeRef)

      const db = openHrcDatabase(fixture.dbPath)
      const stale = isoMinutesAgo(60)
      try {
        db.runtimes.insert({
          runtimeId: 'rt-corrupt-awaiting',
          hostSessionId: 'hsid-corrupt',
          scopeRef,
          laneRef: 'default',
          generation: 1,
          transport: 'tmux',
          harness: 'claude-code',
          provider: 'anthropic',
          status: 'awaiting_input',
          supportsInflightInput: true,
          adopted: false,
          activeInvocationId: 'inv-rt-corrupt-awaiting',
          // Deliberately NO activeRunId — this is the corrupt state.
          lastActivityAt: stale,
          createdAt: stale,
          updatedAt: stale,
        })
      } finally {
        db.close()
      }

      const body = await reconcile({ olderThan: '30m', yes: true })

      // The corrupt runtime must appear as suspect.
      const corruptResult = body.results.find(
        (r) => r.reason === 'runtime_awaiting_without_active_run'
      )
      expect(corruptResult).toBeDefined()
      expect(corruptResult?.status).toBe('suspect')
      expect(corruptResult?.runtimeId).toBe('rt-corrupt-awaiting')

      // errorMessage must be JSON-parseable and contain the invocationId.
      expect(corruptResult?.errorMessage).toBeDefined()
      const identity = JSON.parse(corruptResult?.errorMessage ?? '{}') as Record<string, unknown>
      expect(identity['invocationId']).toBe('inv-rt-corrupt-awaiting')

      // Runtime must NOT have been mutated to ready/busy — status stays awaiting_input.
      expect(getRuntime('rt-corrupt-awaiting')?.status).toBe('awaiting_input')
      expect(getRuntime('rt-corrupt-awaiting')?.activeRunId ?? null).toBeNull()

      // No reap event emitted.
      expect(listEvents('turn.reaped')).toHaveLength(0)
    })

    it('5. CORRUPT SURFACE WITH BRACKET IDENTITY: corrupt runtime with open ask bracket surfaces harnessGeneration + turnAttempt in openBrackets', async () => {
      // Seed a corrupt awaiting_input runtime that has an activeInvocationId and a
      // real open ask bracket — the bracket was appended with harnessGeneration:7
      // and turnAttempt:2.  The corrupt-state reconciler must surface those fields
      // in the errorMessage JSON's openBrackets array.
      const scopeRef = 'agent:ask-corrupt-with-bracket'
      fixture.seedSession('hsid-corrupt-bracket', scopeRef)

      const db = openHrcDatabase(fixture.dbPath)
      const stale = isoMinutesAgo(60)
      try {
        db.runtimes.insert({
          runtimeId: 'rt-corrupt-bracket',
          hostSessionId: 'hsid-corrupt-bracket',
          scopeRef,
          laneRef: 'default',
          generation: 1,
          transport: 'tmux',
          harness: 'claude-code',
          provider: 'anthropic',
          status: 'awaiting_input',
          supportsInflightInput: true,
          adopted: false,
          activeInvocationId: 'inv-rt-corrupt-bracket',
          // Deliberately NO activeRunId — corrupt state.
          lastActivityAt: stale,
          createdAt: stale,
          updatedAt: stale,
        })

        // Append a tool.call.started event with full bracket identity.
        db.brokerInvocationEvents.appendEvent({
          invocationId: 'inv-rt-corrupt-bracket',
          seq: 1,
          time: isoMinutesAgo(55),
          type: 'tool.call.started',
          runtimeId: 'rt-corrupt-bracket',
          runId: 'run-corrupt-bracket',
          harnessGeneration: 7,
          turnAttempt: 2,
          payload: {
            toolCallId: 'tc-x',
            name: 'AskUserQuestion',
          },
        })
      } finally {
        db.close()
      }

      const body = await reconcile({ olderThan: '30m', yes: true })

      // The corrupt runtime must appear as suspect.
      const corruptResult = body.results.find((r) => r.runtimeId === 'rt-corrupt-bracket')
      expect(corruptResult).toBeDefined()
      expect(corruptResult?.status).toBe('suspect')
      expect(corruptResult?.reason).toBe('runtime_awaiting_without_active_run')

      // Parse the identity payload.
      expect(corruptResult?.errorMessage).toBeDefined()
      const identity = JSON.parse(corruptResult?.errorMessage ?? '{}') as {
        invocationId: string
        openBrackets: {
          runId: string | null
          toolCallId: string | null
          harnessGeneration: number | null
          turnAttempt: number | null
          seq: number
        }[]
        latestBrokerSeq: number | null
      }

      expect(identity.invocationId).toBe('inv-rt-corrupt-bracket')
      expect(identity.openBrackets).toHaveLength(1)

      const bracket = identity.openBrackets[0]!
      expect(bracket.toolCallId).toBe('tc-x')
      expect(bracket.harnessGeneration).toBe(7)
      expect(bracket.turnAttempt).toBe(2)

      // Runtime must NOT have been mutated.
      expect(getRuntime('rt-corrupt-bracket')?.status).toBe('awaiting_input')
      expect(getRuntime('rt-corrupt-bracket')?.activeRunId ?? null).toBeNull()

      // No reap event emitted.
      expect(listEvents('turn.reaped')).toHaveLength(0)
    })
  })
})
