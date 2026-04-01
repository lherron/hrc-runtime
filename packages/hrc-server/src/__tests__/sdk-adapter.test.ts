/**
 * RED/GREEN tests for hrc-adapter-agent-spaces Phase 2 — SDK adapter (T-00968 / T-00966)
 *
 * Tests the sdk-adapter/ surface of hrc-adapter-agent-spaces:
 *   - runSdkTurn maps HRC intent to runTurnNonInteractive correctly
 *   - Event mapping: each AgentEvent type maps to correct HRC eventKind with source='agent-spaces'
 *   - Buffer callback fires for message_delta and message events
 *   - Continuation is extracted from response
 *   - Provider mismatch throws correct HRC domain error
 *   - Unsupported harness throws UnsupportedHarnessError
 *
 * Pass conditions for Curly (T-00966):
 *   1. runSdkTurn({ harness: { provider: 'anthropic', interactive: false } }) calls runTurnNonInteractive with frontend='agent-sdk'
 *   2. runSdkTurn({ harness: { provider: 'openai', interactive: false } }) calls runTurnNonInteractive with frontend='pi-sdk'
 *   3. runSdkTurn with interactive=true rejects with UnsupportedHarnessError
 *   4. Event mapping: AgentEvent { type: 'state', state: 'running' } → eventKind='sdk.running', source='agent-spaces'
 *   5. Event mapping: AgentEvent { type: 'message', role: 'assistant', content } → eventKind='sdk.message'
 *   6. Event mapping: AgentEvent { type: 'message_delta', delta } → eventKind='sdk.message_delta'
 *   7. Event mapping: AgentEvent { type: 'tool_call' } → eventKind='sdk.tool_call'
 *   8. Event mapping: AgentEvent { type: 'tool_result' } → eventKind='sdk.tool_result'
 *   9. Event mapping: AgentEvent { type: 'complete', result } → eventKind='sdk.complete'
 *  10. Event mapping: AgentEvent { type: 'log' } → eventKind='sdk.log'
 *  11. Buffer callback fires for message_delta events with delta text
 *  12. Buffer callback fires for message events with role=assistant
 *  13. Continuation is returned in SdkTurnResult from runTurnNonInteractive response
 *  14. Provider/frontend fields are returned in SdkTurnResult
 *  15. Provider mismatch (requested vs existing) throws HrcDomainError with code 'provider_mismatch'
 *  16. All event envelopes include hostSessionId, scopeRef, laneRef, generation, runId, runtimeId
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 2
 */
import { describe, expect, it } from 'bun:test'

import type { AgentEvent } from 'agent-spaces'
import type { HrcEventEnvelope, HrcProvider, HrcRuntimeIntent } from 'hrc-core'
import type { RuntimePlacement } from 'spaces-config'

// RED GATE: These imports will fail until Curly implements the SDK adapter module
import {
  type SdkTurnOptions,
  type SdkTurnRunner,
  runSdkTurn,
} from '../agent-spaces-adapter/sdk-adapter'

// ---------------------------------------------------------------------------
// Stub SdkTurnRunner — simulates runTurnNonInteractive without a real
// agent-spaces installation. The adapter's value-add (intent mapping, event
// mapping, buffer callbacks, continuation extraction) is exercised on top.
// ---------------------------------------------------------------------------

/** Base fields shared by all stub AgentEvents */
const STUB_BASE = {
  ts: new Date().toISOString(),
  hostSessionId: 'hsid-test',
  runId: 'run-test',
} as const

function stubEvent(
  seq: number,
  fields: Omit<AgentEvent, 'ts' | 'seq' | 'hostSessionId' | 'runId'>
): AgentEvent {
  return { ...STUB_BASE, seq, ...fields } as AgentEvent
}

function createStubRunner(opts?: {
  events?: AgentEvent[]
  continuation?: { provider: 'anthropic' | 'openai'; key?: string }
}): SdkTurnRunner {
  const events: AgentEvent[] = opts?.events ?? [
    stubEvent(1, { type: 'state', state: 'running' }),
    stubEvent(2, { type: 'message', role: 'assistant', content: 'Hello from SDK' }),
    stubEvent(3, { type: 'complete', result: { success: true, finalOutput: 'Done' } }),
  ]

  return async (req) => {
    for (const event of events) {
      await req.callbacks.onEvent(event)
    }

    return {
      continuation: opts?.continuation ?? {
        provider: req.frontend === 'pi-sdk' ? 'openai' : 'anthropic',
        key: 'cont-key-123',
      },
      provider: req.frontend === 'pi-sdk' ? 'openai' : 'anthropic',
      frontend: req.frontend,
      model: 'test-model',
      result: { success: true, finalOutput: 'Done' },
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_PLACEMENT: RuntimePlacement = {
  agentRoot: '/tmp/agent',
  runMode: 'task',
  bundle: { kind: 'agent-default' },
}

function makeIntent(
  overrides: {
    provider?: 'anthropic' | 'openai'
    interactive?: boolean
    model?: string
  } = {}
): HrcRuntimeIntent {
  return {
    placement: STUB_PLACEMENT,
    harness: {
      provider: overrides.provider ?? 'anthropic',
      interactive: overrides.interactive ?? false,
      model: overrides.model,
    },
  }
}

function makeOptions(overrides: Partial<SdkTurnOptions> = {}): SdkTurnOptions {
  return {
    intent: overrides.intent ?? makeIntent(),
    hostSessionId: overrides.hostSessionId ?? 'hsid-test-001',
    runId: overrides.runId ?? 'run-test-001',
    runtimeId: overrides.runtimeId ?? 'rt-test-001',
    prompt: overrides.prompt ?? 'Say hello',
    scopeRef: overrides.scopeRef ?? 'project:test',
    laneRef: overrides.laneRef ?? 'default',
    generation: overrides.generation ?? 1,
    onHrcEvent: overrides.onHrcEvent ?? (() => {}),
    onBuffer: overrides.onBuffer ?? (() => {}),
    runner: overrides.runner,
    existingProvider: overrides.existingProvider,
    signal: overrides.signal,
  }
}

// ---------------------------------------------------------------------------
// 1. Provider → frontend mapping
// ---------------------------------------------------------------------------
describe('runSdkTurn provider mapping', () => {
  it('maps anthropic provider to agent-sdk frontend', async () => {
    let capturedFrontend: string | undefined
    const runner: SdkTurnRunner = async (req) => {
      capturedFrontend = req.frontend
      return {
        continuation: { provider: 'anthropic', key: 'k' },
        provider: 'anthropic',
        frontend: 'agent-sdk',
        result: { success: true },
      }
    }

    await runSdkTurn(
      makeOptions({
        intent: makeIntent({ provider: 'anthropic' }),
        runner,
      })
    )

    expect(capturedFrontend).toBe('agent-sdk')
  })

  it('maps openai provider to pi-sdk frontend', async () => {
    let capturedFrontend: string | undefined
    const runner: SdkTurnRunner = async (req) => {
      capturedFrontend = req.frontend
      return {
        continuation: { provider: 'openai', key: 'k' },
        provider: 'openai',
        frontend: 'pi-sdk',
        result: { success: true },
      }
    }

    await runSdkTurn(
      makeOptions({
        intent: makeIntent({ provider: 'openai' }),
        runner,
      })
    )

    expect(capturedFrontend).toBe('pi-sdk')
  })
})

// ---------------------------------------------------------------------------
// 2. Interactive harness rejection
// ---------------------------------------------------------------------------
describe('runSdkTurn harness validation', () => {
  it('rejects interactive harness with UnsupportedHarnessError', async () => {
    await expect(
      runSdkTurn(
        makeOptions({
          intent: makeIntent({ interactive: true }),
        })
      )
    ).rejects.toThrow(/unsupported|interactive/i)
  })
})

// ---------------------------------------------------------------------------
// 3. Event mapping — each AgentEvent type → HRC eventKind
// ---------------------------------------------------------------------------
describe('event mapping', () => {
  it('maps state/running to sdk.running', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'state', state: 'running' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const running = events.find((e) => e.eventKind === 'sdk.running')
    expect(running).toBeDefined()
    expect(running!.source).toBe('agent-spaces')
  })

  it('maps assistant message to sdk.message', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'message', role: 'assistant', content: 'Hello' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const msg = events.find((e) => e.eventKind === 'sdk.message')
    expect(msg).toBeDefined()
    expect(msg!.source).toBe('agent-spaces')
    expect(msg!.eventJson!['role']).toBe('assistant')
    expect(msg!.eventJson!['content']).toBe('Hello')
  })

  it('maps message_delta to sdk.message_delta', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'message_delta', role: 'assistant', delta: 'chunk' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const delta = events.find((e) => e.eventKind === 'sdk.message_delta')
    expect(delta).toBeDefined()
    expect(delta!.eventJson!['delta']).toBe('chunk')
  })

  it('maps tool_call to sdk.tool_call', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'tool_call', toolUseId: 'tu-1', toolName: 'read_file', input: {} }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const tc = events.find((e) => e.eventKind === 'sdk.tool_call')
    expect(tc).toBeDefined()
    expect(tc!.eventJson!['toolName']).toBe('read_file')
  })

  it('maps tool_result to sdk.tool_result', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, {
          type: 'tool_result',
          toolUseId: 'tu-1',
          toolName: 'read_file',
          output: 'file contents',
          isError: false,
        }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const tr = events.find((e) => e.eventKind === 'sdk.tool_result')
    expect(tr).toBeDefined()
    expect(tr!.eventJson!['toolName']).toBe('read_file')
  })

  it('maps complete to sdk.complete', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [stubEvent(1, { type: 'complete', result: { success: true, finalOutput: 'Done' } })],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const complete = events.find((e) => e.eventKind === 'sdk.complete')
    expect(complete).toBeDefined()
    expect((complete!.eventJson!['result'] as Record<string, unknown>)['success']).toBe(true)
  })

  it('maps log to sdk.log', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'log', level: 'info', message: 'test log' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    const log = events.find((e) => e.eventKind === 'sdk.log')
    expect(log).toBeDefined()
    expect(log!.eventJson!['level']).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// 4. Event envelope context fields
// ---------------------------------------------------------------------------
describe('event envelope context', () => {
  it('includes hostSessionId, scopeRef, laneRef, generation, runId, runtimeId', async () => {
    const events: Omit<HrcEventEnvelope, 'seq'>[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'state', state: 'running' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        hostSessionId: 'hsid-ctx-test',
        runId: 'run-ctx-test',
        runtimeId: 'rt-ctx-test',
        scopeRef: 'project:ctx',
        laneRef: 'lane-ctx',
        generation: 5,
        runner,
        onHrcEvent: (e) => events.push(e),
      })
    )

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.hostSessionId).toBe('hsid-ctx-test')
      expect(event.scopeRef).toBe('project:ctx')
      expect(event.laneRef).toBe('lane-ctx')
      expect(event.generation).toBe(5)
      expect(event.runId).toBe('run-ctx-test')
      expect(event.runtimeId).toBe('rt-ctx-test')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Buffer callbacks
// ---------------------------------------------------------------------------
describe('buffer callbacks', () => {
  it('fires onBuffer for message_delta events', async () => {
    const bufferChunks: string[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'message_delta', role: 'assistant', delta: 'chunk1' }),
        stubEvent(2, { type: 'message_delta', role: 'assistant', delta: 'chunk2' }),
        stubEvent(3, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onBuffer: (text) => bufferChunks.push(text),
      })
    )

    expect(bufferChunks).toContain('chunk1')
    expect(bufferChunks).toContain('chunk2')
  })

  it('fires onBuffer for assistant message events', async () => {
    const bufferChunks: string[] = []
    const runner = createStubRunner({
      events: [
        stubEvent(1, { type: 'message', role: 'assistant', content: 'Full response' }),
        stubEvent(2, { type: 'complete', result: { success: true } }),
      ],
    })

    await runSdkTurn(
      makeOptions({
        runner,
        onBuffer: (text) => bufferChunks.push(text),
      })
    )

    expect(bufferChunks).toContain('Full response')
  })
})

// ---------------------------------------------------------------------------
// 6. Continuation extraction
// ---------------------------------------------------------------------------
describe('continuation extraction', () => {
  it('returns continuation from runTurnNonInteractive response', async () => {
    const runner = createStubRunner({
      continuation: { provider: 'anthropic', key: 'cont-abc-123' },
    })

    const result = await runSdkTurn(makeOptions({ runner }))

    expect(result.continuation).toBeDefined()
    expect(result.continuation!.provider).toBe('anthropic')
    expect(result.continuation!.key).toBe('cont-abc-123')
  })

  it('returns provider and frontend in result', async () => {
    const runner = createStubRunner()

    const result = await runSdkTurn(
      makeOptions({
        intent: makeIntent({ provider: 'anthropic' }),
        runner,
      })
    )

    expect(result.provider).toBe('anthropic')
    expect(result.frontend).toBe('agent-sdk')
  })
})

// ---------------------------------------------------------------------------
// 7. Provider mismatch
// ---------------------------------------------------------------------------
describe('provider mismatch', () => {
  it('throws when requested provider differs from existing runtime provider', async () => {
    await expect(
      runSdkTurn(
        makeOptions({
          intent: makeIntent({ provider: 'anthropic' }),
          existingProvider: 'openai',
        })
      )
    ).rejects.toThrow(/provider.?mismatch/i)
  })

  it('does not throw when providers match', async () => {
    const runner = createStubRunner()
    const result = await runSdkTurn(
      makeOptions({
        intent: makeIntent({ provider: 'anthropic' }),
        existingProvider: 'anthropic',
        runner,
      })
    )

    expect(result).toBeDefined()
  })

  it('does not throw when no existing provider', async () => {
    const runner = createStubRunner()
    const result = await runSdkTurn(
      makeOptions({
        intent: makeIntent({ provider: 'anthropic' }),
        existingProvider: undefined,
        runner,
      })
    )

    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Step 4 red-gate tests (T-00981): M-11, m-21
//
// RED GATE: These tests exercise error/edge paths that do NOT exist yet:
//   - M-11: runSdkTurn must validate response.provider against HrcProvider union
//   - m-21: runSdkTurn must accept AbortSignal and reject on abort
//
// Pass conditions for Curly (T-00981):
//   1. runSdkTurn throws descriptive error when runner returns invalid provider (M-11)
//   2. runSdkTurn rejects with abort error when signal fires during runner (m-21)
// ---------------------------------------------------------------------------
describe('Step 4 red-gate: adapter contract fixes (T-00981)', () => {
  // -- M-11: Unchecked provider cast in SDK adapter --
  // Current code: `response.provider as HrcProvider` (sdk-adapter/index.ts:276,283)
  // No runtime validation — an unexpected provider string enters the domain silently.
  // Expected: validate response.provider against the HrcProvider union ('anthropic' | 'openai')
  // and throw a descriptive error on mismatch.
  it('M-11: runSdkTurn throws on invalid provider from runner response', async () => {
    const runner: SdkTurnRunner = async (req) => {
      await req.callbacks.onEvent(stubEvent(1, { type: 'complete', result: { success: true } }))

      return {
        continuation: undefined,
        // Intentionally invalid provider string to test validation
        provider: 'unknown-bogus-provider' as 'anthropic',
        frontend: 'agent-sdk',
        result: { success: true },
      }
    }

    // After fix: runSdkTurn must reject with an error about the invalid provider.
    await expect(
      runSdkTurn(
        makeOptions({
          intent: makeIntent({ provider: 'anthropic' }),
          runner,
        })
      )
    ).rejects.toThrow(/invalid provider|provider.?mismatch/i)
  })

  it('M-11: runSdkTurn accepts valid providers without error', async () => {
    // Confirm 'anthropic' and 'openai' still work after validation is added
    for (const provider of ['anthropic', 'openai'] as HrcProvider[]) {
      const runner = createStubRunner()
      const result = await runSdkTurn(
        makeOptions({
          intent: makeIntent({ provider }),
          runner,
        })
      )
      expect(result.provider).toBe(provider)
    }
  })

  // -- m-21: SDK turn has no timeout/cancellation --
  // Current code: SdkTurnOptions has no signal field.
  // runner() call at sdk-adapter/index.ts:237 has no abort handling.
  // Expected: accept optional AbortSignal in SdkTurnOptions, reject when aborted.
  it('m-21: runSdkTurn rejects with abort error when signal fires', async () => {
    const controller = new AbortController()
    let runnerCompleted = false

    const runner: SdkTurnRunner = async (req) => {
      // Simulate a long-running turn — abort fires while waiting
      await new Promise((resolve) => setTimeout(resolve, 200))
      runnerCompleted = true
      await req.callbacks.onEvent(stubEvent(1, { type: 'complete', result: { success: true } }))
      return {
        continuation: undefined,
        provider: 'anthropic',
        frontend: 'agent-sdk',
        result: { success: true },
      }
    }

    // Abort after 50ms — before runner completes at 200ms
    setTimeout(() => controller.abort(), 50)

    // After fix: runSdkTurn should reject when the signal fires at 50ms.
    await expect(
      runSdkTurn(
        makeOptions({
          intent: makeIntent({ provider: 'anthropic' }),
          runner,
          signal: controller.signal,
        })
      )
    ).rejects.toThrow(/abort/i)

    // The abort should have prevented the runner from completing.
    expect(runnerCompleted).toBe(false)
  })
})
