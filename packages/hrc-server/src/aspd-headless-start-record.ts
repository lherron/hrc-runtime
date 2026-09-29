import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcExecutionFormat, HrcRuntimeIntent } from 'hrc-core'
import type {
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
} from 'spaces-aspc-protocol'
import type { BrokerLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'
import { buildAspdWorkerArgv } from './agent-spaces-adapter/aspd-execution-release.js'
import type { AspdServiceIdentity } from './agent-spaces-adapter/aspd-preparation-client.js'
import {
  type BrokerSubstratePaths,
  describeBrokerSubstratePaths,
} from './broker-interactive-handlers/substrate-allocator.js'
import type { SelectedExecution, SelectedExecutionPlan } from './broker/selected-execution.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { getBrokerObserverSocketPath } from './tmux-socket.js'
import type { toBrokerResponseFormat } from './turn-response-format.js'

export const ASPD_PREPARATION_SCHEMA = 'hrc-aspd-preparation/v1'
type OkCompileResponse = Extract<AspcCompileHarnessInvocationResponse, { ok: true }>

/**
 * The routes a frozen aspd preparation launches on (T-08556 adds the interactive
 * Codex TUI; T-08562 adds the non-Codex interactive tmux broker route; the
 * headless muse-serve route admits that driver with presentation none or the
 * observer viewer).
 */
export type AspdPreparationRoute = 'producer-selected-execution'

/** The frozen preparation persisted in `runtime_operations.preparation_json`. */
export type AspdPreparationRecord = {
  schemaVersion: typeof ASPD_PREPARATION_SCHEMA
  route: AspdPreparationRoute
  preparedAt: string
  hostSessionId: string
  generation: number
  runtimeId: string
  /** Format 2 has no admission-time run; it mints a carrier on turn.started. */
  runId?: string | undefined
  operationId: string
  dispatchIdempotencyKey?: string | undefined
  aspd: AspdServiceIdentity
  /** The complete, unchanged successful compileHarnessInvocation response. */
  response: OkCompileResponse
  executionRelease: AspcExecutionRelease
  admission: {
    execution: SelectedExecution
    plan: SelectedExecutionPlan
    hrcPolicy: RuntimeCompileRequest['hrcPolicy']
    identity: RuntimeIdentityAllocation
    /** HRC admission format frozen before this preparation crosses P. */
    executionFormat: HrcExecutionFormat
  }
  hosting: {
    /** Producer-selected diagnostic key used only to name per-runtime paths. */
    driverKind: string
    /** A resource projection derived solely from the admitted execution. */
    presentation: AspdHostingPresentation
    executable: string
    argv: string[]
    paths: AspdHostingPaths
  }
  dispatch: {
    dispatchEnv?: Record<string, string> | undefined
    /** Stable format-2 admission body identity, retained across a preparation retry. */
    format2RequestHash?: string | undefined
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
    routeDecision: Record<string, unknown>
    runtimeAuthority?: Record<string, unknown> | undefined
    requestedResponseFormat?: ReturnType<typeof toBrokerResponseFormat>
  }
  intent: HrcRuntimeIntent
  startOutcome?: 'rejected' | 'uncertain' | undefined
}

export type AspdHostingPresentation = 'none' | 'terminal' | 'attachable'

/** HRC's deterministic hosting paths; a viewer adds its observer socket. */
export type AspdHostingPaths = BrokerSubstratePaths & { observerSocketPath?: string | undefined }

export function describeAspdHostingPaths(
  options: HrcServerInstanceForHandlers['options'],
  driverKind: string,
  runtimeId: string,
  presentation: AspdHostingPresentation
): AspdHostingPaths {
  const paths = describeBrokerSubstratePaths(options, driverKind, runtimeId)
  return presentation === 'attachable'
    ? {
        ...paths,
        observerSocketPath: getBrokerObserverSocketPath(options, driverKind, runtimeId),
      }
    : paths
}

export function aspdWorkerArgv(
  release: AspcExecutionRelease,
  record: Pick<AspdPreparationRecord, 'runtimeId' | 'hostSessionId' | 'generation'>,
  paths: AspdHostingPaths
): string[] {
  return buildAspdWorkerArgv(release, {
    socketPath: paths.brokerIpcSocketPath,
    eventLedgerPath: paths.eventLedgerPath,
    runtimeId: record.runtimeId,
    hostSessionId: record.hostSessionId,
    generation: record.generation,
    attachTokenPath: paths.attachTokenPath,
    ...(paths.observerSocketPath !== undefined
      ? { observerSocketPath: paths.observerSocketPath }
      : {}),
  })
}

export function presentationForExecution(execution: SelectedExecution): AspdHostingPresentation {
  if (execution.presentationSurface?.transport === 'websocket-unix') return 'attachable'
  return execution.hosting.terminalRequired ? 'terminal' : 'none'
}

export function aspdStartError(
  code: string,
  message: string,
  detail: Record<string, unknown>
): HrcRuntimeUnavailableError {
  return new HrcRuntimeUnavailableError(message, { code, route: 'aspd', ...detail })
}

/** Read and parse a prepared operation's frozen record from the database. */
export function readAspdPreparation(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  operationId: string
): { status: string; record: AspdPreparationRecord } {
  const operation = server.db.runtimeOperations.getByOperationId(operationId)
  if (operation?.preparationJson === undefined) {
    throw aspdStartError('aspd_preparation_missing', `no aspd preparation ${operationId}`, {
      operationId,
    })
  }
  const record = JSON.parse(operation.preparationJson) as AspdPreparationRecord
  if (record.schemaVersion !== ASPD_PREPARATION_SCHEMA || record.operationId !== operationId) {
    throw aspdStartError('aspd_preparation_invalid', `aspd preparation ${operationId} is invalid`, {
      operationId,
      schemaVersion: record.schemaVersion,
    })
  }
  return { status: operation.status, record }
}
