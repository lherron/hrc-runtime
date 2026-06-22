/**
 * RED integration/acceptance tests for T-05084 (Phase B of T-05078):
 * dispatch DTO dual cursors + startIdentity + capability truth.
 *
 * Author: smokey (TDD RED gatekeeper). These tests are EXPECTED TO FAIL until
 * Phase B implementation lands. They pin three acceptance tests from the full
 * T-05078 gate (tests 3, 13, 17):
 *
 *   Test 3  — Cursor atomicity: dispatchTurn(waitForCompletion:false) response
 *              captures lifecycle.fromSeq = maxHrcSeq()+1 AND
 *              broker.afterSeq = maxBrokerSeq(invocationId), BOTH captured
 *              PRE-side-effect. Replay from each cursor includes the first
 *              relevant event per plane; no dispatched events appear below them.
 *
 *   Test 13 — DTO shape: response carries runId, runtimeId, generation,
 *              transport, status, startIdentity, observation.{lifecycle, broker?}.
 *              startIdentity = {kind:'broker', invocationId} for broker transport
 *              (real invocationId from runs.invocationId / broker_invocations);
 *              sdk dispatch omits observation.broker.
 *
 *   Test 17 — Capability truth: headless broker dispatch reports
 *              supportsInFlightInput=FALSE; delivering in-flight input to the
 *              same runtime class yields INFLIGHT_UNSUPPORTED.
 *
 * RED signals (current codebase):
 *   - DispatchTurnResponse lacks startIdentity + observation fields → assertions
 *     on (resp as any).startIdentity / (resp as any).observation fail.
 *   - broker-headless-handlers.ts has supportsInFlightInput: true in 4 places
 *     → static scan asserts 0, dispatch response check asserts false.
 *
 * The implementer must provide:
 *   - DispatchTurnResponse.startIdentity: {kind:'broker', invocationId} | {kind:'sdk'}
 *   - DispatchTurnResponse.observation.lifecycle.{selector, fromSeq}
 *   - DispatchTurnResponse.observation.broker?.{selector, afterSeq}
 *   - maxBrokerSeq(invocationId) reader in broker-events repo
 *   - Turn handler captures both cursors PRE-side-effect
 *   - supportsInFlightInput: false in broker-headless-handlers.ts (all 4 sites)
 *
 * Stub pattern (established in server-sdk-dispatch.test.ts):
 *   (server as any).getHarnessBrokerController = () => ({ dispatchInput: async () => ... })
 *   This replaces broker IPC with a no-spawn stub while exercising the real DB
 *   row path and response serialisation.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test broker-dispatch-dto
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ── Source path for static scans (test 17) ───────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BROKER_HEADLESS_HANDLERS_PATH = resolve(
  REPO_ROOT,
  'packages/hrc-server/src/broker-headless-handlers.ts'
)

// ── Stable test constants ────────────────────────────────────────────────────

const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05084'
const PROVIDER = 'openai' as const
const INVOCATION_ID = 'inv-dispatch-dto-test-01'
const OPERATION_ID = 'op-dispatch-dto-test-01'

// ── Fixtures ─────────────────────────────────────────────────────────────────

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-dispatch-dto-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create the server with headlessCodexBrokerEnabled so that a headless+openai
 * intent routes to handleHeadlessBrokerDispatchTurn.
 */
async function startBrokerServer(): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
}

/**
 * Dispatch intent that routes to the headless broker path:
 *   - preferredMode:'headless' → shouldUseHeadlessTransport
 *   - provider:'openai', interactive:false → decideHeadlessExecutionRoute → 'broker'
 *   - dryRun:true → cwd fallback, no real filesystem assertions
 */
function headlessBrokerIntent(): object {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: PROVIDER,
      interactive: false,
    },
    execution: {
      preferredMode: 'headless',
    },
  }
}

/**
 * Seed a broker headless runtime (status:'ready', activeInvocationId set) and
 * the matching broker_invocation row for a given hostSessionId/generation pair.
 * Returns the seeded runtimeId.
 *
 * After seeding, the runtime is "reusable" by getReusableHeadlessRuntimeForSession:
 *   - transport='headless', provider='openai', controllerKind='harness-broker'
 *   - activeInvocationId set + invocationState='ready' (non-terminal)
 *   - status='ready' (not unavailable)
 */
function seedBrokerRuntime(
  hostSessionId: string,
  scopeRef: string,
  generation: number,
  runtimeId: string
): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = new Date().toISOString()

  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'codex-cli',
      provider: PROVIDER,
      status: 'ready',
      supportsInflightInput: true, // Currently seeded as true (the lie we're fixing)
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: OPERATION_ID,
      activeInvocationId: INVOCATION_ID,
      createdAt: now,
      updatedAt: now,
    })

    db.brokerInvocations.insert({
      invocationId: INVOCATION_ID,
      operationId: OPERATION_ID,
      runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready', // Non-terminal: getReusableHeadlessRuntimeForSession includes it
      capabilitiesJson: JSON.stringify({}),
      specHash: 'sha256:spec-dto-test',
      startRequestHash: 'sha256:req-dto-test',
      selectedProfileHash: 'sha256:prof-dto-test',
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

/**
 * Stub getHarnessBrokerController().dispatchInput() on the server to return
 * a successful broker input response. This bypasses the real broker IPC (which
 * requires a live leased-tmux subprocess) while exercising the full handler
 * path: DB row creation, cursor capture, response serialisation.
 *
 * Pattern established in server-sdk-dispatch.test.ts (installHeadlessBrokerStartStub).
 */
function stubBrokerDispatchInput(): void {
  ;(server as any).getHarnessBrokerController = () => ({
    dispatchInput: async (_input: unknown) => ({
      ok: true,
      response: {
        inputId: `input-stub-${Date.now()}`,
        accepted: true,
        disposition: 'started',
      },
    }),
    waitForAttachedStartReady: async () => Promise.reject(new Error('not applicable')),
  })
}

/**
 * Read the current max hrc_seq from the DB (0 if no events).
 * Mirrors the db.hrcEvents.maxHrcSeq() call that the handler must use for
 * observation.lifecycle.fromSeq.
 */
function readMaxHrcSeq(): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.maxHrcSeq()
  } finally {
    db.close()
  }
}

/**
 * Read the current max broker seq for an invocationId from broker_invocation_events
 * (0 if no events). Mirrors the maxBrokerSeq(invocationId) reader the implementer
 * must add to the broker-events repo for observation.broker.afterSeq.
 */
function readMaxBrokerSeqForInvocation(invocationId: string): number {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const rows = db.brokerInvocationEvents.listByInvocationId(invocationId)
    if (rows.length === 0) return 0
    return Math.max(...rows.map((r) => r.seq))
  } finally {
    db.close()
  }
}

// =============================================================================
// Test 13 — DTO shape
// =============================================================================

describe('T-05078/13 dispatch DTO shape — broker transport', () => {
  it('response carries startIdentity={kind:broker,invocationId}, observation.lifecycle, observation.broker', async () => {
    await startBrokerServer()

    // Resolve a session and seed a reusable broker runtime.
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-dto-shape-test-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)

    // Stub broker controller so dispatchInput succeeds without a live broker.
    stubBrokerDispatchInput()

    // Dispatch with waitForCompletion:false (the path that should return observation).
    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'Hello from DTO shape test',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })

    // Phase B response must be 200 with the new DTO fields.
    expect(res.status).toBe(200)

    const body = (await res.json()) as any

    // Core fields (already present — baseline check to confirm routing).
    expect(body.runId).toEqual(expect.any(String))
    expect(body.runtimeId).toEqual(expect.any(String))
    expect(body.generation).toEqual(expect.any(Number))
    expect(body.transport).toBe('headless')
    expect(body.status).toBe('started')

    // ── RED: startIdentity absent from current DispatchTurnResponse ────────
    // When green: {kind:'broker', invocationId: INVOCATION_ID}
    expect((body as any).startIdentity).toBeDefined() // RED: currently undefined
    expect((body as any).startIdentity?.kind).toBe('broker') // RED
    // invocationId must be the REAL id from runs.invocationId / broker_invocations,
    // NOT a fabricated placeholder. It equals the INVOCATION_ID we seeded.
    expect((body as any).startIdentity?.invocationId).toBe(INVOCATION_ID) // RED

    // ── RED: observation absent from current DispatchTurnResponse ──────────
    expect((body as any).observation).toBeDefined() // RED: currently undefined

    // lifecycle cursor — always present for broker transport.
    expect((body as any).observation?.lifecycle).toBeDefined() // RED
    expect((body as any).observation?.lifecycle?.selector).toBeDefined() // RED
    expect((body as any).observation?.lifecycle?.selector?.runId).toEqual(
      expect.any(String)
    ) // RED
    expect((body as any).observation?.lifecycle?.selector?.runtimeId).toEqual(
      expect.any(String)
    ) // RED
    expect((body as any).observation?.lifecycle?.selector?.generation).toEqual(
      expect.any(Number)
    ) // RED
    expect((body as any).observation?.lifecycle?.fromSeq).toEqual(expect.any(Number)) // RED

    // broker cursor — present for broker transport; absent for sdk.
    expect((body as any).observation?.broker).toBeDefined() // RED
    expect((body as any).observation?.broker?.selector?.invocationId).toBe(INVOCATION_ID) // RED
    expect((body as any).observation?.broker?.selector?.runId).toEqual(expect.any(String)) // RED
    expect((body as any).observation?.broker?.selector?.runtimeId).toEqual(
      expect.any(String)
    ) // RED
    expect((body as any).observation?.broker?.selector?.generation).toEqual(
      expect.any(Number)
    ) // RED
    expect((body as any).observation?.broker?.afterSeq).toEqual(expect.any(Number)) // RED
  }, 15_000)

  it('response runId matches the run created in the DB', async () => {
    // Confirms the response is wired to the real DB row (not a placeholder).
    await startBrokerServer()

    // Each test gets a fresh fixture DB (beforeEach), so SCOPE_REF is safe to reuse.
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-dto-runid-check-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)
    stubBrokerDispatchInput()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'runId check',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // Verify the run was persisted in the DB with the returned runId.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const run = db.runs.getByRunId(body.runId)
      expect(run).toBeDefined()
      expect(run?.runtimeId).toBe(body.runtimeId)

      // RED: startIdentity.invocationId must equal the run's persisted invocationId.
      // This guards against fabrication: the response must carry the REAL DB value.
      expect((body as any).startIdentity?.invocationId).toBe(run?.invocationId) // RED
    } finally {
      db.close()
    }
  }, 15_000)
})

// =============================================================================
// Test 3 — Cursor atomicity
// =============================================================================

describe('T-05078/3 dispatch DTO cursor atomicity — pre-side-effect capture', () => {
  it('lifecycle.fromSeq = maxHrcSeq()+1 captured BEFORE dispatch appends events', async () => {
    await startBrokerServer()

    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-dto-cursor-test-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)
    stubBrokerDispatchInput()

    // Snapshot the HRC high-water mark BEFORE the dispatch. The handler must
    // capture fromSeq = priorMaxHrcSeq + 1 BEFORE writing any run/event rows.
    const priorMaxHrcSeq = readMaxHrcSeq()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'cursor atomicity test',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // ── RED: observation absent ────────────────────────────────────────────
    expect((body as any).observation).toBeDefined() // RED
    expect((body as any).observation?.lifecycle).toBeDefined() // RED

    // ── RED: cursor value must be pre-side-effect ──────────────────────────
    // The dispatch handler appends turn.accepted, turn.user_prompt, turn.started
    // events as side effects. fromSeq must be captured BEFORE those writes,
    // so fromSeq === priorMaxHrcSeq + 1. Events for THIS turn have
    // hrcSeq >= fromSeq; no prior event has hrcSeq >= fromSeq.
    const fromSeq: number = (body as any).observation?.lifecycle?.fromSeq
    expect(fromSeq).toBeDefined() // RED: currently observation is absent
    expect(fromSeq).toBe(priorMaxHrcSeq + 1) // RED: currently fails (field absent)

    // Sanity: the dispatch DID append lifecycle events AFTER fromSeq.
    // From a cursor at fromSeq, /v1/events should yield at least turn.accepted.
    const afterDispatchMaxHrcSeq = readMaxHrcSeq()
    expect(afterDispatchMaxHrcSeq).toBeGreaterThanOrEqual(priorMaxHrcSeq + 1)
    // When green: fromSeq is strictly before all events created by this dispatch.
    expect(fromSeq).toBeLessThanOrEqual(afterDispatchMaxHrcSeq)
  }, 15_000)

  it('broker.afterSeq = maxBrokerSeq(invocationId) captured BEFORE dispatch input', async () => {
    await startBrokerServer()

    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-dto-broker-cursor-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)
    stubBrokerDispatchInput()

    // Fresh invocation: no broker events exist yet → maxBrokerSeq = 0.
    // The broker.afterSeq cursor must be captured BEFORE the stub's dispatchInput
    // runs (which in production would stream broker events into broker_invocation_events).
    const priorMaxBrokerSeq = readMaxBrokerSeqForInvocation(INVOCATION_ID)
    expect(priorMaxBrokerSeq).toBe(0) // Sanity: fresh invocation

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'broker cursor atomicity test',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // ── RED: observation.broker absent ────────────────────────────────────
    expect((body as any).observation?.broker).toBeDefined() // RED

    // ── RED: afterSeq must equal the pre-dispatch max broker seq ──────────
    // For a fresh invocation, afterSeq=0 (exclusive, meaning "all events from seq>0").
    // This is the EXCLUSIVE cursor matching broker eventsSince(afterSeq=0).
    const afterSeq: number = (body as any).observation?.broker?.afterSeq
    expect(afterSeq).toBeDefined() // RED
    expect(afterSeq).toBe(priorMaxBrokerSeq) // RED: 0 for fresh invocation
    // afterSeq is exclusive: replay from afterSeq includes events with seq > afterSeq.
    // For a fresh invocation afterSeq=0 means "start from beginning".
    expect(afterSeq).toBeGreaterThanOrEqual(0) // RED
  }, 15_000)

  it('lifecycle selector in observation.lifecycle matches the dispatched run and runtime', async () => {
    // Guards that the selector is wired to the REAL run/runtime created by this
    // dispatch, not a placeholder. Required for T-05078 §2: the coordinator must
    // pass the returned selector directly to /v1/events for correct filtering.
    await startBrokerServer()

    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-dto-selector-check-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)
    stubBrokerDispatchInput()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'selector wiring check',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // ── RED: observation absent; selector values must match top-level fields ─
    const obs = (body as any).observation
    expect(obs).toBeDefined() // RED

    // When green: lifecycle selector must be consistent with the response envelope.
    // The run was created by this dispatch; the runtime is the seeded one.
    expect(obs?.lifecycle?.selector?.runId).toBe(body.runId) // RED
    expect(obs?.lifecycle?.selector?.runtimeId).toBe(body.runtimeId) // RED
    expect(obs?.lifecycle?.selector?.generation).toBe(body.generation) // RED

    // broker selector must likewise match.
    expect(obs?.broker?.selector?.runId).toBe(body.runId) // RED
    expect(obs?.broker?.selector?.runtimeId).toBe(body.runtimeId) // RED
    expect(obs?.broker?.selector?.generation).toBe(body.generation) // RED
    expect(obs?.broker?.selector?.invocationId).toBe(INVOCATION_ID) // RED
  }, 15_000)
})

// =============================================================================
// Test 17 — Capability truth
// =============================================================================

describe('T-05078/17 capability truth — broker headless supportsInFlightInput', () => {
  // ── Part A: Static source scan ──────────────────────────────────────────────
  // Fail-fast contract: broker-headless-handlers.ts must have ZERO instances of
  // supportsInFlightInput: true. Currently 4 instances → RED.
  //
  // This is a static contract test (analogous to runtime-status-contract.ts)
  // that catches the lying capability at the source before runtime.
  it('broker-headless-handlers.ts has no supportsInFlightInput: true literals', () => {
    const source = readFileSync(BROKER_HEADLESS_HANDLERS_PATH, 'utf8')

    // Match both spellings (DB column uses camelCase without capital I in Input).
    const trueInstances = [...source.matchAll(/supportsInFlightInput\s*:\s*true/g)]

    // RED: currently 4 instances at lines ~187, 199, 392, 404.
    // When green: 0 (all changed to false or the field becomes derived).
    expect(trueInstances.length).toBe(0) // RED: currently 4
  })

  // ── Part B: Dispatch response value ────────────────────────────────────────
  // The ACTUAL dispatch response from the broker path must report false.
  it('broker headless dispatch response has supportsInFlightInput=false', async () => {
    await startBrokerServer()

    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-capability-truth-01'
    seedBrokerRuntime(hostSessionId, SCOPE_REF, generation, runtimeId)
    stubBrokerDispatchInput()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'capability truth test',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any

    // RED: currently returns supportsInFlightInput: true (the lying capability).
    // When green: false (broker in-flight is not supported; sendInFlightInput is
    // SDK-transport-only per deliverInFlightInputToRuntime transport guard).
    expect(body.supportsInFlightInput).toBe(false) // RED: currently true
  }, 15_000)

  // ── Part C: In-flight input to broker runtime returns INFLIGHT_UNSUPPORTED ──
  // Validates the end-to-end coherence: after the capability-truth fix, the
  // dispatch advertises false AND the in-flight endpoint correctly rejects.
  // (Non-SDK transport is already gated by deliverInFlightInputToRuntime:
  // transport!=='sdk' → INFLIGHT_UNSUPPORTED regardless of supportsInflightInput.)
  it('in-flight input to a broker headless runtime returns 422 INFLIGHT_UNSUPPORTED', async () => {
    await startBrokerServer()

    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-inflight-reject-01'
    const runId = 'run-inflight-reject-01'

    // Seed a broker runtime with an active run (busy, matching the in-flight target).
    const db = openHrcDatabase(fixture.dbPath)
    const now = new Date().toISOString()
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation,
        transport: 'headless', // broker headless transport
        harness: 'codex-cli',
        provider: PROVIDER,
        status: 'busy',
        supportsInflightInput: true, // currently seeded as true (the lie); even so, endpoint rejects
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: OPERATION_ID,
        activeInvocationId: INVOCATION_ID,
        activeRunId: runId,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId,
        hostSessionId,
        runtimeId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation,
        transport: 'headless',
        status: 'started',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
        operationId: OPERATION_ID,
        invocationId: INVOCATION_ID,
      })
    } finally {
      db.close()
    }

    // POST /v1/in-flight-input to the broker runtime.
    // deliverInFlightInputToRuntime gates on transport!=='sdk' → INFLIGHT_UNSUPPORTED.
    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'in-flight attempt on broker runtime',
    })

    // 422 INFLIGHT_UNSUPPORTED — non-SDK transport is never broker-in-flight eligible.
    expect(res.status).toBe(422)
    const errorBody = (await res.json()) as any
    expect(errorBody.error?.code).toBe('inflight_unsupported')
  }, 15_000)
})
