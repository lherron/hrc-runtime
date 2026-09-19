import {
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
} from 'hrc-core'
import type { InjectorSeatProbe, RuntimeSeatResponse, WithdrawSubmissionResponse } from 'hrc-core'

import { brokerCapabilitiesAdmissionClasses } from './broker/capabilities.js'
import type { HarnessBrokerController } from './broker/controller.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody, parseWithdrawSubmissionRequest } from './server-parsers.js'
import { json } from './server-util.js'

/**
 * Injector seat probe (T-08606): `GET /v1/runtimes/{runtimeId}/seat`.
 *
 * One read wrapping `HarnessBrokerController.seatProbe`, plus the frozen
 * invocation facts the injector persists as its write-ahead lower bound
 * (`invocationId` + `currentBrokerSeq`) and the frozen admission-class truth
 * used for door selection. The DB facts are returned even when the live probe
 * fails; the probe failure is carried in `probeError`, never thrown, so a
 * momentarily unreachable broker does not hide the committed lower bound.
 */
export async function handleRuntimeSeat(
  this: HrcServerInstanceForHandlers,
  runtimeId: string
): Promise<Response> {
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }
  const invocationId = runtime.activeInvocationId ?? null
  const invocation =
    invocationId === null ? null : this.db.brokerInvocations.getByInvocationId(invocationId)
  const admissionClasses =
    invocation?.capabilitiesJson === undefined
      ? null
      : (brokerCapabilitiesAdmissionClasses(invocation.capabilitiesJson) ?? null)
  const currentBrokerSeq =
    invocationId === null ? null : this.db.brokerInvocationEvents.maxBrokerSeq(invocationId)
  const probe = await this.getHarnessBrokerController().seatProbe(runtimeId)
  let injectorProbe: InjectorSeatProbe | null = null
  let probeError: { code: string; message: string } | null = null
  if (probe.ok) {
    const seat = probe.response.seat
    injectorProbe = {
      invocationId: probe.response.invocationId,
      seat:
        seat.state === 'turn-active'
          ? { state: seat.state, turnId: String(seat.turnId), policy: seat.policy }
          : seat.state === 'turn-observed'
            ? { state: seat.state, turnId: String(seat.turnId) }
            : { state: seat.state },
      brokerHeldDepth: probe.response.brokerHeldDepth,
    }
  } else {
    probeError = { code: probe.error.code, message: probe.error.message }
  }
  return json({
    runtimeId,
    invocationId,
    generation: runtime.generation,
    admissionClasses,
    currentBrokerSeq,
    probe: injectorProbe,
    probeError,
  } satisfies RuntimeSeatResponse)
}

/**
 * Injector submission withdraw (T-08606): `POST /v1/submissions/withdraw`.
 * Thin wrap of `HarnessBrokerController.withdraw`; the broker's outcome passes
 * through verbatim with the runtime echoed for correlation.
 */
export async function handleWithdrawSubmission(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseWithdrawSubmissionRequest(await parseJsonBody(request))
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
  let result: Awaited<ReturnType<HarnessBrokerController['withdraw']>>
  if (body.submissionId !== undefined) {
    result = await this.getHarnessBrokerController().withdraw({
      runtimeId: body.runtimeId,
      submissionId: body.submissionId,
      reason: body.reason,
    })
  } else if (body.envelopeId !== undefined) {
    result = await this.getHarnessBrokerController().withdraw({
      runtimeId: body.runtimeId,
      envelopeId: body.envelopeId,
      reason: body.reason,
    })
  } else {
    throw new HrcInternalError('withdraw request names no submission', {
      runtimeId: body.runtimeId,
    })
  }
  if (!result.ok) {
    throw new HrcRuntimeUnavailableError(result.error.message, {
      runtimeId: body.runtimeId,
      brokerErrorCode: result.error.code,
    })
  }
  const response = result.response
  return json({
    runtimeId: body.runtimeId,
    outcome: response.outcome,
    ...(response.outcome === 'not_held' ? { state: response.state } : {}),
  } satisfies WithdrawSubmissionResponse)
}

export const seatWithdrawHandlersMethods = {
  handleRuntimeSeat,
  handleWithdrawSubmission,
}

export type SeatWithdrawHandlersMethods = typeof seatWithdrawHandlersMethods
