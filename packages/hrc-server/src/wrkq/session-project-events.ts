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
export type SessionProjectEventType = 'session.born' | 'session.rotated'

/**
 * The declared `cause` vocabulary: the DOOR a session came through, which is
 * what the birth site can actually observe. See the doc for why `mail` and
 * `dispatch` are not separable here.
 */
export type SessionBirthCause =
  | 'rotation'
  | 'summon'
  | 'dispatch'
  | 'desktop'
  | 'command_run'
  | 'resolve'

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
  if (reason === 'codex-desktop-registration') return 'desktop'
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
    scopeRef: session.scopeRef,
    occurredAt,
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
}

/**
 * Observes the lifecycle stream and publishes one project event per birth.
 *
 * Wired into `notifyEvent` alongside the ACP bridge, on the same observer
 * discipline: synchronous entry, detached emission, every failure swallowed
 * into a log line.
 */
export class SessionProjectEventPublisher {
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly deps: SessionProjectEventPublisherDeps) {}

  observe(event: Pick<HrcLifecycleEvent, 'eventKind' | 'hostSessionId' | 'ts' | 'payload'>): void {
    if (event.eventKind !== 'session.created') return
    const session = this.deps.db.sessions.getByHostSessionId(event.hostSessionId)
    if (session === null) return
    const claim = this.deps.db.sessionTaskClaimAuthorities.getByHostSessionId(event.hostSessionId)
    const fact = deriveSessionProjectEvent({
      session,
      payload: event.payload,
      node: this.deps.node,
      occurredAt: event.ts,
      ...(claim === null ? {} : { requestedBy: claim.claimedBy }),
    })
    if (fact === undefined) return

    const task = this.publish(fact).finally(() => {
      this.inFlight.delete(task)
    })
    this.inFlight.add(task)
  }

  /** Test seam: await every detached post this publisher has started. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
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
          hostSessionId: fact.idempotencyKey,
          affiliation: params.task === undefined ? 'project' : 'task',
          fallingBack: !last,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
