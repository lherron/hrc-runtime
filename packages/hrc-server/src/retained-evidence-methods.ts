import {
  type CaptureRecoverResponse,
  HrcBadRequestError,
  HrcErrorCode,
  HrcNotFoundError,
  type HrcTurnAdmissionCloseRequest,
  type HrcTurnAdmissionReopenRequest,
} from 'hrc-core'
import {
  RETAINED_EVIDENCE_PASS_LIMIT,
  RETAINED_EVIDENCE_TERMINAL_DELAY_MS,
  type RecoverRetainedEvidenceInput,
  recoverRetainedEvidence,
  retainedEvidencePassCandidates,
} from './broker/offline-evidence'
import type { HrcServerInstance } from './index.js'
import { writeServerLog } from './server-log.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import type { HrcServerOptions } from './server-types.js'
import { json, timestamp } from './server-util.js'
import { probeBrokerHealth } from './startup-reconcile/broker-probe.js'

export const retainedEvidenceMethods = {
  /**
   * T-08566 — one retained-evidence recovery attempt for a runtime. Shared by the
   * operator route and the automatic triggers (terminal, startup, report, gap).
   */
  async recoverRetainedEvidence(
    this: HrcServerInstance,
    input: RecoverRetainedEvidenceInput
  ): Promise<CaptureRecoverResponse | undefined> {
    const controller = this.getHarnessBrokerController()
    const extra = this.options as HrcServerOptions & {
      offlineEvidenceSliceMaxPages?: number | undefined
    }
    return await recoverRetainedEvidence(
      {
        db: this.db,
        now: timestamp,
        ownerMap: this.brokerReattachOperations,
        probeBrokerHealth,
        activeClientInvocationId: (runtimeId) => controller.activeClientInvocationId(runtimeId),
        notifyEvent: (event) => this.notifyEvent(event),
        options: {
          ...(extra.offlineEvidenceSliceMaxPages !== undefined
            ? { sliceMaxPages: extra.offlineEvidenceSliceMaxPages }
            : {}),
        },
      },
      input
    )
  },

  /**
   * T-08566 O2 — one background attempt after HRC records a harness-broker
   * runtime entering a terminal status. Delayed briefly so an exiting worker's
   * endpoint has gone; a still-reachable endpoint is refused unrecorded and the
   * next startup pass retries.
   */
  scheduleRetainedEvidenceRecovery(this: HrcServerInstance, runtimeId: string): void {
    const timer = setTimeout(() => {
      this.retainedEvidenceTerminalTimers.delete(timer)
      void this.recoverRetainedEvidence({ runtimeId, trigger: 'terminal' }).catch((error) => {
        writeServerLog('WARN', 'retained_evidence.terminal_attempt_failed', { runtimeId, error })
      })
    }, RETAINED_EVIDENCE_TERMINAL_DELAY_MS)
    this.retainedEvidenceTerminalTimers.add(timer)
  },

  /**
   * T-08566 — bounded retained-evidence pass (startup and each lease-GC tick,
   * before the orphan sweep): at most 20 bound terminal runtimes whose evidence
   * is not yet attempted or is retryable. Incomplete and paused evidence waits
   * for an operator. Never blocks request service.
   */
  async runRetainedEvidencePass(this: HrcServerInstance): Promise<void> {
    if (this.retainedEvidencePassInFlight) return await this.retainedEvidencePassInFlight
    const pass = (async () => {
      const candidates = retainedEvidencePassCandidates(this.db, RETAINED_EVIDENCE_PASS_LIMIT)
      const outcomes: Record<string, number> = {}
      for (const runtimeId of candidates.runtimeIds) {
        try {
          const response = await this.recoverRetainedEvidence({ runtimeId, trigger: 'startup' })
          const outcome = response?.outcome ?? 'unknown_runtime'
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
        } catch (error) {
          outcomes['attempt_error'] = (outcomes['attempt_error'] ?? 0) + 1
          writeServerLog('WARN', 'retained_evidence.startup_attempt_failed', { runtimeId, error })
        }
      }
      // Quiet on an empty store (embedded CLI daemons keep stderr clean); any
      // attempt, eligible backlog or unbound-by-design history is logged.
      if (
        candidates.runtimeIds.length === 0 &&
        candidates.eligible === 0 &&
        candidates.unboundTerminal === 0
      ) {
        return
      }
      writeServerLog('INFO', 'retained_evidence.pass_complete', {
        attempted: candidates.runtimeIds.length,
        eligible: candidates.eligible,
        limit: RETAINED_EVIDENCE_PASS_LIMIT,
        outcomes,
        unboundTerminalRuntimes: candidates.unboundTerminal,
      })
    })()
    this.retainedEvidencePassInFlight = pass
    try {
      await pass
    } finally {
      if (this.retainedEvidencePassInFlight === pass) this.retainedEvidencePassInFlight = undefined
    }
  },

  /** `POST /v1/capture/recover` — explicit, mutating operator recovery (SPEC §4.2). */
  async handleCaptureRecover(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['runtimeId'] !== 'string') {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
    }
    const dryRun = body['dryRun'] === true
    if (!dryRun && body['yes'] !== true) {
      return json(
        {
          error: {
            code: 'confirmation_required',
            message: 'capture recover is mutating; pass yes (or dryRun)',
            detail: { runtimeId: body['runtimeId'] },
          },
        },
        400
      )
    }
    const response = await this.recoverRetainedEvidence({
      runtimeId: body['runtimeId'],
      trigger: 'operator',
      dryRun,
    })
    if (response === undefined) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        `unknown runtime: ${body['runtimeId']}`
      )
    }
    return json(response)
  },

  async handleCloseTurnAdmission(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['operationId'] !== 'string') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission close requires operationId'
      )
    }
    const requestedBy = body['requestedBy']
    const requestedRunId = body['requestedRunId']
    const reason = body['reason']
    if (
      (requestedBy !== undefined && requestedBy !== null && typeof requestedBy !== 'string') ||
      (requestedRunId !== undefined &&
        requestedRunId !== null &&
        typeof requestedRunId !== 'string') ||
      (reason !== undefined && typeof reason !== 'string')
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission close attribution is malformed'
      )
    }
    const input: HrcTurnAdmissionCloseRequest = {
      operationId: body['operationId'],
      ...(requestedBy === undefined ? {} : { requestedBy }),
      ...(requestedRunId === undefined ? {} : { requestedRunId }),
      ...(reason === undefined ? {} : { reason }),
    }
    return json(await this.turnAdmissionGate.close(input))
  },

  async handleReopenTurnAdmission(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['operationId'] !== 'string') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission reopen requires operationId'
      )
    }
    const input: HrcTurnAdmissionReopenRequest = { operationId: body['operationId'] }
    return json(await this.turnAdmissionGate.reopen(input.operationId))
  },
}

export type RetainedEvidenceMethods = typeof retainedEvidenceMethods
