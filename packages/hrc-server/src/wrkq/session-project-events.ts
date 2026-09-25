import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { WrkqProjectEventPostParams } from './ledger-client.js'

/**
 * T-08389 — HRC as a producer of `session.*` project events.
 *
 * HRC knows every session it births and, until this, shared none of it. One
 * foreign project fact per birth puts "who was spawned, where, and why" on a
 * project timeline that a human already reads (`wrkp log <project>`).
 *
 * The vocabulary, its stability promise, and the affiliation consequence are
 * declared in `session-project-events.md` beside this file. hrc-runtime owns
 * `session.*`; wrkq owns only the envelope and cannot validate a subject
 * namespace, so this module and that doc are the only guards.
 *
 * BEST-EFFORT BY CONSTRUCTION. A birth is a durable HRC fact the moment
 * `session.created` is appended; this publication is an observation of that
 * fact, made after the write, on a detached promise. Nothing here can delay,
 * fail, or otherwise reach the birth that produced it.
 */

/** The declared `session.*` vocabulary. First segment names the SUBJECT. */
export type SessionProjectEventType =
  | 'session.born'
  | 'session.rotated'
  | 'session.started'
  | 'session.ended'

/**
 * T-08928 — how a runtime of the session stopped being live. Each value is an
 * HRC ledger kind that already exists (`runtime.<end>`); nothing new is
 * classified here. A reap is `terminated` with its reason (`operator_reap`).
 */
export type SessionEndKind = 'terminated' | 'crashed' | 'dead' | 'stale'

const END_KINDS: Record<string, SessionEndKind> = {
  'runtime.terminated': 'terminated',
  'runtime.crashed': 'crashed',
  'runtime.dead': 'dead',
  'runtime.stale': 'stale',
}

/**
 * The declared `cause` vocabulary: the DOOR a session came through, which is
 * what the birth site can actually observe. See the doc for why `mail` and
 * `dispatch` are not separable here.
 */
export type SessionBirthCause = 'rotation' | 'summon' | 'dispatch' | 'command_run' | 'resolve'

export type SessionProjectEventFact = {
  type: SessionProjectEventType
  /** Project name from the scope ref. Affiliation target when `task` is absent. */
  project: string
  /** Canonical `T-\d{5}` selector only; see `taskSelectorFrom`. */
  task: string | undefined
  summary: string
  /** Insertion order is the render order. Never sort this. */
  attributes: Record<string, string>
  idempotencyKey: string
  /** The session's FULL ref, `<scopeRef>/lane:<lane>` (T-08928). */
  scopeRef: string
  occurredAt: string
}

/** wrkq refuses any value over 1024 bytes; clamp rather than lose the row. */
const MAX_ATTRIBUTE_VALUE = 1024
const MAX_SUMMARY = 512

const CANONICAL_TASK_ID = /^T-\d{5}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampValue(value: string): string {
  return value.length > MAX_ATTRIBUTE_VALUE ? value.slice(0, MAX_ATTRIBUTE_VALUE) : value
}

/** Single-line, bounded: wrkq refuses a summary carrying CR/LF or over 512. */
function clampSummary(value: string): string {
  const single = value.replace(/[\r\n]+/g, ' ').trim()
  return single.length > MAX_SUMMARY ? single.slice(0, MAX_SUMMARY) : single
}

/**
 * `<scopeRef>/lane:<lane>`, the same full ref every other wrkp producer writes.
 * Legacy rows store `laneRef` with its `lane:` prefix; never double it.
 */
export function fullSessionRef(scopeRef: string, laneRef: string): string {
  const lane = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  return `${scopeRef}/lane:${lane}`
}

export type ParsedSeat = {
  agent: string | undefined
  project: string | undefined
  selector: string | undefined
}

/** `agent:<a>:project:<p>:task:<selector>`. Every segment is optional in the wild. */
export function parseSeat(scopeRef: string): ParsedSeat {
  return {
    agent: scopeRef.match(/^agent:([^:]+)/)?.[1],
    project: scopeRef.match(/:project:([^:]+)/)?.[1],
    selector: scopeRef.match(/:task:(.+)$/)?.[1],
  }
}

/**
 * The affiliation rule (T-08389). `--task` is attempted ONLY for a canonical
 * `T-\d{5}` with no suffix, because ~7% of live scope selectors are T-shaped
 * but unresolvable (`T-08199:role:parallel-alpha`, `-e2e` variants, `T-8151`,
 * ids purged from the ledger) and wrkq answers an unresolvable task with
 * `NotFoundError` — the INSERT never happens. A naive producer would silently
 * drop exactly the probe and federation births worth debugging.
 *
 * The full selector always survives in `seat`, whichever branch is taken.
 */
export function taskSelectorFrom(selector: string | undefined): string | undefined {
  if (selector === undefined) return undefined
  return CANONICAL_TASK_ID.test(selector) ? selector : undefined
}

function causeFor(session: HrcSessionRecord, payload: Record<string, unknown>): SessionBirthCause {
  if (session.priorHostSessionId !== undefined || session.generation > 1) return 'rotation'
  if (payload['commandRun'] === true) return 'command_run'
  if (payload['summon'] === true) return 'summon'
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined
  if (reason === 'exact-scope-claim' || reason === 'roster-suffix-claim') return 'dispatch'
  return 'resolve'
}

/**
 * Build the fact a `session.created` event carries, or `undefined` when there
 * is nothing to affiliate it to.
 *
 * A scope ref with no `:project:` segment (`agent:foo`, node-local lanes) has
 * no project timeline to land on, and wrkq's envelope requires one. Those are
 * dropped here rather than sent and refused.
 */
export function deriveSessionProjectEvent(input: {
  session: HrcSessionRecord
  payload: unknown
  node: string
  occurredAt: string
  requestedBy?: string | undefined
}): SessionProjectEventFact | undefined {
  const { session, node, occurredAt } = input
  const payload = isRecord(input.payload) ? input.payload : {}
  const seat = parseSeat(session.scopeRef)
  if (seat.project === undefined || seat.project.length === 0) return undefined

  const cause = causeFor(session, payload)
  const rotated = cause === 'rotation'
  const type: SessionProjectEventType = rotated ? 'session.rotated' : 'session.born'
  const intent = session.lastAppliedIntentJson
  const harness = intent?.harness
  const mode =
    intent?.execution?.preferredMode ??
    (harness === undefined ? undefined : harness.interactive ? 'interactive' : 'headless')

  // ORDER IS THE CONTRACT. wrkq stores the attribute object's raw bytes and
  // renders `key=value` in producer order, so this literal is what a human
  // reads on the timeline: provenance first, then the seat someone is looking
  // for, then how it was born.
  const attributes: Record<string, string> = {
    source: 'hrc-server',
    node: clampValue(node),
    seat: clampValue(session.scopeRef),
    ...(seat.agent === undefined ? {} : { agent: clampValue(seat.agent) }),
    ...taskAttribute(seat),
    cause,
    ...(harness?.id === undefined ? {} : { harness: harness.id }),
    ...(harness?.provider === undefined ? {} : { provider: harness.provider }),
    ...(mode === undefined ? {} : { mode }),
    session: clampValue(session.hostSessionId),
    ...(session.priorHostSessionId === undefined
      ? {}
      : { prior_session: clampValue(session.priorHostSessionId) }),
    generation: String(session.generation),
    runtime: payload['commandRun'] === true ? 'command' : 'harness',
    ...(input.requestedBy === undefined || input.requestedBy.length === 0
      ? {}
      : { requested_by: clampValue(input.requestedBy) }),
  }

  const who = seat.agent ?? session.scopeRef
  const where = seat.selector === undefined ? seat.project : `${seat.project}:${seat.selector}`
  const summary = rotated
    ? `${who} rotated to generation ${session.generation} at ${where} on ${node}`
    : `${who} born at ${where} on ${node} via ${cause}`

  return {
    type,
    project: seat.project,
    task: taskSelectorFrom(seat.selector),
    summary: clampSummary(summary),
    attributes,
    // Unique per birth: retries of the same birth collapse, and a rotation —
    // which is a different host session id — never collapses onto its prior.
    idempotencyKey: session.hostSessionId,
    scopeRef: fullSessionRef(session.scopeRef, session.laneRef),
    occurredAt,
  }
}

/** The assignment: the canonical task a seat serves, when it names one. */
function taskAttribute(seat: ParsedSeat): Record<string, string> {
  const task = taskSelectorFrom(seat.selector)
  return task === undefined ? {} : { task }
}

type RuntimeLifecycleEvent = Pick<
  HrcLifecycleEvent,
  | 'eventKind'
  | 'hostSessionId'
  | 'scopeRef'
  | 'laneRef'
  | 'generation'
  | 'runtimeId'
  | 'ts'
  | 'payload'
>

/**
 * T-08928 — the broker seat's FIRST transition (`previousState: null`, cause
 * `binding-established`) is the moment a runtime of this session became live.
 * It is the only runtime-birth fact HRC already records for every broker
 * runtime; `runtime.created` is registered but never appended.
 */
function isRuntimeStart(event: RuntimeLifecycleEvent, payload: Record<string, unknown>): boolean {
  return (
    event.eventKind === 'broker.seat.transition' &&
    payload['previousState'] === null &&
    payload['cause'] === 'binding-established'
  )
}

/**
 * Build the `session.started` / `session.ended` fact a runtime lifecycle event
 * carries, or `undefined` when the event is neither or has no project.
 *
 * A session outlives its runtimes: 91 of 472 sessions in a week had more than
 * one. So `ended` is "the live runtime stopped", `started` is "a runtime came
 * live", and a consumer's current state for a session is the latest of the
 * two. Both key on `session` (the host session id) for upsert, and the wrkq
 * idempotency key adds the runtime id so the FIRST terminal fact of a runtime
 * wins and a later `stale` → `dead` for the same runtime collapses onto it.
 */
export function deriveSessionRuntimeEvent(input: {
  event: RuntimeLifecycleEvent
  node: string
}): SessionProjectEventFact | undefined {
  const { event, node } = input
  const payload = isRecord(event.payload) ? event.payload : {}
  const end = END_KINDS[event.eventKind]
  const started = end === undefined && isRuntimeStart(event, payload)
  if (end === undefined && !started) return undefined

  const seat = parseSeat(event.scopeRef)
  if (seat.project === undefined || seat.project.length === 0) return undefined

  const runtimeId =
    event.runtimeId ?? (typeof payload['runtimeId'] === 'string' ? payload['runtimeId'] : undefined)
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined
  const state = typeof payload['nextState'] === 'string' ? payload['nextState'] : undefined

  // Same leading order as a birth: provenance, then the seat, then the fact.
  const attributes: Record<string, string> = {
    source: 'hrc-server',
    node: clampValue(node),
    seat: clampValue(event.scopeRef),
    ...(seat.agent === undefined ? {} : { agent: clampValue(seat.agent) }),
    ...taskAttribute(seat),
    ...(end === undefined ? {} : { end }),
    ...(end === undefined || reason === undefined ? {} : { reason: clampValue(reason) }),
    ...(started && state !== undefined ? { state } : {}),
    session: clampValue(event.hostSessionId),
    generation: String(event.generation),
    ...(runtimeId === undefined ? {} : { runtime_id: clampValue(runtimeId) }),
  }

  const who = seat.agent ?? event.scopeRef
  const where = seat.selector === undefined ? seat.project : `${seat.project}:${seat.selector}`
  const summary =
    end === undefined
      ? `${who} started at ${where} on ${node}`
      : `${who} ended (${end}${reason === undefined ? '' : `: ${reason}`}) at ${where} on ${node}`
  const type: SessionProjectEventType = end === undefined ? 'session.started' : 'session.ended'

  return {
    type,
    project: seat.project,
    task: taskSelectorFrom(seat.selector),
    summary: clampSummary(summary),
    attributes,
    idempotencyKey: `${event.hostSessionId}:${end === undefined ? 'started' : 'ended'}:${
      runtimeId ?? event.ts
    }`,
    scopeRef: fullSessionRef(event.scopeRef, event.laneRef),
    occurredAt: event.ts,
  }
}

/** The two shapes a fact can be posted as, most specific first. */
export function postParamsFor(fact: SessionProjectEventFact): WrkqProjectEventPostParams[] {
  const base = {
    type: fact.type,
    summary: fact.summary,
    attributes: fact.attributes,
    idempotencyKey: fact.idempotencyKey,
    occurredAt: fact.occurredAt,
    scopeRef: fact.scopeRef,
  }
  // `project` and `task` are never sent together: wrkq refuses the pair with
  // `task_not_in_project` when they disagree, and this producer cannot prove
  // they agree. Task-affiliated posts inherit the project from the task.
  return fact.task === undefined
    ? [{ ...base, project: fact.project }]
    : [
        { ...base, task: fact.task },
        { ...base, project: fact.project },
      ]
}

export type SessionProjectEventPublisherDeps = {
  db: HrcDatabase
  post: (params: WrkqProjectEventPostParams) => Promise<unknown>
  node: string
  /** Tail cadence. `0` disables the timer (tests pump through `drain`). */
  pollIntervalMs?: number | undefined
}

/**
 * T-08928 — the durable `wrkq_ledger_cursors` stream this tail advances. It
 * names a stream HRC publishes TO wrkq, beside `envelope`, which HRC reads.
 */
export const SESSION_PROJECT_EVENTS_STREAM = 'session-project-events'

/** Every HRC ledger kind this producer turns into a `session.*` fact. */
export const SESSION_PROJECT_EVENT_SOURCE_KINDS = [
  'session.created',
  'broker.seat.transition',
  ...Object.keys(END_KINDS),
]

const TAIL_BATCH = 200
const DEFAULT_POLL_INTERVAL_MS = 1000

/**
 * Tails the HRC ledger and publishes one project event per birth, runtime
 * start and runtime end.
 *
 * T-08928 — a TAIL, not a `notifyEvent` observer. Most runtime ends
 * (`runtime.crashed` and `runtime.terminated` from the broker lifecycle,
 * `runtime.dead`/`runtime.stale` from startup reconcile) and every seat
 * transition are appended without ever reaching the notify fan-out, so an
 * observer would publish births and silently miss most ends. The ledger is the
 * one place every one of them lands, in `hrc_seq` order.
 *
 * The cursor is durable and advances only after a batch's posts settle, so a
 * daemon restart resumes at the gap. A fresh cursor starts at the ledger's
 * current high water: history before the producer existed is not backfilled.
 *
 * Posts for one session are chained, so wrkp's insertion order is HRC's order.
 * Every failure is swallowed into a log line: publication is an observation of
 * a fact that is already durable, and never reaches it.
 */
export class SessionProjectEventPublisher {
  private readonly tails = new Map<string, Promise<void>>()
  private pumping: Promise<void> | undefined
  private rerun = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: SessionProjectEventPublisherDeps) {
    const cursors = deps.db.wrkqLedgerCursors
    if (cursors.get(SESSION_PROJECT_EVENTS_STREAM) === undefined) {
      cursors.advance(deps.db.hrcEvents.maxHrcSeq(), SESSION_PROJECT_EVENTS_STREAM)
    }
    const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    if (interval > 0) {
      this.timer = setInterval(() => this.kick(), interval)
      this.timer.unref?.()
    }
  }

  /** A notify-path hint that the ledger moved. The timer covers every miss. */
  observe(event: Pick<HrcLifecycleEvent, 'eventKind'>): void {
    if (SESSION_PROJECT_EVENT_SOURCE_KINDS.includes(event.eventKind)) this.kick()
  }

  /** Test seam: pump to the ledger head and await every post. */
  async drain(): Promise<void> {
    this.kick()
    while (this.pumping !== undefined) await this.pumping
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private kick(): void {
    if (this.pumping !== undefined) {
      this.rerun = true
      return
    }
    this.pumping = this.pump()
      .catch((error) => {
        writeServerLog('WARN', 'session_project_event.tail_failed', {
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

  private async pump(): Promise<void> {
    const cursors = this.deps.db.wrkqLedgerCursors
    for (;;) {
      const after = cursors.get(SESSION_PROJECT_EVENTS_STREAM) ?? 0
      const events = this.deps.db.hrcEvents.listFromHrcSeqFiltered(after + 1, {
        // Imported rows are another node's facts; that node publishes them.
        sourceRef: null,
        eventKinds: SESSION_PROJECT_EVENT_SOURCE_KINDS,
        limit: TAIL_BATCH,
      })
      const last = events.at(-1)
      if (last === undefined) return
      const posts: Promise<void>[] = []
      for (const event of events) {
        // T-08566: a retained-origin row is observable history, never current.
        if (event.evidenceOrigin != null) continue
        const fact =
          event.eventKind === 'session.created'
            ? this.birthFact(event)
            : deriveSessionRuntimeEvent({ event, node: this.deps.node })
        if (fact !== undefined) posts.push(this.enqueue(event.hostSessionId, fact))
      }
      await Promise.all(posts)
      cursors.advance(last.hrcSeq, SESSION_PROJECT_EVENTS_STREAM)
      if (events.length < TAIL_BATCH) return
    }
  }

  private enqueue(hostSessionId: string, fact: SessionProjectEventFact): Promise<void> {
    const previous = this.tails.get(hostSessionId) ?? Promise.resolve()
    const task: Promise<void> = previous
      .then(() => this.publish(fact))
      .finally(() => {
        if (this.tails.get(hostSessionId) === task) this.tails.delete(hostSessionId)
      })
    this.tails.set(hostSessionId, task)
    return task
  }

  private birthFact(event: RuntimeLifecycleEvent): SessionProjectEventFact | undefined {
    const session = this.deps.db.sessions.getByHostSessionId(event.hostSessionId)
    if (session === null) return undefined
    const claim = this.deps.db.sessionTaskClaimAuthorities.getByHostSessionId(event.hostSessionId)
    return deriveSessionProjectEvent({
      session,
      payload: event.payload,
      node: this.deps.node,
      occurredAt: event.ts,
      ...(claim === null ? {} : { requestedBy: claim.claimedBy }),
    })
  }

  private async publish(fact: SessionProjectEventFact): Promise<void> {
    const attempts = postParamsFor(fact)
    for (let index = 0; index < attempts.length; index += 1) {
      const params = attempts[index]
      if (params === undefined) continue
      try {
        await this.deps.post(params)
        return
      } catch (error) {
        // ANY refusal of the task-affiliated attempt falls back to the project:
        // `NotFoundError` for a purged or malformed id is the measured ~7%, but
        // `task_not_in_project` and `task has no owning project` are refusals
        // too, and a birth is never dropped because wrkq could not resolve the
        // selector its scope happens to name.
        const last = index === attempts.length - 1
        writeServerLog(last ? 'WARN' : 'INFO', 'session_project_event.post_failed', {
          type: fact.type,
          seat: fact.scopeRef,
          hostSessionId: fact.attributes['session'],
          idempotencyKey: fact.idempotencyKey,
          affiliation: params.task === undefined ? 'project' : 'task',
          fallingBack: !last,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
