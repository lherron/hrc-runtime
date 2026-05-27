/**
 * Broker COMPILE ADAPTER (T-01695 / T-01690 Wave W2).
 *
 * Translates an HrcRuntimeIntent (+ overlays) into a RuntimeCompileRequest,
 * compiles it (via an injected compile fn — no live compiler is required here),
 * runs the W2 profile selector, and returns a verified + frozen plan / profile /
 * startRequest / dispatchEnv / identities. It does NOT spawn the broker or wire
 * any route (W3B/W4 own that).
 *
 * Key invariants:
 *  - Runtime identities are allocated BEFORE compile and mirrored into both
 *    `identity` and `correlation` (same values).
 *  - initialInputId + runId are allocated ONLY when an initial user turn exists.
 *  - placement.dispatchEnv is a DISPATCH-TIME channel: carried on the request's
 *    placement and surfaced on the result, but NEVER folded into the hashed
 *    startRequest/spec material. W3B passes it as the second argument to
 *    BrokerClient.startInvocationFromRequest(startRequest, dispatchEnv).
 *
 * BOUNDARY (W1A broker-path scoped guard): `compile-*.ts` may import only
 * spaces-runtime-contracts / spaces-harness-broker-protocol / -client (+ hrc-core
 * contracts). It must NEVER import launch/exec.ts, spaces-harness-codex, or
 * spaces-harness-broker internals.
 *
 * FLAG DARKNESS: nothing here is wired into a live dispatch path; it is
 * unreachable unless an explicit caller (W3B/W4, behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED) invokes it.
 */

import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  HostSessionId,
  InputId,
  InvocationId,
  RequestId,
  RunId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
  RuntimeCorrelation,
  RuntimeId,
  RuntimeIdentityAllocation,
  RuntimeOperationId,
  TraceId,
} from 'spaces-runtime-contracts'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { HrcRuntimeIntent } from 'hrc-core'

import {
  selectBrokerExecutionProfile,
  type BrokerProfileRejectionCode,
} from './compile-profile-selector'

/**
 * Allocates the runtime identities used by a single compile+dispatch operation.
 * Injected so callers/tests control id shape; W3B supplies the real allocator.
 */
export type RuntimeIdAllocator = {
  requestId: () => string
  operationId: () => string
  runtimeId: () => string
  invocationId: () => string
  initialInputId: () => string
  runId: () => string
  traceId: () => string
}

export type CompileFn = (request: RuntimeCompileRequest) => Promise<RuntimeCompileResponse>

export type BrokerCompileAdapterDeps = {
  /** Compiles a runtime plan. W3B binds this to createAgentSpacesClient().compileRuntimePlan. */
  compile: CompileFn
  ids: RuntimeIdAllocator
}

export type BrokerCompileAdapterInput = {
  intent: HrcRuntimeIntent
  hostSessionId: string
  generation: number
  /** Dispatch-time only channel; never hashed. Passed to startInvocationFromRequest at dispatch. */
  dispatchEnv?: Record<string, string> | undefined
  continuation?: RuntimeCompileRequest['continuation']
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
}

/**
 * Adapter result. Discriminated on `admitted`. `identity` is ALWAYS present
 * (even on rejection) so callers can correlate the failed operation.
 */
export type BrokerCompileAdapterResult =
  | {
      admitted: true
      profile: BrokerExecutionProfile
      /** Verified + frozen. NEVER mutate. */
      startRequest: InvocationStartRequest
      specHash: string
      startRequestHash: string
      plan: CompiledRuntimePlan
      identity: RuntimeIdentityAllocation
      /** Dispatch-time channel for W3B; absent from all hashed material. */
      dispatchEnv?: Record<string, string> | undefined
    }
  | {
      admitted: false
      code: BrokerProfileRejectionCode
      identity: RuntimeIdentityAllocation
    }

/** True when the intent carries an initial user turn (prompt and/or attachments). */
function hasInitialUserTurn(intent: HrcRuntimeIntent): boolean {
  return intent.initialPrompt !== undefined || (intent.attachments?.length ?? 0) > 0
}

/**
 * Map hrc-core attachment refs into the contracts attachment shape. The two
 * packages use different `kind` vocabularies, so translate explicitly rather
 * than passing through.
 */
function toCompileAttachments(
  attachments: HrcRuntimeIntent['attachments']
): RuntimeCompileRequest['materialization']['attachments'] {
  if (!attachments) {
    return undefined
  }
  return attachments.map((attachment) => {
    if (attachment.kind === 'url') {
      return {
        kind: 'opaque' as const,
        ref: attachment.url ?? attachment.path ?? '',
        ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      }
    }
    const isImage = attachment.contentType?.startsWith('image/') ?? false
    return {
      kind: isImage ? ('image' as const) : ('local-file' as const),
      path: attachment.path ?? '',
      ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
    }
  })
}

/**
 * Allocate identities, build a RuntimeCompileRequest, compile, select+verify the
 * broker profile, and return a verified/frozen plan. Does not execute anything.
 */
export async function compileBrokerRuntimePlan(
  input: BrokerCompileAdapterInput,
  deps: BrokerCompileAdapterDeps
): Promise<BrokerCompileAdapterResult> {
  const { intent } = input
  const { ids } = deps

  // (1) Allocate identities BEFORE compile. initialInputId + runId only exist
  //     when there is an initial user turn.
  const withInitialTurn = hasInitialUserTurn(intent)
  const identity: RuntimeIdentityAllocation = {
    requestId: ids.requestId() as RequestId,
    operationId: ids.operationId() as RuntimeOperationId,
    hostSessionId: input.hostSessionId as HostSessionId,
    generation: input.generation,
    runtimeId: ids.runtimeId() as RuntimeId,
    invocationId: ids.invocationId() as InvocationId,
    traceId: ids.traceId() as TraceId,
    ...(withInitialTurn
      ? { initialInputId: ids.initialInputId() as InputId, runId: ids.runId() as RunId }
      : {}),
  }

  // (2) Mirror the SAME values into correlation.
  const correlation: RuntimeCorrelation = {
    requestId: identity.requestId,
    operationId: identity.operationId,
    hostSessionId: identity.hostSessionId,
    generation: identity.generation,
    runtimeId: identity.runtimeId,
    invocationId: identity.invocationId,
    traceId: identity.traceId,
    ...(identity.runId !== undefined ? { runId: identity.runId } : {}),
  }

  // (3) Translate intent + overlays. dispatchEnv rides on placement as a
  //     dispatch-time channel (contracts RuntimePlacement carries arbitrary
  //     keys); it is NOT part of the hashed startRequest/spec material.
  const placement = {
    ...intent.placement,
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
  }

  const request: RuntimeCompileRequest = {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      interactionMode: intent.harness.interactive ? 'interactive' : 'headless',
      ...(intent.harness.model ? { model: intent.harness.model } : {}),
    },
    materialization: {
      initialPrompt: intent.initialPrompt,
      attachments: toCompileAttachments(intent.attachments),
      taskContext: intent.taskContext,
    },
    hrcPolicy: input.policy ?? {},
    correlation,
    ...(input.continuation ? { continuation: input.continuation } : {}),
  }

  // (4) Compile, then statically admit + hash-verify the broker profile.
  const response = await deps.compile(request)
  const selection = selectBrokerExecutionProfile(response, identity)

  if (!selection.admitted) {
    return { admitted: false, code: selection.code, identity }
  }

  // selection.admitted ⇒ response.ok was true; this guard re-narrows for TS and
  // keeps the invariant honest.
  if (!response.ok) {
    return { admitted: false, code: 'compile-not-ok', identity }
  }

  return {
    admitted: true,
    profile: selection.profile,
    startRequest: selection.startRequest,
    specHash: selection.specHash,
    startRequestHash: selection.startRequestHash,
    plan: response.plan,
    identity,
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
  }
}
