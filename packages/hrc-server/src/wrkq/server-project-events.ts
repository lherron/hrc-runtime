import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { WrkqProjectEventPostParams } from './ledger-client.js'

/**
 * T-08137 — HRC as a producer of `server.*` project events on `hrc-runtime`.
 *
 * A separate, cursor-backed tail beside `session-project-events`. It projects
 * only a completed stop (`server.stopped`) and a start (`server.started`); it
 * never projects shutdown initiation or an unattributed predecessor, so a
 * killed daemon cannot appear on the timeline as a clean stop.
 *
 * Unlike the session tail, the cursor advances only after a post resolves
 * (including an idempotent re-acceptance). A refused or unavailable post leaves
 * it where it was, logs a warning, and is retried by the timer or the next
 * daemon. Nothing here reaches lifecycle persistence, startup, or shutdown.
 */

export type ServerProjectEventType = 'server.started' | 'server.stopped'

export const SERVER_PROJECT_EVENTS_STREAM = 'server-project-events'
export const SERVER_PROJECT_EVENTS_PROJECT = 'hrc-runtime'
export const SERVER_PROJECT_EVENT_SOURCE_KINDS: readonly ServerProjectEventType[] = [
  'server.started',
  'server.stopped',
]

const MAX_ATTRIBUTE_VALUE = 1024
const TAIL_BATCH = 50
const DEFAULT_POLL_INTERVAL_MS = 5000

/**
 * The same sequence from a replacement ledger or another node must never
 * collapse onto an unrelated timeline fact.
 */
export function serverProjectEventIdempotencyKey(input: {
  nodeId: string
  ledgerIncarnationId: string
  hrcSeq: number
}): string {
  return `server:${input.nodeId}:${input.ledgerIncarnationId}:${input.hrcSeq}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value.length > MAX_ATTRIBUTE_VALUE ? value.slice(0, MAX_ATTRIBUTE_VALUE) : value
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function attr(key: string, value: unknown): Record<string, string> {
  const rendered = text(value)
  return rendered === undefined ? {} : { [key]: rendered }
}

type ServerLifecycleRow = Pick<HrcLifecycleEvent, 'hrcSeq' | 'ts' | 'eventKind' | 'payload'>

/** The timeline fact for a `server.started`/`server.stopped` row, else undefined. */
export function deriveServerProjectEvent(input: {
  event: ServerLifecycleRow
  nodeId: string
  ledgerIncarnationId: string
}): WrkqProjectEventPostParams | undefined {
  const { event, nodeId } = input
  if (event.eventKind !== 'server.started' && event.eventKind !== 'server.stopped') {
    return undefined
  }
  const payload = isRecord(event.payload) ? event.payload : {}
  const stopped = event.eventKind === 'server.stopped'
  // T-09861: a contract daemon attributes from its verified grant; a
  // pre-contract predecessor's row still carries the flat fields.
  const granted = 'grant' in payload
  const grant = isRecord(payload['grant']) ? payload['grant'] : {}
  const flags = isRecord(grant['flags']) ? grant['flags'] : {}
  const requestedBy = text(granted ? grant['requestedBy'] : payload['requestedBy']) ?? 'external'
  const reason = text(granted ? grant['reason'] : payload['requestedReason'])

  // ORDER IS THE CONTRACT (wrkq renders producer order): provenance, then the
  // process, then how it started or who stopped it.
  const attributes: Record<string, string> = {
    source: 'hrc-server',
    node: text(nodeId) ?? nodeId,
    ...attr('pid', payload['pid']),
    ...(stopped
      ? {
          requested_by: requestedBy,
          ...attr('reason', reason),
          ...(granted
            ? {
                ...attr('caller_kind', grant['callerKind']),
                ...attr('action', grant['action']),
                ...attr('origin_node', grant['originNode']),
                ...attr('request_id', grant['requestId']),
                ...attr(
                  'flags',
                  ['wait', 'drain', 'force'].filter((flag) => flags[flag] === true).join(',')
                ),
              }
            : {
                ...attr('caller_kind', payload['callerKind']),
                ...attr('action', payload['requestedAction']),
                ...attr('run_id', payload['requestedRunId']),
              }),
          ...attr('signal', payload['reason']),
        }
      : {
          ...attr('release', payload['release']),
          ...attr('source_commit', payload['sourceCommit']),
          ...attr('store_schema', payload['storeSchema']),
          ...attr('process_started_at', payload['processStartedAt']),
          ...attr('previous_pid', payload['previousPid']),
        }),
  }

  const release = text(payload['release'])
  const summary = stopped
    ? `hrc-server stopped on ${nodeId} (requested by ${requestedBy}${reason === undefined ? '' : `: ${reason}`})`
    : `hrc-server started on ${nodeId}${release === undefined ? '' : ` (${release})`}`

  return {
    project: SERVER_PROJECT_EVENTS_PROJECT,
    type: event.eventKind,
    summary: summary.replace(/[\r\n]+/g, ' ').slice(0, 512),
    attributes,
    idempotencyKey: serverProjectEventIdempotencyKey({
      nodeId,
      ledgerIncarnationId: input.ledgerIncarnationId,
      hrcSeq: event.hrcSeq,
    }),
    occurredAt: event.ts,
  }
}

export type ServerProjectEventPublisherDeps = {
  db: HrcDatabase
  post: (params: WrkqProjectEventPostParams) => Promise<unknown>
  nodeId: string
  /** Tail cadence. `0` disables the timer (tests pump through `drain`). */
  pollIntervalMs?: number | undefined
}

export class ServerProjectEventPublisher {
  private pumping: Promise<void> | undefined
  private rerun = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: ServerProjectEventPublisherDeps) {
    const cursors = deps.db.wrkqLedgerCursors
    if (cursors.get(SERVER_PROJECT_EVENTS_STREAM) === undefined) {
      // History before the producer existed is not backfilled.
      cursors.advance(deps.db.hrcEvents.maxHrcSeq(), SERVER_PROJECT_EVENTS_STREAM)
    }
    const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    if (interval > 0) {
      this.timer = setInterval(() => this.kick(), interval)
      this.timer.unref?.()
    }
  }

  /** Pump to the ledger head (or the first refusal) and await it. */
  async drain(): Promise<void> {
    this.kick()
    while (this.pumping !== undefined) await this.pumping
  }

  kick(): void {
    if (this.pumping !== undefined) {
      this.rerun = true
      return
    }
    this.pumping = this.pump()
      .catch((error) => {
        writeServerLog('WARN', 'server_project_event.tail_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.pumping = undefined
        if (this.rerun) {
          this.rerun = false
          this.kick()
        }
      })
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private async pump(): Promise<void> {
    const { db } = this.deps
    const cursors = db.wrkqLedgerCursors
    const ledgerIncarnationId = db.hrcEvents.ledgerIncarnationId()
    for (;;) {
      const after = cursors.get(SERVER_PROJECT_EVENTS_STREAM) ?? 0
      const events = db.hrcEvents.listFromHrcSeqFiltered(after + 1, {
        // Imported rows are another node's facts; that node publishes them.
        sourceRef: null,
        eventKinds: [...SERVER_PROJECT_EVENT_SOURCE_KINDS],
        limit: TAIL_BATCH,
      })
      if (events.length === 0) return
      for (const event of events) {
        const params =
          event.evidenceOrigin != null
            ? undefined
            : deriveServerProjectEvent({ event, nodeId: this.deps.nodeId, ledgerIncarnationId })
        if (params !== undefined) {
          try {
            await this.deps.post(params)
          } catch (error) {
            writeServerLog('WARN', 'server_project_event.post_failed', {
              type: params.type,
              hrcSeq: event.hrcSeq,
              idempotencyKey: params.idempotencyKey,
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }
        }
        cursors.advance(event.hrcSeq, SERVER_PROJECT_EVENTS_STREAM)
      }
      if (events.length < TAIL_BATCH) return
    }
  }
}
