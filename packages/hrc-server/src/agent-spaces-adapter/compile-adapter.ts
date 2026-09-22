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

/**
 * T-08712/T-08713: why HRC refused a successful ASP compile. Ids and hashes are
 * echoed as-is; `null` means the producer response had no value at that path.
 */
export type HrcAdmissionDiagnostic = {
  level: 'error'
  plane: 'hrc-admission'
  code: V2ExecutionRejectionCode
  field: string
  expected?: unknown
  actual: unknown
  message: string
  check?: 'plan-identity' | 'start-request-identity' | undefined
  fields?: Array<{ name: string; requested: unknown; compiled: unknown }> | undefined
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

type IdentityMismatch = { field: string; expected: unknown; actual: unknown }

function allocatedIdentityMismatches(
  planIdentity: Record<string, unknown>,
  identity: RuntimeIdentityAllocation
): IdentityMismatch[] {
  return allocatedPlanIdentityFields.flatMap((field) =>
    planIdentity[field] === identity[field]
      ? []
      : [
          {
            field: `plan.identity.${field}`,
            expected: identity[field],
            actual: planIdentity[field],
          },
        ]
  )
}

function canonicalStartIdentityMismatches(
  startRequest: Record<string, unknown>,
  identity: RuntimeIdentityAllocation,
  hosting: Record<string, unknown>
): IdentityMismatch[] {
  const mismatches: IdentityMismatch[] = []
  const spec = isRecord(startRequest['spec']) ? startRequest['spec'] : {}
  if (spec['invocationId'] !== identity.invocationId) {
    mismatches.push({
      field: 'startRequest.spec.invocationId',
      expected: identity.invocationId,
      actual: spec['invocationId'],
    })
  }
  const correlation = spec['correlation']
  if (!isRecord(correlation)) {
    mismatches.push({
      field: 'startRequest.spec.correlation',
      expected: 'object',
      actual: correlation,
    })
  } else {
    const correlationFields: readonly (keyof RuntimeIdentityAllocation)[] = [
      'requestId',
      'operationId',
      'hostSessionId',
      'runtimeId',
      'runId',
      'traceId',
    ]
    for (const field of correlationFields) {
      if (correlation[field] !== identity[field]) {
        mismatches.push({
          field: `startRequest.spec.correlation.${field}`,
          expected: identity[field],
          actual: correlation[field],
        })
      }
    }
  }
  if (identity.initialInputId === undefined) {
    return mismatches
  }
  const initialInput = startRequest['initialInput']
  // T-08712: a terminal-hosted execution delivers its first turn through the
  // launch substrate (argv/priming), never as broker initialInput, so there is
  // no input id to echo. HRC still binds the turn by the echoed runId above.
  // Any execution that does carry initialInput must echo the allocation.
  if (initialInput === undefined && hosting['terminalHost'] === 'tmux') {
    return mismatches
  }
  const inputId = isRecord(initialInput) ? initialInput['inputId'] : undefined
  if (inputId !== identity.initialInputId) {
    mismatches.push({
      field: 'startRequest.initialInput.inputId',
      expected: identity.initialInputId,
      actual: inputId,
    })
  }
  return mismatches
}

function describeValue(value: unknown): string {
  return value === undefined || value === null ? '(absent)' : JSON.stringify(value)
}

function admissionRefusal(
  code: V2ExecutionRejectionCode,
  field: string,
  actual: unknown,
  expected?: unknown
): { admitted: false; code: V2ExecutionRejectionCode; diagnostic: HrcAdmissionDiagnostic } {
  const normalizedActual = actual === undefined ? null : actual
  return {
    admitted: false,
    code,
    diagnostic: {
      level: 'error',
      plane: 'hrc-admission',
      code,
      field,
      ...(expected !== undefined ? { expected } : {}),
      actual: normalizedActual,
      message:
        expected !== undefined
          ? `${field}: expected ${describeValue(expected)}, got ${describeValue(actual)}`
          : `${field}: invalid value ${describeValue(actual)}`,
    },
  }
}

function identityAdmissionRefusal(
  check: 'plan-identity' | 'start-request-identity',
  fields: IdentityMismatch[]
): { admitted: false; code: V2ExecutionRejectionCode; diagnostic: HrcAdmissionDiagnostic } {
  const first = fields[0]
  if (first === undefined)
    throw new Error('identity refusal requires at least one mismatched field')
  const refusal = admissionRefusal(
    'execution-identity-mismatch',
    first.field,
    first.actual,
    first.expected
  )
  return {
    ...refusal,
    diagnostic: {
      ...refusal.diagnostic,
      check,
      fields: fields.map((field) => ({
        name: field.field,
        requested: field.expected ?? null,
        compiled: field.actual ?? null,
      })),
    },
  }
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
  | { admitted: false; code: V2ExecutionRejectionCode; diagnostic: HrcAdmissionDiagnostic } {
  if (!hasV2CompileEnvelope(response) || !isRecord(response)) {
    return admissionRefusal(
      'v2-envelope-required',
      'schemaVersion',
      isRecord(response) ? response['schemaVersion'] : undefined,
      'aspc-compile-harness-invocation-response/v2'
    )
  }
  if (response['ok'] !== true || !isRecord(response['plan'])) {
    return admissionRefusal(
      'v2-plan-required',
      'plan',
      response['plan'] === undefined ? undefined : typeof response['plan']
    )
  }
  const plan = response['plan'] as V2CompiledPlan
  if (plan.schemaVersion !== 'agent-runtime-plan/v2') {
    return admissionRefusal(
      'v2-plan-required',
      'plan.schemaVersion',
      plan.schemaVersion,
      'agent-runtime-plan/v2'
    )
  }
  if (!hasDurablePlanMetadata(plan)) {
    const record = plan as unknown as Record<string, unknown>
    const field = ['planHash', 'compileId', 'createdAt'].find(
      (key) => !isNonEmptyString(record[key])
    )
    return field !== undefined
      ? admissionRefusal('v2-plan-required', `plan.${field}`, record[field])
      : admissionRefusal('v2-plan-required', 'plan.diagnostics', record['diagnostics'])
  }
  if (!hasValidSelection(plan.selection)) {
    return admissionRefusal('execution-selection-invalid', 'plan.selection', plan.selection)
  }
  if (!isRecord(plan.agent) || plan.agent.id !== agentId) {
    return identityAdmissionRefusal('plan-identity', [
      {
        field: 'plan.agent.id',
        actual: isRecord(plan.agent) ? plan.agent.id : undefined,
        expected: agentId,
      },
    ])
  }
  const planIdentityMismatches = isRecord(plan.identity)
    ? allocatedIdentityMismatches(plan.identity, identity)
    : [{ field: 'plan.identity', expected: 'object', actual: plan.identity }]
  if (planIdentityMismatches.length > 0) {
    return identityAdmissionRefusal('plan-identity', planIdentityMismatches)
  }
  const execution = plan.execution
  if (!isRecord(execution)) {
    return admissionRefusal('execution-invalid', 'plan.execution', execution)
  }
  const missingExecutionField = (
    [
      ['recipeId', isNonEmptyString(execution.recipeId)],
      ['driver', isNonEmptyString(execution.driver)],
      ['hosting', isRecord(execution.hosting)],
      ['profile', isRecord(execution.profile)],
      ['dispatchRequest', isRecord(execution.dispatchRequest)],
      [
        'dispatchRequest.startRequest',
        isRecord(execution.dispatchRequest) && isRecord(execution.dispatchRequest.startRequest),
      ],
    ] as const
  ).find(([, present]) => !present)?.[0]
  if (missingExecutionField !== undefined) {
    return admissionRefusal(
      'execution-invalid',
      `plan.execution.${missingExecutionField}`,
      missingExecutionField === 'dispatchRequest.startRequest'
        ? undefined
        : (execution as unknown as Record<string, unknown>)[missingExecutionField]
    )
  }
  if (execution.protocol !== 'harness-broker/0.2') {
    return admissionRefusal(
      'execution-protocol-invalid',
      'plan.execution.protocol',
      execution.protocol,
      'harness-broker/0.2'
    )
  }
  if (!hasValidHosting(execution.hosting)) {
    return admissionRefusal(
      'execution-hosting-invalid',
      'plan.execution.hosting',
      execution.hosting
    )
  }
  if (!hasCoherentPresentation(execution, execution.hosting)) {
    return admissionRefusal('execution-presentation-invalid', 'plan.execution.presentation', {
      presentationFulfillment: execution['presentationFulfillment'],
      presentationSurface: execution['presentationSurface'],
      terminalRequired: execution.hosting['terminalRequired'],
    })
  }
  const profileField = (
    ['profileId', 'profileHash', 'compatibilityHash', 'startRequestHash'] as const
  ).find((key) => !isNonEmptyString(execution.profile[key]))
  if (profileField !== undefined) {
    return admissionRefusal(
      'execution-profile-invalid',
      `plan.execution.profile.${profileField}`,
      execution.profile[profileField]
    )
  }
  const typed = execution as V2SelectedExecution
  const startRequest = typed.dispatchRequest.startRequest
  const startRequestRecord = startRequest as unknown as Record<string, unknown>
  const startSpec = startRequestRecord['spec']
  const startDriver =
    isRecord(startSpec) && isRecord(startSpec['driver']) ? startSpec['driver']['kind'] : undefined
  if (!isNonEmptyString(startDriver) || startDriver !== typed.driver) {
    return admissionRefusal(
      'execution-driver-mismatch',
      'startRequest.spec.driver.kind',
      startDriver,
      typed.driver
    )
  }
  const startIdentityMismatches = canonicalStartIdentityMismatches(
    startRequestRecord,
    identity,
    typed.hosting as unknown as Record<string, unknown>
  )
  if (startIdentityMismatches.length > 0) {
    return identityAdmissionRefusal('start-request-identity', startIdentityMismatches)
  }
  // v2 declares the canonical start-request hash. compatibilityHash is a
  // broader producer cache/reuse key, not a spec hash, so HRC must not invent
  // an equality between the two domains.
  const startRequestHash = neutralStartRequestHash(startRequest)
  if (startRequestHash !== typed.profile.startRequestHash) {
    return admissionRefusal(
      'execution-hash-mismatch',
      'plan.execution.profile.startRequestHash',
      typed.profile.startRequestHash,
      startRequestHash
    )
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

  const selection = admitV2Execution(response, identity, v2AgentIdForScope(input.scopeRef))

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
