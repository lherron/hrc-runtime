import type {
  HrcBoundedEventStreamRecord,
  HrcEventTail,
  HrcLifecycleEvent,
  HrcMailAckRequest,
  HrcMailAckResponse,
  HrcMailCatRequest,
  HrcMailCatResponse,
  HrcMailDeferRequest,
  HrcMailDeferResponse,
  HrcMailInboxRequest,
  HrcMailInboxResponse,
  HrcMailListRequest,
  HrcMailListResponse,
  HrcMailSendRequest,
  HrcMailSendResponse,
  HrcMessageRecord,
  HrcTargetView,
  TraceMessageRequest,
  TraceMessageResponse,
} from 'hrc-core'
import type { CaptureRecoverRequest, CaptureRecoverResponse } from 'hrc-core'
import { HrcClientDiagnosticsMethods } from './client-diagnostics.js'
import {
  boolField,
  buildPath,
  emptyToUndefined,
  eventFilterParams,
  matchesWatchOptions,
} from './client-transport.js'
import type {
  CaptureBySelectorRequest,
  CaptureBySelectorResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  DeliverLiteralBySelectorRequest,
  DeliverLiteralBySelectorResponse,
  DispatchTurnBySelectorRequest,
  DispatchTurnBySelectorResponse,
  EnsureTargetRequest,
  HrcEventTailOptions,
  InvocationEventEnvelope,
  LatestEventBySessionFilter,
  ListMessagesResponse,
  SemanticDmRequest,
  SemanticDmResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
  TargetListFilter,
  WaitMessageRequest,
  WaitMessageResponse,
  WatchBoundedEventsOptions,
  WatchBrokerEventsOptions,
  WatchMessagesOptions,
  WatchOptions,
} from './types.js'

export class HrcClientChatEventMethods extends HrcClientDiagnosticsMethods {
  // -- hrcchat: targets --------------------------------------------------------

  async listTargets(filter?: TargetListFilter): Promise<HrcTargetView[]> {
    const path = buildPath('/v1/targets', {
      projectId: emptyToUndefined(filter?.projectId),
      lane: emptyToUndefined(filter?.lane),
      discover: boolField(filter?.discover),
      includeDormant: boolField(filter?.includeDormant),
    })
    return this.getJson<HrcTargetView[]>(path)
  }

  async getTarget(sessionRef: string): Promise<HrcTargetView> {
    return this.getJson<HrcTargetView>(
      `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
    )
  }

  async ensureTarget(request: EnsureTargetRequest): Promise<HrcTargetView> {
    return this.postJson<HrcTargetView>('/v1/targets/ensure', request)
  }

  // -- hrcchat: selector-based dispatch ----------------------------------------

  async dispatchTurnBySelector(
    request: DispatchTurnBySelectorRequest
  ): Promise<DispatchTurnBySelectorResponse> {
    return this.postJson<DispatchTurnBySelectorResponse>('/v1/turns/by-selector', request)
  }

  async deliverLiteralBySelector(
    request: DeliverLiteralBySelectorRequest
  ): Promise<DeliverLiteralBySelectorResponse> {
    return this.postJson<DeliverLiteralBySelectorResponse>('/v1/literal-input/by-selector', request)
  }

  async captureBySelector(request: CaptureBySelectorRequest): Promise<CaptureBySelectorResponse> {
    return this.postJson<CaptureBySelectorResponse>('/v1/capture/by-selector', request)
  }

  /** T-08566: one explicit retained-evidence recovery attempt, or a dry run. */
  async captureRecover(request: CaptureRecoverRequest): Promise<CaptureRecoverResponse> {
    return this.postJson<CaptureRecoverResponse>('/v1/capture/recover', request)
  }

  // -- hrcchat: durable messages -----------------------------------------------

  async createMessage(request: CreateMessageRequest): Promise<CreateMessageResponse> {
    return this.postJson<CreateMessageResponse>('/v1/messages', request)
  }

  async listMessages(filter?: import('hrc-core').HrcMessageFilter): Promise<ListMessagesResponse> {
    return this.postJson<ListMessagesResponse>('/v1/messages/query', filter ?? {})
  }

  async traceMessage(request: TraceMessageRequest): Promise<TraceMessageResponse> {
    return this.postJson<TraceMessageResponse>('/v1/messages/trace', request)
  }

  async waitMessage(request: WaitMessageRequest): Promise<WaitMessageResponse> {
    return this.postJson<WaitMessageResponse>('/v1/messages/wait', request)
  }

  async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
    return this.postJson<SemanticDmResponse>('/v1/messages/dm', request)
  }

  async semanticTurnHandoff(
    request: SemanticTurnHandoffRequest
  ): Promise<SemanticTurnHandoffResponse> {
    return this.postJson<SemanticTurnHandoffResponse>('/v1/messages/turn-handoff', request)
  }

  async *watchMessages(options?: WatchMessagesOptions): AsyncIterable<HrcMessageRecord> {
    const body = {
      ...(options?.filter ?? {}),
      follow: options?.follow ?? false,
      timeoutMs: options?.timeoutMs,
    }

    yield* this.streamNdjson<HrcMessageRecord>(
      '/v1/messages/watch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      options?.signal
    )
  }

  // -- hrcmail: embedded envelope mailbox -----------------------------------

  async sendMail(request: HrcMailSendRequest): Promise<HrcMailSendResponse> {
    return this.postJson<HrcMailSendResponse>('/v1/mail/send', request)
  }

  async mailInbox(request: HrcMailInboxRequest): Promise<HrcMailInboxResponse> {
    return this.postJson<HrcMailInboxResponse>('/v1/mail/inbox', request)
  }

  async ackMail(request: HrcMailAckRequest): Promise<HrcMailAckResponse> {
    return this.postJson<HrcMailAckResponse>('/v1/mail/ack', request)
  }

  async deferMail(request: HrcMailDeferRequest): Promise<HrcMailDeferResponse> {
    return this.postJson<HrcMailDeferResponse>('/v1/mail/defer', request)
  }

  async catMail(request: HrcMailCatRequest): Promise<HrcMailCatResponse> {
    return this.postJson<HrcMailCatResponse>('/v1/mail/cat', request)
  }

  async listMail(request: HrcMailListRequest = {}): Promise<HrcMailListResponse> {
    return this.postJson<HrcMailListResponse>('/v1/mail/list', request)
  }

  // -- Event stream -----------------------------------------------------------

  /**
   * Return the latest HRC lifecycle event per `(hostSessionId, generation)`.
   *
   * Backs ACP listMobileSessions freshness. Uses the indexed
   * `idx_hrc_events_host_session_generation_seq` query and does not depend on
   * a bounded recent window, so callers can compute `lastHrcSeq` /
   * `lastActivityAt` reliably regardless of total event count.
   */
  async listLatestEventBySession(
    filter?: LatestEventBySessionFilter
  ): Promise<HrcLifecycleEvent[]> {
    const path = buildPath('/v1/events/latest-by-session', eventFilterParams(filter))
    return this.getJson<HrcLifecycleEvent[]>(path)
  }

  async tailEvents(options: HrcEventTailOptions): Promise<HrcEventTail> {
    const path = buildPath('/v1/events/tail', {
      limit: options.limit,
      beforeHrcSeq: options.beforeHrcSeq,
      ledgerIncarnationId: options.ledgerIncarnationId,
      ...eventFilterParams(options),
    })
    return this.getJson<HrcEventTail>(path)
  }

  async *watchBoundedEvents(
    options: WatchBoundedEventsOptions
  ): AsyncIterable<HrcBoundedEventStreamRecord> {
    const path = buildPath('/v1/events/bounded-stream', {
      ledgerIncarnationId: options.ledgerIncarnationId,
      afterSeq: options.afterSeq,
      follow: 'true',
      ...eventFilterParams(options),
    })
    yield* this.streamNdjson<HrcBoundedEventStreamRecord>(
      path,
      {
        method: 'GET',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.signal
    )
  }

  async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
    const path = buildPath('/v1/events', {
      fromSeq: options?.fromSeq,
      follow: boolField(options?.follow),
      receipt: options?.follow ? 'consumer-ack-v1' : undefined,
      ...eventFilterParams(options),
    })

    yield* this.streamNdjson<HrcLifecycleEvent>(
      path,
      {
        method: 'GET',
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      options?.signal,
      (event) => matchesWatchOptions(event, options),
      (event) => event.hrcSeq
    )
  }

  async *watchBrokerEvents(
    options: WatchBrokerEventsOptions
  ): AsyncIterable<InvocationEventEnvelope> {
    const path = buildPath('/v1/broker-events', {
      invocationId: options.invocationId,
      runId: options.runId,
      runtimeId: options.runtimeId,
      generation: options.generation,
      afterSeq: options.afterSeq ?? 0,
      follow: boolField(options.follow),
      receipt: options.follow ? 'consumer-ack-v1' : undefined,
    })

    yield* this.streamNdjson<InvocationEventEnvelope>(
      path,
      {
        method: 'GET',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.signal,
      undefined,
      (event) => event.seq
    )
  }
}
