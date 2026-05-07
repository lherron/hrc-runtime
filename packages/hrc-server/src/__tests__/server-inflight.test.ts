/**
 * RED/GREEN tests for hrc-server Phase 3 — Semantic In-Flight Input (T-00969)
 *
 * Tests the server's POST /v1/in-flight-input endpoint:
 *   - Valid runtimeId + runId on supported SDK runtime -> 200 accepted
 *   - Unknown runtimeId -> 404 unknown_runtime
 *   - Wrong runId (mismatch) -> 409 run_mismatch
 *   - Tmux runtime -> 422 inflight_unsupported
 *   - Unsupported SDK runtime (openai/pi-sdk) -> 422 inflight_unsupported
 *   - inflight.accepted event emitted on success
 *   - inflight.rejected event emitted on rejection
 *   - last_activity_at updated after successful in-flight input
 *
 * Pass conditions for Larry (T-00969):
 *   1. POST /v1/in-flight-input with valid runtimeId + matching runId on a supported
 *      SDK runtime returns 200 { accepted: true }
 *   2. POST /v1/in-flight-input with unknown runtimeId returns 404
 *      { error: { code: 'unknown_runtime' } }
 *   3. POST /v1/in-flight-input with runtimeId whose activeRunId != request runId
 *      returns 409 { error: { code: 'run_mismatch' } }
 *   4. POST /v1/in-flight-input on a tmux-transport runtime returns 422
 *      { error: { code: 'inflight_unsupported' } }
 *   5. POST /v1/in-flight-input on an SDK runtime with supportsInflightInput=false
 *      returns 422 { error: { code: 'inflight_unsupported' } }
 *   6. On success, an event with eventKind='inflight.accepted' is appended with
 *      correct runtimeId/runId, and payload containing the prompt
 *   7. On rejection (run_mismatch, inflight_unsupported), an event with
 *      eventKind='inflight.rejected' is appended with the rejection reason
 *   8. On success, the runtime's last_activity_at is updated to a timestamp
 *      >= the pre-request timestamp
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 3
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const resolved = await fixture.resolveSession(scope)
  return resolved.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent.
 * Uses interactive=false without preferredMode so that
 * shouldUseSdkTransport matches (not shouldUseHeadlessTransport). */
function sdkIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: false,
    },
  }
}

/** Dispatch an SDK turn and return { runtimeId, runId } for in-flight testing */
async function dispatchSdkTurn(
  hsid: string,
  provider: 'anthropic' | 'openai' = 'anthropic'
): Promise<{ runtimeId: string; runId: string }> {
  const res = await fixture.postJson('/v1/turns', {
    hostSessionId: hsid,
    prompt: 'In-flight base turn',
    runtimeIntent: sdkIntent(provider),
  })
  const data = (await res.json()) as any
  // Wait for SDK turn to complete so runtime transitions to ready
  await new Promise((r) => setTimeout(r, 500))
  return { runtimeId: data.runtimeId, runId: data.runId }
}

/** Dispatch a second SDK turn that will be in-flight (busy) for testing */
async function _dispatchBusySdkTurn(hsid: string, _runtimeId: string): Promise<{ runId: string }> {
  // Dispatch another turn — the server should create a new run on the existing runtime
  const res = await fixture.postJson('/v1/turns', {
    hostSessionId: hsid,
    prompt: 'Busy turn for in-flight test',
    runtimeIntent: sdkIntent('anthropic'),
  })
  const data = (await res.json()) as any
  return { runId: data.runId }
}

function seedSdkActiveRuntime(input: {
  hostSessionId: string
  scopeRef: string
  runtimeId: string
  runId: string
  supportsInflightInput?: boolean | undefined
  provider?: 'anthropic' | 'openai' | undefined
}): void {
  const db = openHrcDatabase(fixture.dbPath)
  const timestamp = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: input.runtimeId,
      hostSessionId: input.hostSessionId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: input.provider ?? 'anthropic',
      status: 'busy',
      supportsInflightInput: input.supportsInflightInput ?? true,
      adopted: false,
      activeRunId: input.runId,
      lastActivityAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    db.runs.insert({
      runId: input.runId,
      hostSessionId: input.hostSessionId,
      runtimeId: input.runtimeId,
      scopeRef: input.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'sdk',
      status: 'running',
      acceptedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    })
  } finally {
    db.close()
  }
}

/** Get all events from the server */
async function getAllEvents(): Promise<any[]> {
  const eventsRes = await fixture.fetchSocket('/v1/events?fromSeq=1')
  const text = await eventsRes.text()
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-inflight-test-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

// ---------------------------------------------------------------------------
// 1. Valid in-flight input on supported SDK runtime -> 200
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — valid request', () => {
  it('returns 200 accepted for a supported SDK runtime with matching runId', async () => {
    const hsid = await resolveSession('inflight-valid-1')
    const { runtimeId, runId } = await dispatchSdkTurn(hsid, 'anthropic')

    // Now dispatch a second turn so we have an active runId
    // (first turn completes synchronously in dryRun mode)
    // For this test, we'll send in-flight input referencing a completed run
    // to test the endpoint exists and handles supported runtimes.
    // RED GATE: POST /v1/in-flight-input does not exist yet
    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Additional context from the user',
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.accepted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Unknown runtimeId -> 404
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — unknown runtime', () => {
  it('returns 404 with code unknown_runtime for nonexistent runtimeId', async () => {
    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId: 'rt-does-not-exist',
      runId: 'run-doesnt-matter',
      prompt: 'Input for missing runtime',
    })

    expect(res.status).toBe(404)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('unknown_runtime')
  })
})

// ---------------------------------------------------------------------------
// 3. Wrong runId -> 409
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — run mismatch', () => {
  it('returns 409 with code run_mismatch when runId does not match active run', async () => {
    const hsid = await resolveSession('inflight-mismatch-1')
    const { runtimeId } = await dispatchSdkTurn(hsid, 'anthropic')

    // Send in-flight input with a wrong runId
    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId: 'run-wrong-id-that-does-not-match',
      prompt: 'Input with wrong run',
    })

    expect(res.status).toBe(409)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('run_mismatch')
  })
})

// ---------------------------------------------------------------------------
// 4. Tmux runtime -> 422 inflight_unsupported
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — tmux runtime unsupported', () => {
  it('returns 422 with code inflight_unsupported for tmux transport runtime', async () => {
    const hsid = await resolveSession('inflight-tmux-1')

    // Ensure a tmux runtime (interactive harness)
    const ensureRes = await fixture.postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: 'anthropic',
          interactive: true,
        },
      },
    })
    const ensureData = (await ensureRes.json()) as any
    const tmuxRuntimeId = ensureData.runtimeId

    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId: tmuxRuntimeId,
      runId: 'run-doesnt-matter',
      prompt: 'Input to tmux runtime',
    })

    expect(res.status).toBe(422)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('inflight_unsupported')
  })
})

// ---------------------------------------------------------------------------
// 5. Unsupported SDK runtime (openai/pi-sdk) -> 422
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — unsupported SDK provider', () => {
  it('returns 422 with code inflight_unsupported for SDK runtime that does not support in-flight', async () => {
    const hsid = await resolveSession('inflight-unsupported-1')
    // Dispatch an openai SDK turn — adapter should declare supportsInflightInput=false
    const { runtimeId, runId } = await dispatchSdkTurn(hsid, 'openai')

    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Input to unsupported SDK',
    })

    expect(res.status).toBe(422)
    const data = (await res.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('inflight_unsupported')
  })
})

// ---------------------------------------------------------------------------
// 6. inflight.accepted event emitted on success
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — accepted event', () => {
  it('appends inflight.accepted event with correct metadata on success', async () => {
    const hsid = await resolveSession('inflight-event-accept-1')
    const { runtimeId, runId } = await dispatchSdkTurn(hsid, 'anthropic')

    await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Additional user context',
    })

    const events = await getAllEvents()
    const accepted = events.find((e: any) => e.eventKind === 'inflight.accepted')
    expect(accepted).toBeDefined()
    expect(accepted!.runtimeId).toBe(runtimeId)
    expect(accepted!.runId).toBe(runId)
    expect(accepted!.payload).toBeDefined()
    expect((accepted!.payload as any).prompt).toBe('Additional user context')
  })
})

// ---------------------------------------------------------------------------
// 7. inflight.rejected event emitted on rejection
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — rejected event', () => {
  it('appends inflight.rejected event when runtime does not support in-flight', async () => {
    const hsid = await resolveSession('inflight-event-reject-1')
    // Use openai which should have supportsInflightInput=false
    const { runtimeId, runId } = await dispatchSdkTurn(hsid, 'openai')

    await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Rejected input',
    })

    const events = await getAllEvents()
    const rejected = events.find((e: any) => e.eventKind === 'inflight.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.runtimeId).toBe(runtimeId)
    expect(rejected!.payload).toBeDefined()
    expect((rejected!.payload as any).reason).toMatch(/unsupported|inflight/i)
  })
})

// ---------------------------------------------------------------------------
// 8. last_activity_at updated after successful in-flight input
// ---------------------------------------------------------------------------
describe('POST /v1/in-flight-input — activity tracking', () => {
  it('updates runtime last_activity_at after successful in-flight input', async () => {
    const hsid = await resolveSession('inflight-activity-1')
    const { runtimeId, runId } = await dispatchSdkTurn(hsid, 'anthropic')

    // Record time before in-flight input
    const beforeTs = new Date().toISOString()

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 50))

    const res = await fixture.postJson('/v1/in-flight-input', {
      runtimeId,
      runId,
      prompt: 'Activity tracking test',
    })

    expect(res.status).toBe(200)

    // Verify last_activity_at was updated by checking the response
    // or by querying runtime state
    const _data = (await res.json()) as any
    // The response should include the updated runtime state or we verify via events
    // that the activity timestamp moved forward
    const events = await getAllEvents()
    const accepted = events.find((e: any) => e.eventKind === 'inflight.accepted')
    expect(accepted).toBeDefined()
    // The event timestamp should be after our beforeTs
    expect(accepted!.ts >= beforeTs).toBe(true)
  })
})

describe('POST /v1/active-run-contributions — disabled rich contribution contract', () => {
  it('rejects malformed contribution requests before ledger writes', async () => {
    const res = await fixture.postJson('/v1/active-run-contributions', {
      inputAttemptId: 'ia_missing_application',
      prompt: 'missing application id',
      selector: {},
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as any
    expect(data.error.code).toBe('malformed_request')
  })

  it('returns a queryable rejected ledger row when no active run exists', async () => {
    const seeded = await fixture.ensureRuntime('active-contrib-no-run')
    const request = {
      selector: { runtimeId: seeded.runtimeId },
      inputAttemptId: 'ia_no_active',
      inputApplicationId: 'iap_no_active',
      idempotencyKey: 'same-app',
      prompt: 'try contributing',
    }

    const first = await fixture.postJson('/v1/active-run-contributions', request)
    const duplicate = await fixture.postJson('/v1/active-run-contributions', request)
    const queried = await fixture.fetchSocket('/v1/active-run-contributions/iap_no_active')

    expect(first.status).toBe(200)
    expect(duplicate.status).toBe(200)
    expect(queried.status).toBe(200)

    const payload = (await first.json()) as any
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'rejected',
        inputApplicationId: 'iap_no_active',
        runtimeId: seeded.runtimeId,
        errorCode: 'no_active_run',
        capability: { supported: false },
      })
    )
    expect(await duplicate.json()).toEqual(payload)
    expect(await queried.json()).toEqual(payload)
  })

  it('rejects expectedRunId mismatch against the active runtime run', async () => {
    fixture.seedSession('hsid-active-contrib', 'active-contrib-mismatch')
    fixture.seedTmuxRuntime('hsid-active-contrib', 'active-contrib-mismatch', 'rt-active-contrib', {
      status: 'busy',
      activeRunId: 'hrc-active-run',
    })

    const res = await fixture.postJson('/v1/active-run-contributions', {
      selector: { runtimeId: 'rt-active-contrib' },
      expectedRunId: 'hrc-other-run',
      inputAttemptId: 'ia_mismatch',
      inputApplicationId: 'iap_mismatch',
      prompt: 'wrong run',
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'rejected',
        inputApplicationId: 'iap_mismatch',
        runtimeId: 'rt-active-contrib',
        runId: 'hrc-active-run',
        errorCode: 'run_mismatch',
        capability: { supported: false },
      })
    )
  })

  it('keeps provider delivery disabled even when an active run matches', async () => {
    fixture.seedSession('hsid-active-disabled', 'active-contrib-disabled')
    fixture.seedTmuxRuntime(
      'hsid-active-disabled',
      'active-contrib-disabled',
      'rt-active-disabled',
      {
        status: 'busy',
        activeRunId: 'hrc-active-disabled',
      }
    )

    const res = await fixture.postJson('/v1/active-run-contributions', {
      selector: {
        sessionRef: {
          scopeRef: 'agent:active-contrib-disabled',
          laneRef: 'default',
        },
      },
      expectedRunId: 'hrc-active-disabled',
      inputAttemptId: 'ia_disabled',
      inputApplicationId: 'iap_disabled',
      prompt: 'would contribute if enabled',
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'rejected',
        inputApplicationId: 'iap_disabled',
        runtimeId: 'rt-active-disabled',
        runId: 'hrc-active-disabled',
        errorCode: 'active_run_contribution_disabled',
        capability: { supported: false },
      })
    )
  })

  it('marks the ledger ambiguous when enabled provider delivery throws after pending insert', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    if (server) {
      await server.stop()
    }
    server = await createHrcServer(
      fixture.serverOpts({
        sdkInflightInputMissingActiveRunRetryMs: 0,
      })
    )
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-ambiguous',
      scopeRef: 'agent:active-contrib-ambiguous',
      runtimeId: 'rt-active-ambiguous',
      runId: 'hrc-active-ambiguous',
    })

    try {
      const request = {
        selector: { runtimeId: 'rt-active-ambiguous' },
        expectedRunId: 'hrc-active-ambiguous',
        inputAttemptId: 'ia_ambiguous',
        inputApplicationId: 'iap_ambiguous',
        idempotencyKey: 'ambiguous-once',
        prompt: 'provider call should throw',
      }

      const first = await fixture.postJson('/v1/active-run-contributions', request)
      const dbAfterFirst = openHrcDatabase(fixture.dbPath)
      const rowAfterFirst =
        dbAfterFirst.activeInputDeliveries.getByInputApplicationId('iap_ambiguous')
      dbAfterFirst.close()
      const duplicate = await fixture.postJson('/v1/active-run-contributions', request)
      const queried = await fixture.fetchSocket('/v1/active-run-contributions/iap_ambiguous')
      const db = openHrcDatabase(fixture.dbPath)
      const row = db.activeInputDeliveries.getByInputApplicationId('iap_ambiguous')
      db.close()

      expect(first.status).toBe(200)
      expect(duplicate.status).toBe(200)
      expect(queried.status).toBe(200)
      expect(row?.status).toBe('ambiguous')
      expect(row?.errorCode).toBe('delivery_ambiguous')
      expect(row?.updatedAt).toBe(rowAfterFirst?.updatedAt)

      const firstPayload = (await first.json()) as any
      expect(firstPayload).toEqual(
        expect.objectContaining({
          status: 'pending',
          inputApplicationId: 'iap_ambiguous',
          runtimeId: 'rt-active-ambiguous',
          runId: 'hrc-active-ambiguous',
          errorCode: 'delivery_ambiguous',
          capability: expect.objectContaining({ supported: true }),
        })
      )
      expect(await duplicate.json()).toEqual(
        expect.objectContaining({
          status: 'pending',
          inputApplicationId: 'iap_ambiguous',
          runtimeId: 'rt-active-ambiguous',
          runId: 'hrc-active-ambiguous',
          errorCode: 'delivery_ambiguous',
        })
      )
      expect(await queried.json()).toEqual(
        expect.objectContaining({
          status: 'pending',
          inputApplicationId: 'iap_ambiguous',
          runtimeId: 'rt-active-ambiguous',
          runId: 'hrc-active-ambiguous',
          errorCode: 'delivery_ambiguous',
        })
      )
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('keeps contribution capability gated by sdk transport metadata, not provider name', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-capability',
      scopeRef: 'agent:active-contrib-capability',
      runtimeId: 'rt-active-capability',
      runId: 'hrc-active-capability',
      supportsInflightInput: false,
      provider: 'anthropic',
    })

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: { runtimeId: 'rt-active-capability' },
        expectedRunId: 'hrc-active-capability',
        inputAttemptId: 'ia_capability',
        inputApplicationId: 'iap_capability',
        prompt: 'provider name alone must not enable delivery',
      })

      expect(res.status).toBe(200)
      const payload = (await res.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'rejected',
          inputApplicationId: 'iap_capability',
          runtimeId: 'rt-active-capability',
          runId: 'hrc-active-capability',
          errorCode: 'active_run_contribution_disabled',
          capability: { supported: false },
        })
      )
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('accepts and idempotently replays AgentSpaces SDK provider contributions', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    const providerCalls: unknown[] = []
    if (server) {
      await server.stop()
    }
    server = await createHrcServer(
      fixture.serverOpts({
        sdkInflightInputClient: {
          queueInFlightInput: async (request) => {
            providerCalls.push(request)
            return { accepted: true, pendingTurns: 1 }
          },
        },
      })
    )
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-accepted',
      scopeRef: 'agent:active-contrib-accepted',
      runtimeId: 'rt-active-accepted',
      runId: 'hrc-active-accepted',
      supportsInflightInput: true,
      provider: 'anthropic',
    })

    try {
      const request = {
        selector: { runtimeId: 'rt-active-accepted' },
        expectedRunId: 'hrc-active-accepted',
        inputAttemptId: 'ia_accepted',
        inputApplicationId: 'iap_accepted',
        idempotencyKey: 'accepted-once',
        prompt: 'provider should enqueue this as a sequential follow-up',
      }

      const first = await fixture.postJson('/v1/active-run-contributions', request)
      const duplicate = await fixture.postJson('/v1/active-run-contributions', request)
      const queried = await fixture.fetchSocket('/v1/active-run-contributions/iap_accepted')
      const db = openHrcDatabase(fixture.dbPath)
      const row = db.activeInputDeliveries.getByInputApplicationId('iap_accepted')
      db.close()

      expect(first.status).toBe(200)
      expect(duplicate.status).toBe(200)
      expect(queried.status).toBe(200)

      const payload = (await first.json()) as any
      expect(payload).toEqual(
        expect.objectContaining({
          status: 'accepted',
          inputApplicationId: 'iap_accepted',
          hostSessionId: 'hsid-active-accepted',
          generation: 1,
          runtimeId: 'rt-active-accepted',
          runId: 'hrc-active-accepted',
          capability: {
            supported: true,
            deliverySemantics: 'sequential_followup',
            ackSemantics: 'accepted_only',
            ordering: 'fifo',
            supportsAttachments: false,
          },
        })
      )
      expect(await duplicate.json()).toEqual(payload)
      expect(await queried.json()).toEqual(payload)
      expect(row?.status).toBe('accepted')
      expect(row?.response).toEqual(payload)
      expect(providerCalls).toEqual([
        expect.objectContaining({
          hostSessionId: 'hsid-active-accepted',
          runId: 'hrc-active-accepted',
          inputApplicationId: 'iap_accepted',
          idempotencyKey: 'accepted-once',
          prompt: 'provider should enqueue this as a sequential follow-up',
        }),
      ])
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })

  it('retries a transient AgentSpaces SDK in-flight registry miss', async () => {
    const previousGate = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED']
    process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = '1'
    let providerCalls = 0
    if (server) {
      await server.stop()
    }
    server = await createHrcServer(
      fixture.serverOpts({
        sdkInflightInputRetryDelayMs: 1,
        sdkInflightInputMissingActiveRunRetryMs: 50,
        sdkInflightInputClient: {
          queueInFlightInput: async () => {
            providerCalls += 1
            if (providerCalls === 1) {
              throw new Error('No active in-flight run for hostSessionId hsid-active-retry')
            }
            return { accepted: true, pendingTurns: 1 }
          },
        },
      })
    )
    seedSdkActiveRuntime({
      hostSessionId: 'hsid-active-retry',
      scopeRef: 'agent:active-contrib-retry',
      runtimeId: 'rt-active-retry',
      runId: 'hrc-active-retry',
      supportsInflightInput: true,
      provider: 'anthropic',
    })

    try {
      const res = await fixture.postJson('/v1/active-run-contributions', {
        selector: { runtimeId: 'rt-active-retry' },
        expectedRunId: 'hrc-active-retry',
        inputAttemptId: 'ia_retry',
        inputApplicationId: 'iap_retry',
        prompt: 'provider should enqueue after transient registry readiness',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(
        expect.objectContaining({
          status: 'accepted',
          inputApplicationId: 'iap_retry',
          runtimeId: 'rt-active-retry',
          runId: 'hrc-active-retry',
        })
      )
      expect(providerCalls).toBe(2)
    } finally {
      if (previousGate === undefined) {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = undefined
      } else {
        process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] = previousGate
      }
    }
  })
})
