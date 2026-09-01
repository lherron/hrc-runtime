import type {
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageHistoryStatus,
  HrcMessageRecord,
  ListMessagesResponse,
} from 'hrc-core'
import type { HrcDatabase, RecordCollectiveHistoryObservationInput } from 'hrc-store-sqlite'

import { parseMessageFilter } from '../messages.js'
import { writeServerLog } from '../server-log.js'
import type { FederationConfig, PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import { buildPeerProtocolHeaders } from './peer-request.js'

export const COLLECTIVE_HISTORY_AUTHORITY_NODE_ID = 'svc'

export type CollectiveHistoryCoordinatorOptions = {
  db: HrcDatabase
  config: FederationConfig
  pollIntervalMs?: number | undefined
  now?: (() => Date) | undefined
  fetch?: typeof fetch | undefined
}

type ReplicationBody = {
  record: HrcMessageRecord
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseAddress(value: unknown): HrcMessageAddress {
  if (!isRecord(value)) throw new Error('collective history address must be an object')
  if (value['kind'] === 'entity' && (value['entity'] === 'human' || value['entity'] === 'system')) {
    return { kind: 'entity', entity: value['entity'] }
  }
  if (
    value['kind'] === 'session' &&
    typeof value['sessionRef'] === 'string' &&
    value['sessionRef'].length > 0
  ) {
    return { kind: 'session', sessionRef: value['sessionRef'] }
  }
  throw new Error('collective history address is invalid')
}

export function parseCollectiveHistoryMessage(value: unknown): HrcMessageRecord {
  if (!isRecord(value)) throw new Error('collective history record must be an object')
  const messageSeq = value['messageSeq']
  const messageId = value['messageId']
  const createdAt = value['createdAt']
  const kind = value['kind']
  const phase = value['phase']
  const rootMessageId = value['rootMessageId']
  const body = value['body']
  const execution = value['execution']
  if (!Number.isSafeInteger(messageSeq) || (messageSeq as number) < 1) {
    throw new Error('collective history messageSeq is invalid')
  }
  if (
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    typeof createdAt !== 'string' ||
    createdAt.length === 0 ||
    !['dm', 'literal', 'system'].includes(String(kind)) ||
    !['request', 'response', 'oneway'].includes(String(phase)) ||
    typeof rootMessageId !== 'string' ||
    rootMessageId.length === 0 ||
    typeof body !== 'string' ||
    value['bodyFormat'] !== 'text/plain' ||
    !isRecord(execution) ||
    typeof execution['state'] !== 'string'
  ) {
    throw new Error('collective history message record is invalid')
  }
  const replyToMessageId = value['replyToMessageId']
  const metadataJson = value['metadataJson']
  if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
    throw new Error('collective history replyToMessageId is invalid')
  }
  if (metadataJson !== undefined && !isRecord(metadataJson)) {
    throw new Error('collective history metadataJson is invalid')
  }
  return structuredClone({
    ...(value as unknown as HrcMessageRecord),
    messageSeq: messageSeq as number,
    messageId,
    createdAt,
    kind: kind as HrcMessageRecord['kind'],
    phase: phase as HrcMessageRecord['phase'],
    from: parseAddress(value['from']),
    to: parseAddress(value['to']),
    rootMessageId,
    body,
    bodyFormat: 'text/plain',
    execution: execution as HrcMessageRecord['execution'],
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(metadataJson === undefined ? {} : { metadataJson }),
  })
}

function ingressOriginNodeId(record: HrcMessageRecord): string | undefined {
  const ingress = record.metadataJson?.['federationIngress']
  if (!isRecord(ingress)) return undefined
  const nodeId = ingress['authenticatedNodeId']
  return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : undefined
}

function observationFor(
  sourceNodeId: string,
  record: HrcMessageRecord
): Omit<RecordCollectiveHistoryObservationInput, 'observedAt'> {
  const ingressOrigin = ingressOriginNodeId(record)
  if (ingressOrigin !== undefined) {
    return {
      sourceNodeId,
      sourceRole: 'destination',
      originNodeId: ingressOrigin,
      acceptedDestinationNodeId: sourceNodeId,
      record,
    }
  }
  return {
    sourceNodeId,
    sourceRole: 'origin',
    originNodeId: sourceNodeId,
    record,
  }
}

function historyStatus(input: {
  source: 'collective' | 'local'
  complete: boolean
  queriedNodeId: string
  pendingReplicationCount: number
  unconfirmedNodeIds?: string[] | undefined
  degraded?: HrcMessageHistoryStatus['degraded'] | undefined
}): HrcMessageHistoryStatus {
  return {
    source: input.source,
    complete: input.complete,
    authorityNodeId: COLLECTIVE_HISTORY_AUTHORITY_NODE_ID,
    queriedNodeId: input.queriedNodeId,
    cursorKind: input.source === 'collective' ? 'collective' : 'node-local',
    pendingReplicationCount: input.pendingReplicationCount,
    ...(input.unconfirmedNodeIds === undefined
      ? {}
      : { unconfirmedNodeIds: input.unconfirmedNodeIds }),
    ...(input.degraded === undefined ? {} : { degraded: input.degraded }),
  }
}

function authorityPeer(config: FederationConfig): PeerEntry | undefined {
  for (const [nodeId, peer] of config.peers) {
    if (nodeId === COLLECTIVE_HISTORY_AUTHORITY_NODE_ID) return peer
  }
  return undefined
}

export class CollectiveHistoryCoordinator {
  private readonly now: () => Date
  private readonly fetchImpl: typeof fetch
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private drainInFlight: Promise<void> | undefined
  private stopped = false
  private readonly confirmedSourceNodeIds = new Set<string>()
  private lastCheckpointAtMs = 0

  constructor(private readonly options: CollectiveHistoryCoordinatorOptions) {
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetch ?? fetch
    this.pollIntervalMs = Math.max(10, Math.trunc(options.pollIntervalMs ?? 1_000))
  }

  get localNodeId(): string {
    return this.options.config.nodeId
  }

  get isAuthority(): boolean {
    return this.localNodeId === COLLECTIVE_HISTORY_AUTHORITY_NODE_ID
  }

  start(): void {
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.options.db.messages.subscribeChanges((record) => {
      // Always leave the bilateral message transaction before deriving archive
      // state. Startup backfill closes the crash window between those commits.
      queueMicrotask(() => this.observeLocalRecord(record))
    })
    for (const record of this.options.db.messages.query({})) {
      this.observeLocalRecord(record)
    }
    if (!this.isAuthority) {
      this.timer = setInterval(() => {
        this.requestDrain('poll')
      }, this.pollIntervalMs)
      this.requestDrain('startup')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  acceptReplication(
    authenticatedNodeId: string,
    body: unknown
  ): {
    outcome: 'accepted'
    messageId: string
  } {
    if (!this.isAuthority) throw new Error('collective history is not authoritative here')
    if (!isRecord(body) || !isRecord(body['record'])) {
      throw new Error('collective history replication body is invalid')
    }
    const record = parseCollectiveHistoryMessage(body['record'])
    this.options.db.collectiveHistory.recordObservation({
      ...observationFor(authenticatedNodeId, record),
      observedAt: this.now().toISOString(),
    })
    return { outcome: 'accepted', messageId: record.messageId }
  }

  acceptCheckpoint(
    authenticatedNodeId: string,
    body: unknown
  ): {
    outcome: 'accepted'
    nodeId: string
  } {
    if (!this.isAuthority) throw new Error('collective history is not authoritative here')
    if (!isRecord(body) || !isRecord(body['checkpoint'])) {
      throw new Error('collective history checkpoint body is invalid')
    }
    const checkpoint = body['checkpoint']
    const maxMessageSeq = checkpoint['maxMessageSeq']
    const pendingReplicationCount = checkpoint['pendingReplicationCount']
    if (
      !Number.isSafeInteger(maxMessageSeq) ||
      (maxMessageSeq as number) < 0 ||
      !Number.isSafeInteger(pendingReplicationCount) ||
      (pendingReplicationCount as number) < 0
    ) {
      throw new Error('collective history checkpoint is invalid')
    }
    if (pendingReplicationCount === 0) {
      this.confirmedSourceNodeIds.add(authenticatedNodeId)
    } else {
      this.confirmedSourceNodeIds.delete(authenticatedNodeId)
    }
    return { outcome: 'accepted', nodeId: authenticatedNodeId }
  }

  queryAuthority(filterValue: unknown): ListMessagesResponse {
    if (!this.isAuthority) throw new Error('collective history is not authoritative here')
    const filter = parseMessageFilter(filterValue)
    const unconfirmedNodeIds = [...this.options.config.peers.keys()]
      .filter((nodeId) => !this.confirmedSourceNodeIds.has(nodeId))
      .sort()
    return {
      messages: this.options.db.collectiveHistory.query(
        filter,
        COLLECTIVE_HISTORY_AUTHORITY_NODE_ID
      ),
      history: historyStatus({
        source: 'collective',
        complete: unconfirmedNodeIds.length === 0,
        queriedNodeId: this.localNodeId,
        pendingReplicationCount: 0,
        ...(unconfirmedNodeIds.length === 0
          ? {}
          : {
              unconfirmedNodeIds,
              degraded: {
                code: 'collective_lagging' as const,
                message: `awaiting catch-up checkpoint from ${unconfirmedNodeIds.join(', ')}`,
              },
            }),
      }),
    }
  }

  async query(filter: HrcMessageFilter): Promise<ListMessagesResponse> {
    if (this.isAuthority) return this.queryAuthority(filter)

    await this.drainDue()
    const pendingReplicationCount = this.options.db.collectiveHistoryReplications.pendingCount()
    const peer = authorityPeer(this.options.config)
    if (peer === undefined) {
      return this.localFallback(
        filter,
        pendingReplicationCount,
        'collective_not_configured',
        'collective history authority svc is not configured as a peer'
      )
    }

    try {
      const response = await this.fetchImpl(
        new URL('/v1/federation/history/query', peer.endpoint),
        {
          method: 'POST',
          headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION, {
            contentType: 'application/json',
          }),
          body: JSON.stringify({ filter }),
          signal: AbortSignal.timeout(3_000),
        }
      )
      if (!response.ok) {
        throw new Error(`collective history authority returned HTTP ${response.status}`)
      }
      const value = (await response.json()) as ListMessagesResponse
      if (
        !Array.isArray(value.messages) ||
        !isRecord(value.history) ||
        value.history['source'] !== 'collective' ||
        typeof value.history['complete'] !== 'boolean'
      ) {
        throw new Error('collective history authority returned an invalid response')
      }
      const complete = value.history.complete && pendingReplicationCount === 0
      return {
        ...value,
        history: historyStatus({
          source: 'collective',
          complete,
          queriedNodeId: this.localNodeId,
          pendingReplicationCount,
          ...(value.history.unconfirmedNodeIds === undefined
            ? {}
            : { unconfirmedNodeIds: value.history.unconfirmedNodeIds }),
          ...(pendingReplicationCount === 0
            ? value.history.degraded === undefined
              ? {}
              : { degraded: value.history.degraded }
            : {
                degraded: {
                  code: 'collective_lagging' as const,
                  message: `${pendingReplicationCount} local message replication(s) are pending`,
                },
              }),
        }),
      }
    } catch (error) {
      return this.localFallback(
        filter,
        pendingReplicationCount,
        'collective_unreachable',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async drainDue(): Promise<void> {
    if (this.isAuthority || this.stopped) return
    if (this.drainInFlight !== undefined) return this.drainInFlight
    const operation = this.drainDueInner().finally(() => {
      if (this.drainInFlight === operation) this.drainInFlight = undefined
    })
    this.drainInFlight = operation
    return operation
  }

  private observeLocalRecord(record: HrcMessageRecord): void {
    if (this.stopped) return
    const observation = observationFor(this.localNodeId, record)
    try {
      if (this.isAuthority) {
        this.options.db.collectiveHistory.recordObservation({
          ...observation,
          observedAt: this.now().toISOString(),
        })
      } else {
        this.options.db.collectiveHistoryReplications.enqueue(observation, this.now().toISOString())
        this.requestDrain('message_observed', record.messageId)
      }
    } catch (error) {
      writeServerLog('WARN', 'federation.collective_history.observe_failed', {
        localNodeId: this.localNodeId,
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private requestDrain(trigger: string, messageId?: string): void {
    void this.drainDue().catch((error) => {
      writeServerLog('WARN', 'federation.collective_history.drain_failed', {
        localNodeId: this.localNodeId,
        trigger,
        ...(messageId === undefined ? {} : { messageId }),
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async drainDueInner(): Promise<void> {
    const peer = authorityPeer(this.options.config)
    if (peer === undefined) return
    const due = this.options.db.collectiveHistoryReplications.listDue(this.now().toISOString())
    for (const replication of due) {
      const attemptedAt = this.now()
      try {
        const body: ReplicationBody = { record: replication.record }
        const response = await this.fetchImpl(
          new URL('/v1/federation/history/replicate', peer.endpoint),
          {
            method: 'POST',
            headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION, {
              contentType: 'application/json',
            }),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3_000),
          }
        )
        if (!response.ok) {
          throw new Error(`collective history authority returned HTTP ${response.status}`)
        }
        const acknowledgement = await response.json()
        if (
          !isRecord(acknowledgement) ||
          !isRecord(acknowledgement['ack']) ||
          acknowledgement['ack']['outcome'] !== 'accepted' ||
          acknowledgement['ack']['messageId'] !== replication.messageId
        ) {
          throw new Error('collective history authority returned an invalid acknowledgement')
        }
        this.options.db.collectiveHistoryReplications.markDelivered(
          replication.messageId,
          replication.fingerprint,
          attemptedAt.toISOString()
        )
      } catch (error) {
        const delayMs = Math.min(60_000, 250 * 2 ** Math.min(replication.totalAttempts, 8))
        this.options.db.collectiveHistoryReplications.scheduleRetry({
          messageId: replication.messageId,
          fingerprint: replication.fingerprint,
          now: attemptedAt.toISOString(),
          nextAttemptAt: new Date(attemptedAt.getTime() + delayMs).toISOString(),
          errorCode: 'collective_unreachable',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        // Every row targets the same authority. One failed probe is enough for
        // this drain; leave the remaining durable rows queued for the next
        // cadence instead of multiplying an outage by the backlog size.
        break
      }
    }
    await this.sendCheckpointIfDue()
  }

  private async sendCheckpointIfDue(): Promise<void> {
    const pendingReplicationCount = this.options.db.collectiveHistoryReplications.pendingCount()
    if (pendingReplicationCount !== 0) return
    const peer = authorityPeer(this.options.config)
    if (peer === undefined) return
    const checkpointIntervalMs = Math.max(100, this.pollIntervalMs)
    const now = this.now()
    if (now.getTime() - this.lastCheckpointAtMs < checkpointIntervalMs) return

    try {
      const response = await this.fetchImpl(
        new URL('/v1/federation/history/checkpoint', peer.endpoint),
        {
          method: 'POST',
          headers: buildPeerProtocolHeaders(peer, PEER_PROTOCOL_VERSION, {
            contentType: 'application/json',
          }),
          body: JSON.stringify({
            checkpoint: {
              maxMessageSeq: this.options.db.messages.maxMessageSeq(),
              pendingReplicationCount,
            },
          }),
          signal: AbortSignal.timeout(3_000),
        }
      )
      if (!response.ok) {
        throw new Error(`collective history authority returned HTTP ${response.status}`)
      }
      const acknowledgement = await response.json()
      if (
        !isRecord(acknowledgement) ||
        !isRecord(acknowledgement['ack']) ||
        acknowledgement['ack']['outcome'] !== 'accepted' ||
        acknowledgement['ack']['nodeId'] !== this.localNodeId
      ) {
        throw new Error(
          'collective history authority returned an invalid checkpoint acknowledgement'
        )
      }
      this.lastCheckpointAtMs = now.getTime()
    } catch (error) {
      writeServerLog('WARN', 'federation.collective_history.checkpoint_failed', {
        localNodeId: this.localNodeId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private localFallback(
    filter: HrcMessageFilter,
    pendingReplicationCount: number,
    code: NonNullable<HrcMessageHistoryStatus['degraded']>['code'],
    message: string
  ): ListMessagesResponse {
    return {
      messages: this.options.db.messages.query(filter),
      history: historyStatus({
        source: 'local',
        complete: false,
        queriedNodeId: this.localNodeId,
        pendingReplicationCount,
        degraded: { code, message },
      }),
    }
  }
}
