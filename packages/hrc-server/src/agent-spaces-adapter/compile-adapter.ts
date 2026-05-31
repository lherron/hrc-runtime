/**
 * Broker COMPILE ADAPTER (T-01695 / T-01690 Wave W2).
 *
 * Translates an HrcRuntimeIntent (+ overlays) into a RuntimeCompileRequest,
 * compiles it through the injected ASPC JSON-RPC facade client, runs the W2
 * profile selector, and returns a verified + frozen plan / profile /
 * startRequest / dispatchEnv / identities. It does NOT spawn the broker route
 * itself (W3B/W4 own that).
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

import type { HrcRuntimeIntent } from 'hrc-core'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcProfileSelector,
} from 'spaces-aspc-protocol'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompileDiagnostic,
  CompiledRuntimePlan,
  HarnessFamily,
  HarnessRuntime,
  HostSessionId,
  InputId,
  InvocationId,
  ProviderDomain,
  RequestId,
  RunId,
  RuntimeCompileRequest,
  RuntimeCorrelation,
  RuntimeId,
  RuntimeIdentityAllocation,
  RuntimeOperationId,
  TraceId,
} from 'spaces-runtime-contracts'

import {
  type BrokerProfileRejectionCode,
  selectBrokerExecutionProfile,
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

export type CompileHarnessInvocationFn = (
  request: AspcCompileHarnessInvocationRequest
) => Promise<AspcCompileHarnessInvocationResponse>

export type BrokerCompileAdapterDeps = {
  /** Compiles through the ASPC facade. W3B binds this to aspc.compileHarnessInvocation. */
  compileHarnessInvocation: CompileHarnessInvocationFn
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
      diagnostics: CompileDiagnostic[]
    }
  | {
      admitted: false
      code: BrokerProfileRejectionCode
      identity: RuntimeIdentityAllocation
      diagnostics?: CompileDiagnostic[] | undefined
    }

/** True when the intent carries an initial user turn (prompt and/or attachments). */
function hasInitialUserTurn(intent: HrcRuntimeIntent): boolean {
  return (
    intent.initialPrompt !== undefined ||
    (intent.attachments?.length ?? 0) > 0 ||
    hasManagedInteractiveStartupPrompt(intent)
  )
}

function hasManagedInteractiveStartupPrompt(intent: HrcRuntimeIntent): boolean {
  if (intent.harness.interactive !== true) {
    return false
  }
  const bundle = intent.placement.bundle
  return (
    bundle !== null &&
    typeof bundle === 'object' &&
    'kind' in bundle &&
    bundle.kind === 'agent-project'
  )
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

function toRequestedHarnessRoute(harness: HrcRuntimeIntent['harness']): {
  modelProvider: ProviderDomain
  harnessFamily?: HarnessFamily | undefined
  preferredHarnessRuntime?: HarnessRuntime | undefined
} {
  const preferredHarnessRuntime = toPreferredHarnessRuntime(harness.id)
  const harnessFamily = toHarnessFamily(harness.provider, preferredHarnessRuntime)
  return {
    modelProvider: harness.provider,
    ...(harnessFamily ? { harnessFamily } : {}),
    ...(preferredHarnessRuntime ? { preferredHarnessRuntime } : {}),
  }
}

function toPreferredHarnessRuntime(
  harnessId: HrcRuntimeIntent['harness']['id']
): HarnessRuntime | undefined {
  switch (harnessId) {
    case 'claude-code':
      return 'claude-code-cli'
    case 'codex-cli':
      return 'codex-cli'
    case 'pi':
    case 'pi-cli':
      return 'pi-cli'
    case 'pi-sdk':
      return 'pi-sdk'
    default:
      return undefined
  }
}

function toHarnessFamily(
  provider: HrcRuntimeIntent['harness']['provider'],
  runtime: HarnessRuntime | undefined
): HarnessFamily | undefined {
  if (runtime === 'claude-code-cli' || runtime === 'claude-agent-sdk') return 'claude-code'
  if (runtime === 'codex-cli') return 'codex'
  if (runtime === 'pi-cli' || runtime === 'pi-sdk') return 'pi'
  return provider === 'openai' ? 'codex' : 'claude-code'
}

function toProfileSelector(intent: HrcRuntimeIntent): AspcProfileSelector | undefined {
  if (intent.harness.interactive === true) {
    const runtime = toPreferredHarnessRuntime(intent.harness.id)
    if (runtime === 'claude-code-cli') {
      return { brokerDriver: 'claude-code-tmux' }
    }
    if (runtime === 'codex-cli') {
      return { brokerDriver: 'codex-cli-tmux' }
    }
    return undefined
  }

  const runtime = toPreferredHarnessRuntime(intent.harness.id)
  if (runtime === 'codex-cli' || intent.harness.provider === 'openai') {
    return { brokerDriver: 'codex-app-server' }
  }
  return undefined
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
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
      ...toRequestedHarnessRoute(intent.harness),
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

  // (4) Compile through ASPC, then statically admit + hash-verify the broker
  //     profile HRC will dispatch. ASPC returns the exact dispatch envelope; HRC
  //     still verifies the selected startRequest/hash/identity contract before
  //     trusting it.
  const profileSelector = toProfileSelector(intent)
  const response = await deps.compileHarnessInvocation({
    compileRequest: request,
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
    ...(profileSelector ? { profileSelector } : {}),
  })
  if (!response.ok) {
    return {
      admitted: false,
      code: 'compile-not-ok',
      identity,
      diagnostics: response.diagnostics,
    }
  }

  const selection = selectBrokerExecutionProfile(response.compileResponse, identity)

  if (!selection.admitted) {
    return {
      admitted: false,
      code: selection.code,
      identity,
      diagnostics: response.diagnostics,
    }
  }

  if (!jsonEqual(response.dispatchRequest.startRequest, response.startRequest)) {
    return {
      admitted: false,
      code: 'start-request-hash-mismatch',
      identity,
      diagnostics: response.diagnostics,
    }
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
    diagnostics: response.diagnostics,
  }
}
