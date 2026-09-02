import { HrcDomainError, RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcSessionRecord,
  PreemptSubmissionRequest,
} from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type {
  HrcMailDriveAttempt,
  HrcMailDriveAttemptState,
  HrcMailDriveWakeReason,
  HrcMailEnvelopeReminder,
} from 'hrc-store-sqlite'

import { autoReplyCandidateFor } from './auto-reply-handlers.js'
import type { ForeignHome } from './federation/home-authority.js'
import { homeAuthorityDeps, resolveForeignHome } from './federation/home-authority.js'
import { formatSessionRef } from './messages.js'
import { parseSessionRef } from './server-parsers.js'
import { preemptAuthorized } from './turn-dispatch-handlers.js'

import { isRunActive, isRuntimeUnavailableStatus } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRecord } from './server-parsers.js'
import { findTargetSession } from './target-view.js'
import {
  type EnvelopePresentationForm,
  type PresentableEnvelope,
  formatEnvelopeFailureNotice,
  formatEnvelopePresentations,
} from './wrkq/envelope-presentation.js'
import { buildKickRuntimeIntent } from './wrkq/kick-intent.js'
import { WrkqLedgerUnavailableError } from './wrkq/ledger-client.js'
import { targetSessionRefForLedgerScope } from './wrkq/ledger-scope.js'
import { newestPresentationReceipt, obligationSummons } from './wrkq/ledger-types.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopeCreatedPayload,
  WrkqEnvelopeFailedPayload,
  WrkqEnvelopeFailureReason,
  WrkqEnvelopePendingView,
  WrkqMonitorEvent,
} from './wrkq/ledger-types.js'

/**
 * The kicker, re-pointed at the wrkq collaboration ledger (T-07612 §10, T-07615).
 *
 * What did NOT change: the per-scope drive slot, the stable `driveAttemptId`,
 * and the summon gate as the sole message-traffic provisioning door. What
 * changed is where the obligations live. HRC reads them from wrkq, presents
 * them per §4, and records the presentation back into wrkq — it keeps no
 * durable copy of an envelope.
 *
 * REV 5.1 (T-07702, T-07704) rebinds an obligation's LIFETIME to the runtime it
 * was presented to, and spends its budget only on reader decisions:
 *
 *  - D1/D6 the body is pushed ONCE per envelope; every later surface is a
 *    pointer with a read hint.
 *  - D2 a `presented` envelope is never re-presented to a different runtime.
 *    There is no redelivery floor any more, because there is no redelivery.
 *  - D3 a runtime that terminates holding one FAILS the obligation, and the
 *    sender is told (§5).
 *  - D4/D5 inside one runtime the kicker gets exactly one reminder, and a
 *    reminder turn that ends undisposed fails the obligation as `ignored`.
 *  - D7 five consecutive refused birth sweeps fail it as `undeliverable`.
 *
 * Three wake sources, per §10:
 *  - `envelope.created` on the wrkq event ledger, tailed from a persisted
 *    cursor over the rpc:// channel HRC already holds;
 *  - turn completion, so a scope that just finished picks up what arrived
 *    while it was busy;
 *  - a periodic sweep, which is the correctness backstop that makes tail
 *    latency never load-bearing.
 */

/**
 * The four runtime terminal events (rev 5.1 D3).
 *
 * `broker/controller/lifecycle.ts` classifies a user-initiated exit as
 * `terminated` and every abnormal broker terminal as `crashed`; the reaper and
 * the startup reconciler mark `dead`/`stale`. They are the WAKE — the runtime's
 * status column is what actually decides.
 */
const RUNTIME_TERMINAL_EVENTS = new Set([
  'runtime.terminated',
  'runtime.crashed',
  'runtime.dead',
  'runtime.stale',
])

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
 * How long a reminder is held after the turn that left the obligation
 * undisposed (rev 5.1 D4).
 *
 * A DELAY, not a backoff: it does not double, because there is nothing to back
 * off from. There is exactly one reminder per (envelope, runtime), and the
 * minute exists so a reader who is about to reply in their next breath is not
 * interrupted to be told they have not replied yet.
 */
const REMINDER_HOLD_MS = 60_000
/** Broker-held kicker presentations expire before the runtime zombie horizon. */
const KICKER_SUBMISSION_TTL_MS = 30 * 60_000
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
/** The doubling base of the virgin-birth retry bound: 1m, 2m, 4m, 8m, 16m. */
const BIRTH_SWEEP_BACKOFF_BASE_MS = 60_000
/**
 * How many consecutive refused birth sweeps an obligation is worth (rev 5.1 D7,
 * T-07661).
 *
 * It used to FLATTEN at five and retry forever on the grounds that "an
 * obligation does not stop being owed because its birth is hard". rev 5.1
 * overrules that: an addressee that cannot be seated after five escalating
 * attempts is not going to be seated by a sixth, and a sender left waiting on a
 * sixteen-minute spin learns nothing. The fifth refusal fails the envelope
 * `undeliverable` and hands the decision back to the sender, which is the same
 * shape as every other rev 5.1 failure.
 */
const BIRTH_SWEEP_MAX_REFUSALS = 5
/**
 * How far back the D3 lapse backstop looks for runtimes that have since died.
 *
 * A week, and it is a COST bound rather than a correctness one: the wake path
 * catches a lapse in a second, and the memo means each runtime is observed at
 * most once per process, so this only decides how much history one restart
 * re-walks. An obligation older than this that no wake and no earlier sweep
 * ever saw is not a case the daemon can invent evidence for.
 */
const LAPSE_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000

type AttemptObservation = 'dispatch' | 'waiting' | 'finished'

/**
 * How an in-flight attempt was discovered.
 *
 * `active-attempt` is the ordinary path: the slot was already held when the
 * wake arrived. `claim` is the RACE: two wakes for one scope, where
 * `getActiveAttempt` saw nothing and the claim CAS then reported the slot
 * already active. Both decline the slot for the same reason, so both must act
 * the same way — queue the mail into the live turn (rev 4), and say so.
 */
type InFlightDeclineRoute = 'active-attempt' | 'claim'

/** The run a session is currently busy on, for the busy-decline log line. */
/**
 * Is this run still genuinely in flight?
 *
 * `completed_at` is checked FIRST and it wins. A run row can carry a terminal
 * `completed_at` while its `status` was never moved off `running` — 346 such
 * rows on max3 and 18 on svc as of 2026-08-28, reaching back to July — and the
 * status-only test read every one of them as live. That is not cosmetic here:
 * this predicate is what `observeAttempt` consults before it looks at
 * `completedAt` at all, so a contradictory row reported `'waiting'` forever and
 * held its scope's drive slot; `targetHasRunningTurn` read the same row as a
 * permanently busy target. The kicker stays a READER of the run row (T-07653) —
 * this is about reading it correctly, not about writing it. The rows themselves
 * are a defect in whoever stamped `completed_at` without the status, and
 * repairing them belongs to that writer.
 */
function isDurablyActiveRun(run: HrcRunRecord): boolean {
  if (run.completedAt !== undefined) return false
  return run.status === 'queued' || isRunActive(run)
}

function activeRunIdFor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): string | undefined {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId !== undefined) return runtime.activeRunId
  }
  return undefined
}

/** A mid-turn attempt (rev 4): owned by the queued input's run, holding no slot. */
function isQueuedAttempt(attempt: HrcMailDriveAttempt): boolean {
  return attempt.driveAttemptId.startsWith('queued-')
}

/** The session's active run id only if its row is durably in flight. */
function durablyActiveRunIdFor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): string | undefined {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId === undefined) continue
    const run = server.db.runs.getByRunId(runtime.activeRunId)
    if (run !== null && isDurablyActiveRun(run)) return run.runId
  }
  return undefined
}

function terminalRunEvent(events: HrcLifecycleEvent[]): HrcLifecycleEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return event
  }
  return undefined
}

/**
 * What a finished attempt's own turn did to the obligations it carried
 * (rev 5.1 D4/D5).
 *
 * The trigger is the attempt's OWN turn having provably started and ended:
 * `completeStartedAttempt` returns envelope ids only in that case, so an input
 * the harness merged into another turn reaches here with nothing and neither
 * arms a reminder nor strikes an obligation out. That is the rev 4 ownership
 * rule, retained for exactly this one job.
 *
 * Two outcomes, decided by whether THIS attempt was the reminder:
 *
 *  - an ordinary delivery attempt ARMS the one reminder for (envelope,
 *    runtime), held `REMINDER_HOLD_MS`;
 *  - the reminder attempt STRIKES OUT — the reader has now ended two turns
 *    holding the obligation, one of them after being pointed straight at it.
 *
 * Both are conditional on the envelope still being `presented` AND on this
 * attempt still owning its newest receipt. A reply, a defer, or a delivery that
 * has since been superseded all mean this attempt has nothing left to decide.
 * Failures are logged and dropped: not failing an obligation makes it live
 * longer, which is the safe direction, and D3 bounds it regardless.
 */
function disposeAttemptObligations(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt,
  envelopeIds: readonly string[]
): void {
  // T-07671 §5: a line about a target that does not name the target is not part
  // of that target's timeline, and `grep <scope>` silently misses it.
  const { targetSessionRef, driveAttemptId } = attempt
  if (envelopeIds.length === 0) return
  const reminded = new Map(
    server.db.mailDrives
      .remindersForAttempt(driveAttemptId)
      .map((reminder) => [reminder.envelopeId, reminder] as const)
  )
  const turnEndedAt = attempt.completedAt ?? new Date().toISOString()
  const remindAt = new Date(Date.now() + REMINDER_HOLD_MS).toISOString()
  void (async () => {
    for (const envelope of envelopeIds) {
      try {
        const row = await server.wrkqLedger.envelopeShow({ envelope })
        if (row.state !== 'presented') continue
        const newest = newestPresentationReceipt(row)
        // Superseded: another attempt has presented this since, so the
        // obligation is bound to that delivery and not to this one.
        if (newest?.driveAttemptId !== driveAttemptId) continue
        const runtime = newest.runtimeId ?? attempt.runtimeId
        if (runtime === undefined) continue
        if (reminded.has(envelope)) {
          await failEnvelope(server, {
            envelope,
            reason: 'ignored',
            runtime,
            targetSessionRef,
            driveAttemptId,
          })
          continue
        }
        const armed = server.db.mailDrives.armReminder({
          envelopeId: envelope,
          runtimeId: runtime,
          targetSessionRef,
          turnEndedAt,
          remindAt,
        })
        if (!armed) continue
        writeServerLog('INFO', 'wrkq.kicker.reminder_armed', {
          targetSessionRef,
          driveAttemptId,
          envelope,
          runtimeId: runtime,
          remindAt,
        })
      } catch (error) {
        writeServerLog('WARN', 'wrkq.kicker.dispose_obligation_failed', {
          targetSessionRef,
          driveAttemptId,
          envelope,
          error: errorText(error),
        })
      }
    }
  })()
}

/**
 * End one obligation unsuccessfully, and say so in one greppable line.
 *
 * The call is IDEMPOTENT per (envelope, runtime) on the wrkq side, and a
 * runtime that no longer owns the newest receipt is REFUSED there rather than
 * allowed to fail a delivery that has moved on. Both matter here: this is
 * reached from a wake, from a sweep, and from a completed attempt, and all
 * three can observe the same lapse.
 */
async function failEnvelope(
  server: HrcServerInstanceForHandlers,
  input: {
    envelope: string
    reason: Exclude<WrkqEnvelopeFailureReason, 'legacy'>
    runtime?: string | undefined
    targetSessionRef: string
    driveAttemptId?: string | undefined
  }
): Promise<void> {
  const failed = await server.wrkqLedger.fail({
    envelope: input.envelope,
    reason: input.reason,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  })
  writeServerLog('INFO', 'wrkq.kicker.envelope_failed', {
    targetSessionRef: input.targetSessionRef,
    ...(input.driveAttemptId === undefined ? {} : { driveAttemptId: input.driveAttemptId }),
    envelope: input.envelope,
    reason: input.reason,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    state: failed.state,
  })
}

/** Is this runtime, by its own status column, no longer live? */
function isRuntimeTerminal(status: string): boolean {
  const level = (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null>)[status]
  return level === 'runtime-dead'
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
      disposeAttemptObligations(server, completed.attempt, completed.presentedEnvelopeIds)
      server.requestAutoReplyReconcile()
    }
    return 'finished'
  }

  const run = server.db.runs.getByRunId(current.runId)
  // T-07612 rev 4: a mid-turn (`queued-`) attempt holds no slot and is never
  // replayed. If its run is gone, or its runtime died before the input ever
  // started a turn, nothing will complete it: close it WITHOUT rounds — the
  // envelope was not shown at a boundary — and let the floor re-drive.
  if (started === undefined && isQueuedAttempt(current)) {
    const runtime =
      current.runtimeId === undefined
        ? undefined
        : (server.db.runtimes.getByRuntimeId(current.runtimeId) ?? undefined)
    const reason =
      run === null
        ? 'queued input has no run row'
        : runtime?.status === 'terminated'
          ? 'runtime terminated before the queued input started a turn'
          : undefined
    if (reason !== undefined) {
      server.db.mailDrives.failWithoutStart(current.driveAttemptId, reason)
      writeServerLog('INFO', 'wrkq.kicker.queued_attempt_reaped', {
        targetSessionRef: current.targetSessionRef,
        driveAttemptId: current.driveAttemptId,
        runId: current.runId,
        queuedBehindRunId: current.queuedBehindRunId,
        reason,
      })
      return 'finished'
    }
  }
  if (run === null) return 'dispatch'
  if (isDurablyActiveRun(run)) return 'waiting'

  if (run.completedAt !== undefined || run.status === 'completed' || run.status === 'failed') {
    const completed = server.db.mailDrives.completeStartedAttempt(
      current.runId,
      `run.${run.status}`
    )
    if (completed !== undefined) {
      disposeAttemptObligations(server, completed.attempt, completed.presentedEnvelopeIds)
      server.requestAutoReplyReconcile()
    }
    return 'finished'
  }
  return 'waiting'
}

/**
 * One envelope this wake may deliver, and WHICH of the §4 forms it takes.
 *
 * The form is decided from the ledger row plus HRC's own reminder record, in
 * one place, so no delivery path gets to choose a shape for itself.
 */
type ActionableEnvelope = {
  envelope: WrkqEnvelope
  form: EnvelopePresentationForm
  /** The armed reminder this delivery discharges, for the D5 binding. */
  reminder?: HrcMailEnvelopeReminder | undefined
}

/**
 * A stored hold is an interruption request and therefore owns one admission
 * decision. It can never inherit another envelope's origin by being batched,
 * nor lend its hold intent to ordinary queue mail.
 */
function isolatedDeliveryBatch(actionable: readonly ActionableEnvelope[]): {
  selected: ActionableEnvelope[]
  deferredCount: number
} {
  const hold = actionable.find((item) => item.envelope.delivery === 'hold')
  if (hold === undefined) return { selected: [...actionable], deferredCount: 0 }
  return { selected: [hold], deferredCount: actionable.length - 1 }
}

/**
 * Ask wrkq what stands against one target, and in what form.
 *
 * `pendingView` is the wake set and the stop-hook predicate in one read, and its
 * sweep re-pends due deferrals — so calling it here IS the periodic-sweep half
 * of §5's wake routing.
 *
 * REV 5.1 D2 lives here, and it is a subtraction rather than a gate. A
 * `presented` envelope is simply not deliverable: it is bound to the runtime in
 * its newest receipt, and the only thing that can surface it again is that same
 * runtime's own due reminder. Everything else this returns is `pending` — first
 * delivery (empty `presented_to`, full form) or a defer retry (non-empty,
 * pointer form carrying the reader's own reason). The redelivery floor that
 * used to hold a presented envelope back for 1/2/4/8/16 minutes is gone with
 * the re-presentation it was throttling.
 */
async function readActionableEnvelopes(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string
): Promise<ActionableEnvelope[]> {
  const view = await server.wrkqLedger.pendingView({
    scopes: [targetSessionRef],
    // T-07627: fyi rows ride the same read. They never summon (§5) and never
    // block a turn end, but a seated addressee should still be shown them.
    includeFyi: true,
  })
  if (view.repended > 0) {
    writeServerLog('INFO', 'wrkq.kicker.deferrals_repended', {
      targetSessionRef,
      repended: view.repended,
    })
  }
  const due = new Map(
    server.db.mailDrives
      .listDueReminders(targetSessionRef, new Date().toISOString())
      .map((reminder) => [reminder.envelopeId, reminder] as const)
  )
  const actionable: ActionableEnvelope[] = []
  const claimedReminders = new Set<string>()
  for (const envelope of view.items) {
    if (envelope.state === 'pending') {
      // D1 vs D6: `presented_to` non-empty means the body has already been
      // pushed once, so this is a defer retry and takes the pointer form.
      const form: EnvelopePresentationForm =
        envelope.presentedTo.length === 0 ? 'full' : 'defer-retry'
      actionable.push({ envelope, form })
      continue
    }
    if (envelope.state !== 'presented') continue
    const reminder = due.get(envelope.id)
    if (reminder === undefined) continue
    // The reminder is bound to ONE runtime. If the newest receipt has moved on,
    // this reminder is stale evidence about a delivery that no longer stands.
    if (newestPresentationReceipt(envelope)?.runtimeId !== reminder.runtimeId) continue
    claimedReminders.add(reminder.envelopeId)
    actionable.push({ envelope, form: 'reminder', reminder })
  }
  // Every due reminder this read did NOT claim is one whose obligation has
  // stopped standing on that runtime — replied, deferred, lapsed by D3, or
  // superseded. Retire it here, where the wake set that decided so is in hand.
  // Left armed it stays due forever and puts this scope in every later sweep's
  // candidate set for nothing.
  for (const reminder of due.values()) {
    if (claimedReminders.has(reminder.envelopeId)) continue
    if (!server.db.mailDrives.retireReminder(reminder.envelopeId, reminder.runtimeId)) continue
    writeServerLog('INFO', 'wrkq.kicker.reminder_retired', {
      targetSessionRef,
      envelope: reminder.envelopeId,
      runtimeId: reminder.runtimeId,
    })
  }
  return actionable.slice(0, MAX_PRESENTED_PER_ATTEMPT)
}

/**
 * May this envelope birth a previously unseated target?
 *
 * T-07746 separated summoning from reply debt. Both `reply_required` and the
 * default `notify` birth and wake; only `reply_required` goes on to owe a
 * reply. T-07612 §5 tied the two together, but what §5 was protecting was the
 * DEBT — an unborn seat must not be conscripted into owing an answer — not the
 * birth. Waking a seat to read something it owes nothing on is a different act.
 *
 * A legacy `fyi` still does NOT summon: those rows were written under the old
 * rule and never could, so honoring them here keeps history truthful.
 */
function summonsATurn(envelope: WrkqEnvelope): boolean {
  return obligationSummons(envelope.obligation)
}

/**
 * The birth directive block the ledger carried, if any envelope carried one.
 *
 * wrkq stores it VERBATIM (`+node=svc`) and never parses it — that vocabulary
 * is HRC's. It is a string, not an intent: the intent is assembled at kick time
 * from the target agent's own profile on this node.
 */
function actionableDirectives(actionable: readonly ActionableEnvelope[]): string | undefined {
  for (const { envelope } of actionable) {
    const raw = envelope.materializationIntent?.trim()
    if (raw !== undefined && raw.length > 0) return raw
  }
  return undefined
}

/**
 * Ask wrkq what each presentation would contain, without writing a receipt.
 *
 * The ledger remains the sole authority for the §7 history cue, but a preview
 * neither marks the runtime warm nor auto-acks a fyi. Delivery is committed
 * only after the broker accepts the prompt below.
 */
async function recordPresentations(
  server: HrcServerInstanceForHandlers,
  actionable: readonly ActionableEnvelope[],
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord,
  runtimeId: string | undefined
): Promise<PresentableEnvelope[]> {
  const presentables: PresentableEnvelope[] = []
  for (const item of actionable) {
    const result = await server.wrkqLedger.present({
      envelope: item.envelope.id,
      preview: true,
      node: server.federationNodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runId: attempt.runId,
      driveAttemptId: attempt.driveAttemptId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
    presentables.push({
      envelope: result.envelope,
      delivery: result.envelope.delivery,
      // A pointer form carries no body and therefore no history cue: the cue
      // exists to orient a cold reader at first contact, and every pointer
      // goes to a reader who has already had one.
      historyHint: item.form === 'full' && result.historyHint,
      messageCount: result.messageCount,
      ...(result.lastMessageAt === undefined ? {} : { lastMessageAt: result.lastMessageAt }),
      form: item.form,
      ...(item.reminder === undefined ? {} : { turnEndedAt: item.reminder.turnEndedAt }),
      ...senderGenerationFor(server, result.envelope),
    })
  }
  return presentables
}

/** Commit receipts only after an ordinary dispatch accepted the composed prompt. */
async function commitPresentations(
  server: HrcServerInstanceForHandlers,
  presentables: readonly PresentableEnvelope[],
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord,
  runtimeId: string | undefined,
  /**
   * Absent for a cold birth: the prompt rode the runtime's `initialPrompt`, so
   * that delivery class has no invocation input to name (T-07693). The receipt
   * contract already declares this field optional for exactly that reason.
   */
  inputId: string | undefined
): Promise<void> {
  for (const presentable of presentables) {
    await server.wrkqLedger.present({
      envelope: presentable.envelope.id,
      node: server.federationNodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      runId: attempt.runId,
      ...(inputId === undefined ? {} : { inputId }),
      driveAttemptId: attempt.driveAttemptId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
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

/**
 * T-07612 rev 4 — present into a seat that is on a live turn.
 *
 * The slot exists so two kicker drives never double-drive one scope, and the
 * attempt holding it releases only when its run ends. Under rev 4 nothing
 * waits for that: mail arriving while a kicker-driven turn is in flight is
 * handed to the broker with its ordinary queue policy, exactly as a typed
 * message would be, and the harness surfaces it mid-turn. No probe, no proof
 * of preemption, no typed busy failure — the steer class (T-07203) is not on
 * this path (rev 4 §5).
 *
 * A drive attempt of its own (`queued-` id) that holds NO slot, owned by the
 * queued input's run (§6 bounded redelivery needs an owner): if the harness
 * starts that input as its own turn, `completeStartedAttempt` advances the
 * round when it ends undisposed. If the harness merged it into the turn it was
 * queued behind (no `turn.started` of its own) this attempt advances NOTHING —
 * HRC cannot tell a merge from a slow start and does not guess (daedalus, rev
 * 4 ruling 3); the redelivery floor expires and the next ordinary drive into
 * the then-idle seat owns the round. Rendered without the history cue: only a
 * RECORDING `present` yields it, and the receipt is written after the broker
 * accepts.
 */
async function presentIntoBusyTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  session: HrcSessionRecord,
  queuedBehindRunId: string,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): Promise<boolean> {
  const activeRunId = queuedBehindRunId
  // The duplicate guard covers exactly the dispatch→commit window and nothing
  // more. An ordinary drive writes its LOCAL receipt before it dispatches and
  // commits the LEDGER receipt only after the broker accepts (T-07672); a wake
  // landing inside that window would re-present the same mail into the same
  // turn. Once the ledger receipt exists the envelope is `presented` and D2
  // takes it out of the wake set entirely: an input the harness merged and
  // never started is not re-queued by anything, and is bounded by D3 instead
  // (rev 5.1 D2/D5 replacing rev 4 ruling 4).
  //
  // And the window always CLOSES (ruling 5): a local receipt whose ledger
  // receipt is missing is replayed here, exactly as an ordinary drive replays
  // after a kill between persisting and dispatching (T-07615) — `present` is
  // exactly-once per driveAttemptId, and a `queued-` attempt exists only after
  // the broker accepted, so the replay claims nothing that did not happen.
  const uncommitted = new Set<string>()
  for (const unfinished of server.db.mailDrives.listUnfinishedAttempts(targetSessionRef)) {
    if (!isQueuedAttempt(unfinished)) {
      // An ordinary drive commits its own receipts right after its dispatch;
      // its window is the few ms in between, and it is not replayed here.
      for (const id of server.db.mailDrives.presentationEnvelopeIds(unfinished.driveAttemptId)) {
        const envelope = actionable.find((candidate) => candidate.envelope.id === id)?.envelope
        const committed = envelope?.presentedTo.some(
          (receipt) => receipt.driveAttemptId === unfinished.driveAttemptId
        )
        if (committed !== true) uncommitted.add(id)
      }
      continue
    }
    for (const id of server.db.mailDrives.presentationEnvelopeIds(unfinished.driveAttemptId)) {
      const envelope = actionable.find((candidate) => candidate.envelope.id === id)?.envelope
      if (envelope === undefined) continue
      const committed = envelope.presentedTo.some(
        (receipt) => receipt.driveAttemptId === unfinished.driveAttemptId
      )
      if (committed) continue
      try {
        await server.wrkqLedger.present({
          envelope: id,
          node: server.federationNodeId,
          ...(unfinished.hostSessionId === undefined
            ? {}
            : { hostSessionId: unfinished.hostSessionId }),
          ...(unfinished.generation === undefined
            ? {}
            : { generation: String(unfinished.generation) }),
          driveAttemptId: unfinished.driveAttemptId,
          deliveryOutcome: 'queued_to_live_harness',
          runId: unfinished.runId,
          ...(() => {
            const dispatched = server.db.runs.getByRunId(unfinished.runId)?.dispatchedInputId
            return dispatched === undefined ? {} : { inputId: dispatched }
          })(),
          ...(unfinished.runtimeId === undefined ? {} : { runtimeId: unfinished.runtimeId }),
        })
        writeServerLog('INFO', 'wrkq.kicker.queued_receipt_replayed', {
          targetSessionRef,
          driveAttemptId: unfinished.driveAttemptId,
          runId: unfinished.runId,
          envelope: id,
        })
        // Committed now, so the envelope is `presented` and bound to that
        // runtime: D2 takes it out of every later wake set, this one included.
        uncommitted.add(id)
      } catch (error) {
        writeServerLog('WARN', 'wrkq.kicker.queued_receipt_replay_failed', {
          targetSessionRef,
          driveAttemptId: unfinished.driveAttemptId,
          envelope: id,
          error: errorText(error),
        })
        uncommitted.add(id)
      }
    }
  }
  const envelopes = actionable.filter(
    (item) =>
      !uncommitted.has(item.envelope.id) &&
      // Already handed to this very turn: saying it twice into one turn is noise.
      !item.envelope.presentedTo.some((receipt) => receipt.runId === activeRunId)
  )
  if (envelopes.length === 0) return false

  const intent =
    session.lastAppliedIntentJson ??
    buildKickRuntimeIntent(
      parseSessionRef(targetSessionRef).scopeRef,
      actionableDirectives(envelopes)
    )
  if (intent === undefined) {
    writeServerLog('WARN', 'wrkq.kicker.busy_delivery_unavailable', {
      targetSessionRef,
      wakeReason,
      reason: 'no_runtime_intent_available',
      envelopes: envelopes.map((item) => item.envelope.id),
    })
    return false
  }

  const presentables: PresentableEnvelope[] = []
  for (const item of envelopes) {
    presentables.push({
      envelope: item.envelope,
      delivery: item.envelope.delivery,
      historyHint: false,
      messageCount: 0,
      form: item.form,
      ...(item.reminder === undefined ? {} : { turnEndedAt: item.reminder.turnEndedAt }),
      ...senderGenerationFor(server, item.envelope),
    })
  }
  const prompt = formatEnvelopePresentations(presentables)

  const firstEnvelope = envelopes[0]?.envelope
  const origin = {
    principalRef: firstEnvelope?.from.principalRef ?? 'system:hrc-kicker',
    ...(firstEnvelope?.from.scopeRef === undefined
      ? {}
      : { scopeRef: firstEnvelope.from.scopeRef }),
    ...(firstEnvelope === undefined ? {} : { envelopeId: firstEnvelope.id }),
  }
  let submissionDoor: 'enqueue' | 'preempt' = 'enqueue'
  let holdRefusedAuthority = false
  if (firstEnvelope?.delivery === 'hold') {
    const request: PreemptSubmissionRequest = {
      target: targetSessionRef,
      body: prompt,
      origin,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      turnPolicy: 'guarded',
    }
    if (await preemptAuthorized(server, session, request)) {
      submissionDoor = 'preempt'
    } else {
      holdRefusedAuthority = true
    }
  }

  let body: DispatchTurnResponse & { inputId?: string | undefined }
  try {
    const response = await server.dispatchTurnForSession(session, intent, prompt, {
      waitForCompletion: false,
      submissionDoor,
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      ...(submissionDoor === 'preempt' ? { turnPolicy: 'guarded' as const } : {}),
      submissionOrigin: origin,
    })
    body = (await response.json()) as DispatchTurnResponse & { inputId?: string | undefined }
    if (body.status !== 'started') {
      throw new Error(`busy delivery did not start (status=${body.status})`)
    }
  } catch (error) {
    // Nothing honest can be claimed, so nothing is recorded and the envelope
    // stays exactly as pending as it was; the next wake retries.
    writeServerLog('WARN', 'wrkq.kicker.busy_delivery_failed', {
      targetSessionRef,
      wakeReason,
      activeRunId,
      envelopes: envelopes.map((item) => item.envelope.id),
      error: errorText(error),
    })
    return false
  }

  const inputId = body.inputId ?? server.db.runs.getByRunId(body.runId)?.dispatchedInputId
  const runtimeId = body.runtimeId ?? presentationRuntimeIdFor(server, session)
  // The round-completing owner (rev 4): an attempt of its own, owned by the
  // queued input's run and queued behind the holder's, holding no slot. Local
  // receipt first, then the ledger with the same attempt id (the T-07615
  // ordering that survives a kill in between).
  const queuedAttempt = server.db.mailDrives.insertQueuedAttempt({
    targetSessionRef,
    runId: body.runId,
    wakeReason,
    prompt,
    envelopeIds: envelopes.map((item) => item.envelope.id),
    queuedBehindRunId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(() => {
      const candidate = autoReplyCandidateFor(envelopes.map((item) => item.envelope))
      return candidate === undefined ? {} : { autoReplyCandidate: candidate }
    })(),
  })
  for (const item of envelopes) {
    await server.wrkqLedger.present({
      envelope: item.envelope.id,
      node: server.federationNodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      driveAttemptId: queuedAttempt.driveAttemptId,
      // The outcome CLASS goes on the RECEIPT, not only on the log line
      // (C-16526, re-ruled on T-07644 C-16658): a log rotates and is grepped
      // from one node; the receipt travels with the envelope.
      deliveryOutcome: holdRefusedAuthority
        ? 'hold_refused_authority'
        : item.form === 'full'
          ? (body.delivery?.code ??
            (submissionDoor === 'preempt' ? 'preempted_live_harness' : 'queued_to_live_harness'))
          : `${item.form}_queued_to_live_harness`,
      runId: body.runId,
      ...(inputId === undefined ? {} : { inputId }),
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
    if (item.reminder !== undefined) {
      server.db.mailDrives.markReminderDelivered(
        item.reminder.envelopeId,
        item.reminder.runtimeId,
        queuedAttempt.driveAttemptId
      )
    }
  }

  writeServerLog('INFO', 'wrkq.kicker.queued_into_busy_target', {
    targetSessionRef,
    wakeReason,
    driveAttemptId: queuedAttempt.driveAttemptId,
    activeRunId,
    runId: body.runId,
    ...(inputId === undefined ? {} : { inputId }),
    queuedBehindRunId,
    envelopes: envelopes.map((item) => item.envelope.id),
    forms: envelopes.map((item) => item.form),
    submissionDoor,
    ...(holdRefusedAuthority ? { deliveryOutcome: 'hold_refused_authority' } : {}),
  })
  return true
}

/**
 * The scope's drive slot is held by a kicker attempt that has not finished yet
 * (T-07644).
 *
 * The SLOT is declined — claiming a second one for a scope already mid-drive
 * would double-drive it — but the MAIL does not wait (T-07612 rev 4): it is
 * queued into the live turn by `presentIntoBusyTarget`, slot-less. Before rev 4
 * only the retired urgent path took that route, and before T-07644 it was unreachable
 * here — a bare `return` sat above it.
 *
 * And it LOGS, unconditionally. The instrumented fall-through below already
 * carries the reason — a silent decline is indistinguishable from a dead kicker
 * — and that lesson shipped directly above a bare unlogged return that declined
 * for a different reason.
 *
 * The kind is `drive_in_flight` and deliberately NOT `target_busy` (mable,
 * T-07644 C-16626). They are different conditions — "a drive is already in
 * flight for this target" versus "the addressee is mid-turn on its own run" —
 * and merging them would destroy the meaning of the counter that ended four
 * wrong root causes. The payload is the reduced one for the same reason: what
 * this line has to name is the attempt holding the slot, because the state it
 * reports can WEDGE. An attempt whose run never reaches a terminal event stays
 * `started` forever, and until this line existed the scope simply went quiet.
 */
async function declineForInFlightAttempt(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  attempt: HrcMailDriveAttempt,
  session: HrcSessionRecord | undefined,
  actionable: readonly ActionableEnvelope[],
  wakeReason: HrcMailDriveWakeReason,
  route: { via: InFlightDeclineRoute; observation: AttemptObservation }
): Promise<void> {
  // No session means the drive that owns the slot has not reached one yet;
  // there is no live turn to steer into, so the decline is all there is.
  const queued =
    session === undefined
      ? false
      : await presentIntoBusyTarget(
          server,
          targetSessionRef,
          session,
          attempt.runId,
          actionable,
          wakeReason
        )
  writeServerLog('INFO', 'wrkq.kicker.drive_in_flight', {
    ...(queued ? { queuedDelivery: true } : {}),
    targetSessionRef,
    wakeReason,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    // Which route found the attempt, and what it observed. Without these the
    // line reproduces one level down the ambiguity it exists to remove: two
    // branches decline for the same reason and a single counter cannot say
    // which, nor tell a `waiting` decline from a `finished` one.
    via: route.via,
    observation: route.observation,
    // T-07671: WHICH envelopes are held behind the in-flight attempt, not just
    // how many. A wedged attempt is reconstructed from the log alone only if
    // the line names the mail that is stuck behind it.
    envelopeIds: actionable.map((item) => item.envelope.id),
  })
}

/** Home-authority deps, with the kicker's own name on a consult failure. */
function kickerHomeDeps(server: HrcServerInstanceForHandlers) {
  return homeAuthorityDeps(server, (scopeRef, error) => {
    writeServerLog('WARN', 'wrkq.kicker.home_consult_failed', {
      scopeRef,
      error: errorText(error),
    })
  })
}

/**
 * The runtime a presentation receipt must name: the host session's CURRENT
 * seat, not the oldest row it ever had (T-07650 mechanism A).
 *
 * The previous expression was `listByHostSessionId(...).find(r => r.status !==
 * 'exited')`. That query is `ORDER BY created_at ASC`, and `'exited'` is an
 * `HrcBrokerInvocationState`, never a runtime status — no stored row has ever
 * held it, so the predicate excluded nothing and the expression was `[0]`: the
 * FIRST runtime the host session ever had, whatever became of it. A receipt
 * therefore named a five-week-old row while the turn ran on the current one, in
 * proportion to how long the session had lived and not to anything being wrong.
 * The audits found it fleet-wide with zero true corpses behind it — max3 60/60,
 * svc 38/38, every one resolving to a live host session.
 *
 * Newest-first, skipping the unavailable states, and pinned to the SESSION'S
 * GENERATION so a prior-generation runtime left `ready` after a rotation can
 * never be named (T-07650, on Lance's max3 specimen: gen 27 `ready` since
 * 17:00Z took a message meant for gen 50). No current-generation seat means NO
 * runtimeId on the receipt: a receipt with no runtime is honest and already has
 * its own line in the audit, while a receipt naming the wrong one is not
 * recoverable after the fact.
 */
function presentationRuntimeIdFor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): string | undefined {
  const runtimes = server.db.runtimes.listByHostSessionId(session.hostSessionId)
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    const runtime = runtimes[index]
    if (runtime === undefined) continue
    if (runtime.generation !== session.generation) continue
    if (runtime.status === 'exited' || isRuntimeUnavailableStatus(runtime.status)) continue
    return runtime.runtimeId
  }
  return undefined
}

/**
 * Finish a drive attempt that threw, instead of merely annotating it.
 *
 * `recordError` ANNOTATES; it does not finish, and a `claimed` attempt owns its
 * scope's drive slot for as long as the row exists. A catch that only annotates
 * therefore makes the target permanently undrivable by this daemon, silently —
 * the hazard the missing-intent branch already names in `driveMailTargetOnce`,
 * reached through a different door. Both generic catches were that door
 * (T-07653); this is their single exit.
 *
 * A `started` attempt is the one case that is NOT finished here, and it is not
 * an exception to the rule. It PROVED a dispatch: the turn is before the
 * harness, the run row exists, and `observeAttempt` closes the attempt from the
 * run's terminal event with the round accounting `completeStartedAttempt` owes
 * the presented envelopes. Finishing it here would release a slot the live turn
 * still holds and re-present those envelopes under a NEW attempt id, which is a
 * duplicate delivery rather than a repair. A run that ends without ever
 * reaching a terminal state is the ACTIVE-RUN RECONCILER's to terminalize
 * (`sweep-reconcile.ts`), not the kicker's — the kicker only reads that row.
 */
function failDriveAfterThrow(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt,
  message: string
): HrcMailDriveAttemptState {
  const current = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt
  return current.state === 'started'
    ? server.db.mailDrives.recordError(current.driveAttemptId, message).state
    : server.db.mailDrives.failWithoutStart(current.driveAttemptId, message).state
}

/** The scope behind a drive target, or nothing when the ref is unparseable. */
function kickerScopeRefFor(targetSessionRef: string): string | undefined {
  try {
    return parseSessionRef(targetSessionRef).scopeRef
  } catch {
    return undefined
  }
}

/**
 * Skip a foreign-homed target: ONE positive line per scope per epoch.
 *
 * Two things happen here and both matter. The line is written once — a skip
 * repeated every tick is the same noise this fixes, wearing a calmer verb — and
 * any still-CLAIMED attempt is FINISHED rather than left annotated.
 * `recordError` alone leaves an attempt `claimed`, and a claimed attempt owns
 * the scope's drive slot forever, which is how twelve dead rows accumulated on
 * lab and kept re-entering `listInFlightTargets()` hours after the rebind. A
 * `started` attempt is left alone: it proved a dispatch, and its terminal event
 * is what closes it.
 *
 * Stale local RUNTIMES are deliberately NOT torn down here. Evicting a live
 * seat is an operator retirement decision (the retirement primitive enumerates the scope's live
 * runtime ids at revoke time), never a delivery mechanism's; a routing verdict
 * must not kill a session an operator may be attached to. Nor is the exclusion
 * pushed into `listLiveSessionRefs()`: that query lives in hrc-store-sqlite,
 * which has neither this node's identity nor a registry client, and it would
 * still leave `listInFlightTargets()` unfiltered. One filter, at the one place
 * both candidate sources converge.
 */
function skipForeignHomedTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  scopeRef: string,
  foreign: ForeignHome,
  wakeReason: HrcMailDriveWakeReason
): void {
  const attempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  const failedAttemptId =
    attempt?.state === 'claimed'
      ? server.db.mailDrives.failWithoutStart(
          attempt.driveAttemptId,
          `${scopeRef} is homed on ${foreign.homeNodeId}; this node has no authority to drive it`
        ).driveAttemptId
      : undefined

  // Announcement is deduped on its OWN map, not on the resolver's memo. The
  // memo is shared with the shadow teardown, and whichever mechanism happened
  // to resolve the scope first would otherwise silence this line for the other.
  const announcement = foreign.homeNodeId
  const alreadyAnnounced = server.mailKickerForeignHomeAnnounced.get(scopeRef) === announcement
  server.mailKickerForeignHomeAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced && failedAttemptId === undefined) return

  writeServerLog('INFO', 'wrkq.kicker.foreign_home_skipped', {
    targetSessionRef,
    scopeRef,
    homeNodeId: foreign.homeNodeId,
    source: foreign.source,
    wakeReason,
    ...(failedAttemptId === undefined ? {} : { failedAttemptId }),
  })
}

/**
 * A gate refusal that is a BIRTH DEFERRAL rather than a drive failure (T-07655).
 *
 * Two reasons qualify, and both mean the same thing operationally: this node
 * takes no part in the birth, and there is nothing wrong with it or with the
 * mail. Before this existed they fell into the generic catch and printed
 * `drive_failed`, which is how three nodes racing for one birth looked like
 * three broken drives.
 */
type BirthDeferral = {
  reason:
    | 'birth-designated-elsewhere'
    | 'designated-home-unreachable'
    | 'birth-designation-mismatch'
  homeNodeId: string
  designationEpoch: number
  birthEnvelopeId: string
  senderScopeRef: string
  provenance: string
}

function birthDeferralFor(error: unknown): BirthDeferral | undefined {
  if (!(error instanceof HrcDomainError)) return undefined
  const reason = error.detail['reason']
  if (
    reason !== 'birth-designated-elsewhere' &&
    reason !== 'designated-home-unreachable' &&
    reason !== 'birth-designation-mismatch'
  ) {
    return undefined
  }
  const designation = error.detail['birthDesignation']
  if (!isRecord(designation)) return undefined
  const homeNodeId = designation['homeNodeId']
  const designationEpoch = designation['designationEpoch']
  const birthEnvelopeId = designation['birthEnvelopeId']
  const senderScopeRef = designation['senderScopeRef']
  const provenance = designation['provenance']
  if (
    typeof homeNodeId !== 'string' ||
    typeof designationEpoch !== 'number' ||
    typeof birthEnvelopeId !== 'string' ||
    typeof senderScopeRef !== 'string' ||
    typeof provenance !== 'string'
  ) {
    return undefined
  }
  return { reason, homeNodeId, designationEpoch, birthEnvelopeId, senderScopeRef, provenance }
}

/**
 * Finish a deferred attempt and say so ONCE per scope per designation epoch.
 *
 * The attempt must be FINISHED, not merely annotated: a claimed attempt owns
 * the scope's drive slot, and a scope this node will never birth would hold its
 * own slot forever (the T-07653 invariant, and the same trap
 * `placement_unresolvable` documents above).
 */
function deferBirthForTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  scopeRef: string,
  attempt: HrcMailDriveAttempt,
  deferral: BirthDeferral,
  wakeReason: HrcMailDriveWakeReason
): void {
  const failedAttemptId =
    server.db.mailDrives.getAttempt(attempt.driveAttemptId)?.state === 'claimed'
      ? server.db.mailDrives.failWithoutStart(
          attempt.driveAttemptId,
          `${scopeRef} is designated to be born on ${deferral.homeNodeId}; this node takes no part in the birth`
        ).driveAttemptId
      : undefined

  const announcement = `${deferral.homeNodeId}@${deferral.designationEpoch}`
  const alreadyAnnounced = server.mailKickerBirthDeferredAnnounced.get(scopeRef) === announcement
  server.mailKickerBirthDeferredAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced) return

  writeServerLog('INFO', 'wrkq.kicker.birth_deferred', {
    targetSessionRef,
    scopeRef,
    birthEnvelopeId: deferral.birthEnvelopeId,
    senderScopeRef: deferral.senderScopeRef,
    homeNodeId: deferral.homeNodeId,
    provenance: deferral.provenance,
    designationEpoch: deferral.designationEpoch,
    reason: deferral.reason,
    wakeReason,
    ...(failedAttemptId === undefined ? {} : { failedAttemptId }),
  })
}

async function driveMailTargetOnce(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason,
  /** Bounded re-entry for the claim race; see the `finished` branch below. */
  redriveDepth = 0
): Promise<void> {
  // Placement first, before the drive slot, the ledger read, or the gate. A
  // scope homed on another node cannot be driven from here by any wake reason,
  // so claiming an attempt for it only manufactures the failure (T-07650).
  // A ref this daemon cannot parse gets no verdict and no new failure mode:
  // it falls through to the path that already reported that for what it is.
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  const foreign =
    scopeRef === undefined ? undefined : await resolveForeignHome(kickerHomeDeps(server), scopeRef)
  if (scopeRef !== undefined && foreign !== undefined) {
    skipForeignHomedTarget(server, targetSessionRef, scopeRef, foreign, wakeReason)
    return
  }

  let attempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  // Held rather than returned on: the decline needs the pending set and the
  // session, and both are read below. See `declineForInFlightAttempt`.
  let inFlight: HrcMailDriveAttempt | undefined
  if (attempt !== undefined) {
    const observation = observeAttempt(server, attempt)
    if (observation === 'waiting') inFlight = attempt
    if (observation === 'finished') attempt = undefined
  }
  // T-07612 rev 4: mid-turn attempts hold no slot, so nothing above finds
  // them. Every wake observes them too — that is how their rounds end.
  for (const queued of server.db.mailDrives.listUnfinishedAttempts(targetSessionRef)) {
    if (isQueuedAttempt(queued)) observeAttempt(server, queued)
  }

  let session = findTargetSession(server.db, targetSessionRef) ?? undefined
  // §5 — the sender-side failure notices this scope is owed. Delivered here
  // rather than folded into the drive because a notice is not an obligation:
  // it rides a live generation if there is one and waits for the next attend
  // otherwise, and it NEVER summons.
  if (session !== undefined) await deliverFailureNotices(server, targetSessionRef, session)
  let actionable: ActionableEnvelope[]
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
  const batch = isolatedDeliveryBatch(actionable)
  actionable = batch.selected
  if (batch.deferredCount > 0) {
    // The current target operation will observe this on its next drain-loop
    // iteration. No timer or polling is introduced; this preserves the same
    // wake while giving each hold its own admission decision.
    server.requestMailKickerWake(targetSessionRef, wakeReason)
  }

  if (inFlight !== undefined) {
    await declineForInFlightAttempt(
      server,
      targetSessionRef,
      inFlight,
      session,
      actionable,
      wakeReason,
      { via: 'active-attempt', observation: 'waiting' }
    )
    return
  }

  if (attempt === undefined) {
    // T-07612 rev 4: a busy target is NOT a reason to wait, and not a reason
    // to claim the slot either. A seat on a durably live turn gets the mail
    // as a slot-less attempt owned by the queued input's own run — the same
    // path an in-flight kicker turn takes — so a queued input the harness
    // merges into the live turn (never starting one of its own) can never
    // wedge the scope slot. The slot-claiming drive below is for an IDLE seat.
    if (session !== undefined) {
      const busyRunId = durablyActiveRunIdFor(server, session)
      if (busyRunId !== undefined) {
        await presentIntoBusyTarget(
          server,
          targetSessionRef,
          session,
          busyRunId,
          actionable,
          wakeReason
        )
        return
      }
    }
    // A non-summoning envelope (a legacy `fyi`) is presented into a live
    // generation if there is one, and otherwise waits. It is never the reason a
    // session is born, so a wake set holding nothing else stops here rather
    // than at the summon gate. `notify` DOES summon (T-07746) and so never
    // reaches this return.
    if (session === undefined && !actionable.some((item) => summonsATurn(item.envelope))) return
    const directives = actionableDirectives(actionable)
    const claim = server.db.mailDrives.claim(targetSessionRef, wakeReason, {
      envelopeIds: actionable.map((item) => item.envelope.id),
      ...(() => {
        const intent = buildKickRuntimeIntent(
          parseSessionRef(targetSessionRef).scopeRef,
          directives
        )
        return intent === undefined ? {} : { materializationIntent: intent }
      })(),
    })
    if (claim.outcome === 'clear') return
    attempt = claim.attempt
    if (claim.outcome === 'active') {
      // The CLAIM race (T-07644 C-16642): `getActiveAttempt` saw no attempt at
      // the top of this function, and the claim CAS then found the slot already
      // held — two wakes racing for one scope. This tests the identical
      // condition as the top branch, so it must answer identically. It used to
      // be a bare `return` that subsumed BOTH live observations: `waiting`, the
      // very state this task exists to instrument, and `finished`, which the
      // top of this function deliberately treats as re-drivable.
      const observation = observeAttempt(server, attempt)
      if (observation === 'finished') {
        // `observeAttempt` has just completed it and released the slot, so the
        // wake is still live work rather than something to drop. Re-enter, the
        // way the top branch re-drives a finished attempt.
        //
        // Bounded at one: the second pass sees a released slot by construction,
        // and retrying a state that did not change is a spin, not a fix.
        if (redriveDepth > 0) {
          writeServerLog('WARN', 'wrkq.kicker.claim_redrive_exhausted', {
            targetSessionRef,
            wakeReason,
            driveAttemptId: attempt.driveAttemptId,
          })
          return
        }
        await driveMailTargetOnce(server, targetSessionRef, wakeReason, redriveDepth + 1)
        return
      }
      if (observation !== 'dispatch') {
        await declineForInFlightAttempt(
          server,
          targetSessionRef,
          attempt,
          session,
          actionable,
          wakeReason,
          { via: 'claim', observation }
        )
        return
      }
    } else {
      try {
        await server.options.hrcMailKickerAfterClaim?.(attempt)
      } catch (error) {
        const message = errorText(error)
        const attemptState = failDriveAfterThrow(server, attempt, message)
        writeServerLog('WARN', 'wrkq.kicker.after_claim_failed', {
          targetSessionRef,
          driveAttemptId: attempt.driveAttemptId,
          runId: attempt.runId,
          attemptState,
          error: message,
        })
        return
      }
    }
  }

  // T-07671: the drive is now committed — the slot is held and this daemon owns
  // it. Every later outcome (presented, dispatched, no-op, failed) carries the
  // same `driveAttemptId`, so this line is the head of a timeline that
  // `grep <scope>` reconstructs without opening `state.sqlite`. It is emitted
  // for a re-driven pre-existing attempt as well as a fresh claim, because the
  // question it answers — "did this daemon start driving this mail at all" —
  // is the same one in both shapes.
  writeServerLog('INFO', 'wrkq.kicker.drive_claimed', {
    targetSessionRef,
    driveAttemptId: attempt.driveAttemptId,
    runId: attempt.runId,
    wakeReason,
    envelopeIds: actionable.map((item) => item.envelope.id),
    // Whether a seat already existed, and what it was doing. A drive that has
    // to summon first behaves nothing like one into a live seat, and the two
    // were previously indistinguishable in the log.
    seated: session !== undefined,
    ...(session === undefined ? {} : { activeRunId: activeRunIdFor(server, session) }),
  })

  try {
    // T-07206: session intent is reusable authority because fresh broker starts
    // commit it only after controller.start succeeds; rejected candidates never
    // outrank the drive's own materialization intent here.
    const materializationIntent = session?.lastAppliedIntentJson ?? attempt.materializationIntent
    if (materializationIntent === undefined) {
      // Placement is HRC's, so a missing intent means this node could not find
      // the target agent's profile — not that the sender forgot something.
      //
      // The attempt must be FINISHED, not merely annotated. `recordError` alone
      // leaves it `claimed`, and a claimed attempt owns the scope's slot: the
      // target is then permanently undrivable by this daemon, silently, for as
      // long as the row exists. Observed live — a smoketest scope this node
      // cannot place held its slot for 80 minutes.
      const reason = `no runtime intent for ${targetSessionRef}: this node cannot resolve the agent's placement`
      server.db.mailDrives.failWithoutStart(attempt.driveAttemptId, reason)
      writeServerLog('WARN', 'wrkq.kicker.placement_unresolvable', {
        targetSessionRef,
        driveAttemptId: attempt.driveAttemptId,
        wakeReason,
      })
      return
    }

    if (session === undefined) {
      // This is the only message-traffic provisioning path. ensureTargetSession
      // enters the normal summon/placement gate before it mints anything, so a
      // scope this node does not home is refused here rather than pre-filtered.
      session = await server.ensureTargetSession(
        targetSessionRef,
        materializationIntent,
        undefined,
        'local',
        // The drive carries this candidate explicitly until dispatch succeeds.
        // A rejected cold birth must leave no never-materialized session authority.
        { persistIntent: false }
      )
    }
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: session.hostSessionId,
      generation: session.generation,
    })

    // The local receipt is written FIRST, then the ledger is told with the same
    // attempt id. A kill in between replays into an exactly-once `present`.
    const envelopeIds = server.db.mailDrives.presentForAttempt(
      attempt.driveAttemptId,
      actionable.map((item) => item.envelope.id)
    )
    if (envelopeIds.length === 0) {
      server.db.mailDrives.completeNoOp(attempt.driveAttemptId)
      // T-07671: an attempt that ends here wrote no receipts and dispatched no
      // turn. Silent, it is indistinguishable from a kicker that never ran.
      writeServerLog('WARN', 'wrkq.kicker.drive_no_op', {
        targetSessionRef,
        driveAttemptId: attempt.driveAttemptId,
        runId: attempt.runId,
        wakeReason,
        reason: 'already_presented',
        envelopeIds: actionable.map((item) => item.envelope.id),
        note: 'this attempt had already recorded its presentations; no turn dispatched',
      })
      return
    }

    const runtimeId = presentationRuntimeIdFor(server, session)
    const byId = new Map(actionable.map((item) => [item.envelope.id, item]))
    const ordered = envelopeIds
      .map((id) => byId.get(id))
      .filter((item): item is ActionableEnvelope => item !== undefined)
    const presentables = await recordPresentations(server, ordered, attempt, session, runtimeId)
    const prompt = formatEnvelopePresentations(presentables)
    server.db.mailDrives.recordPresentation(attempt.driveAttemptId, prompt, presentables.length)
    server.db.mailDrives.recordAutoReplyCandidate(
      attempt.driveAttemptId,
      autoReplyCandidateFor(ordered.map((item) => item.envelope))
    )
    attempt = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt

    const response = await server.dispatchTurnForSession(
      session,
      session.lastAppliedIntentJson ?? materializationIntent,
      attempt.prompt,
      {
        runId: attempt.runId,
        waitForCompletion: false,
        submissionDoor: 'enqueue',
        ttlMs: KICKER_SUBMISSION_TTL_MS,
        submissionOrigin: {
          principalRef: ordered[0]?.envelope.from.principalRef ?? 'system:hrc-kicker',
          ...(ordered[0]?.envelope.from.scopeRef === undefined
            ? {}
            : { scopeRef: ordered[0].envelope.from.scopeRef }),
          ...(ordered[0] === undefined ? {} : { envelopeId: ordered[0].envelope.id }),
        },
        // An idle seat has nothing to preempt; even a stored hold starts by enqueue.
      }
    )
    const body = (await response.json()) as DispatchTurnResponse & {
      inputId?: string | undefined
    }
    const inputId = body.inputId ?? server.db.runs.getByRunId(body.runId)?.dispatchedInputId
    // T-07693: `inputId` is optional on the receipt contract — "when the
    // delivery class has one" — and a COLD birth's class has none: the prompt
    // rides the runtime's `initialPrompt`, so there is no invocation input to
    // name. Requiring one here booked every cold ledger-tail birth as
    // `drive_failed` (15 of 15 in the live log, all `wakeReason:"insert"`),
    // which released the drive slot and left the envelope pending for the next
    // wake to redeliver — the second wake that then raced the birth (T-07688).
    // A started turn is a started turn; only the STATUS is load-bearing.
    if (body.status !== 'started') {
      throw new Error(`mail dispatch did not start a turn (status=${body.status})`)
    }
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      runtimeId: body.runtimeId,
    })
    writeServerLog('INFO', 'wrkq.kicker.turn_dispatched', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      presentedCount: presentables.length,
      // T-07671: WHICH envelopes rode this turn, and WHERE it landed. A count
      // cannot answer "was EN-00823 delivered", and without the seat identity
      // the dispatch cannot be joined to the ledger's own receipt.
      envelopeIds: presentables.map((presentable) => presentable.envelope.id),
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      inputId,
      wakeReason,
    })
    const committedRuntimeId = body.runtimeId ?? runtimeId
    await commitPresentations(server, presentables, attempt, session, committedRuntimeId, inputId)
    // The reminder is bound to the attempt that carried it: D5 reads this row
    // back when that attempt's own turn ends, and it is what stops a second
    // reminder ever being armed for the same (envelope, runtime).
    for (const item of ordered) {
      if (item.reminder === undefined) continue
      server.db.mailDrives.markReminderDelivered(
        item.reminder.envelopeId,
        item.reminder.runtimeId,
        attempt.driveAttemptId
      )
    }
    // T-07671: this line belongs at COMMIT, where the ledger now holds the
    // receipt. `inputId` joins it to the broker's input.accepted event.
    writeServerLog('INFO', 'wrkq.kicker.presented', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      inputId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      ...(committedRuntimeId === undefined ? {} : { runtimeId: committedRuntimeId }),
      envelopes: presentables.map((presentable) => ({
        id: presentable.envelope.id,
        obligation: presentable.envelope.obligation,
        form: presentable.form ?? 'full',
      })),
    })
    observeAttempt(server, attempt)
  } catch (error) {
    // A birth deferral is not a failed drive. It is this node correctly
    // declining to take a birth the collective designated elsewhere, and
    // reporting it as `drive_failed` is precisely what made the pre-T-07655
    // race look like breakage on every node that lost it.
    const deferral = birthDeferralFor(error)
    if (deferral !== undefined && scopeRef !== undefined) {
      deferBirthForTarget(server, targetSessionRef, scopeRef, attempt, deferral, wakeReason)
      return
    }
    const message = errorText(error)
    const attemptState = failDriveAfterThrow(server, attempt, message)
    writeServerLog('WARN', 'wrkq.kicker.drive_failed', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      wakeReason,
      attemptState,
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
      queueMicrotask(() => {
        void this.drainMailKickerTarget(targetSessionRef).catch((error: unknown) => {
          writeServerLog('WARN', 'wrkq.kicker.rekick_failed', {
            targetSessionRef,
            error: errorText(error),
          })
        })
      })
    }
  })
  this.mailKickerTargetOperations.set(targetSessionRef, operation)
  return operation
}

/**
 * The periodic sweep: the correctness backstop behind the ledger tail.
 *
 * Its candidate set is deliberately NARROW — the scopes this node is currently
 * seating, plus any drive attempt still in flight. It keeps one bounded
 * `pendingView` per sweep instead of a query that grows with every scope the
 * daemon has ever seen. Discovering a scope with no live seat is the TAIL's
 * job: it resumes from a persisted cursor, so an envelope written while HRC was
 * down is replayed rather than swept for.
 *
 * That division of labour holds for a RESTART and ONLY for a restart. A
 * first-ever start has no cursor to resume from and the tail starts at the
 * ledger's END, so nothing here and nothing there can see an envelope that was
 * already pending — the seated set does not contain the scope, and the tail has
 * jumped past its `envelope.created`. The one-time cold-start catch-up below
 * (`runMailKickerColdStartCatchup`, T-07643) closes exactly that case; this
 * comment previously asserted a backstop that did not exist in it.
 *
 * The candidate set gained a THIRD source in T-07661: the virgin births this
 * node owes. Both of the sources above key on a scope this node already HAS —
 * a seat or an attempt — and a virgin scope whose one insert wake ended in a
 * refusal has neither, so it had no second chance at all until unrelated later
 * traffic re-woke the kicker. See `unbornBirthWakeCandidates`.
 */
export function runMailKickerSweep(this: HrcServerInstanceForHandlers): Promise<void> {
  if (!this.hrcMailKickerEnabled || this.stopping) return Promise.resolve()
  if (this.mailKickerSweepInFlight !== undefined) return this.mailKickerSweepInFlight

  const sweep = (async () => {
    // rev 5.1 D3 backstop. Ahead of the delivery sweep on purpose: an
    // obligation that has already lapsed should be failed before the same tick
    // reads the wake set, so the sender's notice and the reader's next
    // presentation cannot cross.
    await sweepLapsedObligations(this)
    const now = new Date().toISOString()
    const targets = new Set<string>(this.db.mailDrives.listInFlightTargets())
    // Two rev 5.1 candidate sources that key on nothing in the ledger: a due
    // D4 reminder, and a §5 notice waiting for its sender's next attend.
    // Neither shows up as pending mail, so without these a scope whose only
    // outstanding business is one of them is never woken at all.
    for (const target of this.db.mailDrives.listDueReminderTargets(now)) targets.add(target)
    for (const target of this.db.mailDrives.listFailureNoticeTargets()) targets.add(target)
    const seated = this.db.runtimes.listLiveSessionRefs()
    const unborn = await unbornBirthWakeCandidates(this, seated)
    for (const batch of chunk([...seated, ...unborn], LEDGER_SWEEP_SCOPE_BATCH)) {
      try {
        // includeFyi here too: a seated addressee should be shown a fyi on the
        // next sweep, which is §5's "otherwise on X's next attend".
        const view = await this.wrkqLedger.pendingView({ scopes: batch, includeFyi: true })
        if (view.repended > 0) {
          writeServerLog('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
        }
        collectPendingTargets(view.items, targets)
      } catch (error) {
        writeServerLog(
          error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
          'wrkq.kicker.sweep_pending_view_failed',
          { scopes: batch.length, error: errorText(error) }
        )
        break
      }
    }
    chargeBirthSweepRetries(this, unborn, targets)
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

/**
 * The VIRGIN BIRTHS this node owes, as sweep candidates (T-07661).
 *
 * THE GAP. The kicker's two wake sources both need the scope to exist already.
 * The ledger tail is an INSERT wake consumed once — after it, the cursor is
 * past that `envelope.created` forever — and the sweep's candidate sources are
 * the scopes this node seats and the attempts it holds. A virgin scope whose
 * one insert wake ended in a refusal (a registry 503, a designated home that
 * was momentarily unreachable, a capability failure, or the wire-enum bug that
 * actually produced T-07658) is in none of them, so nothing ever tried again.
 * The obligation stayed visible in the ledger the whole time — nothing was
 * lost — but delivery waited on unrelated traffic arriving. On T-07658 that
 * took 21 minutes and a daemon restart.
 *
 * TWO SOURCES, because the designation has two classes and they are discovered
 * from opposite ends:
 *
 *  - DESIGNATED. The registry host holds a live designation naming this node,
 *    for a scope it has never established. That is the collective's own record
 *    of a birth this node owes, and it is authoritative: a node asks only about
 *    ITSELF, so this can never make a non-designated node claim a scope. It
 *    also covers the case no local record can — a designated node that never
 *    saw the insert at all, because it was down when the wake fired.
 *
 *  - `none` CLASS. A sender that names no scope (a human) designates NOTHING,
 *    and tier 5 stays local on every node — the pre-T-07655 law, explicitly out
 *    of that task's scope. There is no designation row to read, so the only
 *    record is this node's own refused drive attempt.
 *
 * WHAT IT MUST NOT DO is re-introduce the multi-node birth race. It does not:
 * the designated source is scoped to the asking node by the host, and the
 * `none` source only re-attempts what this node already attempted once from the
 * insert wake — the same already-arbitrated tier-5 CAS, at a sixtieth of the
 * rate. Scopes this node has been told are designated ELSEWHERE are dropped
 * here rather than re-driven into a deferral it has already announced, and the
 * T-07650 foreign-home filter still runs ahead of every claim regardless.
 *
 * A ledger or registry failure yields the candidates it could resolve and logs;
 * it never takes the ordinary sweep down with it.
 */
async function unbornBirthWakeCandidates(
  server: HrcServerInstanceForHandlers,
  seated: readonly string[]
): Promise<string[]> {
  const seatedSet = new Set(seated)
  const candidates = new Set<string>()

  for (const targetSessionRef of await designatedUnbornTargets(server)) {
    if (!seatedSet.has(targetSessionRef)) candidates.add(targetSessionRef)
  }
  for (const targetSessionRef of refusedBirthTargets(server)) {
    if (!seatedSet.has(targetSessionRef)) candidates.add(targetSessionRef)
  }

  // A scope that has left the candidate set has been born (or bound elsewhere),
  // so its retry bound is spent state. Pruned here rather than on the birth
  // itself because this is the one place that sees the whole set.
  for (const targetSessionRef of server.mailKickerBirthSweepBackoff.keys()) {
    if (!candidates.has(targetSessionRef)) {
      server.mailKickerBirthSweepBackoff.delete(targetSessionRef)
    }
  }

  const now = Date.now()
  return [...candidates].filter(
    (targetSessionRef) =>
      (server.mailKickerBirthSweepBackoff.get(targetSessionRef)?.nextAtMs ?? 0) <= now
  )
}

/** Live designations naming this node whose scope the registry has never bound. */
async function designatedUnbornTargets(server: HrcServerInstanceForHandlers): Promise<string[]> {
  const list = server.federationRegistryClient?.listUnbornDesignations
  if (list === undefined) return []
  let designations: readonly { scopeRef: string }[]
  try {
    designations = await list.call(server.federationRegistryClient, server.federationNodeId)
  } catch (error) {
    // An unreachable registry is not evidence that this node owes no births.
    // It is a reason to try again on the next sweep, and never a reason to
    // widen the local half to compensate.
    writeServerLog('WARN', 'wrkq.kicker.unborn_designations_failed', {
      nodeId: server.federationNodeId,
      error: errorText(error),
    })
    return []
  }
  const targets: string[] = []
  for (const designation of designations) {
    const sessionRef = targetSessionRefForLedgerScope(designation.scopeRef)
    if (sessionRef !== undefined) targets.push(sessionRef)
  }
  return targets
}

/**
 * Scopes this node refused a birth for, from its own drive-attempt rows.
 *
 * Filtered against the two records that say the scope is no longer this node's
 * to birth: a local placement-ledger row (it was established, here or by a
 * rebind onto here) and a birth deferral this node has already announced (the
 * collective designated it elsewhere, and re-driving it would buy one more
 * refusal per sweep and nothing else).
 */
function refusedBirthTargets(server: HrcServerInstanceForHandlers): string[] {
  const ledger = createPlacementLedgerRepository(server.db.sqlite)
  const targets: string[] = []
  for (const targetSessionRef of server.db.mailDrives.listRefusedBirthTargets()) {
    const scopeRef = kickerScopeRefFor(targetSessionRef)
    if (scopeRef === undefined) continue
    if (ledger.get(scopeRef) !== undefined) continue
    if (server.mailKickerBirthDeferredAnnounced.has(scopeRef)) continue
    targets.push(targetSessionRef)
  }
  return targets
}

/**
 * Charge one retry against every unborn candidate the sweep is about to drive,
 * and give up on the fifth (rev 5.1 D7).
 *
 * Charged on the ENQUEUE and not on the outcome, deliberately. A birth is
 * asynchronous and its failure modes are many; keying the bound on "we tried"
 * needs no outcome plumbing, and the success case clears itself — a born scope
 * leaves the candidate set, which prunes its entry. Candidates the ledger
 * reported no pending mail for are not charged: they cost nothing but a slot in
 * a batched read, and holding them off for sixteen minutes would delay the
 * scope's real birth when its mail does arrive.
 *
 * Under rev 4 the bound FLATTENED at five and retried forever at sixteen-minute
 * intervals. rev 5.1 ends it instead: the fifth refusal fails every pending
 * envelope for that target `undeliverable` and tells the sender, which is a
 * decision someone can act on rather than a spin nobody is watching.
 */
function chargeBirthSweepRetries(
  server: HrcServerInstanceForHandlers,
  unborn: readonly string[],
  driving: ReadonlySet<string>
): void {
  const now = Date.now()
  for (const targetSessionRef of unborn) {
    if (!driving.has(targetSessionRef)) continue
    const attempts = (server.mailKickerBirthSweepBackoff.get(targetSessionRef)?.attempts ?? 0) + 1
    if (attempts >= BIRTH_SWEEP_MAX_REFUSALS) {
      server.mailKickerBirthSweepBackoff.delete(targetSessionRef)
      void failUndeliverableMail(server, targetSessionRef, attempts).catch((error: unknown) => {
        writeServerLog('WARN', 'wrkq.kicker.undeliverable_failed', {
          targetSessionRef,
          error: errorText(error),
        })
      })
      continue
    }
    server.mailKickerBirthSweepBackoff.set(targetSessionRef, {
      attempts,
      nextAtMs: now + BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    })
    writeServerLog('INFO', 'wrkq.kicker.unborn_birth_retry', {
      targetSessionRef,
      attempt: attempts,
      nextAttemptInMs: BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    })
  }
}

/**
 * rev 5.1 D7 — this node cannot seat the addressee, and has stopped trying.
 *
 * Only a `pending` envelope is failed: `undeliverable` means the body was never
 * pushed at all, and wrkqd enforces that on its side too. Anything already
 * presented belongs to D3/D5 and is not this bound's to end.
 */
async function failUndeliverableMail(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  refusals: number
): Promise<void> {
  const view = await server.wrkqLedger.pendingView({ scopes: [targetSessionRef] })
  for (const envelope of view.items) {
    if (envelope.state !== 'pending') continue
    if (envelope.presentedTo.length > 0) continue
    writeServerLog('WARN', 'wrkq.kicker.birth_refusals_exhausted', {
      targetSessionRef,
      envelope: envelope.id,
      refusals,
    })
    await failEnvelope(server, { envelope: envelope.id, reason: 'undeliverable', targetSessionRef })
  }
}

/**
 * rev 5.1 D3 — a runtime that terminated holding an obligation fails it.
 *
 * The predicate is *R is no longer live*, read off the runtime STATUS column;
 * the four terminal event kinds are only the wake. That distinction is the
 * whole of D3's robustness: `terminated`, `crashed`, `dead` and `stale` are
 * written by four different mechanisms (user exit, abnormal broker terminal,
 * the reaper twice over), and a rule keyed on one event name would silently
 * miss the other three.
 *
 * Returns whether the observation COMPLETED, so a caller can memoize a runtime
 * as swept without memoizing a ledger outage as an answer.
 */
async function failLapsedObligations(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  runtimeIds: ReadonlySet<string>
): Promise<boolean> {
  let view: WrkqEnvelopePendingView
  try {
    view = await server.wrkqLedger.pendingView({ scopes: [targetSessionRef], includeFyi: true })
  } catch (error) {
    writeServerLog(
      error instanceof WrkqLedgerUnavailableError ? 'WARN' : 'ERROR',
      'wrkq.kicker.lapse_pending_view_failed',
      { targetSessionRef, error: errorText(error) }
    )
    return false
  }
  let complete = true
  for (const envelope of view.items) {
    if (envelope.state !== 'presented') continue
    const runtime = newestPresentationReceipt(envelope)?.runtimeId
    if (runtime === undefined || !runtimeIds.has(runtime)) continue
    try {
      await failEnvelope(server, {
        envelope: envelope.id,
        reason: 'runtime_terminated',
        runtime,
        targetSessionRef,
      })
    } catch (error) {
      writeServerLog('WARN', 'wrkq.kicker.lapse_failed', {
        targetSessionRef,
        envelope: envelope.id,
        runtimeId: runtime,
        error: errorText(error),
      })
      complete = false
    }
  }
  return complete
}

/**
 * The D3 backstop: every locally-known runtime that has since gone terminal.
 *
 * The wake path below catches the ordinary case within a second of the event.
 * This exists because a wake is a claim and a status column is a fact — a
 * daemon that was down when the runtime died, a reaper reclassification that
 * fanned out no event, a `--force` restart that orphaned a broker: none of
 * those reach the observer, and all of them leave the same row behind.
 *
 * Memoized per runtime per process. Nothing can be presented TO a dead runtime,
 * so one complete observation per runtime is the whole job; a restart re-scans
 * the lookback window, and the ledger's own idempotence absorbs the overlap.
 */
async function sweepLapsedObligations(server: HrcServerInstanceForHandlers): Promise<void> {
  const since = new Date(Date.now() - LAPSE_SWEEP_LOOKBACK_MS).toISOString()
  const byTarget = new Map<string, Set<string>>()
  for (const bound of server.db.mailDrives.listRuntimeBoundTargets(since)) {
    if (server.mailKickerLapsedRuntimes.has(bound.runtimeId)) continue
    const runtime = server.db.runtimes.getByRuntimeId(bound.runtimeId) ?? undefined
    if (runtime === undefined || !isRuntimeTerminal(runtime.status)) continue
    const runtimes = byTarget.get(bound.targetSessionRef) ?? new Set<string>()
    runtimes.add(bound.runtimeId)
    byTarget.set(bound.targetSessionRef, runtimes)
  }
  for (const [targetSessionRef, runtimeIds] of byTarget) {
    if (await failLapsedObligations(server, targetSessionRef, runtimeIds)) {
      for (const runtimeId of runtimeIds) server.mailKickerLapsedRuntimes.add(runtimeId)
    }
  }
}

/**
 * §5 — hand this scope the failure notices it is owed, as a sender.
 *
 * fyi-class: rendered from the ledger row, carrying no envelope and creating no
 * obligation. It rides the scope's LIVE GENERATION and nothing else — no live
 * seat means the notices simply stay queued for the next attend, because a
 * failure notice must never be the reason a session is born. That is why the
 * gate is `presentationRuntimeIdFor` (a current-generation seat) rather than
 * "a session row exists": a session whose runtime is gone would otherwise have
 * a dispatch provision one.
 */
async function deliverFailureNotices(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  session: HrcSessionRecord
): Promise<void> {
  const notices = server.db.mailDrives.listUndeliveredFailureNotices(targetSessionRef)
  if (notices.length === 0) return
  if (presentationRuntimeIdFor(server, session) === undefined) return
  const intent =
    session.lastAppliedIntentJson ??
    buildKickRuntimeIntent(parseSessionRef(targetSessionRef).scopeRef, undefined)
  if (intent === undefined) return
  const prompt = notices.map((notice) => notice.notice).join('\n\n')
  try {
    const response = await server.dispatchTurnForSession(session, intent, prompt, {
      waitForCompletion: false,
      submissionDoor: 'enqueue',
      ttlMs: KICKER_SUBMISSION_TTL_MS,
      submissionOrigin: { principalRef: 'system:hrc-kicker', scopeRef: session.scopeRef },
    })
    const body = (await response.json()) as DispatchTurnResponse
    if (body.status !== 'started') {
      throw new Error(`failure notice did not start (status=${body.status})`)
    }
    server.db.mailDrives.markFailureNoticesDelivered(
      targetSessionRef,
      notices.map((notice) => notice.envelopeId)
    )
    writeServerLog('INFO', 'wrkq.kicker.failure_notice_delivered', {
      targetSessionRef,
      runId: body.runId,
      envelopes: notices.map((notice) => notice.envelopeId),
    })
  } catch (error) {
    // Nothing is marked delivered, so the next attend tries again. A notice
    // that could not be shown is not a notice that stops being owed.
    writeServerLog('WARN', 'wrkq.kicker.failure_notice_failed', {
      targetSessionRef,
      envelopes: notices.map((notice) => notice.envelopeId),
      error: errorText(error),
    })
  }
}

/**
 * §5 — queue the sender-side notice for one `envelope.failed` off the tail.
 *
 * Rendered by reading the ROW back, not from the event payload: the real
 * payload carries `{state, reason, room_uuid, runtime_id}` and neither party
 * nor the room key (paired against wrkqd at wrkq 88b133a). The envelope id is
 * on the event row itself.
 *
 * Only a sender this node homes or seats is served. A notice is delivered by
 * exactly one daemon — the sender's own — and a human sender is served by the
 * ACP surfaces instead (§11), never by a summon here.
 */
async function queueFailureNotice(
  server: HrcServerInstanceForHandlers,
  event: WrkqMonitorEvent
): Promise<void> {
  const envelopeId = event.resourceId
  if (envelopeId === undefined) return
  const reason = failureReasonFor(event.payload)
  if (reason === undefined) return
  const envelope = await server.wrkqLedger.envelopeShow({ envelope: envelopeId })
  const senderScope = envelope.from.scopeRef
  if (senderScope === undefined) return
  const targetSessionRef = targetSessionRefForLedgerScope(senderScope)
  if (targetSessionRef === undefined) return
  // The placement ledger is keyed on the CANONICAL scope, not on the handle
  // wrkq stores. Handing it the handle throws rather than missing, which is how
  // one un-normalized read took the whole notice path down.
  const canonicalScope = kickerScopeRefFor(targetSessionRef)
  const placement =
    canonicalScope === undefined
      ? undefined
      : createPlacementLedgerRepository(server.db.sqlite).get(canonicalScope)
  const homed = placement?.state === 'active' && placement.homeNodeId === server.federationNodeId
  if (!homed && findTargetSession(server.db, targetSessionRef) === null) return
  const runtimeId = failedPayload(event.payload)?.runtime_id
  const notice = formatEnvelopeFailureNotice(envelope, reason, {
    ...(runtimeId === undefined ? {} : { runtimeId }),
  })
  if (!server.db.mailDrives.recordFailureNotice({ envelopeId, targetSessionRef, notice })) return
  writeServerLog('INFO', 'wrkq.kicker.failure_notice_queued', {
    targetSessionRef,
    envelope: envelopeId,
    reason,
  })
  server.requestMailKickerWake(targetSessionRef, 'insert')
}

function failedPayload(raw: string | undefined): WrkqEnvelopeFailedPayload | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? (parsed as WrkqEnvelopeFailedPayload) : undefined
}

const FAILURE_REASONS = new Set<WrkqEnvelopeFailureReason>([
  'runtime_terminated',
  'ignored',
  'undeliverable',
  'legacy',
])

function failureReasonFor(raw: string | undefined): WrkqEnvelopeFailureReason | undefined {
  const reason = failedPayload(raw)?.reason
  if (reason === undefined) return undefined
  return FAILURE_REASONS.has(reason as WrkqEnvelopeFailureReason)
    ? (reason as WrkqEnvelopeFailureReason)
    : undefined
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

/** The drive targets a `pendingView` page names, added to an existing set. */
function collectPendingTargets(items: readonly WrkqEnvelope[], targets: Set<string>): void {
  for (const envelope of items) {
    const scopeRef = envelope.to?.scopeRef
    if (scopeRef === undefined) continue
    const sessionRef = targetSessionRefForLedgerScope(scopeRef)
    if (sessionRef !== undefined) targets.add(sessionRef)
  }
}

/**
 * Every scope this node HOMES, seated or not.
 *
 * The placement ledger is the daemon's own record of the bindings it holds
 * authority for, so it is the only local answer to "which addressees are mine"
 * that does not require a live seat. It is read here rather than kept on the
 * instance because the catch-up runs once per process and a stale snapshot
 * would be worse than a query.
 *
 * A scope no node has ever homed has no row anywhere, and is not this node's to
 * deliver to: an envelope to one still rides the tail's `envelope.created` into
 * the summon gate, which is where a first birth belongs.
 */
function homedTargetSessionRefs(server: HrcServerInstanceForHandlers): string[] {
  const refs = new Set<string>()
  for (const record of createPlacementLedgerRepository(server.db.sqlite).list()) {
    if (record.state !== 'active') continue
    if (record.homeNodeId !== server.federationNodeId) continue
    const sessionRef = targetSessionRefForLedgerScope(record.scopeRef)
    if (sessionRef !== undefined) refs.add(sessionRef)
  }
  return [...refs]
}

/**
 * The one-time cold-start catch-up (T-07643).
 *
 * A first-ever start persists its cursor at the ledger's END — replaying the
 * whole log would re-drive every historical envelope — and the periodic sweep
 * only looks at seated scopes. So on that one start, an envelope that was
 * ALREADY pending against a scope this node homes but is not currently seating
 * is invisible to both halves of the wake routing, and nothing ever delivers
 * it. It stays `pending` with an empty `presentedTo` indefinitely: not dead,
 * not floored, not logged. That is what happened on svc and lab at the T-07616
 * flag day, where an envelope was rescued only because unrelated later traffic
 * to the same scope swept it up.
 *
 * The fix is one widened sweep, run once, over the placement-ledger scopes this
 * node homes. It is not the periodic sweep's job: the sweep runs every thirty
 * ticks forever, and a query that grows with every scope the daemon has ever
 * bound is a load problem when it is not a one-off.
 *
 * THROWS on a ledger failure, deliberately. A catch-up that silently did not
 * happen is the same silent gap it exists to close, so the caller keeps the
 * intent armed and retries on the next tick instead.
 *
 * It DISCOVERS; it does not deliver. Each target is handed to the ordinary wake
 * path and the catch-up returns, because awaiting a cold summon per target
 * would hold the tail — the one-second wake path — for as long as the slowest
 * birth on the node takes.
 */
async function runMailKickerColdStartCatchup(server: HrcServerInstanceForHandlers): Promise<void> {
  const homed = homedTargetSessionRefs(server)
  const targets = new Set<string>()
  for (const batch of chunk(homed, LEDGER_SWEEP_SCOPE_BATCH)) {
    const view = await server.wrkqLedger.pendingView({ scopes: batch, includeFyi: true })
    if (view.repended > 0) {
      writeServerLog('INFO', 'wrkq.kicker.deferrals_repended', { repended: view.repended })
    }
    collectPendingTargets(view.items, targets)
  }
  writeServerLog('INFO', 'wrkq.kicker.cold_start_catchup', {
    homedScopes: homed.length,
    targets: [...targets],
  })
  for (const targetSessionRef of targets) {
    server.requestMailKickerWake(targetSessionRef, 'recovery')
  }
}

/**
 * Follow wrkq's event ledger for `envelope.created`, from a PERSISTED cursor.
 *
 * Always explicit: a read with no cursor replays the whole log (T-07620). The
 * first tail on a virgin store resolves "now" from row identity via `lastN`
 * rather than by arithmetic on a high-water mark — and then hands to the
 * one-time cold-start catch-up, because starting at "now" is exactly what makes
 * an already-pending envelope unreachable (T-07643).
 */
export async function runWrkqLedgerTail(this: HrcServerInstanceForHandlers): Promise<void> {
  if (!this.hrcMailKickerEnabled || this.stopping) return
  if (this.wrkqLedgerTailInFlight !== undefined) return this.wrkqLedgerTailInFlight

  const tail = (async () => {
    try {
      let cursor = this.db.wrkqLedgerCursors.get()
      if (cursor === undefined) {
        cursor = this.db.wrkqLedgerCursors.advance(await resolveTailStartCursor(this))
        // Armed BEFORE the catch-up runs and cleared only when one completes,
        // so a wrkq outage on the first tick costs a retry rather than the
        // whole backlog: the cursor is already persisted and this condition
        // will never be true again in this store.
        this.mailKickerColdStartCatchupPending = true
        writeServerLog('INFO', 'wrkq.kicker.tail_started', { cursor })
      }
      if (this.mailKickerColdStartCatchupPending) {
        await runMailKickerColdStartCatchup(this)
        this.mailKickerColdStartCatchupPending = false
      }
      const page = await this.wrkqLedger.eventsView({
        cursor,
        // `envelope.failed` rides the SAME cursor as `envelope.created` (§5).
        // It is not a wake — nothing is owed to the addressee any more — it is
        // how the SENDER learns, and it reaches senders on other nodes for
        // free because every node tails the one ledger.
        eventTypes: ['envelope.created', 'envelope.failed'],
        limit: LEDGER_TAIL_PAGE_LIMIT,
      })
      // Resolved lazily and once per page: a fyi wakes only a target this node
      // is currently seating, and the tail must not pay a runtimes query on
      // every empty tick.
      let seated: Set<string> | undefined
      for (const event of page.items) {
        if (event.eventType === 'envelope.failed') {
          await queueFailureNotice(this, event).catch((error: unknown) => {
            writeServerLog('WARN', 'wrkq.kicker.failure_notice_queue_failed', {
              envelope: event.resourceId,
              error: errorText(error),
            })
          })
          continue
        }
        seated ??= new Set(this.db.runtimes.listLiveSessionRefs())
        const target = wakeTargetForEvent(event, seated)
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
 *
 * An empty ledger was the ONLY case that covered, and a first start against a
 * non-empty one is the common case, not the rare one — every already-pending
 * envelope sits before this cursor. What makes those reachable is the
 * cold-start catch-up the caller runs immediately after persisting this mark,
 * never this function widening its start.
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
 * `reply_required` and `notify` both wake (T-07746), seated or not: they summon.
 * A `fyi` never summons — an unseated addressee is not born for it — but it IS
 * injected into a seated addressee (the `wrkc say --fyi` contract), and before
 * this branch the only path to that injection was the thirty-tick sweep, so a
 * fyi to an idle seat landed up to thirty seconds after it was sent (observed
 * at 29s on mable@hcs:primary, 2026-09-02 12:03Z). The drain path already
 * refuses to birth on a fyi-only wake set, so waking a seated target here costs
 * nothing new; the seated check exists only so the tail does not wake the
 * drain for scopes nothing can be presented into. A scope-less addressee (a
 * human principal) is never kicked either — ACP presents those.
 */
function wakeTargetForEvent(
  event: WrkqMonitorEvent,
  seatedSessionRefs: ReadonlySet<string>
): string | undefined {
  if (event.eventType !== 'envelope.created' || event.payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(event.payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const payload = parsed as WrkqEnvelopeCreatedPayload
  const scopeRef = payload.to_scope_ref
  if (typeof scopeRef !== 'string') return undefined
  const target = targetSessionRefForLedgerScope(scopeRef)
  if (target === undefined) return undefined
  if (obligationSummons(payload.obligation)) return target
  return seatedSessionRefs.has(target) ? target : undefined
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
  if (RUNTIME_TERMINAL_EVENTS.has(event.eventKind)) {
    // rev 5.1 D3. The EVENT is the wake and the STATUS column is the authority,
    // so this re-reads the row rather than trusting the name it arrived under —
    // a `runtime.stale` that the reaper has since walked back is not a lapse.
    const runtimeId = event.runtimeId
    if (runtimeId === undefined) return
    if (this.mailKickerLapsedRuntimes.has(runtimeId)) return
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId) ?? undefined
    if (runtime === undefined || !isRuntimeTerminal(runtime.status)) return
    const targetSessionRef = formatSessionRef(event.scopeRef, event.laneRef)
    void failLapsedObligations(this, targetSessionRef, new Set([runtimeId]))
      .then((complete) => {
        if (complete) this.mailKickerLapsedRuntimes.add(runtimeId)
      })
      .catch((error: unknown) => {
        writeServerLog('WARN', 'wrkq.kicker.lapse_wake_failed', {
          targetSessionRef,
          runtimeId,
          error: errorText(error),
        })
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
