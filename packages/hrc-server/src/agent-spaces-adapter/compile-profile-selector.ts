/**
 * Broker execution-profile SELECTOR (T-01695 / T-01690 Wave W2).
 *
 * Performs STATIC admission + hash verification over a compiled runtime plan.
 * For T-01690 it admits ONLY a headless codex-app-server harness-broker profile
 * and REJECTS (never silently falls back) on every other condition.
 *
 * BOUNDARY (W1A broker-path scoped guard): this file lives at
 * `agent-spaces-adapter/compile-*.ts`, so it may import only
 * spaces-runtime-contracts / spaces-harness-broker-protocol / -client. It must
 * NEVER import launch/exec.ts, spaces-harness-codex, or spaces-harness-broker
 * internals. (No broker is spawned here — this only verifies and freezes.)
 *
 * FLAG DARKNESS: nothing in this module is wired into a live dispatch path.
 * It is unreachable unless an explicit caller (W3B/W4, behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED) invokes it.
 */

import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { project } from 'spaces-runtime-contracts'
import type {
  BrokerExecutionProfile,
  RuntimeCompileResponse,
  RuntimeExecutionProfile,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

/** Codes for every REJECT path. We never silently fall back. */
export type BrokerProfileRejectionCode =
  | 'compile-not-ok'
  | 'no-matching-profile'
  | 'ambiguous-profiles'
  | 'profile-diagnostics-error'
  | 'spec-hash-mismatch'
  | 'start-request-hash-mismatch'
  | 'invocation-id-mismatch'
  | 'initial-input-id-mismatch'

/** Result of static admission. Discriminated on `admitted`. */
export type BrokerProfileSelection =
  | {
      admitted: true
      profile: BrokerExecutionProfile
      /** The verified + frozen start request. NEVER mutate. */
      startRequest: InvocationStartRequest
      specHash: string
      startRequestHash: string
    }
  | { admitted: false; code: BrokerProfileRejectionCode }

/**
 * Admissible broker-protocol versions for the static selector (T-01878 Ph4b).
 *
 * The selector ADMITS both the v0.1 legacy default and the v0.2 durable headless
 * profile (emitted by ASP under the operator dev flag). It must NOT branch on any
 * flag/env (daedalus C-03314 #2): the selector only SELECTS the profile; the
 * controller/runtime-hosting derive durability from the (echoed-through, unchanged)
 * profile.brokerProtocol + persisted endpoint/substrate — never from the activation
 * flag. The Ph3 route selector (broker-headless-handlers.ts) reads brokerProtocol to
 * distinguish v0.2 → durable vs v0.1 → legacy, so the value is never coerced here.
 */
function isAdmissibleBrokerProtocol(brokerProtocol: unknown): boolean {
  return brokerProtocol === 'harness-broker/0.1' || brokerProtocol === 'harness-broker/0.2'
}

/**
 * Static admission predicate for broker-controller profiles. Headless Codex and
 * interactive broker-owned tmux drivers share the same HRC controller; the
 * interactive path is selected by profile driver/terminal metadata, not harness
 * identity.
 */
export function isBrokerControllerProfile(
  profile: RuntimeExecutionProfile
): profile is BrokerExecutionProfile {
  return (
    profile.kind === 'harness-broker' &&
    isAdmissibleBrokerProtocol(profile.brokerProtocol) &&
    (isHeadlessCodexBrokerProfile(profile) || isInteractiveTmuxBrokerProfile(profile))
  )
}

export function isHeadlessCodexBrokerProfile(
  profile: RuntimeExecutionProfile
): profile is BrokerExecutionProfile {
  return (
    profile.kind === 'harness-broker' &&
    profile.interactionMode === 'headless' &&
    isAdmissibleBrokerProtocol(profile.brokerProtocol) &&
    profile.brokerDriver === 'codex-app-server'
  )
}

export function isInteractiveTmuxBrokerProfile(
  profile: RuntimeExecutionProfile
): profile is BrokerExecutionProfile {
  return (
    profile.kind === 'harness-broker' &&
    profile.interactionMode === 'interactive' &&
    isAdmissibleBrokerProtocol(profile.brokerProtocol) &&
    typeof profile.brokerDriver === 'string' &&
    (profile.brokerDriver === 'claude-code-tmux' || profile.brokerDriver === 'codex-cli-tmux') &&
    profile.brokerTerminal?.host === 'tmux'
  )
}

/** Recompute the spec hash via the exported contracts projection helper. */
function recomputeSpecHash(spec: unknown): string {
  return (project(spec, 'spec') as { specHash: string }).specHash
}

/** Recompute the start-request hash via the exported contracts projection helper. */
function recomputeStartRequestHash(startRequest: unknown): string {
  return (project(startRequest, 'start-request') as { startRequestHash: string }).startRequestHash
}

/** Deep-freeze so the verified start request can never be mutated downstream. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/**
 * Select + verify the single admissible broker profile from a compile response.
 *
 * Verification order is significant: structural admission (one matching
 * profile) → declared diagnostics → hash integrity (spec, then start request) →
 * identity binding (invocationId, then initialInputId). The first failure wins.
 */
export function selectBrokerExecutionProfile(
  response: RuntimeCompileResponse,
  identity: RuntimeIdentityAllocation
): BrokerProfileSelection {
  if (!response.ok) {
    return { admitted: false, code: 'compile-not-ok' }
  }

  const candidates = response.plan.executionProfiles.filter(isBrokerControllerProfile)
  if (candidates.length === 0) {
    return { admitted: false, code: 'no-matching-profile' }
  }
  if (candidates.length > 1) {
    return { admitted: false, code: 'ambiguous-profiles' }
  }

  const profile = candidates[0]
  if (!profile) {
    return { admitted: false, code: 'no-matching-profile' }
  }

  if (profile.diagnostics?.some((diagnostic) => diagnostic.level === 'error')) {
    return { admitted: false, code: 'profile-diagnostics-error' }
  }

  const { startRequest, specHash, startRequestHash } = profile.harnessInvocation

  // Hash integrity: recompute and compare BEFORE trusting any spec contents.
  if (recomputeSpecHash(startRequest.spec) !== specHash) {
    return { admitted: false, code: 'spec-hash-mismatch' }
  }
  if (recomputeStartRequestHash(startRequest) !== startRequestHash) {
    return { admitted: false, code: 'start-request-hash-mismatch' }
  }

  // Identity binding: the compiler must have echoed our allocated identities.
  if (startRequest.spec.invocationId !== identity.invocationId) {
    return { admitted: false, code: 'invocation-id-mismatch' }
  }

  // Interactive tmux routes deliver the startup priming via the launch argv
  // (carried in spec.launch), so they legitimately carry NO broker
  // initialInput — there is nothing to id-correlate. For every other route the
  // compiler must echo our allocated initialInputId (when one was allocated).
  const initialInput = startRequest.initialInput
  const primingViaLaunch = startRequest.spec.launch?.initialPrompt !== undefined
  if (!(primingViaLaunch && initialInput === undefined)) {
    if (identity.initialInputId !== undefined || initialInput !== undefined) {
      if (initialInput?.inputId !== identity.initialInputId) {
        return { admitted: false, code: 'initial-input-id-mismatch' }
      }
    }
  }

  // Verified: freeze and hand back. Hashes are echoed through for the caller.
  return {
    admitted: true,
    profile,
    startRequest: deepFreeze(startRequest),
    specHash,
    startRequestHash,
  }
}
