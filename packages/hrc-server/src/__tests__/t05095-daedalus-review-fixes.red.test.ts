/**
 * RED tests for T-05095 (daedalus review fixes for T-05078).
 *
 * These pin two review findings that survived the first T-05078 landing:
 * - when a queue-capable headless broker already has a live active run,
 *   dispatchTurn(..., whenBusy:'reject') must reject at admission with
 *   runtime_busy and create zero run/broker/lifecycle side effects.
 * - /v1/broker-events must return exactly the persisted broker_envelope_json;
 *   read-time DB correlation joins are not wire authority.
 *
 * Run with:
 *   TMPDIR=/tmp bun run --filter hrc-server test t05095-daedalus-review-fixes
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcErrorCode } from 'hrc-core'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import {
  CALLER_SURFACE_REUSE_REFUSAL,
  decideInteractiveBrokerAdmission,
  normalizeClaudeInteractiveBrokerIntent,
  refusesSurfaceReuse,
} from '../index'

import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'
import { createT05095Helpers } from './fixtures/t05095-review.fixture'

const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05095'
const PROVIDER = 'openai' as const
let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let headlessBrokerIntent: ReturnType<typeof createT05095Helpers>['headlessBrokerIntent']
let codexHeadlessIntent: ReturnType<typeof createT05095Helpers>['codexHeadlessIntent']
let codexInteractiveIntent: ReturnType<typeof createT05095Helpers>['codexInteractiveIntent']
let claudeSdkIntent: ReturnType<typeof createT05095Helpers>['claudeSdkIntent']
let installDispatchInputSpy: ReturnType<typeof createT05095Helpers>['installDispatchInputSpy']
let installMapperBackedDispatchInputSpy: ReturnType<
  typeof createT05095Helpers
>['installMapperBackedDispatchInputSpy']
let seedQueueCapableBrokerWithLiveRun: ReturnType<
  typeof createT05095Helpers
>['seedQueueCapableBrokerWithLiveRun']
let seedReadyBrokerRuntime: ReturnType<typeof createT05095Helpers>['seedReadyBrokerRuntime']
let runIdsForRuntime: ReturnType<typeof createT05095Helpers>['runIdsForRuntime']
let runtimeControlState: ReturnType<typeof createT05095Helpers>['runtimeControlState']
let eventKindsForRuntime: ReturnType<typeof createT05095Helpers>['eventKindsForRuntime']
let turnUserPromptEventsForRuntime: ReturnType<
  typeof createT05095Helpers
>['turnUserPromptEventsForRuntime']
let persistedBrokerEnvelopes: ReturnType<typeof createT05095Helpers>['persistedBrokerEnvelopes']
let seedBrokerEventFixture: ReturnType<typeof createT05095Helpers>['seedBrokerEventFixture']
let readBrokerEvents: ReturnType<typeof createT05095Helpers>['readBrokerEvents']
let ALL_BROKERS: ReturnType<typeof createT05095Helpers>['ALL_BROKERS']

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t05095-review-fixes-')
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      claudeCodeTmuxBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: true,
      otelListenerEnabled: false,
    })
  )
  ;({
    headlessBrokerIntent,
    codexHeadlessIntent,
    codexInteractiveIntent,
    claudeSdkIntent,
    installDispatchInputSpy,
    installMapperBackedDispatchInputSpy,
    seedQueueCapableBrokerWithLiveRun,
    seedReadyBrokerRuntime,
    runIdsForRuntime,
    runtimeControlState,
    eventKindsForRuntime,
    turnUserPromptEventsForRuntime,
    persistedBrokerEnvelopes,
    seedBrokerEventFixture,
    readBrokerEvents,
    ALL_BROKERS,
  } = createT05095Helpers(fixture, () => server))
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('T-05095 finding 1 — queue-capable broker busy reject is admission-fenced', () => {
  it('whenBusy:reject rejects a live queue-capable headless broker with zero side effects', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-queue-capable-busy'
    const invocationId = 'inv-t05095-queue-capable-busy'
    const activeRunId = 'run-t05095-active'

    seedQueueCapableBrokerWithLiveRun({
      hostSessionId,
      generation,
      runtimeId,
      invocationId,
      activeRunId,
    })
    const dispatchSpy = installDispatchInputSpy()
    const runIdsBefore = runIdsForRuntime(runtimeId)
    const userPromptsBefore = turnUserPromptEventsForRuntime(runtimeId)

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'second session input must reject, not queue',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
      whenBusy: 'reject',
    })

    // RED today: the queue-capable path ignores the explicit reject marker,
    // allocates a new run, emits turn.user_prompt, and calls dispatchInput.
    const body = (await res.json()) as any
    expect({
      status: res.status,
      errorCode: body.error?.code,
      runIds: runIdsForRuntime(runtimeId),
      dispatchInputCalls: dispatchSpy.calls.length,
      turnUserPromptCount: turnUserPromptEventsForRuntime(runtimeId).length,
    }).toEqual({
      status: 409,
      errorCode: HrcErrorCode.RUNTIME_BUSY,
      runIds: runIdsBefore,
      dispatchInputCalls: 0,
      turnUserPromptCount: userPromptsBefore.length,
    })
  }, 15_000)
})

describe('T-05095 regression guard — interactive live-TUI queue is preserved', () => {
  it('busy queue-capable interactive broker receives queued dispatchInput', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-interactive-queue'
    const invocationId = 'inv-t05095-interactive-queue'
    const activeRunId = 'run-t05095-interactive-active'

    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId,
      invocationId,
      transport: 'tmux',
      status: 'ready',
      activeRunId,
      capabilitiesJson: { input: { queue: true } },
    })
    const dispatchSpy = installDispatchInputSpy()
    const runIdsBefore = runIdsForRuntime(runtimeId)

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'deliver this into the live TUI queue',
      runtimeIntent: codexInteractiveIntent(),
      waitForCompletion: false,
    })

    expect(res.status).toBe(202)
    const body = (await res.json()) as any
    expect(body.runtimeId).toBe(runtimeId)
    expect(runIdsForRuntime(runtimeId)).toHaveLength(runIdsBefore.length + 1)
    expect(dispatchSpy.calls).toHaveLength(1)
    expect(dispatchSpy.calls[0]).toMatchObject({
      runtimeId,
      policy: { whenBusy: 'queue' },
    })
  }, 15_000)

  it('T-05177: explicit false reuse veto keeps same-session codex dispatch on the headless broker route', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const interactiveRuntimeId = 'rt-t05177-live-tui-veto'
    const headlessRuntimeId = 'rt-t05177-headless-veto'

    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: interactiveRuntimeId,
      invocationId: 'inv-t05177-live-tui-veto',
      transport: 'tmux',
    })
    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: headlessRuntimeId,
      invocationId: 'inv-t05177-headless-veto',
      transport: 'headless',
    })
    const dispatchSpy = installDispatchInputSpy()
    const vetoedIntent: HrcRuntimeIntent = {
      ...codexHeadlessIntent(),
      execution: {
        preferredMode: 'nonInteractive',
        allowInteractiveSurfaceReuse: false,
      },
    }

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'autonomous verifier must not land in the live TUI',
      runtimeIntent: vetoedIntent,
      waitForCompletion: false,
    })

    expect(res.status).toBe(202)
    const body = (await res.json()) as { runtimeId?: string }
    expect(body.runtimeId).toBe(headlessRuntimeId)
    expect(dispatchSpy.calls).toHaveLength(1)
    expect(dispatchSpy.calls[0]).toMatchObject({ runtimeId: headlessRuntimeId })
  }, 15_000)

  it('T-05177 guard: omitted reuse flag still delivers codex headless-preferred DM into the live TUI', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const interactiveRuntimeId = 'rt-t05177-live-tui-default'
    const headlessRuntimeId = 'rt-t05177-headless-default'

    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: interactiveRuntimeId,
      invocationId: 'inv-t05177-live-tui-default',
      transport: 'tmux',
    })
    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: headlessRuntimeId,
      invocationId: 'inv-t05177-headless-default',
      transport: 'headless',
    })
    const dispatchSpy = installDispatchInputSpy()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'operator DM should still land in the live TUI',
      runtimeIntent: codexHeadlessIntent(),
      waitForCompletion: false,
    })

    expect(res.status).toBe(202)
    const body = (await res.json()) as { runtimeId?: string }
    expect(body.runtimeId).toBe(interactiveRuntimeId)
    expect(dispatchSpy.calls).toHaveLength(1)
    expect(dispatchSpy.calls[0]).toMatchObject({
      runtimeId: interactiveRuntimeId,
      policy: { whenBusy: 'queue' },
    })
  }, 15_000)

  // -------------------------------------------------------------------------
  // T-07397 (daedalus-approved v4) replacement assertions.
  //
  // These REPLACE the old "explicit false reuse veto prevents Claude SDK
  // normalization into the live TUI" test, which asserted the refused claude
  // turn lands on a HEADLESS runtime. That state has no executor: headless
  // claude resolves to `legacy-exec`, which is retired, so the assertion
  // described a hard 503 in production. The refusal is still honoured — it just
  // fails loudly instead of being routed into a dead end, and it no longer
  // vetoes the claude-code-tmux redirect.
  // -------------------------------------------------------------------------

  it('(a) T-07397: refusal + healthy live claude TUI fails normally and mutates NOTHING', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const interactiveRuntimeId = 'rt-t07397-claude-live-tui-refusal'
    const operatorRunId = 'run-t07397-operator-in-flight'
    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: interactiveRuntimeId,
      invocationId: 'inv-t07397-claude-live-tui-refusal',
      transport: 'tmux',
      status: 'ready',
      activeRunId: operatorRunId,
      provider: 'anthropic',
      harness: 'claude-code',
      brokerDriver: 'claude-code-tmux',
    })
    const dispatchSpy = installDispatchInputSpy()
    const before = runtimeControlState(interactiveRuntimeId)
    const kindsBefore = eventKindsForRuntime(interactiveRuntimeId)

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'autonomous claude dispatch refusing to reuse the operator surface',
      runtimeIntent: claudeSdkIntent(false),
      waitForCompletion: false,
    })

    // Fails loudly, and names WHY so the caller can act on it.
    expect(res.status).toBe(503)
    const body = (await res.json()) as any
    expect(body.error?.code).toBe(HrcErrorCode.RUNTIME_UNAVAILABLE)
    expect(body.error?.message).toBe(CALLER_SURFACE_REUSE_REFUSAL)
    expect(body.error?.detail?.reason).toBe(CALLER_SURFACE_REUSE_REFUSAL)

    // ZERO mutation of the operator's runtime — the Flaw 2 boundary. A refusal
    // to be delivered into a surface is not authority to invalidate it.
    expect(runtimeControlState(interactiveRuntimeId)).toEqual(before)
    expect(runtimeControlState(interactiveRuntimeId).activeRunId).toBe(operatorRunId)
    expect(eventKindsForRuntime(interactiveRuntimeId)).toEqual(kindsBefore)
    expect(eventKindsForRuntime(interactiveRuntimeId)).not.toContain('runtime.stale')
    expect(dispatchSpy.calls).toHaveLength(0)
  }, 15_000)

  it('(b) T-07397: refusal + FREE scope reaches the broker route, never the legacy-exec 503', async () => {
    // Pure decision: nothing live on the scope → a fresh claude-code-tmux pane.
    // Not reuse, so the refusal has nothing to refuse and no state is touched.
    expect(
      decideInteractiveBrokerAdmission(
        normalizeClaudeInteractiveBrokerIntent(claudeSdkIntent(false)),
        null,
        ALL_BROKERS
      )
    ).toEqual({
      decision: 'broker-start',
      flagEnvName: expect.any(String),
      allowedBrokerDriver: 'claude-code-tmux',
    })

    // End to end on a free scope: whatever else happens in a fixture that has no
    // real tmux, the retired legacy-exec route must NOT be what we land on.
    // That 503 was the entire T-07397 outage.
    const { hostSessionId } = await fixture.resolveSession(SCOPE_REF)
    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'autonomous claude dispatch on a free scope',
      runtimeIntent: claudeSdkIntent(false),
      waitForCompletion: false,
    })
    if (res.status >= 400) {
      const body = (await res.json()) as any
      expect(body.error?.message).not.toBe('headless legacy execution is unavailable')
      expect(body.error?.detail?.route).not.toBe('legacy-exec')
    }
  }, 15_000)

  it('(c) T-07397 Flaw 1 trap: the refusal survives claude interactive normalization', async () => {
    const submitted = claudeSdkIntent(false)
    expect(refusesSurfaceReuse(submitted)).toBe(true)
    // normalizeClaudeInteractiveBrokerIntent rewrites harness.interactive and
    // execution.preferredMode — the exact two fields a mode-entangled reading
    // keys on. The predicate must not flip, or an autonomous dispatch is
    // silently readmitted into a live operator TUI.
    const normalized = normalizeClaudeInteractiveBrokerIntent(submitted)
    expect(normalized.harness.interactive).toBe(true)
    expect(normalized.execution?.preferredMode).toBe('interactive')
    expect(refusesSurfaceReuse(normalized)).toBe(true)
    // And a caller that did NOT refuse still does not, after normalization.
    expect(
      refusesSurfaceReuse(normalizeClaudeInteractiveBrokerIntent(claudeSdkIntent(undefined)))
    ).toBe(false)
  })

  // ---- v7 (approved) — surface OWNERSHIP, proven by exact invocation identity.
  // v4 refused any healthy matching live runtime, which broke multi-turn
  // sessions from turn 2 (a scope stops being free once turn 1 runs) — found by
  // live e2e, C-15300. v7 lets a refusing caller continue the invocation IT
  // established, and only that one.

  const CLAUDE_TUI = {
    controllerKind: 'harness-broker' as const,
    transport: 'tmux',
    status: 'ready',
    provider: 'anthropic' as const,
    brokerDriver: 'claude-code-tmux' as const,
    inputDispatchable: true,
    activeInvocationId: 'inv-owned-by-this-caller',
  }
  const refusingClaude = () => normalizeClaudeInteractiveBrokerIntent(claudeSdkIntent(false))

  it('(e) T-07397 v7: a refusing caller MAY continue the invocation it established', async () => {
    // The C-15300 trap: this is session turn 2+ on the caller's own pane.
    expect(
      decideInteractiveBrokerAdmission(refusingClaude(), CLAUDE_TUI, {
        ...ALL_BROKERS,
        establishedBrokerInvocationId: 'inv-owned-by-this-caller',
      })
    ).toEqual({ decision: 'broker-reuse', allowedBrokerDriver: 'claude-code-tmux' })
  })

  it('(f) T-07397 v7: absent or mismatched identity never reuses', async () => {
    // Absent — a first turn owns nothing yet, and a cross-caller dispatch that
    // simply omits the field must not be handed someone else's surface.
    expect(decideInteractiveBrokerAdmission(refusingClaude(), CLAUDE_TUI, ALL_BROKERS)).toEqual({
      decision: 'runtime-unavailable',
      reason: CALLER_SURFACE_REUSE_REFUSAL,
    })
    // Mismatched — a different caller naming ITS invocation cannot borrow this one.
    expect(
      decideInteractiveBrokerAdmission(refusingClaude(), CLAUDE_TUI, {
        ...ALL_BROKERS,
        establishedBrokerInvocationId: 'inv-belongs-to-someone-else',
      })
    ).toEqual({ decision: 'runtime-unavailable', reason: CALLER_SURFACE_REUSE_REFUSAL })
  })

  it('(g) T-07397 v7: a STALE identity loses ownership when the surface rotates', async () => {
    // The operator's pane restarted, so the runtime is driving a new invocation.
    // A caller holding the old id no longer owns this surface and must be refused
    // — ownership is exact identity against the ACTIVE invocation, never "was
    // mine once" and never "is a claude-code-tmux runtime". This is the Flaw 2
    // boundary: the refusal must not become authority over the operator's pane.
    expect(
      decideInteractiveBrokerAdmission(
        refusingClaude(),
        { ...CLAUDE_TUI, activeInvocationId: 'inv-after-operator-restart' },
        { ...ALL_BROKERS, establishedBrokerInvocationId: 'inv-owned-by-this-caller' }
      )
    ).toEqual({ decision: 'runtime-unavailable', reason: CALLER_SURFACE_REUSE_REFUSAL })
    // A runtime with no active invocation matches nothing, whatever is carried.
    const { activeInvocationId: _dropped, ...noActive } = CLAUDE_TUI
    expect(
      decideInteractiveBrokerAdmission(refusingClaude(), noActive, {
        ...ALL_BROKERS,
        establishedBrokerInvocationId: 'inv-owned-by-this-caller',
      })
    ).toEqual({ decision: 'runtime-unavailable', reason: CALLER_SURFACE_REUSE_REFUSAL })
  })

  it('(h) T-07397 v7: a true multi-turn session runs turn 1 then continues on turn 2', async () => {
    const intent = refusingClaude()
    // Turn 1: scope free -> fresh pane. The session now owns invocation X.
    const turn1 = decideInteractiveBrokerAdmission(intent, null, ALL_BROKERS)
    expect(turn1.decision).toBe('broker-start')
    const established = 'inv-session-turn-1'
    const liveAfterTurn1 = { ...CLAUDE_TUI, activeInvocationId: established }
    // Turn 2 carrying it: continues the SAME pane — this is the continuity that
    // T-07397 exists to restore.
    expect(
      decideInteractiveBrokerAdmission(intent, liveAfterTurn1, {
        ...ALL_BROKERS,
        establishedBrokerInvocationId: established,
      }).decision
    ).toBe('broker-reuse')
    // Turn 2 WITHOUT it reproduces the C-15300 failure exactly — pinned so the
    // regression cannot return silently.
    expect(decideInteractiveBrokerAdmission(intent, liveAfterTurn1, ALL_BROKERS)).toEqual({
      decision: 'runtime-unavailable',
      reason: CALLER_SURFACE_REUSE_REFUSAL,
    })
  })

  it('(i) T-07397 v7: identity is inside the idempotency fence', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: 'rt-t07397-idem',
      invocationId: 'inv-t07397-idem',
      transport: 'tmux',
      status: 'ready',
      provider: 'anthropic',
      harness: 'claude-code',
      brokerDriver: 'claude-code-tmux',
    })
    installDispatchInputSpy()
    const key = 'idem-t07397-identity'
    const post = (extra: Record<string, unknown>) =>
      fixture.postJson('/v1/turns', {
        hostSessionId,
        prompt: 'same prompt, same key',
        runtimeIntent: claudeSdkIntent(false),
        waitForCompletion: false,
        idempotencyKey: key,
        ...extra,
      })

    // First use of the key, carrying an identity.
    const first = await post({ establishedBrokerInvocationId: 'inv-t07397-idem' })
    // Replaying the SAME key with the identity REMOVED, or SUBSTITUTED, is a
    // different semantic request and must be rejected — otherwise a replay could
    // launder ownership of a surface the replaying caller does not hold.
    for (const substitution of [{}, { establishedBrokerInvocationId: 'inv-someone-else' }]) {
      const replay = await post(substitution)
      expect(replay.status).toBe(409)
      const body = (await replay.json()) as any
      expect(body.error?.code).toBe(HrcErrorCode.STALE_CONTEXT)
    }
    // The identical request replays idempotently rather than dispatching twice.
    const same = await post({ establishedBrokerInvocationId: 'inv-t07397-idem' })
    expect(same.status).toBe(first.status)
    expect(runIdsForRuntime('rt-t07397-idem').length).toBeLessThanOrEqual(1)
  }, 20_000)

  it('(d) T-07397 codex control: admission decisions unchanged for openai intents', async () => {
    const codex = codexInteractiveIntent()
    const healthyCodexTui = {
      controllerKind: 'harness-broker' as const,
      transport: 'tmux',
      status: 'ready',
      provider: PROVIDER,
      brokerDriver: 'codex-cli-tmux' as const,
      inputDispatchable: true,
    }

    // free scope
    expect(decideInteractiveBrokerAdmission(codex, null, ALL_BROKERS).decision).toBe('broker-start')
    // healthy matching live runtime → reuse, exactly as before T-07397
    expect(decideInteractiveBrokerAdmission(codex, healthyCodexTui, ALL_BROKERS).decision).toBe(
      'broker-reuse'
    )
    // unhealthy by the EXISTING health rules → stale-and-reprovision, and the
    // cause is the runtime's own state, never a caller refusal
    expect(
      decideInteractiveBrokerAdmission(
        codex,
        { ...healthyCodexTui, inputDispatchable: false },
        ALL_BROKERS
      ).decision
    ).toBe('stale-and-reprovision')
  })

  it('T-05177 guard: omitted reuse flag still normalizes Claude SDK dispatch into the live TUI', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const interactiveRuntimeId = 'rt-t05177-claude-live-tui-default'
    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId: interactiveRuntimeId,
      invocationId: 'inv-t05177-claude-live-tui-default',
      transport: 'tmux',
      provider: 'anthropic',
      harness: 'claude-code',
      brokerDriver: 'claude-code-tmux',
    })
    const dispatchSpy = installDispatchInputSpy()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'operator Claude SDK DM should still land in the live TUI',
      runtimeIntent: claudeSdkIntent(undefined),
      waitForCompletion: false,
    })

    expect(res.status).toBe(202)
    const body = (await res.json()) as { runtimeId?: string }
    expect(body.runtimeId).toBe(interactiveRuntimeId)
    expect(dispatchSpy.calls).toHaveLength(1)
    expect(dispatchSpy.calls[0]).toMatchObject({ runtimeId: interactiveRuntimeId })
  }, 15_000)
})

describe('T-05095 finding 2 — /v1/broker-events wire authority is persisted envelope JSON', () => {
  it('returns a non-repair envelope without read-time correlation injected from the run row', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-raw-exact'
    const runId = 'run-t05095-raw-exact'
    const invocationId = 'inv-t05095-raw-exact'
    const persistedEnvelope: InvocationEventEnvelope = {
      invocationId,
      seq: 1,
      time: new Date().toISOString(),
      type: 'assistant.message.completed',
      itemId: 'item-t05095-exact' as InvocationEventEnvelope['itemId'],
      payload: { id: 'item-t05095-exact', text: 'persisted only' } as any,
    }

    seedBrokerEventFixture({
      hostSessionId,
      runtimeId,
      runId,
      invocationId,
      generation,
      envelope: persistedEnvelope,
      runCorrelation: {
        kind: 'json_repair',
        sourceRunId: 'run-previous',
        failedValidationRunId: 'run-previous',
        repairRunId: runId,
      },
    })

    const events = await readBrokerEvents({ invocationId, runId, runtimeId, generation })

    // RED today: parseBrokerEnvelopeRow injects runs.correlation_json during
    // read, so the HTTP body is not JSON.parse(broker_envelope_json).
    expect(events).toEqual([persistedEnvelope])
    expect((events[0] as any).correlation).toBeUndefined()
  })

  it('does not overwrite broker-provided correlation while removing DB-side joins', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-broker-corr'
    const runId = 'run-t05095-broker-corr'
    const invocationId = 'inv-t05095-broker-corr'
    const brokerCorrelation = { brokerOwned: true, requestId: 'req-from-broker' }
    const persistedEnvelope: InvocationEventEnvelope = {
      invocationId,
      seq: 1,
      time: new Date().toISOString(),
      type: 'turn.completed',
      payload: { status: 'completed', finalOutput: 'done' } as any,
      correlation: brokerCorrelation,
    } as InvocationEventEnvelope

    seedBrokerEventFixture({
      hostSessionId,
      runtimeId,
      runId,
      invocationId,
      generation,
      envelope: persistedEnvelope,
      runCorrelation: {
        kind: 'json_repair',
        sourceRunId: 'run-db-should-not-win',
        failedValidationRunId: 'run-db-should-not-win',
        repairRunId: runId,
      },
    })

    const events = await readBrokerEvents({ invocationId, runId, runtimeId, generation })

    // Guard: the implementation must remove DB-side injection without
    // stripping or replacing correlation that the broker actually persisted.
    expect(events).toEqual([persistedEnvelope])
    expect((events[0] as any).correlation).toEqual(brokerCorrelation)
  })
})

describe('T-05095 finding 2 — repair correlation is write-time envelope authority', () => {
  it('persists json_repair correlation into broker_envelope_json before any read path', async () => {
    const { hostSessionId, generation } = await fixture.resolveSession(SCOPE_REF)
    const runtimeId = 'rt-t05095-repair-write-time'
    const invocationId = 'inv-t05095-repair-write-time'
    const sourceRunId = 'run-t05095-repair-source'

    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId,
      invocationId,
      capabilitiesJson: { input: { queue: true } },
    })
    installMapperBackedDispatchInputSpy()

    const res = await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'repair the previous JSON',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
      repair: {
        kind: 'json_repair',
        sourceRunId,
        failedValidationRunId: sourceRunId,
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const persisted = persistedBrokerEnvelopes(invocationId)

    // RED today: the run has correlation_json, and /v1/broker-events can inject
    // it at read time, but broker_envelope_json itself is still uncorrelated.
    expect({
      repairRunId: body.runId,
      persistedCorrelationSourceRunIds: persisted.map((event) => event.correlation?.sourceRunId),
    }).toEqual({
      repairRunId: body.runId,
      persistedCorrelationSourceRunIds: persisted.map(() => sourceRunId),
    })
  }, 15_000)
})

describe('T-05095 dispatch DTO — malformed whenBusy is rejected at parse time', () => {
  it('rejects whenBusy:queue with unsupported_when_busy before run, broker input, or prompt events', async () => {
    const scopeRef = `${SCOPE_REF}:role:malformed-when-busy`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = 'rt-t05095-malformed-when-busy'
    const invocationId = 'inv-t05095-malformed-when-busy'

    seedReadyBrokerRuntime({
      hostSessionId,
      generation,
      runtimeId,
      invocationId,
      scopeRef,
      capabilitiesJson: { input: { queue: true } },
    })
    const dispatchSpy = installDispatchInputSpy()
    const runIdsBefore = runIdsForRuntime(runtimeId)
    const userPromptsBefore = turnUserPromptEventsForRuntime(runtimeId)

    const req = {
      hostSessionId,
      prompt: 'queue is not accepted on the agent-loop seam',
      runtimeIntent: headlessBrokerIntent(),
      waitForCompletion: false,
      whenBusy: 'queue',
    } as any
    const res = await fixture.postJson('/v1/turns', req)
    const body = (await res.json()) as any

    // T-05097: keep the T-05095 no-side-effects guard, but require the
    // 422-native unsupported_when_busy code instead of malformed_request.
    expect({
      status: res.status,
      errorCode: body.error?.code,
      runIds: runIdsForRuntime(runtimeId),
      dispatchInputCalls: dispatchSpy.calls.length,
      turnUserPromptCount: turnUserPromptEventsForRuntime(runtimeId).length,
    }).toEqual({
      status: 422,
      errorCode: 'unsupported_when_busy',
      runIds: runIdsBefore,
      dispatchInputCalls: 0,
      turnUserPromptCount: userPromptsBefore.length,
    })
  }, 15_000)
})
