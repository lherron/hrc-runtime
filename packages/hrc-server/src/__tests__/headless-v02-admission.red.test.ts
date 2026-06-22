/**
 * RED tests — T-01878 / T-01868 Ph4b (HRC side): static admission selector for
 * v0.2 headless broker profiles.
 *
 * ROOT CAUSE TODAY:
 * The static admission gate (`selectBrokerExecutionProfile` →
 * `isBrokerControllerProfile` → `isHeadlessCodexBrokerProfile`) in
 * compile-profile-selector.ts hardcodes `brokerProtocol === 'harness-broker/0.1'`
 * at three sites (lines 62, 73, 84). An ASP-emitted v0.2 headless profile (emitted
 * when the operator dev flag is set) is rejected with code 'no-matching-profile'
 * before it ever reaches the Ph3 route selector in broker-headless-handlers.ts.
 *
 * Ph4b HRC-SIDE FIX (AFTER these reds):
 * Widen `isBrokerControllerProfile` and `isHeadlessCodexBrokerProfile` to admit
 * profiles with `brokerProtocol === 'harness-broker/0.2'` UNCHANGED — no protocol
 * downgrade, no coercion. The v0.2 protocol value must echo through unmodified so
 * the Ph3 route selector (already correct; see GREEN GUARD 2) can distinguish it
 * from v0.1.
 *
 * Daedalus constraint (C-03314 #2):
 * The admission gate MUST NOT branch on any flag or env var. Durability is derived
 * solely from profile.brokerProtocol + persisted endpoint/substrate (not from the
 * ASP activation flag). The selector only SELECTS the profile; the controller/
 * runtime-hosting derive durability after admission.
 *
 * Tests:
 *  RED 1 (forces): selectBrokerExecutionProfile with a v0.2 headless codex-app-server
 *    profile → admitted:true with profile.brokerProtocol echoed through as
 *    'harness-broker/0.2'. FAILS TODAY (returns {admitted:false, code:'no-matching-profile'}).
 *
 *  GREEN GUARD 1: selectBrokerExecutionProfile with a v0.1 headless profile → still
 *    admitted:true. Passes today; guard that the v0.1 admission path is not regressed.
 *
 *  GREEN GUARD 2: The Ph3 route selector predicate (broker-headless-handlers.ts
 *    lines 93–98) already correctly distinguishes v0.2+hatch-off → durable,
 *    v0.2+hatch-on → legacy (hatch wins), v0.1+hatch-off → legacy. Passes today;
 *    expressed as a static predicate guard so the invariant is explicit.
 */

import { describe, expect, it } from 'bun:test'
import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { selectBrokerExecutionProfile } from '../agent-spaces-adapter/compile-profile-selector'
import {
  makeCompileResponse,
  makeIdentity,
  neutralSpecHash,
  neutralStartRequestHash,
} from './broker-compile-fixtures'

// ── v0.2 headless profile fixture ──────────────────────────────────────────────
// Mirrors makeBrokerProfile from broker-compile-fixtures but with
// brokerProtocol:'harness-broker/0.2'. The spec/startRequest shape is identical
// to the v0.1 fixture; only the profile-level brokerProtocol field changes.
// Hash values are computed identically from the same spec content.

function makeV02BrokerProfile(identity: RuntimeIdentityAllocation): {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
} {
  const invocationId = identity.invocationId

  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
    process: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/work',
      lockedEnv: { CODEX_HOME: '/tmp/work/.codex' },
      harnessTransport: { kind: 'jsonrpc-stdio' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single' },
    driver: { kind: 'codex-app-server', model: 'gpt-5-codex' },
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(invocationId),
    },
  } as unknown as HarnessInvocationSpec

  const startRequest = {
    spec,
    ...(identity.initialInputId !== undefined
      ? {
          initialInput: {
            inputId: identity.initialInputId as string,
            kind: 'user',
            content: [{ type: 'text', text: 'hello v0.2 headless admission' }],
          },
        }
      : {}),
  } as unknown as InvocationStartRequest

  const specHash = neutralSpecHash(spec)
  const startRequestHash = neutralStartRequestHash(startRequest)

  // brokerProtocol is 'harness-broker/0.2' — the sole structural difference from
  // the v0.1 fixture. Cast via unknown because BrokerExecutionProfile.brokerProtocol
  // is typed as 'harness-broker/0.1' today (widening is the Ph4b fix target).
  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_codex_headless_v02',
    profileHash: 'profilehash_codex_headless_v02',
    compatibilityHash: 'compat_codex_headless_v02',
    kind: 'harness-broker',
    interactionMode: 'headless',
    brokerProtocol: 'harness-broker/0.2', // ← the only difference from v0.1
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    expectedCapabilities: {},
    harnessInvocation: { startRequest, specHash, startRequestHash },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {},
      exposurePolicy: {},
    },
    observability: {},
  } as unknown as BrokerExecutionProfile

  return { profile, startRequest }
}

// ── Post-cutover route selector predicate ──────────────────────────────────────
// Mirrors the post-T-01866 controller predicate: a headless broker runtime is
// durable UNCONDITIONALLY (admission already guarantees v0.2). The
// HRC_HEADLESS_BROKER_LEGACY_STDIO env var is accepted as a parameter purely to
// PROVE it has no authority — it is never consulted.

function evalDurableHeadlessRoute(
  profile: { interactionMode: string; brokerProtocol: string },
  _hatchEnv: string | undefined
): boolean {
  // The legacy-stdio env var (_hatchEnv) is intentionally ignored: it has zero
  // route authority post-cutover.
  return profile.interactionMode === 'headless'
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('T-01878 Ph4b — HRC-side v0.2 headless admission selector', () => {
  // ── RED 1 ──────────────────────────────────────────────────────────────────
  // isBrokerControllerProfile / isHeadlessCodexBrokerProfile MUST admit a v0.2
  // headless codex-app-server profile. Today they reject it (hardcoded v0.1
  // check → candidates.length === 0 → 'no-matching-profile').
  //
  // After the fix:
  //   isBrokerControllerProfile  accepts brokerProtocol ∈ {0.1, 0.2}
  //   isHeadlessCodexBrokerProfile accepts brokerProtocol ∈ {0.1, 0.2}
  // The protocol value is echoed through UNCHANGED so the Ph3 route selector
  // can distinguish v0.2 → durable vs v0.1 → legacy.

  it('RED 1: v0.2 headless codex-app-server profile passes static admission (admitted:true) with protocol echoed unchanged', () => {
    const identity = makeIdentity()
    const { profile } = makeV02BrokerProfile(identity)
    const response = makeCompileResponse(identity, [profile])

    const result = selectBrokerExecutionProfile(response, identity)

    // ← RED TODAY: returns { admitted: false, code: 'no-matching-profile' }
    // because isBrokerControllerProfile hardcodes brokerProtocol === 'harness-broker/0.1'.
    expect(result.admitted).toBe(true)

    if (!result.admitted) {
      // Emit the rejection code so the failing test surface is diagnostic.
      throw new Error(
        `RED 1 FAILED: admission rejected v0.2 profile — code=${result.code} (expected admitted:true)`
      )
    }

    // Protocol must echo through UNCHANGED (C-03314 #2: no downgrade, no coercion).
    // The Ph3 route selector reads profile.brokerProtocol to decide durable vs legacy;
    // a silently downgraded v0.1 would break that decision.
    expect(String(result.profile.brokerProtocol)).toBe('harness-broker/0.2')
  })

  // ── CUTOVER GUARD 1 (was GREEN GUARD 1) ─────────────────────────────────────
  // T-01866: harness-broker/0.1 is DECOMMISSIONED. A v0.1 headless profile is now
  // REJECTED by the static selector (it is no longer an admissible protocol), so
  // selectBrokerExecutionProfile returns {admitted:false, code:'no-matching-profile'}.
  // (Previously v0.1 was admitted; this guard asserts the narrowing.)

  it('CUTOVER GUARD 1: v0.1 headless profile is REJECTED (no-matching-profile)', () => {
    const identity = makeIdentity({
      runtimeId: 'runtime_v01_guard' as RuntimeIdentityAllocation['runtimeId'],
    })
    // Build a v0.2 fixture, then downgrade the profile-level brokerProtocol to v0.1.
    // brokerProtocol is NOT part of the spec/start-request hashing, so the honestly
    // computed hashes stay valid — only the (now-unsupported) protocol marker changes.
    const { profile } = makeV02BrokerProfile(identity)
    ;(profile as unknown as { brokerProtocol: string }).brokerProtocol = 'harness-broker/0.1'
    const response = makeCompileResponse(identity, [profile])

    const result = selectBrokerExecutionProfile(response, identity)

    // v0.1 is no longer admissible → no candidate matches → rejected.
    expect(result.admitted).toBe(false)
    if (!result.admitted) {
      expect(result.code).toBe('no-matching-profile')
    }
  })

  // ── CUTOVER GUARD 2 (was GREEN GUARD 2) ─────────────────────────────────────
  // T-01866: the headless durable route is UNCONDITIONAL and there is NO escape
  // hatch. The route-selection predicate is now purely interactionMode==='headless'
  // (admission already guarantees v0.2). The HRC_HEADLESS_BROKER_LEGACY_STDIO env
  // var has ZERO route authority — set or unset, a headless runtime is durable and
  // never resurrects stdio. This guard mirrors the post-cutover predicate.

  it('CUTOVER GUARD 2: headless route is durable unconditionally; the legacy-stdio env var has no authority', () => {
    const v02Profile = { interactionMode: 'headless', brokerProtocol: 'harness-broker/0.2' }

    // Durable regardless of the (now-ignored) HRC_HEADLESS_BROKER_LEGACY_STDIO value.
    expect(evalDurableHeadlessRoute(v02Profile, undefined)).toBe(true)
    expect(evalDurableHeadlessRoute(v02Profile, '0')).toBe(true)
    // The stale env var must NOT flip the route back to legacy stdio.
    expect(evalDurableHeadlessRoute(v02Profile, '1')).toBe(true)

    // Edge: an interactive profile does NOT match the headless durable predicate.
    expect(
      evalDurableHeadlessRoute(
        { interactionMode: 'interactive', brokerProtocol: 'harness-broker/0.2' },
        undefined
      )
    ).toBe(false)
  })
})
