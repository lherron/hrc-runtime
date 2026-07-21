import type {
  FederationOutboxDeliveryRecord,
  FederationOutboxRepository,
  HrcDatabase,
} from 'hrc-store-sqlite'

import type { PeerAcceptClientResult } from './accept-client.js'

const SECOND_MS = 1_000
const HOUR_MS = 60 * 60 * SECOND_MS
const DAY_MS = 24 * HOUR_MS

export type FederationOutboxRetryPolicy = {
  /** Delay after the first failed attempt. */
  initialRetryDelayMs: number
  /** Exponential delays stop growing here, but retries continue. */
  maxRetryDelayMs: number
  /** A sleeping peer remains automatic-retry territory for this whole window. */
  deadLetterAfterMs: number
}

export const DEFAULT_FEDERATION_OUTBOX_RETRY_POLICY: FederationOutboxRetryPolicy = {
  initialRetryDelayMs: SECOND_MS,
  maxRetryDelayMs: 6 * HOUR_MS,
  deadLetterAfterMs: 28 * DAY_MS,
}

export function federationRetryDelayMs(
  attemptNumber: number,
  policy: FederationOutboxRetryPolicy = DEFAULT_FEDERATION_OUTBOX_RETRY_POLICY
): number {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error('attemptNumber must be a positive integer')
  }
  const exponent = Math.min(attemptNumber - 1, 52)
  return Math.min(policy.initialRetryDelayMs * 2 ** exponent, policy.maxRetryDelayMs)
}

export type FederationOutboxSend = (
  delivery: FederationOutboxDeliveryRecord
) => Promise<PeerAcceptClientResult>

export type FederationOutboxDeliveryObservation = {
  transition:
    | 'attempt_started'
    | 'delivered'
    | 'retry_scheduled'
    | 'peer_unreachable'
    | 'dead_lettered'
  deliveryId: string
  messageId: string
  peerNodeId: string
  phase: FederationOutboxDeliveryRecord['envelope']['phase']
  replyToMessageId?: string | undefined
  rootMessageId: string
  attemptNumber: number
  cycleAttemptNumber: number
  acceptOutcome?: 'accepted' | 'duplicate' | undefined
  errorCode?: string | undefined
  nextAttemptAt?: string | undefined
}

export type FederationOutboxDeliveryEngineOptions = {
  db: HrcDatabase
  send: FederationOutboxSend
  now?: (() => Date) | undefined
  policy?: FederationOutboxRetryPolicy | undefined
  onError?: ((error: unknown) => void) | undefined
  /** Structured transition seam used by permanent federation diagnostics. */
  onObservation?: ((observation: FederationOutboxDeliveryObservation) => void) | undefined
  onStaleRedirect?:
    | ((
        delivery: FederationOutboxDeliveryRecord,
        redirect: { homeNodeId: string; placementEpoch: number }
      ) => {
        peerNodeId: string
        envelope: FederationOutboxDeliveryRecord['envelope']
      })
    | undefined
}

function validatePolicy(policy: FederationOutboxRetryPolicy): void {
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${field} must be a positive integer`)
    }
  }
  if (policy.maxRetryDelayMs < policy.initialRetryDelayMs) {
    throw new Error('maxRetryDelayMs must be at least initialRetryDelayMs')
  }
  if (policy.deadLetterAfterMs < policy.initialRetryDelayMs) {
    throw new Error('deadLetterAfterMs must be at least initialRetryDelayMs')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FederationOutboxDeliveryEngine {
  private readonly outbox: FederationOutboxRepository
  private readonly send: FederationOutboxSend
  private readonly now: () => Date
  private readonly policy: FederationOutboxRetryPolicy
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly onObservation:
    | ((observation: FederationOutboxDeliveryObservation) => void)
    | undefined
  private readonly onStaleRedirect: FederationOutboxDeliveryEngineOptions['onStaleRedirect']
  private readonly attempting = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private drainInFlight: Promise<FederationOutboxDeliveryRecord[]> | undefined

  constructor(options: FederationOutboxDeliveryEngineOptions) {
    this.outbox = options.db.federationOutbox
    this.send = options.send
    this.now = options.now ?? (() => new Date())
    this.policy = options.policy ?? DEFAULT_FEDERATION_OUTBOX_RETRY_POLICY
    this.onError = options.onError
    this.onObservation = options.onObservation
    this.onStaleRedirect = options.onStaleRedirect
    validatePolicy(this.policy)
  }

  start(pollIntervalMs = SECOND_MS): void {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error('pollIntervalMs must be a positive integer')
    }
    if (this.timer !== undefined) return
    const poll = () => {
      void this.drainDue().catch((error: unknown) => this.onError?.(error))
    }
    poll()
    this.timer = setInterval(poll, pollIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.drainInFlight
  }

  replay(deliveryId: string): FederationOutboxDeliveryRecord {
    return this.outbox.replay(deliveryId, this.now().toISOString())
  }

  drainDue(limit = 100): Promise<FederationOutboxDeliveryRecord[]> {
    if (this.drainInFlight !== undefined) return this.drainInFlight
    const drain = this.drainDueOnce(limit).finally(() => {
      if (this.drainInFlight === drain) this.drainInFlight = undefined
    })
    this.drainInFlight = drain
    return drain
  }

  private async drainDueOnce(limit: number): Promise<FederationOutboxDeliveryRecord[]> {
    const due = this.outbox.listDue(this.now().toISOString(), limit)
    const results: FederationOutboxDeliveryRecord[] = []
    for (const delivery of due) {
      if (this.attempting.has(delivery.deliveryId)) continue
      this.attempting.add(delivery.deliveryId)
      try {
        results.push(await this.attempt(delivery))
      } finally {
        this.attempting.delete(delivery.deliveryId)
      }
    }
    return results
  }

  private async attempt(
    delivery: FederationOutboxDeliveryRecord
  ): Promise<FederationOutboxDeliveryRecord> {
    const attemptedAt = this.now().toISOString()
    this.observe(delivery, 'attempt_started')
    try {
      const result = await this.send(delivery)
      if (result.outcome !== 'refused') {
        if (result.messageId !== delivery.messageId) {
          throw new Error(
            `peer ACK messageId ${result.messageId} does not match delivery ${delivery.messageId}`
          )
        }
        const delivered = this.outbox.markDelivered(delivery.deliveryId, attemptedAt)
        this.observe(delivered, 'delivered', { acceptOutcome: result.outcome })
        return delivered
      }
      if (!result.retryable) {
        const deadLettered = this.outbox.markDeadLetter({
          deliveryId: delivery.deliveryId,
          attemptedAt,
          errorCode: result.code,
          errorMessage: `peer refused delivery with HTTP ${result.status}: ${result.code}`,
        })
        this.observe(deadLettered, 'dead_lettered')
        return deadLettered
      }
      let retryDelivery = delivery
      if (
        result.code === 'stale_placement' &&
        result.redirect !== undefined &&
        this.onStaleRedirect !== undefined
      ) {
        try {
          const retarget = this.onStaleRedirect(delivery, result.redirect)
          retryDelivery = this.outbox.retarget(
            delivery.deliveryId,
            retarget.peerNodeId,
            retarget.envelope,
            attemptedAt
          )
        } catch (error) {
          const deadLettered = this.outbox.markDeadLetter({
            deliveryId: delivery.deliveryId,
            attemptedAt,
            errorCode: 'redirect_conflict',
            errorMessage: errorMessage(error),
          })
          this.observe(deadLettered, 'dead_lettered')
          return deadLettered
        }
      }
      return this.scheduleFailure(
        retryDelivery,
        attemptedAt,
        'retry_scheduled',
        result.code,
        `peer retryable refusal (HTTP ${result.status}): ${result.code}`
      )
    } catch (error) {
      return this.scheduleFailure(
        delivery,
        attemptedAt,
        'peer_unreachable',
        'peer_unreachable',
        errorMessage(error)
      )
    }
  }

  private scheduleFailure(
    delivery: FederationOutboxDeliveryRecord,
    attemptedAt: string,
    state: 'retry_scheduled' | 'peer_unreachable',
    errorCode: string,
    message: string
  ): FederationOutboxDeliveryRecord {
    const attemptedAtMs = Date.parse(attemptedAt)
    const deadlineMs = Date.parse(delivery.retryWindowStartedAt) + this.policy.deadLetterAfterMs
    if (attemptedAtMs >= deadlineMs) {
      const deadLettered = this.outbox.markDeadLetter({
        deliveryId: delivery.deliveryId,
        attemptedAt,
        errorCode: 'retry_window_exhausted',
        errorMessage: `${message}; automatic retry window exhausted`,
      })
      this.observe(deadLettered, 'dead_lettered')
      return deadLettered
    }

    const nextAttemptMs = Math.min(
      attemptedAtMs + federationRetryDelayMs(delivery.cycleAttempts + 1, this.policy),
      deadlineMs
    )
    const scheduled = this.outbox.scheduleRetry({
      deliveryId: delivery.deliveryId,
      state,
      nextAttemptAt: new Date(nextAttemptMs).toISOString(),
      attemptedAt,
      errorCode,
      errorMessage: message,
    })
    this.observe(scheduled, state)
    return scheduled
  }

  private observe(
    delivery: FederationOutboxDeliveryRecord,
    transition: FederationOutboxDeliveryObservation['transition'],
    extra: Pick<FederationOutboxDeliveryObservation, 'acceptOutcome'> = {}
  ): void {
    if (this.onObservation === undefined) return
    try {
      this.onObservation({
        transition,
        deliveryId: delivery.deliveryId,
        messageId: delivery.messageId,
        peerNodeId: delivery.peerNodeId,
        phase: delivery.envelope.phase,
        ...(delivery.envelope.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: delivery.envelope.replyToMessageId }),
        rootMessageId: delivery.envelope.rootMessageId,
        attemptNumber:
          transition === 'attempt_started' ? delivery.totalAttempts + 1 : delivery.totalAttempts,
        cycleAttemptNumber:
          transition === 'attempt_started' ? delivery.cycleAttempts + 1 : delivery.cycleAttempts,
        ...(extra.acceptOutcome === undefined ? {} : { acceptOutcome: extra.acceptOutcome }),
        ...(transition === 'attempt_started' || transition === 'delivered'
          ? {}
          : {
              ...(delivery.lastErrorCode === undefined
                ? {}
                : { errorCode: delivery.lastErrorCode }),
              ...(delivery.nextAttemptAt === undefined
                ? {}
                : { nextAttemptAt: delivery.nextAttemptAt }),
            }),
      })
    } catch (error) {
      this.onError?.(error)
    }
  }
}
