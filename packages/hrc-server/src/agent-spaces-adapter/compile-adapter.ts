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
 * Selection authority: HRC never maps an intent to a provider, profile,
 * driver, terminal, or presentation. Omitted values remain omitted for ASP to
 * resolve from its own profile/target/default precedence.
 */

import { parseScopeRef } from 'agent-scope'
import {
  type HrcRuntimeIntent,
  type HrcTurnResponseFormat,
  parseAppSessionScopeRef,
} from 'hrc-core'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { neutralSpecHash, neutralStartRequestHash } from 'spaces-runtime-contracts'
import type {
  CompileDiagnostic,
  HostSessionId,
  InputId,
  InvocationId,
  RequestId,
  RunId,
  RuntimeCompileRequest,
  RuntimeCorrelation,
  RuntimeId,
  RuntimeIdentityAllocation,
  RuntimeOperationId,
  TraceId,
} from 'spaces-runtime-contracts'

import type { SelectedExecution, SelectedExecutionPlan } from '../broker/selected-execution.js'
import {
  type PrecompileLaunchTimingContext,
  observePrecompileLaunchSpan,
} from '../precompile-launch-timing.js'
import { optional } from './optional.js'

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
  /** The authoritative scope identity from which v2 derives agent.id. */
  scopeRef: string
  hostSessionId: string
  generation: number
  /** Dispatch-time only channel; never hashed. Passed to startInvocationFromRequest at dispatch. */
  dispatchEnv?: Record<string, string> | undefined
  continuation?: RuntimeCompileRequest['continuation']
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
  allowCompilerInitialInputWithoutIdentity?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
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
      identity: RuntimeIdentityAllocation
      diagnostics?: CompileDiagnostic[] | undefined
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

type V2RequestedSelection = NonNullable<HrcRuntimeIntent['selection']>
type V2SummonDirectives = NonNullable<HrcRuntimeIntent['summonDirectives']>

/**
 * Project the already-established HRC scope into ASP's v2 agent identity.
 * App sessions are HRC-owned `app:<appId>` scopes and deliberately do not
 * satisfy agent-scope's `agent:<agentId>` grammar; their validated app id is
 * the v2 agent id. Every agent scope retains agent-scope's canonical parsing.
 * This is identity projection only, never selection authority.
 */
function v2AgentIdForScope(scopeRef: string): string {
  const app = parseAppSessionScopeRef(scopeRef)
  return app?.appId ?? parseScopeRef(scopeRef).agentId
}

/**
 * The local structural v2 request view keeps this source slice buildable until
 * the immutable producer tuple is pulled. It mirrors the public ASP v2 wire;
 * the final dependency advance replaces the temporary structural boundary with
 * the exported package type, without changing its bytes.
 */
export type V2RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v2'
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  placement: RuntimeCompileRequest['placement']
  selectionContext?: { summonDirectives?: V2SummonDirectives | undefined } | undefined
  requested: V2RequestedSelection
  materialization: RuntimeCompileRequest['materialization']
  hrcPolicy: RuntimeCompileRequest['hrcPolicy']
  continuation?: RuntimeCompileRequest['continuation'] | undefined
  correlation: RuntimeCorrelation
}

/** One execution is the complete producer-selected launch and hosting contract. */
export type V2SelectedExecution = SelectedExecution
export type V2SelectedExecutionPlan = SelectedExecutionPlan

type V2CompiledPlan = V2SelectedExecutionPlan & {
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  execution: V2SelectedExecution
}

type V2CompileResponse = {
  schemaVersion: 'aspc-compile-harness-invocation-response/v2'
  ok: true
  plan: V2CompiledPlan
  diagnostics: CompileDiagnostic[]
  executionRelease?: AspcExecutionRelease | undefined
}

export type V2ExecutionRejectionCode =
  | 'compile-not-ok'
  | 'v2-envelope-required'
  | 'v2-plan-required'
  | 'execution-invalid'
  | 'execution-protocol-invalid'
  | 'execution-hosting-invalid'
  | 'execution-presentation-invalid'
  | 'execution-profile-invalid'
  | 'execution-selection-invalid'
  | 'execution-driver-mismatch'
  | 'execution-hash-mismatch'
  | 'execution-identity-mismatch'
  | 'execution-release-invalid'

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
  identity: RuntimeIdentityAllocation
  dispatchEnv?: Record<string, string> | undefined
  continuation?: RuntimeCompileRequest['continuation'] | undefined
  policy?: RuntimeCompileRequest['hrcPolicy'] | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
}): V2RuntimeCompileRequest {
  const { intent } = input
  const placement = {
    ...intent.placement,
    ...(input.dispatchEnv ? { dispatchEnv: input.dispatchEnv } : {}),
  }
  const requested = { ...(intent.selection ?? {}) }
  const summonDirectives = { ...(intent.summonDirectives ?? {}) }

  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: v2AgentIdForScope(input.scopeRef) },
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
      traceId: input.identity.traceId,
      ...optional('runId', input.identity.runId),
      scopeRef: input.scopeRef,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasV2CompileEnvelope(response: unknown): boolean {
  return (
    isRecord(response) &&
    response['schemaVersion'] === 'aspc-compile-harness-invocation-response/v2'
  )
}

function hasValidHosting(hosting: Record<string, unknown>): boolean {
  const transport = hosting['executionTransport']
  const processExecution = hosting['processExecution']
  const terminalRequired = hosting['terminalRequired']
  const terminalHost = hosting['terminalHost']

  if (
    typeof terminalRequired !== 'boolean' ||
    (terminalHost !== undefined && terminalHost !== 'tmux') ||
    terminalRequired !== (terminalHost === 'tmux')
  ) {
    return false
  }

  if (transport === 'jsonrpc-stdio') {
    return processExecution === 'broker-process'
  }
  if (transport === 'pty') {
    return processExecution === 'broker-process' && terminalRequired
  }
  if (transport === 'native-worker') {
    return processExecution === 'native-worker'
  }
  return false
}

function hasCoherentPresentation(
  execution: Record<string, unknown>,
  hosting: Record<string, unknown>
): boolean {
  const fulfillment = execution['presentationFulfillment']
  const surface = execution['presentationSurface']
  if (
    fulfillment !== 'intrinsic' &&
    fulfillment !== 'attachable' &&
    fulfillment !== 'birth-variant'
  ) {
    return false
  }
  if (fulfillment === 'intrinsic' && hosting['terminalRequired'] !== true) {
    return false
  }
  if (surface === undefined) {
    return true
  }
  if (!isRecord(surface) || fulfillment !== 'attachable') {
    return false
  }
  if (
    (surface['transport'] !== 'terminal' && surface['transport'] !== 'websocket-unix') ||
    surface['terminalHost'] !== 'tmux'
  ) {
    return false
  }
  // A terminal surface is the worker terminal itself; an attachable websocket
  // surface may attach to a tmux renderer even when the worker is headless.
  return surface['transport'] !== 'terminal' || hosting['terminalRequired'] === true
}

const allocatedPlanIdentityFields: readonly (keyof RuntimeIdentityAllocation)[] = [
  'requestId',
  'operationId',
  'hostSessionId',
  'generation',
  'runtimeId',
  'invocationId',
  'initialInputId',
  'runId',
  'traceId',
]

function hasMatchingAllocatedIdentity(
  planIdentity: Record<string, unknown>,
  identity: RuntimeIdentityAllocation
): boolean {
  return allocatedPlanIdentityFields.every((field) => planIdentity[field] === identity[field])
}

function hasMatchingCanonicalStartIdentity(
  startRequest: Record<string, unknown>,
  identity: RuntimeIdentityAllocation
): boolean {
  const spec = startRequest['spec']
  if (!isRecord(spec) || spec['invocationId'] !== identity.invocationId) {
    return false
  }
  const correlation = spec['correlation']
  if (!isRecord(correlation)) {
    return false
  }
  const correlationFields: readonly (keyof RuntimeIdentityAllocation)[] = [
    'requestId',
    'operationId',
    'hostSessionId',
    'runtimeId',
    'runId',
    'traceId',
  ]
  if (!correlationFields.every((field) => correlation[field] === identity[field])) {
    return false
  }
  if (identity.initialInputId === undefined) {
    return true
  }
  const initialInput = startRequest['initialInput']
  return isRecord(initialInput) && initialInput['inputId'] === identity.initialInputId
}

function hasValidSelection(selection: unknown): boolean {
  if (!isRecord(selection) || !isRecord(selection['provenance'])) return false
  const provenance = selection['provenance']
  const sources = new Set([
    'agent-profile',
    'project-target',
    'summon-directive',
    'compile-request',
    'catalog-default',
  ])
  return (
    isNonEmptyString(selection['harness']) &&
    isNonEmptyString(selection['modelProvider']) &&
    isNonEmptyString(selection['model']) &&
    typeof selection['presentation'] === 'boolean' &&
    ['harness', 'modelProvider', 'model', 'presentation'].every(
      (field) => typeof provenance[field] === 'string' && sources.has(provenance[field])
    ) &&
    (selection['reasoningEffort'] === undefined
      ? provenance['reasoningEffort'] === undefined
      : isNonEmptyString(selection['reasoningEffort']) &&
        typeof provenance['reasoningEffort'] === 'string' &&
        sources.has(provenance['reasoningEffort']))
  )
}

function hasDurablePlanMetadata(plan: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(plan['planHash']) &&
    isNonEmptyString(plan['compileId']) &&
    isNonEmptyString(plan['createdAt']) &&
    Array.isArray(plan['diagnostics'])
  )
}

function hasValidExecutionRelease(release: unknown): release is AspcExecutionRelease {
  if (!isRecord(release) || !isRecord(release['worker'])) return false
  const worker = release['worker']
  return (
    isNonEmptyString(release['releaseId']) &&
    isNonEmptyString(release['sourceCommit']) &&
    isNonEmptyString(release['builtAt']) &&
    isNonEmptyString(release['releaseRoot']) &&
    isNonEmptyString(worker['protocol']) &&
    isNonEmptyString(worker['executable']) &&
    Array.isArray(worker['argvPrefix']) &&
    worker['argvPrefix'].every((entry) => typeof entry === 'string')
  )
}

/** Validate the singular producer-selected v2 execution without choosing a driver. */
function admitV2Execution(
  response: unknown,
  identity: RuntimeIdentityAllocation,
  agentId: string
):
  | { admitted: true; plan: V2CompiledPlan; execution: V2SelectedExecution }
  | { admitted: false; code: V2ExecutionRejectionCode } {
  if (!hasV2CompileEnvelope(response) || !isRecord(response)) {
    return { admitted: false, code: 'v2-envelope-required' }
  }
  if (response['ok'] !== true || !isRecord(response['plan'])) {
    return { admitted: false, code: 'v2-plan-required' }
  }
  const plan = response['plan'] as V2CompiledPlan
  if (plan.schemaVersion !== 'agent-runtime-plan/v2' || !hasDurablePlanMetadata(plan)) {
    return { admitted: false, code: 'v2-plan-required' }
  }
  if (!hasValidSelection(plan.selection)) {
    return { admitted: false, code: 'execution-selection-invalid' }
  }
  if (
    !isRecord(plan.agent) ||
    plan.agent.id !== agentId ||
    !isRecord(plan.identity) ||
    !hasMatchingAllocatedIdentity(plan.identity, identity)
  ) {
    return { admitted: false, code: 'execution-identity-mismatch' }
  }
  const execution = plan.execution
  if (
    !isRecord(execution) ||
    !isNonEmptyString(execution.recipeId) ||
    !isNonEmptyString(execution.driver) ||
    !isRecord(execution.hosting) ||
    !isRecord(execution.profile) ||
    !isRecord(execution.dispatchRequest) ||
    !isRecord(execution.dispatchRequest.startRequest)
  ) {
    return { admitted: false, code: 'execution-invalid' }
  }
  if (execution.protocol !== 'harness-broker/0.2') {
    return { admitted: false, code: 'execution-protocol-invalid' }
  }
  if (!hasValidHosting(execution.hosting)) {
    return { admitted: false, code: 'execution-hosting-invalid' }
  }
  if (!hasCoherentPresentation(execution, execution.hosting)) {
    return { admitted: false, code: 'execution-presentation-invalid' }
  }
  if (
    !isNonEmptyString(execution.profile.profileId) ||
    !isNonEmptyString(execution.profile.profileHash) ||
    !isNonEmptyString(execution.profile.compatibilityHash) ||
    !isNonEmptyString(execution.profile.startRequestHash)
  ) {
    return { admitted: false, code: 'execution-profile-invalid' }
  }
  const typed = execution as V2SelectedExecution
  const startRequest = typed.dispatchRequest.startRequest
  const startRequestRecord = startRequest as unknown as Record<string, unknown>
  const startSpec = startRequestRecord['spec']
  if (
    !isRecord(startSpec) ||
    !isRecord(startSpec['driver']) ||
    !isNonEmptyString(startSpec['driver']['kind']) ||
    startSpec['driver']['kind'] !== typed.driver
  ) {
    return { admitted: false, code: 'execution-driver-mismatch' }
  }
  if (!hasMatchingCanonicalStartIdentity(startRequestRecord, identity)) {
    return { admitted: false, code: 'execution-identity-mismatch' }
  }
  // v2 declares the canonical start-request hash. compatibilityHash is a
  // broader producer cache/reuse key, not a spec hash, so HRC must not invent
  // an equality between the two domains.
  if (neutralStartRequestHash(startRequest) !== typed.profile.startRequestHash) {
    return { admitted: false, code: 'execution-hash-mismatch' }
  }
  // Freeze the complete producer graph at admission. The plan carries selection
  // provenance and the singular execution carries the dispatch bytes; later
  // persistence must never observe a caller-mutated response object.
  return { admitted: true, plan: deepFreeze(plan), execution: deepFreeze(typed) }
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

  // (3) Translate only explicit v2 request selection and raw summon
  // directives. ASP owns all omitted values and the complete selection merge.
  const request = buildV2CompileRequest({
    intent,
    scopeRef: input.scopeRef,
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
      identity,
      diagnostics: response.diagnostics,
    }
  }
  if (!response.ok) {
    return {
      admitted: false,
      code: 'compile-not-ok',
      identity,
      diagnostics: response.diagnostics,
    }
  }

  const selection = admitV2Execution(response, identity, v2AgentIdForScope(input.scopeRef))

  if (!selection.admitted) {
    return {
      admitted: false,
      code: selection.code,
      identity,
      diagnostics: response.diagnostics,
    }
  }

  const responseRelease = (response as unknown as V2CompileResponse).executionRelease
  if (responseRelease !== undefined && !hasValidExecutionRelease(responseRelease)) {
    return {
      admitted: false,
      code: 'execution-release-invalid',
      identity,
      diagnostics: response.diagnostics,
    }
  }

  return {
    admitted: true,
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
