import { randomUUID } from 'node:crypto'

import { HrcDomainError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcSessionRecord,
} from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type {
  HrcMailDriveAttempt,
  HrcMailDriveAttemptState,
  HrcMailDriveWakeReason,
} from 'hrc-store-sqlite'

import type { ForeignHome } from './federation/home-authority.js'
import { homeAuthorityDeps, resolveForeignHome } from './federation/home-authority.js'
import { formatSessionRef } from './messages.js'
import { parseSessionRef } from './server-parsers.js'

import { isRunActive, isRuntimeUnavailableStatus } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRecord } from './server-parsers.js'
import { findTargetSession } from './target-view.js'
import {
  type PresentableEnvelope,
  formatEnvelopePresentations,
} from './wrkq/envelope-presentation.js'
import { buildKickRuntimeIntent } from './wrkq/kick-intent.js'
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
 * The floor between re-presentations of a still-undisposed envelope, doubling
 * per round: 1m, 2m, 4m, 8m, 16m — so exhausting the bound takes at least 31
 * minutes of wall clock (mable's erratum on T-07612 §6, ruled on T-07615).
 *
 * Without it the bound counts TURNS, not time, and a target whose turns end in
 * seconds burns all five rounds in under a minute: EN-00040 dead-lettered 40
 * seconds after it was written, while its addressee had done nothing wrong.
 * The round semantics are unchanged and there is still no maximum age.
 */
const REDELIVERY_FLOOR_BASE_MS = 60_000
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
/**
 * How far the virgin-birth retry bound doubles before it flattens (T-07661).
 *
 * Five rounds is the redelivery floor's own shape — 1m, 2m, 4m, 8m, 16m — and
 * it is reused rather than reinvented so a refused birth and an undisposed
 * presentation age at the same rate. It FLATTENS rather than expiring: an
 * obligation does not stop being owed because its birth is hard, and a
 * sixteen-minute retry is not a spin.
 */
const BIRTH_SWEEP_MAX_BACKOFF_ROUNDS = 5

type AttemptObservation = 'dispatch' | 'waiting' | 'finished'

/**
 * How an in-flight attempt was discovered.
 *
 * `active-attempt` is the ordinary path: the slot was already held when the
 * wake arrived. `claim` is the RACE: two wakes for one scope, where
 * `getActiveAttempt` saw nothing and the claim CAS then reported the slot
 * already active. Both decline for the same reason, so both must decline the
 * same way — steer an urgent envelope, and say so.
 */
type InFlightDeclineRoute = 'active-attempt' | 'claim'

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

/** The run a session is currently busy on, for the busy-decline log line. */
function activeRunIdFor(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): string | undefined {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId !== undefined) return runtime.activeRunId
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
  const now = Date.now()
  const actionable: WrkqEnvelope[] = []
  const floored: { envelope: string; remainingMs: number }[] = []
  for (const envelope of view.items) {
    const remainingMs = redeliveryFloorRemainingMs(envelope, now)
    if (remainingMs > 0) {
      floored.push({ envelope: envelope.id, remainingMs })
      continue
    }
    actionable.push(envelope)
  }
  if (floored.length > 0) {
    // A skip that only shows up as "the claim came back clear" is a proxy for
    // the thing, not the thing. This says which envelope was held and for how
    // much longer, so the floor is observable rather than inferred.
    writeServerLog('INFO', 'wrkq.kicker.redelivery_floored', {
      targetSessionRef,
      floored,
    })
  }
  return actionable.slice(0, MAX_PRESENTED_PER_ATTEMPT)
}

/**
 * How much longer this envelope is held by its redelivery floor, or 0.
 *
 * Only a PRESENTED envelope can be held: one that has never been shown has
 * nothing to wait from, and neither does one with no receipt to measure from.
 */
function redeliveryFloorRemainingMs(envelope: WrkqEnvelope, now: number): number {
  if (envelope.state !== 'presented') return 0
  const lastPresentedAt = envelope.presentedTo.reduce<number>((newest, receipt) => {
    const at = Date.parse(receipt.presentedAt)
    return Number.isNaN(at) ? newest : Math.max(newest, at)
  }, 0)
  if (lastPresentedAt === 0) return 0
  const floorMs = REDELIVERY_FLOOR_BASE_MS * 2 ** Math.max(envelope.roundCount, 0)
  return Math.max(floorMs - (now - lastPresentedAt), 0)
}

/** Only a `reply_required` obligation is worth a turn, let alone a birth (§5). */
function summonsATurn(envelope: WrkqEnvelope): boolean {
  return envelope.obligation === 'reply_required'
}

/**
 * The birth directive block the ledger carried, if any envelope carried one.
 *
 * wrkq stores it VERBATIM (`+node=svc`) and never parses it — that vocabulary
 * is HRC's. It is a string, not an intent: the intent is assembled at kick time
 * from the target agent's own profile on this node.
 */
function actionableDirectives(envelopes: readonly WrkqEnvelope[]): string | undefined {
  for (const envelope of envelopes) {
    const raw = envelope.materializationIntent?.trim()
    if (raw !== undefined && raw.length > 0) return raw
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
      ...(result.lastMessageAt === undefined ? {} : { lastMessageAt: result.lastMessageAt }),
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

/**
 * T-07616 — actuate `--urgent` instead of declining on a busy target.
 *
 * Spec §5 always said HRC actuates urgent as "steer-or-fail-typed"; nothing
 * read the flag, so an urgent envelope queued behind a long turn exactly like
 * an ordinary one and the documented lever did nothing. Ruled by mable on
 * T-07616: route it through the ratified T-07203 r7 steer classes unchanged.
 *
 * Three properties this path must hold, each the resolution of a named ruling:
 *
 * - SUCCESS IS ANY HONEST CLASS. `admitted_into_active_turn` (actuator proved
 *   turn admission), `presented_to_live_harness` (tmux: only a pane write is
 *   provable, and that is still an honest success) and `started_fresh_turn`
 *   (the target went idle underneath us) all count. Only a state where none of
 *   them can be proven is a failure, and it is never downgraded into a queue.
 *
 * - A STEER DOES NOT ADVANCE THE REDELIVERY BOUND. `roundEnded` is deliberately
 *   NOT called here: rounds measure "shown by a kicker-driven turn and then
 *   ignored", and a mid-turn steer is the weakest possible evidence that anyone
 *   read it. It writes a `presented_to` receipt and nothing else.
 *
 * - ONCE PER ACTIVE RUN. Because rounds never advance, the ordinary floor would
 *   re-steer the same envelope every 60s forever while it stays undisposed. An
 *   envelope already steered into THIS run is skipped, so the target is
 *   interrupted at most once per turn for a given envelope; when that turn
 *   ends, the ordinary kicker-driven path takes over and does advance rounds.
 */
async function steerUrgentIntoBusyTarget(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  session: HrcSessionRecord,
  actionable: readonly WrkqEnvelope[],
  wakeReason: HrcMailDriveWakeReason
): Promise<boolean> {
  const activeRunId = activeRunIdFor(server, session)
  const urgent = actionable.filter(
    (envelope) =>
      envelope.urgent &&
      // Already interrupted this turn with this envelope: saying it twice into
      // one turn is noise, not urgency.
      !envelope.presentedTo.some((receipt) => receipt.runId === activeRunId)
  )
  if (urgent.length === 0) return false

  // Same intent resolution the drive path uses: the session's applied intent
  // when it has one, otherwise built from the target agent's own profile on
  // this node. A steer never mints a session — the target is live by
  // construction — so this only has to be good enough to dispatch with.
  const intent =
    session.lastAppliedIntentJson ??
    buildKickRuntimeIntent(parseSessionRef(targetSessionRef).scopeRef, actionableDirectives(urgent))
  if (intent === undefined) {
    // No intent to dispatch with. Honest decline, not a silent skip.
    writeServerLog('WARN', 'wrkq.kicker.urgent_steer_unavailable', {
      targetSessionRef,
      wakeReason,
      reason: 'no_runtime_intent_available',
      envelopes: urgent.map((envelope) => envelope.id),
    })
    return false
  }

  const driveAttemptId = `steer-${randomUUID()}`
  // Rendered WITHOUT the history cue: the cue is wrkq's decision and only a
  // RECORDING `present` yields it, and a receipt written before a steer that
  // then fails typed would put a presentation in the collaboration ledger that
  // never happened. The cue is the one line an agent can always replace with
  // `wrkc log`; a false receipt is not recoverable.
  const presentables: PresentableEnvelope[] = []
  for (const envelope of urgent) {
    presentables.push({
      envelope,
      historyHint: false,
      messageCount: 0,
      ...(await roomSubjectFor(server, envelope)),
      ...senderGenerationFor(server, envelope),
    })
  }

  let delivery: DispatchTurnResponse['delivery']
  let steeredRunId: string | undefined
  try {
    const response = await server.dispatchTurnForSession(
      session,
      intent,
      formatEnvelopePresentations(presentables),
      { whenBusy: 'steer', waitForCompletion: false }
    )
    const body = (await response.json()) as DispatchTurnResponse
    delivery = body.delivery
    steeredRunId =
      delivery?.code === 'admitted_into_active_turn'
        ? delivery.mergedIntoRunId
        : delivery?.code === 'presented_to_live_harness'
          ? delivery.presentedDuringRunId
          : body.runId
  } catch (error) {
    // Typed failure: nothing honest can be claimed, so nothing is recorded and
    // the envelope stays exactly as pending as it was. NOT a downgrade to the
    // queue — the queue is simply where it already was.
    writeServerLog('WARN', 'wrkq.kicker.urgent_steer_failed', {
      targetSessionRef,
      wakeReason,
      driveAttemptId,
      activeRunId,
      envelopes: urgent.map((envelope) => envelope.id),
      error: errorText(error),
    })
    return false
  }

  if (delivery === undefined) {
    writeServerLog('WARN', 'wrkq.kicker.urgent_steer_failed', {
      targetSessionRef,
      wakeReason,
      driveAttemptId,
      activeRunId,
      envelopes: urgent.map((envelope) => envelope.id),
      error: 'dispatch returned no delivery outcome',
    })
    return false
  }

  const runtimeId = presentationRuntimeIdFor(server, session)
  for (const envelope of urgent) {
    await server.wrkqLedger.present({
      envelope: envelope.id,
      node: server.federationNodeId,
      hostSessionId: session.hostSessionId,
      generation: String(session.generation),
      driveAttemptId,
      // The outcome CLASS goes on the RECEIPT, not only on the log line below
      // (C-16526, ruled again on T-07644 C-16658). A log line rotates and is
      // grepped from one node; the receipt is the durable record of how this
      // delivery landed, readable by anyone holding the envelope. It is written
      // only here, so a receipt carrying it is by construction a steer.
      deliveryOutcome: delivery.code,
      ...(steeredRunId === undefined ? {} : { runId: steeredRunId }),
      ...(runtimeId === undefined ? {} : { runtimeId }),
    })
  }

  writeServerLog('INFO', 'wrkq.kicker.urgent_steered', {
    targetSessionRef,
    wakeReason,
    driveAttemptId,
    // The outcome CLASS is the whole point of the T-07203 contract: it says
    // what was actually proven, not merely that something was sent.
    outcome: delivery.code,
    runId: steeredRunId,
    envelopes: urgent.map((envelope) => envelope.id),
  })
  return true
}

/**
 * The scope's drive slot is held by a kicker attempt that has not finished yet
 * (T-07644).
 *
 * Ordinary mail waits here, and should: the turn-completion wake picks it up,
 * and claiming a second slot for a scope already mid-drive would double-drive
 * it. An URGENT envelope does NOT wait. Before this, the `waiting` observation
 * was a bare `return` placed ABOVE the steer — which lives at the bottom of
 * `if (attempt === undefined)` — so `--urgent` was unreachable in precisely the
 * shape it was built for: a worker mid-turn on kicker-driven work. It was
 * reachable only for a seat busy on a turn the kicker did not start, which is
 * also why testing the feature against any visibly-busy seat passes while the
 * defect ships.
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
  actionable: readonly WrkqEnvelope[],
  wakeReason: HrcMailDriveWakeReason,
  route: { via: InFlightDeclineRoute; observation: AttemptObservation }
): Promise<void> {
  // No session means the drive that owns the slot has not reached one yet;
  // there is no live turn to steer into, so the decline is all there is.
  const steered =
    session === undefined
      ? false
      : await steerUrgentIntoBusyTarget(server, targetSessionRef, session, actionable, wakeReason)
  writeServerLog('INFO', 'wrkq.kicker.drive_in_flight', {
    ...(steered ? { urgentSteered: true } : {}),
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
 * seat is a rebind's decision (`rebind.ts` already enumerates the scope's live
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
          `${scopeRef} is homed on ${foreign.homeNodeId} (epoch ${foreign.placementEpoch}); this node has no authority to drive it`
        ).driveAttemptId
      : undefined

  // Announcement is deduped on its OWN map, not on the resolver's memo. The
  // memo is shared with the shadow teardown, and whichever mechanism happened
  // to resolve the scope first would otherwise silence this line for the other.
  const announcement = `${foreign.homeNodeId}@${foreign.placementEpoch}`
  const alreadyAnnounced = server.mailKickerForeignHomeAnnounced.get(scopeRef) === announcement
  server.mailKickerForeignHomeAnnounced.set(scopeRef, announcement)
  if (alreadyAnnounced && failedAttemptId === undefined) return

  writeServerLog('INFO', 'wrkq.kicker.foreign_home_skipped', {
    targetSessionRef,
    scopeRef,
    homeNodeId: foreign.homeNodeId,
    placementEpoch: foreign.placementEpoch,
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
    if (session !== undefined && targetHasRunningTurn(server, session)) {
      // An urgent envelope does not wait for the turn to end (T-07616): it
      // steers into the live turn through the ratified steer classes, or fails
      // typed and stays pending. Everything else falls through to the decline.
      const steered = await steerUrgentIntoBusyTarget(
        server,
        targetSessionRef,
        session,
        actionable,
        wakeReason
      )
      // Not a failure: a busy target keeps its obligation until its own turn
      // ends, and the turn-completion wake picks it up. Logged because a
      // SILENT decline is indistinguishable from a dead kicker — which is
      // exactly the conclusion two readers reached from its absence.
      writeServerLog('INFO', 'wrkq.kicker.target_busy', {
        ...(steered ? { urgentSteered: true } : {}),
        targetSessionRef,
        wakeReason,
        pending: actionable.length,
        activeRunId: activeRunIdFor(server, session),
      })
      return
    }
    // A fyi is presented into a live generation if there is one, and otherwise
    // waits. It is NEVER the reason a session is born (§5), so a wake set that
    // holds nothing else stops here rather than at the summon gate.
    if (session === undefined && !actionable.some(summonsATurn)) return
    const directives = actionableDirectives(actionable)
    const claim = server.db.mailDrives.claim(targetSessionRef, wakeReason, {
      envelopeIds: actionable.map((envelope) => envelope.id),
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

  try {
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

    const runtimeId = presentationRuntimeIdFor(server, session)
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
    if (!presentables.some((presentable) => summonsATurn(presentable.envelope))) {
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
    const targets = new Set<string>(this.db.mailDrives.listInFlightTargets())
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
 * Charge one retry against every unborn candidate the sweep is about to drive.
 *
 * Charged on the ENQUEUE and not on the outcome, deliberately. A birth is
 * asynchronous and its failure modes are many; keying the bound on "we tried"
 * needs no outcome plumbing, and the success case clears itself — a born scope
 * leaves the candidate set, which prunes its entry. Candidates the ledger
 * reported no pending mail for are not charged: they cost nothing but a slot in
 * a batched read, and holding them off for sixteen minutes would delay the
 * scope's real birth when its mail does arrive.
 */
function chargeBirthSweepRetries(
  server: HrcServerInstanceForHandlers,
  unborn: readonly string[],
  driving: ReadonlySet<string>
): void {
  const now = Date.now()
  for (const targetSessionRef of unborn) {
    if (!driving.has(targetSessionRef)) continue
    const attempts = Math.min(
      (server.mailKickerBirthSweepBackoff.get(targetSessionRef)?.attempts ?? 0) + 1,
      BIRTH_SWEEP_MAX_BACKOFF_ROUNDS
    )
    server.mailKickerBirthSweepBackoff.set(targetSessionRef, {
      attempts,
      nextAtMs: now + REDELIVERY_FLOOR_BASE_MS * 2 ** (attempts - 1),
    })
    writeServerLog('INFO', 'wrkq.kicker.unborn_birth_retry', {
      targetSessionRef,
      attempt: attempts,
      nextAttemptInMs: REDELIVERY_FLOOR_BASE_MS * 2 ** (attempts - 1),
    })
  }
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
