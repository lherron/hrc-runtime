/**
 * Broker compile adapter admission types (split from compile-adapter.ts).
 * Structural v2 wire views and the admission refusal vocabulary.
 */

import type { HrcRuntimeIntent } from 'hrc-core'
import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import type {
  CompileDiagnostic,
  RuntimeCompileRequest,
  RuntimeCorrelation,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'
import type { SelectedExecution, SelectedExecutionPlan } from '../broker/selected-execution.js'

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

type V2RequestedSelection = NonNullable<HrcRuntimeIntent['selection']>
type V2SummonDirectives = NonNullable<HrcRuntimeIntent['summonDirectives']>

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

export type V2CompiledPlan = V2SelectedExecutionPlan & {
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  execution: V2SelectedExecution
}

export type V2CompileResponse = {
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
  | 'execution_presentation_constraint_mismatch'
  | 'format2_initial_input_undeliverable'
