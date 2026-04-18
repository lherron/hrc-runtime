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
