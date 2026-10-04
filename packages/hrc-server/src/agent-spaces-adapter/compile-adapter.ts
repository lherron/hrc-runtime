/**
 * Broker COMPILE ADAPTER (T-01695 / T-01690 Wave W2).
 *
 * Translates an HrcRuntimeIntent (+ overlays) into a RuntimeCompileRequest,
 * compiles it through the injected ASPC JSON-RPC client and admits exactly one
 * producer-selected v2 execution. It returns the verified frozen execution,
 * canonical dispatch request, identities, and dispatch environment. It does
 * NOT spawn the broker route itself (the hosting slice owns that).
 *
 * Key invariants:
 *  - Runtime identities are allocated BEFORE compile and mirrored into both
 *    `identity` and `correlation` (same values).
 *  - Format 1 allocates initialInputId + runId for an initial user turn;
 *    format 2 allocates only initialInputId and waits for observed turn.start.
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
 * Selection authority: HRC never maps an intent to a provider, profile,
 * driver, terminal, or presentation. Omitted values remain omitted for ASP to
 * resolve from its own profile/target/default precedence.
 */

import { parseScopeRef } from 'agent-scope'
import {
  type HrcExecutionFormat,
  type HrcRuntimeIntent,
  type HrcTurnResponseFormat,
  type SessionIdentity,
  parseAppSessionScopeRef,
} from 'hrc-core'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { neutralSpecHash } from 'spaces-runtime-contracts'
import type {
  CompileDiagnostic,
  HostSessionId,
  InputId,
  InvocationId,
  RequestId,
  RunId,
  RuntimeCompileRequest,
  RuntimeId,
  RuntimeIdentityAllocation,
  RuntimeOperationId,
  TraceId,
} from 'spaces-runtime-contracts'
import { isRecord } from '../parsers/common.js'
import {
  type PrecompileLaunchTimingContext,
  observePrecompileLaunchSpan,
} from '../precompile-launch-timing.js'
import {
  admissionRefusal,
  admitV2Execution,
  deepFreeze,
  hasV2CompileEnvelope,
  hasValidExecutionRelease,
} from './compile-adapter-admission.js'
import type {
  HrcAdmissionDiagnostic,
  V2CompileResponse,
  V2ExecutionRejectionCode,
  V2RuntimeCompileRequest,
  V2SelectedExecution,
  V2SelectedExecutionPlan,
} from './compile-adapter-types.js'
import { optional } from './optional.js'

export type {
  HrcAdmissionDiagnostic,
  V2ExecutionRejectionCode,
  V2RuntimeCompileRequest,
  V2SelectedExecution,
  V2SelectedExecutionPlan,
} from './compile-adapter-types.js'

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
  timing?: PrecompileLaunchTimingContext | undefined
}

export type BrokerCompileAdapterInput = {
  intent: HrcRuntimeIntent
  /** Incoming scope address for preview, or established continuity address. */
  scopeRef: string
  /** Stored identity for an established session; previews parse their input address. */
  sessionIdentity?: SessionIdentity | undefined
  hostSessionId: string
  generation: number
  /** Dispatch-time only channel; never hashed. Passed to startInvocationFromRequest at dispatch. */
  dispatchEnv?: Record<string, string> | undefined
  continuation?: RuntimeCompileRequest['continuation']
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
  allowCompilerInitialInputWithoutIdentity?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  /** Admission format selected by HRC before compile; omitted stays format 1. */
  executionFormat?: HrcExecutionFormat | undefined
}

/**
 * Adapter result. Discriminated on `admitted`. `identity` is ALWAYS present
 * (even on rejection) so callers can correlate the failed operation.
 */
export type BrokerCompileAdapterResult =
  | {
      admitted: true
      /** The one producer-selected execution, verified and frozen at admission. */
      execution: V2SelectedExecution
      /** Immutable producer plan metadata and resolved selection/provenance. */
      plan: V2SelectedExecutionPlan
      /** Exact HRC-owned policy submitted in the v2 compile request. */
      hrcPolicy: RuntimeCompileRequest['hrcPolicy']
      /** Immutable worker release returned alongside the selected execution. */
      sessionMetadata?: Record<string, unknown> | undefined
      executionRelease?: AspcExecutionRelease | undefined
      startRequest: InvocationStartRequest
      specHash: string
      startRequestHash: string
      identity: RuntimeIdentityAllocation
      /** Dispatch-time channel for W3B; absent from all hashed material. */
      dispatchEnv?: Record<string, string> | undefined
      diagnostics: CompileDiagnostic[]
    }
  | {
      admitted: false
      code: V2ExecutionRejectionCode
      /**
       * `producer`: ASP did not return a successful v2 compile, and
       * `diagnostics` are ASP's own. `hrc-admission`: ASP compiled, and HRC's
       * own admission refused the returned execution; `admissionDiagnostic`
       * names the check and the field that failed it.
       */
      rejectedBy: 'producer' | 'hrc-admission'
      identity: RuntimeIdentityAllocation
      diagnostics?: CompileDiagnostic[] | undefined
      admissionDiagnostic?: HrcAdmissionDiagnostic | undefined
    }

/** True when the intent carries an initial user turn (prompt and/or attachments). */
export function hasInitialUserTurn(intent: HrcRuntimeIntent): boolean {
  return (
    (typeof intent.initialPrompt === 'string' && intent.initialPrompt.length > 0) ||
    (intent.attachments?.length ?? 0) > 0
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

/**
 * Project stored continuity identity into ASP's v2 agent identity.
 * App sessions are HRC-owned `app:<appId>` scopes and deliberately do not
 * satisfy agent-scope's `agent:<agentId>` grammar; their validated app id is
 * the v2 agent id. Only a preview's incoming address needs agent-scope parsing.
 * This is identity projection only, never selection authority.
 */
function v2AgentIdForScope(scopeRef: string, identity?: SessionIdentity): string {
  const app = parseAppSessionScopeRef(scopeRef)
  return app?.appId ?? identity?.agentId ?? parseScopeRef(scopeRef).agentId
}

function hasOwnKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

/**
 * Build the only v2 selection carrier. It intentionally reads neither
 * `intent.harness` nor `intent.provision`: those are old HRC-owned/merged
 * surfaces and turning either into a compile value would reintroduce local
 * profile, target, provider, or driver selection.
 */
export function buildV2CompileRequest(input: {
  intent: HrcRuntimeIntent
  scopeRef: string
  sessionIdentity?: SessionIdentity | undefined
  identity: RuntimeIdentityAllocation
  dispatchEnv?: Record<string, string> | undefined
  continuation?: RuntimeCompileRequest['continuation'] | undefined
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
}): V2RuntimeCompileRequest {
  const { intent } = input
  // The compiler uses placement correlation to build the launch environment,
  // while `correlation` below becomes the broker event lineage.  HRC owns the
  // allocated execution facts in both channels; never inherit caller-provided
  // identity values into either one.
  // T-09885: hostSessionId/generation (ASP's HRC_HOST_SESSION_ID/HRC_GENERATION)
  // come from the allocation too; callers omit them or carry a prior generation.
  const {
    hostSessionId: _callerHostSessionId,
    generation: _callerGeneration,
    runtimeId: _callerRuntimeId,
    invocationId: _callerInvocationId,
    initialInputId: _callerInitialInputId,
    runId: _callerRunId,
    ...callerPlacementCorrelation
  } = (intent.placement.correlation ?? {}) as Record<string, unknown>
  const placement = {
    ...intent.placement,
    correlation: {
      ...callerPlacementCorrelation,
      hostSessionId: input.identity.hostSessionId,
      generation: input.identity.generation,
      runtimeId: input.identity.runtimeId,
      ...(input.identity.invocationId !== undefined
        ? { invocationId: input.identity.invocationId }
        : {}),
      ...(input.identity.initialInputId !== undefined
        ? { initialInputId: input.identity.initialInputId }
        : {}),
      ...(input.identity.runId !== undefined ? { runId: input.identity.runId } : {}),
    },
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
  }
  const requested = { ...(intent.selection ?? {}) }
  // T-09274: `presentation.operator` is the user-level request constraint.
  // Carry it through the existing producer-v2 boolean rather than deriving a
  // profile, driver, or hosting plan in HRC. An explicit operator choice has
  // precedence over the lower-level requested.presentation field only.
  if (intent.presentation?.operator === 'none') {
    requested.presentation = false
  } else if (
    intent.presentation?.operator === 'tmux-tui' ||
    intent.presentation?.operator === 'observer'
  ) {
    requested.presentation = true
  }
  const summonDirectives = { ...(intent.summonDirectives ?? {}) }

  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: v2AgentIdForScope(input.scopeRef, input.sessionIdentity) },
    identity: input.identity,
    placement,
    ...(hasOwnKeys(summonDirectives) ? { selectionContext: { summonDirectives } } : {}),
    requested,
    materialization: {
      ...(intent.initialPrompt !== undefined ? { initialPrompt: intent.initialPrompt } : {}),
      ...(intent.omitPriming !== undefined ? { omitPriming: intent.omitPriming } : {}),
      ...(toCompileAttachments(intent.attachments) !== undefined
        ? { attachments: toCompileAttachments(intent.attachments) }
        : {}),
      ...(intent.taskContext !== undefined ? { taskContext: intent.taskContext } : {}),
      ...(input.responseFormat?.kind === 'json_schema'
        ? { responseFormat: input.responseFormat }
        : {}),
    },
    hrcPolicy: input.policy ?? {},
    ...(input.continuation ? { continuation: input.continuation } : {}),
    correlation: {
      requestId: input.identity.requestId,
      operationId: input.identity.operationId,
      hostSessionId: input.identity.hostSessionId,
      generation: input.identity.generation,
      runtimeId: input.identity.runtimeId,
      invocationId: input.identity.invocationId,
      ...optional('inputId', input.identity.initialInputId),
      traceId: input.identity.traceId,
      ...optional('runId', input.identity.runId),
      scopeRef: input.scopeRef,
    },
  }
}

/**
 * Allocate identities, build a v2 request, compile, and validate/freeze the
 * one returned execution. Does not execute anything.
 */
export async function compileBrokerRuntimePlan(
  input: BrokerCompileAdapterInput,
  deps: BrokerCompileAdapterDeps
): Promise<BrokerCompileAdapterResult> {
  const { intent } = input
  const { ids } = deps
  const executionFormat = input.executionFormat ?? 'format1'

  // (1) Allocate identities BEFORE compile. Both formats allocate an initial
  // input for a real first user turn; format 2 must not allocate its run before
  // the broker observes an exact native turn.started.
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
      ? {
          initialInputId: ids.initialInputId() as InputId,
          ...(executionFormat === 'format1' ? { runId: ids.runId() as RunId } : {}),
        }
      : {}),
  }

  // (3) Translate only explicit v2 request selection and raw summon
  // directives. ASP owns all omitted values and the complete selection merge.
  const request = buildV2CompileRequest({
    intent,
    scopeRef: input.scopeRef,
    sessionIdentity: input.sessionIdentity,
    identity,
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
    ...(input.continuation ? { continuation: input.continuation } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
  })

  // (4) Compile through ASPC, then statically admit + hash-verify the broker
  //     profile HRC will dispatch. ASPC returns the exact dispatch envelope; HRC
  //     still verifies the selected startRequest/hash/identity contract before
  //     trusting it.
  const compile = () =>
    deps.compileHarnessInvocation({
      // The installed v1 declaration cannot name this v2 structure until the
      // producer tuple advances. The wire is deliberately explicit above; this
      // boundary cast is removed with that atomic dependency advance.
      compileRequest: request as unknown as RuntimeCompileRequest,
      ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
    })
  const response = deps.timing
    ? await observePrecompileLaunchSpan('precompile-compile-rpc', deps.timing, compile)
    : await compile()
  // Reject the legacy ASPC response envelope before looking at its success bit:
  // accepting a v1 failure here would keep a second compatibility path alive.
  if (!hasV2CompileEnvelope(response)) {
    return {
      admitted: false,
      code: 'v2-envelope-required',
      rejectedBy: 'producer',
      identity,
      diagnostics: response.diagnostics,
    }
  }
  if (!response.ok) {
    return {
      admitted: false,
      code: 'compile-not-ok',
      rejectedBy: 'producer',
      identity,
      diagnostics: response.diagnostics,
    }
  }

  const selection = admitV2Execution(
    response,
    identity,
    v2AgentIdForScope(input.scopeRef, input.sessionIdentity),
    executionFormat,
    intent.presentation?.operator === 'tmux-tui' &&
      (intent.harness.provider !== undefined ||
        intent.harness.id !== undefined ||
        intent.harness.interactive === true ||
        intent.execution?.preferredMode === 'interactive')
      ? undefined
      : intent.presentation?.operator
  )

  if (!selection.admitted) {
    return {
      admitted: false,
      code: selection.code,
      rejectedBy: 'hrc-admission',
      identity,
      diagnostics: response.diagnostics,
      admissionDiagnostic: selection.diagnostic,
    }
  }

  const responseRelease = (response as unknown as V2CompileResponse).executionRelease
  if (responseRelease !== undefined && !hasValidExecutionRelease(responseRelease)) {
    const refusal = admissionRefusal(
      'execution-release-invalid',
      'executionRelease',
      responseRelease
    )
    return {
      admitted: false,
      code: refusal.code,
      rejectedBy: 'hrc-admission',
      identity,
      diagnostics: response.diagnostics,
      admissionDiagnostic: refusal.diagnostic,
    }
  }

  return {
    admitted: true,
    ...('sessionMetadata' in response && isRecord(response.sessionMetadata)
      ? { sessionMetadata: response.sessionMetadata }
      : {}),
    execution: selection.execution,
    hrcPolicy: deepFreeze(request.hrcPolicy),
    ...(responseRelease !== undefined ? { executionRelease: deepFreeze(responseRelease) } : {}),
    plan: deepFreeze({
      schemaVersion: selection.plan.schemaVersion,
      planHash: selection.plan.planHash,
      compileId: selection.plan.compileId,
      createdAt: selection.plan.createdAt,
      diagnostics: selection.plan.diagnostics,
      selection: selection.plan.selection,
    }),
    startRequest: selection.execution.dispatchRequest.startRequest,
    specHash: neutralSpecHash(selection.execution.dispatchRequest.startRequest.spec),
    startRequestHash: selection.execution.profile.startRequestHash,
    identity,
    ...(selection.execution.dispatchRequest.dispatchEnv
      ? { dispatchEnv: selection.execution.dispatchRequest.dispatchEnv }
      : {}),
    diagnostics: (response as unknown as V2CompileResponse).diagnostics,
  }
}
