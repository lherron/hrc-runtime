/**
 * Broker compile adapter v2 execution admission (split from compile-adapter.ts).
 * Validates the singular producer-selected v2 execution without choosing a driver.
 */

import type { HrcExecutionFormat } from 'hrc-core'
import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import { neutralStartRequestHash } from 'spaces-runtime-contracts'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'
import type {
  HrcAdmissionDiagnostic,
  V2CompiledPlan,
  V2ExecutionRejectionCode,
  V2SelectedExecution,
} from './compile-adapter-types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function deepFreeze<T>(value: T): T {
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

export function hasV2CompileEnvelope(response: unknown): boolean {
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

export function admissionRefusal(
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

export function hasValidExecutionRelease(release: unknown): release is AspcExecutionRelease {
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
export function admitV2Execution(
  response: unknown,
  identity: RuntimeIdentityAllocation,
  agentId: string,
  executionFormat: HrcExecutionFormat,
  requestedOperatorPresentation: 'none' | 'tmux-tui' | 'observer' | undefined
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
  if (requestedOperatorPresentation === 'tmux-tui') {
    const selection = plan.selection as unknown as Record<string, unknown>
    const provenance = isRecord(selection['provenance']) ? selection['provenance'] : {}
    const surface: Record<string, unknown> = isRecord(execution['presentationSurface'])
      ? execution['presentationSurface']
      : {}
    const actual = {
      requestedOperatorPresentation,
      selectedPresentation: selection['presentation'],
      presentationProvenance: provenance['presentation'],
      terminalRequired: execution.hosting['terminalRequired'],
      terminalHost: execution.hosting['terminalHost'],
      presentationSurface: execution['presentationSurface'],
    }
    if (
      selection['presentation'] !== true ||
      provenance['presentation'] !== 'compile-request' ||
      execution.hosting['terminalRequired'] !== true ||
      execution.hosting['terminalHost'] !== 'tmux' ||
      (surface['transport'] !== 'terminal' && surface['transport'] !== 'websocket-unix') ||
      surface['terminalHost'] !== 'tmux'
    ) {
      return admissionRefusal(
        'execution_presentation_constraint_mismatch',
        'plan.execution.presentation',
        actual,
        {
          requestedOperatorPresentation: 'tmux-tui',
          selectedPresentation: true,
          presentationProvenance: 'compile-request',
          terminalRequired: true,
          terminalHost: 'tmux',
          presentationSurface: { transport: ['terminal', 'websocket-unix'], terminalHost: 'tmux' },
        }
      )
    }
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
  // A format-2 first prompt has exactly one delivery channel: the frozen
  // broker initialInput. Format 1 may use a terminal profile's launch argv,
  // but admitting that shape for format 2 would create an HRC input with no
  // broker-addressable submission identity. Refuse before boundary P.
  if (
    executionFormat === 'format2' &&
    identity.initialInputId !== undefined &&
    !isRecord(startRequestRecord['initialInput'])
  ) {
    return admissionRefusal(
      'format2_initial_input_undeliverable',
      'startRequest.initialInput',
      startRequestRecord['initialInput'],
      'broker-deliverable initialInput'
    )
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
