/**
 * RED tests (T-04240) — evidence-ranked active-run reconcile repair.
 *
 * Live incident smokey@agent-spaces:T-04829 (rt-4f40d76c, run-1fd136bc): the
 * turn actually completed (orphan turn.completed in the broker ledger), but the
 * run was never finalized (run_id-less terminal). The active-run reconcile then
 * REAPED it as `failed`/`runtime_ready_with_active_run` — "failed but completed".
 *
 * Daedalus ruling (DM #8234, option C — evidence-ranked): when reconcile finds a
 * runtime-owned active run fossilized AND the broker ledger contains an orphan
 * terminal for that run's window, finalize FROM THE TERMINAL EVIDENCE:
 *   turn.completed   => completed
 *   turn.failed      => failed
 *   turn.interrupted => cancelled
 * Body/tool/assistant evidence alone is NEVER success. Use a DISTINCT repair
 * reason — not a `runtime_ready_with_active_run` failure. Bounded by runtime
 * ownership + no competing active nonterminal run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  HrcRunRecord,
  HrcRuntimeSnapshot,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-reconcile-evidence-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
  await fixture.cleanup()
})

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

type SeedOptions = {
  runId: string
  inputId: string
  runtimeId: string
  invocationId: string
  hostSessionId: string
  scopeRef: string
  /** terminal broker event seeded as an orphan (run_id NULL) after input.accepted */
  orphanTerminalType?: 'turn.completed' | 'turn.failed' | 'turn.interrupted' | undefined
  /** when true, seed only a body event (assistant.message) and NO terminal */
  bodyOnly?: boolean | undefined
}

/**
 * Seed a fossilized, runtime-owned active run (status=ready, activeRunId pinned,
 * run still `accepted`) plus a broker ledger: input.accepted(inputId) then an
 * orphan terminal (run_id NULL) — the exact shape the incident left behind.
 */
function seedFossilizedRun(options: SeedOptions): void {
  const scopeRef = `agent:${options.scopeRef}`
  fixture.seedSession(options.hostSessionId, options.scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const ts = isoMinutesAgo(60)
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
      status: 'ready',
      controllerKind: 'harness-broker',
      activeInvocationId: options.invocationId,
      activeRunId: options.runId,
      supportsInflightInput: true,
      adopted: false,
      lastActivityAt: ts,
      createdAt: ts,
      updatedAt: ts,
    })
    db.runs.insert({
      runId: options.runId,
      hostSessionId: options.hostSessionId,
      runtimeId: options.runtimeId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts,
      updatedAt: ts,
      dispatchedInputId: options.inputId,
    })
    db.brokerInvocations.insert({
      invocationId: options.invocationId,
      operationId: `op-${options.runId}`,
      runtimeId: options.runtimeId,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: 'claude-code-tmux',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ turns: 'multi' }),
      specHash: 'sha256:spec',
      startRequestHash: 'sha256:req',
      selectedProfileHash: 'sha256:prof',
      createdAt: ts,
      updatedAt: ts,
    })
    // Broker ledger: input.accepted (links to run via inputId) then the body /
    // orphan terminal — all AFTER the input.accepted seq.
    db.brokerInvocationEvents.appendEvent({
      invocationId: options.invocationId,
      seq: 1,
      time: ts,
      type: 'input.accepted',
      runtimeId: options.runtimeId,
      runId: options.runId,
      payload: { inputId: options.inputId },
    })
    if (options.bodyOnly) {
      db.brokerInvocationEvents.appendEvent({
        invocationId: options.invocationId,
        seq: 2,
        time: ts,
        type: 'assistant.message.completed',
        runtimeId: options.runtimeId,
        // orphan (no runId)
        payload: { messageId: 'm1', content: [{ type: 'text', text: 'work' }], final: true },
      })
    } else if (options.orphanTerminalType) {
      db.brokerInvocationEvents.appendEvent({
        invocationId: options.invocationId,
        seq: 2,
        time: ts,
        type: options.orphanTerminalType,
        runtimeId: options.runtimeId,
        // orphan terminal: NO runId — the bug signature.
        payload: { success: options.orphanTerminalType === 'turn.completed' },
      })
    }
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

function countEvents(eventKind: string): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((e) => e.eventKind === eventKind).length
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

describe('[RED T-04240] evidence-ranked reconcile repair', () => {
  it('orphan turn.completed ⇒ run completed (NOT reaped failed), ownership cleared, distinct reason', async () => {
    seedFossilizedRun({
      runId: 'run-c',
      inputId: 'input-c',
      runtimeId: 'rt-c',
      invocationId: 'inv-c',
      hostSessionId: 'hsid-c',
      scopeRef: 'reconcile-evidence-c',
      orphanTerminalType: 'turn.completed',
    })

    const body = await reconcile({ olderThan: '30m' })

    const result = body.results.find((r) => r.runId === 'run-c')
    expect(result?.status).toBe('repaired')
    expect(result?.reason).toBe('runtime_active_run_reconciled_from_terminal')
    expect(getRun('run-c')?.status).toBe('completed')
    expect(getRuntime('rt-c')?.activeRunId).toBeUndefined()
    // Must NOT be reaped as a failure.
    expect(countEvents('turn.reaped')).toBe(0)
  })

  it('orphan turn.failed ⇒ failed; turn.interrupted ⇒ cancelled', async () => {
    seedFossilizedRun({
      runId: 'run-f',
      inputId: 'input-f',
      runtimeId: 'rt-f',
      invocationId: 'inv-f',
      hostSessionId: 'hsid-f',
      scopeRef: 'reconcile-evidence-f',
      orphanTerminalType: 'turn.failed',
    })
    seedFossilizedRun({
      runId: 'run-i',
      inputId: 'input-i',
      runtimeId: 'rt-i',
      invocationId: 'inv-i',
      hostSessionId: 'hsid-i',
      scopeRef: 'reconcile-evidence-i',
      orphanTerminalType: 'turn.interrupted',
    })

    await reconcile({ olderThan: '30m' })

    expect(getRun('run-f')?.status).toBe('failed')
    expect(getRun('run-i')?.status).toBe('cancelled')
  })

  it('body-only evidence (no terminal) is NEVER completed', async () => {
    seedFossilizedRun({
      runId: 'run-b',
      inputId: 'input-b',
      runtimeId: 'rt-b',
      invocationId: 'inv-b',
      hostSessionId: 'hsid-b',
      scopeRef: 'reconcile-evidence-b',
      bodyOnly: true,
    })

    await reconcile({ olderThan: '30m' })

    expect(getRun('run-b')?.status).not.toBe('completed')
  })
})
