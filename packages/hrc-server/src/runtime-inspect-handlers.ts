import { HrcBadRequestError, HrcDomainError, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type {
  BrokerInspectResponse,
  FinalSummaryRecoveryResult,
  InspectRuntimeResponse,
} from 'hrc-core'
import type {
  CaptureStateView,
  EvidenceAuthorityMatrix,
  InvocationCaptureReleaseRequest,
} from 'spaces-harness-broker-protocol'

import { projectActuatorSplitInspectAuthority } from './actuator-split.js'
import { canOperatorAttach, projectBrokerHostingState } from './broker/runtime-hosting.js'
import { extractFullRuntimeControlState } from './broker/runtime-state.js'
import { requireSession } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  isRecord,
  parseBrokerInspectRequest,
  parseInspectRuntimeRequest,
  parseJsonBody,
} from './server-parsers.js'
import { json } from './server-util.js'
import { resolvePersistedBrokerAttachToken } from './startup-reconcile/broker-probe.js'
import { getPersistedDurableBrokerEndpoint } from './startup-reconcile/lease-identity.js'
import { toStatusTmuxView } from './status-views.js'

export async function handleInspectRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseInspectRuntimeRequest(await parseJsonBody(request))
  const runtime = this.db.runtimes.getByRuntimeId(body.runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_RUNTIME,
      `unknown runtime "${body.runtimeId}"`,
      {
        runtimeId: body.runtimeId,
      }
    )
  }

  const session = requireSession(this.db, runtime.hostSessionId)
  const nowMs = Date.now()
  const createdAtMs = Date.parse(runtime.createdAt)
  const lastActivityAt = runtime.lastActivityAt ?? null
  const lastActivityAtMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN
  const continuation = runtime.continuation ?? session.continuation ?? null
  const eventHighWaterSeq = runtime.activeInvocationId
    ? (this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)?.lastEventSeq ??
      null)
    : null
  const control = extractFullRuntimeControlState(runtime.runtimeStateJson, eventHighWaterSeq)
  const authority = projectActuatorSplitInspectAuthority(runtime.runtimeStateJson)
  // T-01876 Ph5 — separate endpoint/substrate/presentation projection (spec
  // §10.9). Undefined for non-broker / unparseable runtimes so those rows do
  // not grow the new fields.
  const brokerHosting = projectBrokerHostingState(runtime)
  const capture = runtime.runtimeStateJson?.['capture'] as CaptureStateView | undefined
  const brokerState = runtime.runtimeStateJson?.['broker'] as Record<string, unknown> | undefined
  const evidenceAuthority = brokerState?.['evidenceAuthority'] as
    | EvidenceAuthorityMatrix
    | undefined
  const sessionCreatedAtMs = Date.parse(session.createdAt)
  const continuationAgeSec = Number.isFinite(sessionCreatedAtMs)
    ? Math.max(0, Math.floor((nowMs - sessionCreatedAtMs) / 1000))
    : 0

  const response = {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    transport: runtime.transport,
    harness: runtime.harness,
    provider: runtime.provider,
    status: runtime.status,
    createdAt: runtime.createdAt,
    createdAgeSec: Number.isFinite(createdAtMs)
      ? Math.max(0, Math.floor((nowMs - createdAtMs) / 1000))
      : 0,
    lastActivityAt,
    lastActivityAgeSec: Number.isFinite(lastActivityAtMs)
      ? Math.max(0, Math.floor((nowMs - lastActivityAtMs) / 1000))
      : null,
    activeRunId: runtime.activeRunId ?? null,
    controllerKind: runtime.controllerKind ?? null,
    activeOperationId: runtime.activeOperationId ?? null,
    activeInvocationId: runtime.activeInvocationId ?? null,
    wrapperPid: runtime.wrapperPid ?? null,
    childPid: runtime.childPid ?? null,
    continuation,
    continuationKey: continuation?.key ?? null,
    continuationStale:
      continuation !== null &&
      this.staleGenerationEnabled &&
      this.staleGenerationThresholdSec > 0 &&
      continuationAgeSec > this.staleGenerationThresholdSec,
    ...(capture !== undefined ? { capture } : {}),
    ...(evidenceAuthority !== undefined ? { evidenceAuthority } : {}),
    ...(authority ? { authority } : {}),
    ...(control ? { control } : {}),
    ...(runtime.transport === 'tmux' || canOperatorAttach(runtime)
      ? { tmux: toStatusTmuxView(runtime.tmuxJson) }
      : {}),
    ...(brokerHosting ? brokerHosting : {}),
  } satisfies InspectRuntimeResponse & {
    capture?: CaptureStateView | undefined
    evidenceAuthority?: EvidenceAuthorityMatrix | undefined
  }
  return json(response)
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  detail: Record<string, unknown> = {}
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, detail)
  }
  return value
}

function parseCaptureRuntimeRequest(value: unknown): { runtimeId: string } {
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  return { runtimeId: requireNonEmptyString(value['runtimeId'], 'runtimeId') }
}

function parseCaptureReleaseRequest(value: unknown): {
  runtimeId: string
  operatorPrincipal: string
  release: Omit<InvocationCaptureReleaseRequest, 'invocationId'>
} {
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const runtimeId = requireNonEmptyString(value['runtimeId'], 'runtimeId')
  const operatorPrincipal = requireNonEmptyString(value['operatorPrincipal'], 'operatorPrincipal')
  if (operatorPrincipal !== 'human' && !operatorPrincipal.startsWith('human:')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'capture release requires an operator principal',
      { operatorPrincipal }
    )
  }
  const rawRecordId = requireNonEmptyString(value['rawRecordId'], 'rawRecordId')
  const disposition = value['disposition']
  if (disposition !== 'ignored-known' && disposition !== 'normalized-as') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'disposition must be ignored-known or normalized-as'
    )
  }
  const note = value['note']
  if (note !== undefined && typeof note !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'note must be a string')
  }

  let normalizedAs: InvocationCaptureReleaseRequest['normalizedAs']
  if (disposition === 'normalized-as') {
    const candidate = value['normalizedAs']
    if (!isRecord(candidate) || !Object.hasOwn(candidate, 'payload')) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'normalizedAs with type and payload is required for normalized-as'
      )
    }
    normalizedAs = {
      type: requireNonEmptyString(candidate['type'], 'normalizedAs.type') as never,
      payload: candidate['payload'],
      ...(typeof candidate['turnId'] === 'string' ? { turnId: candidate['turnId'] as never } : {}),
      ...(typeof candidate['itemId'] === 'string' ? { itemId: candidate['itemId'] } : {}),
    }
  } else if (value['normalizedAs'] !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'normalizedAs is only valid with disposition normalized-as'
    )
  }

  return {
    runtimeId,
    operatorPrincipal,
    release: {
      rawRecordId,
      disposition,
      ...(normalizedAs !== undefined ? { normalizedAs } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  }
}

function throwCaptureControlError(error: {
  code: string
  message: string
  detail: Record<string, unknown>
}): never {
  const reason = error.detail['reason']
  if (typeof reason === 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, reason, error.detail)
  }
  throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, error.message, {
    code: error.code,
    ...error.detail,
  })
}

export async function handleBrokerCaptureStatus(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const { runtimeId } = parseCaptureRuntimeRequest(await parseJsonBody(request))
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }
  const controller = this.harnessBrokerController
  if (!controller) {
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      `broker controller unavailable for runtime ${runtimeId}`,
      { runtimeId }
    )
  }
  const result = await controller.captureStatus(runtimeId)
  if (!result.ok) throwCaptureControlError(result.error)
  return json({ runtimeId, capture: result.response })
}

export async function handleBrokerCaptureRelease(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseCaptureReleaseRequest(await parseJsonBody(request))
  const runtime = this.db.runtimes.getByRuntimeId(body.runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_RUNTIME,
      `unknown runtime "${body.runtimeId}"`,
      { runtimeId: body.runtimeId }
    )
  }
  const controller = this.harnessBrokerController
  if (!controller) {
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      `broker controller unavailable for runtime ${body.runtimeId}`,
      { runtimeId: body.runtimeId }
    )
  }
  const result = await controller.captureRelease(
    body.runtimeId,
    body.release,
    body.operatorPrincipal
  )
  if (!result.ok) throwCaptureControlError(result.error)
  return json(result.response)
}

/**
 * T-01856 P3 — operator broker-inspect surface (T-01844 #4/#5).
 *
 * Read-only. MUST NOT mutate DB state. For broker-backed runtimes this calls
 * the P2 controller read model (controller.listInvocations) and returns the
 * broker's InvocationInspectionSummary[] passed through verbatim (no recompute,
 * cody C-03259 render guards live broker-side / pass-through here). For
 * non-broker runtimes it synthesizes an HRC-runtime-derived lifecycle view and
 * LABELS it `source:'hrc-derived'` so operators never read a synthesized TTL as
 * broker-enforced (item #5 must-not-mislead).
 */
export async function handleBrokerInspect(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseBrokerInspectRequest(await parseJsonBody(request))
  const runtime = this.db.runtimes.getByRuntimeId(body.runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_RUNTIME,
      `unknown runtime "${body.runtimeId}"`,
      {
        runtimeId: body.runtimeId,
      }
    )
  }

  let finalSummary = (runtime.runtimeStateJson as { finalSummary?: unknown } | undefined)
    ?.finalSummary
  let finalSummaryRecovery: FinalSummaryRecoveryResult | undefined
  if (body.recoverFinalSummary !== undefined) {
    if (finalSummary !== undefined) {
      finalSummaryRecovery = { state: 'not_needed' }
    } else if (runtime.controllerKind !== 'harness-broker') {
      finalSummaryRecovery = { state: 'not_broker' }
    } else {
      const endpoint = getPersistedDurableBrokerEndpoint(runtime)
      const attachToken = endpoint ? await resolvePersistedBrokerAttachToken(runtime) : undefined
      const controller = this.harnessBrokerController
      if (!endpoint || !attachToken) {
        finalSummaryRecovery = { state: 'not_durable' }
      } else if (!controller) {
        finalSummaryRecovery = { state: 'unavailable', message: 'broker controller unavailable' }
      } else {
        finalSummaryRecovery = await controller.recoverFinalSummary({
          runtimeId: runtime.runtimeId,
          socketPath: endpoint.socketPath,
          attachToken,
          ...(body.recoverFinalSummary.timeoutMs !== undefined
            ? { timeoutMs: body.recoverFinalSummary.timeoutMs }
            : {}),
        })
        const recoveredRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
        finalSummary = (
          recoveredRuntime?.runtimeStateJson as { finalSummary?: unknown } | undefined
        )?.finalSummary
      }
    }
  }
  const baseFacts = {
    runtimeId: runtime.runtimeId,
    transport: runtime.transport,
    harness: runtime.harness,
    status: runtime.status,
    lastActivityAt: runtime.lastActivityAt ?? null,
    ...(finalSummary !== undefined ? { finalSummary } : {}),
    ...(finalSummaryRecovery !== undefined ? { finalSummaryRecovery } : {}),
  }

  // Broker-backed: delegate to the P2 controller read model. The summaries pass
  // through verbatim — liveness ('cached'/absent) and retention.blockedBy are
  // broker truth and are NEVER re-derived or stripped here.
  const controller = this.harnessBrokerController
  if (runtime.controllerKind === 'harness-broker' && controller) {
    // T-07077 — `includeInvocations:false` skips the broker read model entirely.
    // The runtime is still broker-backed, so this MUST stay `source:'broker'`;
    // falling through to the hrc-derived branch would label broker facts as
    // synthesized. `invocations` is omitted (not []) so callers can tell "not
    // asked for" apart from "asked for, none present".
    if (body.includeInvocations === false) {
      return json({
        ...baseFacts,
        source: 'broker',
      } satisfies BrokerInspectResponse)
    }
    const result = await controller.listInvocations(body.runtimeId, {
      ...(body.includeDisposed !== undefined ? { includeDisposed: body.includeDisposed } : {}),
      ...(body.probeLiveness !== undefined ? { probeLiveness: body.probeLiveness } : {}),
    })
    const invocations = Array.isArray(result) ? result : []
    return json({
      ...baseFacts,
      source: 'broker',
      invocations,
    } satisfies BrokerInspectResponse)
  }

  // Non-broker fallback — HRC-runtime-derived, NEVER broker-reported.
  const note = 'HRC-runtime-derived, not broker-reported'
  // pre-broker / adopted harness: runtime-DB facts ONLY. No idle policy applies,
  // so no synthesized TTL — mode reflects db-only, never a broker retention mode.
  return json({
    ...baseFacts,
    source: 'hrc-derived',
    lifecycle: { retention: { mode: 'db-only' } },
    note,
  } satisfies BrokerInspectResponse)
}

export const runtimeInspectHandlersMethods = {
  handleInspectRuntime,
  handleBrokerInspect,
  handleBrokerCaptureStatus,
  handleBrokerCaptureRelease,
}

export type RuntimeInspectHandlersMethods = typeof runtimeInspectHandlersMethods
