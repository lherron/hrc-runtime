/**
 * RED/GREEN tests for hrc-adapter-agent-spaces Phase 3 — In-Flight Input Adapter (T-00969)
 *
 * Tests the adapter's in-flight input capability and delivery surface:
 *   - getSdkInflightCapability('anthropic') returns true (agent-sdk supports in-flight)
 *   - getSdkInflightCapability('openai') returns false (pi-sdk does not)
 *   - deliverSdkInflightInput calls queueInFlightInput with correct args
 *   - deliverSdkInflightInput emits sdk.inflight_delivered event on success
 *   - deliverSdkInflightInput returns { accepted, pendingTurns } from upstream
 *   - deliverSdkInflightInput propagates errors from queueInFlightInput
 *
 * Pass conditions for Curly (T-00969):
 *   1. Export `getSdkInflightCapability(provider: HrcProvider): boolean` from sdk-adapter/
 *      - returns true for 'anthropic'
 *      - returns false for 'openai'
 *   2. Export `deliverSdkInflightInput(options: SdkInflightInputOptions): Promise<SdkInflightInputResult>`
 *      from sdk-adapter/
 *   3. SdkInflightInputOptions must accept:
 *      - hostSessionId, runId, runtimeId, prompt (required)
 *      - scopeRef, laneRef, generation (for event envelope)
 *      - onHrcEvent callback (for emitting events)
 *      - client?: { queueInFlightInput } (injectable stub for testing)
 *   4. SdkInflightInputResult: { accepted: boolean, pendingTurns?: number }
 *   5. deliverSdkInflightInput calls client.queueInFlightInput with
 *      { hostSessionId, runId, prompt }
 *   6. On success, fires onHrcEvent with eventKind='sdk.inflight_delivered',
 *      source='agent-spaces', and eventJson containing prompt/accepted
 *   7. Returns the upstream response shape { accepted, pendingTurns }
 *   8. If queueInFlightInput throws, the error propagates (no swallowing)
 *
 * Re-exported from packages/hrc-adapter-agent-spaces/src/index.ts
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 3
 */
import { describe, expect, it } from 'bun:test'

import type { HrcEventEnvelope } from 'hrc-core'

// RED GATE: These imports will fail until Curly implements the in-flight adapter functions
import {
  type SdkInflightInputOptions,
  deliverSdkInflightInput,
  getSdkInflightCapability,
} from '../agent-spaces-adapter/sdk-adapter'

// ---------------------------------------------------------------------------
// Stub client — simulates agent-spaces queueInFlightInput
// ---------------------------------------------------------------------------
function createStubClient(opts?: {
  accepted?: boolean
  pendingTurns?: number
  throwError?: Error
}) {
  const calls: Array<{ hostSessionId: string; runId: string; prompt: string }> = []

  return {
    calls,
    queueInFlightInput: async (req: {
      hostSessionId: string
      runId: string
      prompt: string
    }): Promise<{ accepted: boolean; pendingTurns?: number }> => {
      calls.push(req)

      if (opts?.throwError) {
        throw opts.throwError
      }

      return {
        accepted: opts?.accepted ?? true,
        pendingTurns: opts?.pendingTurns ?? 0,
      }
    },
  }
}

function makeInflightOptions(
  overrides: Partial<SdkInflightInputOptions> = {}
): SdkInflightInputOptions {
  return {
    hostSessionId: overrides.hostSessionId ?? 'hsid-inflight-test-001',
    runId: overrides.runId ?? 'run-inflight-test-001',
    runtimeId: overrides.runtimeId ?? 'rt-inflight-test-001',
    prompt: overrides.prompt ?? 'Additional user context',
    scopeRef: overrides.scopeRef ?? 'project:test',
    laneRef: overrides.laneRef ?? 'default',
    generation: overrides.generation ?? 1,
    onHrcEvent: overrides.onHrcEvent ?? (() => {}),
    client: overrides.client,
  }
}

// ---------------------------------------------------------------------------
// 1. getSdkInflightCapability — anthropic returns true
// ---------------------------------------------------------------------------
describe('getSdkInflightCapability', () => {
  it('returns true for anthropic provider (agent-sdk supports in-flight)', () => {
    expect(getSdkInflightCapability('anthropic')).toBe(true)
  })

  it('returns false for openai provider (pi-sdk does not support in-flight)', () => {
    expect(getSdkInflightCapability('openai')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. deliverSdkInflightInput — calls queueInFlightInput with correct args
// ---------------------------------------------------------------------------
describe('deliverSdkInflightInput argument passing', () => {
  it('passes hostSessionId, runId, and prompt to queueInFlightInput', async () => {
    const client = createStubClient()

    await deliverSdkInflightInput(
      makeInflightOptions({
        hostSessionId: 'hsid-arg-test',
        runId: 'run-arg-test',
        prompt: 'Test prompt for in-flight',
        client,
      })
    )

    expect(client.calls.length).toBe(1)
    expect(client.calls[0].hostSessionId).toBe('hsid-arg-test')
    expect(client.calls[0].runId).toBe('run-arg-test')
    expect(client.calls[0].prompt).toBe('Test prompt for in-flight')
  })
})

// ---------------------------------------------------------------------------
// 3. deliverSdkInflightInput — emits sdk.inflight_delivered event
// ---------------------------------------------------------------------------
describe('deliverSdkInflightInput event emission', () => {
  it('emits sdk.inflight_delivered event with source=agent-spaces on success', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const client = createStubClient({ accepted: true, pendingTurns: 2 })

    await deliverSdkInflightInput(
      makeInflightOptions({
        hostSessionId: 'hsid-event-test',
        runId: 'run-event-test',
        runtimeId: 'rt-event-test',
        scopeRef: 'project:event-test',
        laneRef: 'lane-event',
        generation: 3,
        prompt: 'Event test prompt',
        client,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const delivered = events.find((e) => e.eventKind === 'sdk.inflight_delivered')
    expect(delivered).toBeDefined()
    expect(delivered!.source).toBe('agent-spaces')
    expect(delivered!.hostSessionId).toBe('hsid-event-test')
    expect(delivered!.runId).toBe('run-event-test')
    expect(delivered!.runtimeId).toBe('rt-event-test')
    expect(delivered!.scopeRef).toBe('project:event-test')
    expect(delivered!.laneRef).toBe('lane-event')
    expect(delivered!.generation).toBe(3)
    expect((delivered!.eventJson as any).prompt).toBe('Event test prompt')
    expect((delivered!.eventJson as any).accepted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. deliverSdkInflightInput — returns upstream response shape
// ---------------------------------------------------------------------------
describe('deliverSdkInflightInput return value', () => {
  it('returns { accepted, pendingTurns } from upstream response', async () => {
    const client = createStubClient({ accepted: true, pendingTurns: 3 })

    const result = await deliverSdkInflightInput(makeInflightOptions({ client }))

    expect(result.accepted).toBe(true)
    expect(result.pendingTurns).toBe(3)
  })

  it('returns accepted=false when upstream rejects', async () => {
    const client = createStubClient({ accepted: false, pendingTurns: 0 })

    const result = await deliverSdkInflightInput(makeInflightOptions({ client }))

    expect(result.accepted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. deliverSdkInflightInput — propagates errors
// ---------------------------------------------------------------------------
describe('deliverSdkInflightInput error propagation', () => {
  it('propagates errors from queueInFlightInput without swallowing', async () => {
    const client = createStubClient({
      throwError: new Error('upstream connection failed'),
    })

    await expect(deliverSdkInflightInput(makeInflightOptions({ client }))).rejects.toThrow(
      'upstream connection failed'
    )
  })
})
