import type {
  DispatchTurnResponse,
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import { formatSessionRef } from './messages.js'
import { parseRuntimeIntent } from './parsers/runtime.js'
import { isRunActive } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRecord } from './server-parsers.js'
import { findTargetSession } from './target-view.js'
import {
  type PresentableEnvelope,
  formatEnvelopePresentations,
} from './wrkq/envelope-presentation.js'
import { WrkqLedgerUnavailableError } from './wrkq/ledger-client.js'
import { targetSessionRefForLedgerScope } from './wrkq/ledger-scope.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopeCreatedPayload,
  WrkqMonitorEvent,
} from './wrkq/ledger-types.js'

/**
 * The kicker, re-pointed at the wrkq collaboration ledger (T-07612 §10, T-07615).
 *
 * What did NOT change: the per-scope drive slot, the stable `driveAttemptId`,
 * the summon gate as the sole message-traffic provisioning door, and the rule
 * that a clear-inbox no-op turn burns no round. What changed is where the
 * obligations live. HRC reads them from wrkq, presents them per §7, and records
 * the presentation back into wrkq — it keeps no durable copy of an envelope.
 *
 * Three wake sources, per §10:
 *  - `envelope.created` on the wrkq event ledger, tailed from a persisted
 *    cursor over the rpc:// channel HRC already holds;
 *  - turn completion, so a scope that just finished picks up what arrived
 *    while it was busy;
 *  - a periodic sweep, which is the correctness backstop that makes tail
 *    latency never load-bearing.
 */

const MAIL_DRIVE_TERMINAL_EVENTS = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.zombied',
  'turn.reaped',
])

/** One presentation carries a room's worth of obligations, not an inbox dump. */
const MAX_PRESENTED_PER_ATTEMPT = 20
/**
 * Bounded page for the wake tail. The limit bounds RAW ledger rows scanned, not
 * matches, so a busy ledger costs more ticks rather than one unbounded read.
 */
const LEDGER_TAIL_PAGE_LIMIT = 500
/** One `pendingView` carries at most this many scopes. */
const LEDGER_SWEEP_SCOPE_BATCH = 100
/**
 * Sweep ticks between full ledger reads.
 *
 * The tail runs every tick because it IS the wake-latency path and costs one
 * indexed read from the head of the log. The sweep is the backstop, and a
 * backstop that runs every second is a load problem rather than a safety one.
 */
const LEDGER_SWEEP_TICKS = 30

type AttemptObservation = 'dispatch' | 'waiting' | 'finished'

function isDurablyActiveRun(run: HrcRunRecord): boolean {
  return run.status === 'queued' || isRunActive(run)
}

function targetHasRunningTurn(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): boolean {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId !== undefined) {
      const run = server.db.runs.getByRunId(runtime.activeRunId)
      if (run === null || isDurablyActiveRun(run)) return true
    }
    if (
      runtime.status === 'busy' ||
      runtime.status === 'awaiting_input' ||
      runtime.status === 'starting' ||
      runtime.status === 'stopping'
    ) {
      return true
    }
  }
  return false
}

function terminalRunEvent(events: HrcLifecycleEvent[]): HrcLifecycleEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return event
  }
  return undefined
}

/**
 * Advance the redelivery bound for every envelope a finished attempt presented.
 *
 * Rounds belong to wrkq now, and only a still-`presented` envelope advances
 * there, so a turn that replied or deferred costs nothing. Failures are logged
 * and dropped: a missed round makes an obligation live longer, which is the
 * safe direction.
 */
function advanceRoundsForAttempt(
  server: HrcServerInstanceForHandlers,
  driveAttemptId: string,
  envelopeIds: readonly string[]
): void {
  if (envelopeIds.length === 0) return
  void (async () => {
    for (const envelope of envelopeIds) {
      try {
        const advanced = await server.wrkqLedger.roundEnded({
          envelope,
          maxRounds: server.hrcMailMaxRounds,
        })
        if (advanced.state === 'dead') {
          writeServerLog('INFO', 'wrkq.kicker.envelope_dead', {
            driveAttemptId,
            envelope,
            roundCount: advanced.roundCount,
          })
        }
      } catch (error) {
        writeServerLog('WARN', 'wrkq.kicker.round_ended_failed', {
          driveAttemptId,
          envelope,
          error: errorText(error),
        })
      }
    }
  })()
}

function observeAttempt(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt
): AttemptObservation {
  const events = server.db.hrcEvents.listByRun(attempt.runId)
  const started = events.find((event) => event.eventKind === 'turn.started')
  let current = attempt
  if (started !== undefined) {
    current =
      server.db.mailDrives.recordStart({
        runId: attempt.runId,
        startHrcSeq: started.hrcSeq,
        startedAt: started.ts,
        hostSessionId: started.hostSessionId,
        generation: started.generation,
        runtimeId: started.runtimeId,
      }) ?? current
  }

  const terminal = terminalRunEvent(events)
  if (terminal !== undefined) {
    const completed = server.db.mailDrives.completeStartedAttempt(current.runId, terminal.eventKind)
    if (completed !== undefined) {
      advanceRoundsForAttempt(
        server,
        completed.attempt.driveAttemptId,
        completed.presentedEnvelopeIds
      )
    }
    return 'finished'
  }

  const run = server.db.runs.getByRunId(current.runId)
  if (run === null) return 'dispatch'
  if (isDurablyActiveRun(run)) return 'waiting'

  if (run.completedAt !== undefined || run.status === 'completed' || run.status === 'failed') {
    const completed = server.db.mailDrives.completeStartedAttempt(
      current.runId,
      `run.${run.status}`
    )
    if (completed !== undefined) {
      advanceRoundsForAttempt(
        server,
        completed.attempt.driveAttemptId,
        completed.presentedEnvelopeIds
      )
    }
    return 'finished'
  }
  return 'waiting'
}

/**
 * Ask wrkq what stands against one target.
 *
 * `pendingView` is the wake set and the stop-hook predicate in one read, and its
 * sweep re-pends due deferrals — so calling it here IS the periodic-sweep half
 * of §5's wake routing.
 */
async function readActionableEnvelopes(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string
): Promise<WrkqEnvelope[]> {
  const view = await server.wrkqLedger.pendingView({ scopes: [targetSessionRef] })
  if (view.repended > 0) {
    writeServerLog('INFO', 'wrkq.kicker.deferrals_repended', {
      targetSessionRef,
      repended: view.repended,
    })
  }
  return view.items.slice(0, MAX_PRESENTED_PER_ATTEMPT)
}

/**
 * Birth directives ride the envelope verbatim (`+node=`, `+model=`): wrkq stores
 * the string and never parses it, and HRC parses it here, at kick time.
 */
function actionableIntent(envelopes: readonly WrkqEnvelope[]): HrcRuntimeIntent | undefined {
  for (const envelope of envelopes) {
    const raw = envelope.materializationIntent
    if (raw === undefined || raw.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed)) return parseRuntimeIntent(parsed)
    } catch {
      // A malformed intent must not strand the envelope: fall through to the
      // session's own last applied intent, which is what an ordinary DM uses.
    }
  }
  return undefined
}

/**
 * Tell wrkq each envelope was presented, and collect what §7 needs to render it.
 *
 * `present` is exactly-once per `driveAttemptId`: a replayed attempt returns
 * `recorded: false` and leaves one receipt. `historyHint` is wrkq's cue
 * decision, keyed to the RUNTIME rather than the generation, so a post-`/quit`
 * runtime inside the same generation is correctly treated as cold.
 */
async function recordPresentations(
  server: HrcServerInstanceForHandlers,
  envelopes: readonly WrkqEnvelope[],
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord,
  runtimeId: string | undefined
): Promise<PresentableEnvelope[]> {
  const presentables: PresentableEnvelope[] = []
  for (const envelope of envelopes) {
    const result = await server.wrkqLedger.present({
      envelope: envelope.id,
      node: server.federationNodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runId: attempt.runId,
      driveAttemptId: attempt.driveAttemptId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
    presentables.push({
      envelope: result.envelope,
      historyHint: result.historyHint,
      messageCount: result.messageCount,
      ...(result.lastMessage === undefined ? {} : { lastMessage: result.lastMessage }),
      ...(await roomSubjectFor(server, result.envelope)),
      ...senderGenerationFor(server, result.envelope),
    })
  }
  return presentables
}

/** An ad-hoc room's subject, for the §7 header. Absent is not an error. */
async function roomSubjectFor(
  server: HrcServerInstanceForHandlers,
  envelope: WrkqEnvelope
): Promise<{ roomSubject?: string }> {
  if (envelope.roomKind !== 'adhoc') return {}
  try {
    const room = await server.wrkqLedger.roomShow({ room: envelope.roomKey })
    return room.subject === undefined ? {} : { roomSubject: room.subject }
  } catch {
    return {}
  }
}

/**
 * The sender's generation, when this node homes the sender.
 *
 * It is execution state, so it comes from HRC and never from the ledger — and
 * it is omitted rather than guessed when the sender lives on another node.
 */
function senderGenerationFor(
  server: HrcServerInstanceForHandlers,
  envelope: WrkqEnvelope
): { senderGeneration?: number } {
  const scopeRef = envelope.from.scopeRef
  if (scopeRef === undefined) return {}
  const sessionRef = targetSessionRefForLedgerScope(scopeRef)
  if (sessionRef === undefined) return {}
  const session = findTargetSession(server.db, sessionRef)
  return session === null ? {} : { senderGeneration: session.generation }
}

async function driveMailTargetOnce(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): Promise<void> {
  let attempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  if (attempt !== undefined) {
    const observation = observeAttempt(server, attempt)
    if (observation === 'waiting') return
    if (observation === 'finished') attempt = undefined
  }

  let session = findTargetSession(server.db, targetSessionRef) ?? undefined
  let actionable: WrkqEnvelope[]
  try {
    actionable = await readActionableEnvelopes(server, targetSessionRef)
  } catch (error) {
    // wrkq owns the obligations. Unreachable means HRC does not know what to
    // drive, which is a reason to do nothing, never a reason to guess.
    writeServerLog(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.pending_view_failed',
      { targetSessionRef, wakeReason, error: errorText(error) }
    )
    return
  }

  if (attempt === undefined) {
    if (session !== undefined && targetHasRunningTurn(server, session)) return
    const claim = server.db.mailDrives.claim(targetSessionRef, wakeReason, {
      envelopeIds: actionable.map((envelope) => envelope.id),
      ...(() => {
        const intent = actionableIntent(actionable)
        return intent === undefined ? {} : { materializationIntent: intent }
      })(),
    })
    if (claim.outcome === 'clear') return
    attempt = claim.attempt
    if (claim.outcome === 'active') {
      const observation = observeAttempt(server, attempt)
      if (observation !== 'dispatch') return
    } else {
      try {
        await server.options.hrcMailKickerAfterClaim?.(attempt)
      } catch (error) {
        const message = errorText(error)
        server.db.mailDrives.recordError(attempt.driveAttemptId, message)
        writeServerLog('WARN', 'wrkq.kicker.after_claim_failed', {
          targetSessionRef,
          driveAttemptId: attempt.driveAttemptId,
          runId: attempt.runId,
          error: message,
        })
        return
      }
    }
  }

  try {
    const materializationIntent = session?.lastAppliedIntentJson ?? attempt.materializationIntent
    if (materializationIntent === undefined) {
      server.db.mailDrives.recordError(
        attempt.driveAttemptId,
        'target is unborn and the envelope has no materialization intent'
      )
      return
    }

    if (session === undefined) {
      // This is the only message-traffic provisioning path. ensureTargetSession
      // enters the normal summon/placement gate before it mints anything, so a
      // scope this node does not home is refused here rather than pre-filtered.
      session = await server.ensureTargetSession(targetSessionRef, materializationIntent)
    }
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: session.hostSessionId,
      generation: session.generation,
    })

    if (targetHasRunningTurn(server, session)) return

    // The local receipt is written FIRST, then the ledger is told with the same
    // attempt id. A kill in between replays into an exactly-once `present`.
    const envelopeIds = server.db.mailDrives.presentForAttempt(
      attempt.driveAttemptId,
      actionable.map((envelope) => envelope.id)
    )
    if (envelopeIds.length === 0) {
      server.db.mailDrives.completeNoOp(attempt.driveAttemptId)
      return
    }

    const runtimeId = server.db.runtimes
      .listByHostSessionId(session.hostSessionId)
      .find((runtime) => runtime.status !== 'exited')?.runtimeId
    const byId = new Map(actionable.map((envelope) => [envelope.id, envelope]))
    const ordered = envelopeIds
      .map((id) => byId.get(id))
      .filter((envelope): envelope is WrkqEnvelope => envelope !== undefined)
    const presentables = await recordPresentations(server, ordered, attempt, session, runtimeId)
    const prompt = formatEnvelopePresentations(presentables)
    server.db.mailDrives.recordPresentation(attempt.driveAttemptId, prompt, presentables.length)
    attempt = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt

    // An `fyi` is auto-acked at its own presentation and never summons; if that
    // was everything this attempt held, there is no turn to dispatch.
    if (presentables.every((presentable) => presentable.envelope.obligation !== 'reply_required')) {
      server.db.mailDrives.completeNoOp(attempt.driveAttemptId)
      return
    }

    const response = await server.dispatchTurnForSession(
      session,
      session.lastAppliedIntentJson ?? materializationIntent,
      attempt.prompt,
      {
        runId: attempt.runId,
        waitForCompletion: false,
        whenBusy: 'reject',
      }
    )
    const body = (await response.json()) as DispatchTurnResponse
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      runtimeId: body.runtimeId,
    })
    observeAttempt(server, attempt)
    writeServerLog('INFO', 'wrkq.kicker.turn_dispatched', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      presentedCount: presentables.length,
      wakeReason,
    })
  } catch (error) {
    const message = errorText(error)
    server.db.mailDrives.recordError(attempt.driveAttemptId, message)
    writeServerLog('WARN', 'wrkq.kicker.drive_failed', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      wakeReason,
      error: message,
    })
  }
}

export function requestMailKickerWake(
  this: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): void {
  if (!this.hrcMailKickerEnabled || this.stopping) return
  this.mailKickerPendingTargets.set(targetSessionRef, wakeReason)
  queueMicrotask(() => {
    void this.drainMailKickerTarget(targetSessionRef).catch((error: unknown) => {
      writeServerLog('WARN', 'wrkq.kicker.wake_failed', {
        targetSessionRef,
        wakeReason,
        error: errorText(error),
      })
    })
  })
}

export function drainMailKickerTarget(
  this: HrcServerInstanceForHandlers,
  targetSessionRef: string
): Promise<void> {
  const existing = this.mailKickerTargetOperations.get(targetSessionRef)
  if (existing !== undefined) return existing

  const operation = (async () => {
    while (!this.stopping && this.hrcMailKickerEnabled) {
      const reason = this.mailKickerPendingTargets.get(targetSessionRef)
      if (reason === undefined) return
      this.mailKickerPendingTargets.delete(targetSessionRef)
      await driveMailTargetOnce(this, targetSessionRef, reason)
    }
  })().finally(() => {
    this.mailKickerTargetOperations.delete(targetSessionRef)
    if (this.mailKickerPendingTargets.has(targetSessionRef) && !this.stopping) {
      queueMicrotask(() => void this.drainMailKickerTarget(targetSessionRef))
    }
  })
  this.mailKickerTargetOperations.set(targetSessionRef, operation)
  return operation
}

/**
 * The periodic sweep: the correctness backstop behind the ledger tail.
 *
 * Its candidate set is deliberately NARROW — the scopes this node is currently
 * seating, plus any drive attempt still in flight. That is what "scopes this
 * node homes" means in practice, and it keeps one bounded `pendingView` per
 * sweep instead of a query that grows with every scope the daemon has ever
 * seen. Discovering a scope with no live seat is the TAIL's job: it resumes
 * from a persisted cursor, so an envelope written while HRC was down is
 * replayed rather than swept for.
 */
export function runMailKickerSweep(this: HrcServerInstanceForHandlers): Promise<void> {
  if (!this.hrcMailKickerEnabled || this.stopping) return Promise.resolve()
  if (this.mailKickerSweepInFlight !== undefined) return this.mailKickerSweepInFlight

  const sweep = (async () => {
    const targets = new Set<string>(this.db.mailDrives.listInFlightTargets())
    const seated = this.db.runtimes.listLiveSessionRefs()
    for (const batch of chunk(seated, LEDGER_SWEEP_SCOPE_BATCH)) {
      try {
        const view = await this.wrkqLedger.pendingView({ scopes: batch })
        if (view.repended > 0) {
          writeServerLog('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
        }
        for (const envelope of view.items) {
          const scopeRef = envelope.to?.scopeRef
          if (scopeRef === undefined) continue
          const sessionRef = targetSessionRefForLedgerScope(scopeRef)
          if (sessionRef !== undefined) targets.add(sessionRef)
        }
      } catch (error) {
        writeServerLog(
          error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
          'wrkq.kicker.sweep_pending_view_failed',
          { scopes: batch.length, error: errorText(error) }
        )
        break
      }
    }
    for (const targetSessionRef of targets) {
      this.mailKickerPendingTargets.set(targetSessionRef, 'periodic')
    }
    await Promise.all(
      [...targets].map((targetSessionRef) => this.drainMailKickerTarget(targetSessionRef))
    )
  })().finally(() => {
    if (this.mailKickerSweepInFlight === sweep) this.mailKickerSweepInFlight = undefined
  })
  this.mailKickerSweepInFlight = sweep
  return sweep
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

/**
 * Follow wrkq's event ledger for `envelope.created`, from a PERSISTED cursor.
 *
 * Always explicit: a read with no cursor replays the whole log (T-07620). The
 * first tail on a virgin store resolves "now" from row identity via `lastN`
 * rather than by arithmetic on a high-water mark.
 */
export async function runWrkqLedgerTail(this: HrcServerInstanceForHandlers): Promise<void> {
  if (!this.hrcMailKickerEnabled || this.stopping) return
  if (this.wrkqLedgerTailInFlight !== undefined) return this.wrkqLedgerTailInFlight

  const tail = (async () => {
    try {
      let cursor = this.db.wrkqLedgerCursors.get()
      if (cursor === undefined) {
        cursor = this.db.wrkqLedgerCursors.advance(await resolveTailStartCursor(this))
        writeServerLog('INFO', 'wrkq.kicker.tail_started', { cursor })
      }
      const page = await this.wrkqLedger.eventsView({
        cursor,
        eventTypes: ['envelope.created'],
        limit: LEDGER_TAIL_PAGE_LIMIT,
      })
      for (const event of page.items) {
        const target = wakeTargetForEvent(event)
        if (target === undefined) continue
        this.requestMailKickerWake(target, 'insert')
      }
      if (page.highWater > cursor) this.db.wrkqLedgerCursors.advance(page.highWater)
    } catch (error) {
      writeServerLog(
        error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
        'wrkq.kicker.tail_failed',
        { error: errorText(error) }
      )
    }
  })().finally(() => {
    if (this.wrkqLedgerTailInFlight === tail) this.wrkqLedgerTailInFlight = undefined
  })
  this.wrkqLedgerTailInFlight = tail
  return tail
}

/**
 * "Now", resolved from row identity rather than arithmetic.
 *
 * A daemon that has never tailed must start at the CURRENT end of the log:
 * replaying it would re-drive every historical envelope, and guessing a cursor
 * would skip whatever arrived in the gap. `lastN` resolves the row just before
 * the newest one, and one bounded page past it reports that newest row's id as
 * its high water — which is exactly the end. An empty ledger stays at 0, so the
 * very first envelope ever written is still seen.
 */
async function resolveTailStartCursor(server: HrcServerInstanceForHandlers): Promise<number> {
  const beforeLast = await server.wrkqLedger.eventsView({ cursor: 0, lastN: 1 })
  const start = Math.max(beforeLast.highWater, 0)
  const end = await server.wrkqLedger.eventsView({ cursor: start, limit: 1 })
  return Math.max(end.highWater, start)
}

/**
 * The target an `envelope.created` wakes, or undefined for one that never kicks.
 *
 * A `fyi` NEVER summons (§5): it rides into a live generation or waits for the
 * addressee's next attend, so it is not a wake. A scope-less addressee (a human
 * principal) is never kicked either — ACP presents those.
 */
function wakeTargetForEvent(event: WrkqMonitorEvent): string | undefined {
  if (event.eventType !== 'envelope.created' || event.payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(event.payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const payload = parsed as WrkqEnvelopeCreatedPayload
  if (payload.obligation !== 'reply_required') return undefined
  const scopeRef = payload.to_scope_ref
  if (typeof scopeRef !== 'string') return undefined
  return targetSessionRefForLedgerScope(scopeRef)
}

export function startMailKicker(this: HrcServerInstanceForHandlers): void {
  if (!this.hrcMailKickerEnabled || this.mailKickerSweepTimer !== undefined) return
  let tick = 0
  this.mailKickerSweepTimer = setInterval(() => {
    void this.runWrkqLedgerTail().catch((error: unknown) => {
      writeServerLog('WARN', 'wrkq.kicker.tail_tick_failed', { error: errorText(error) })
    })
    tick += 1
    if (tick % LEDGER_SWEEP_TICKS !== 0) return
    void this.runMailKickerSweep().catch((error: unknown) => {
      writeServerLog('WARN', 'wrkq.kicker.periodic_sweep_failed', { error: errorText(error) })
    })
  }, this.hrcMailKickerSweepIntervalMs)
  this.mailKickerSweepTimer.unref?.()
}

export function observeMailDriveLifecycleEvent(
  this: HrcServerInstanceForHandlers,
  event: HrcLifecycleEvent
): void {
  if (event.runId === undefined) return
  if (event.eventKind === 'turn.started') {
    this.db.mailDrives.recordStart({
      runId: event.runId,
      startHrcSeq: event.hrcSeq,
      startedAt: event.ts,
      hostSessionId: event.hostSessionId,
      generation: event.generation,
      runtimeId: event.runtimeId,
    })
    return
  }
  if (!MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return
  this.requestMailKickerWake(formatSessionRef(event.scopeRef, event.laneRef), 'turn_completion')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const mailKickerHandlersMethods = {
  requestMailKickerWake,
  drainMailKickerTarget,
  runMailKickerSweep,
  runWrkqLedgerTail,
  startMailKicker,
  observeMailDriveLifecycleEvent,
}

export type MailKickerHandlersMethods = typeof mailKickerHandlersMethods
