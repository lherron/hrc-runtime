/**
 * "What happened to EN-xxxxx on the HRC side?" — answered by one read (§6).
 *
 * Before this existed the answer required joining four sources by hand: the
 * wrkq envelope row, `hrc-server.err.log`, five tables in `state.sqlite`, and
 * the broker ledger. A sender who cannot do that has no way to tell a reply
 * that is still coming from one that will never come, and on 2026-09-03 the
 * difference went unnoticed for an hour.
 *
 * The join is deliberately split in two so the caller owns the I/O: the store
 * side is synchronous and pure, the ledger side is a map the caller fills. That
 * keeps the whole verdict machine testable against a seeded store with no wrkq
 * anywhere near it, and it lets the CLI degrade to an HRC-only answer when the
 * ledger cannot be reached rather than failing the command.
 */
import type { HrcDatabase, HrcMailAutoReplyIntent } from 'hrc-store-sqlite'
import type {
  HrcMailDriveAttempt,
  HrcMailEnvelopeReminder,
  HrcMailFailureNotice,
} from 'hrc-store-sqlite'

import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import { newestPresentationReceipt } from '../ledger/types.js'
import type { WrkqEnvelope } from '../ledger/types.js'

/** Newest envelopes a scope/runtime query will report on. */
const SCOPE_QUERY_ENVELOPE_LIMIT = 50

export type MailInspectQuery =
  | { kind: 'envelope'; envelopeId: string }
  | { kind: 'scope'; targetSessionRef: string }
  | { kind: 'runtime'; runtimeId: string }

/** The ledger row for one envelope, or the reason there isn't one. */
export type MailInspectLedgerRow =
  | { ok: true; envelope: WrkqEnvelope }
  | { ok: false; error: string }

export type MailInspectRun = {
  runId: string
  status: string
  dispatchedInputId?: string | undefined
  acceptedAt?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type MailInspectAttempt = {
  attempt: HrcMailDriveAttempt
  presentedAt: string
  run?: MailInspectRun | undefined
  runtimeStatus?: string | undefined
  autoReplyIntent?: HrcMailAutoReplyIntent | undefined
  /**
   * What this attempt's turn would have replied — the ONE server-owned response
   * projection, not a second reader (T-07969). Present only when the attempt has
   * a run that produced text, so an inspection of a stranded obligation shows the
   * answer that never got minted.
   */
  canonicalResponse?: string | undefined
}

export type MailInspectEvent = {
  at: string
  kind: string
  detail: string
}

/**
 * What the join concluded. `stranded` is the one the command exists for: a
 * presented obligation whose newest receipt belongs to an attempt that has
 * already ended, with nothing armed and nothing minted behind it.
 */
export type MailInspectVerdictCode =
  | 'stranded'
  | 'awaiting_turn'
  | 'reminder_armed'
  | 'reminder_delivered'
  | 'auto_reply_pending'
  | 'discharged'
  | 'failed'
  | 'awaiting_delivery'
  | 'no_hrc_record'
  | 'ledger_unavailable'

export type MailInspectEnvelope = {
  envelopeId: string
  ledger?: WrkqEnvelope | undefined
  ledgerError?: string | undefined
  attempts: MailInspectAttempt[]
  reminders: HrcMailEnvelopeReminder[]
  failureNotices: HrcMailFailureNotice[]
  timeline: MailInspectEvent[]
  verdict: { code: MailInspectVerdictCode; line: string }
}

/**
 * The canonical response reader, supplied by the caller exactly as `ledgerRows`
 * is. Keeping it a parameter rather than an import is what lets this builder
 * stay synchronous and testable with no server in the process, while still
 * reading the single body authority rather than growing a second one.
 */
export type MailInspectTurnResponseProjector = (runId: string) => {
  body: string
  truncated: boolean
}

export type MailInspection = {
  query: MailInspectQuery
  generatedAt: string
  envelopes: MailInspectEnvelope[]
}

const ENVELOPE_ID = /^EN-\d+$/i
const RUNTIME_ID = /^rt-[0-9a-f-]+$/i

/**
 * Decide what the operator typed.
 *
 * The three forms are distinguishable by shape alone — `EN-03687`, `rt-…`, and
 * everything else is an addressee — so nothing here consults the store and a
 * typo produces an empty report rather than the wrong one.
 */
export function resolveMailInspectQuery(target: string): MailInspectQuery {
  const value = target.trim()
  if (ENVELOPE_ID.test(value)) return { kind: 'envelope', envelopeId: value.toUpperCase() }
  if (RUNTIME_ID.test(value)) return { kind: 'runtime', runtimeId: value }
  // An addressee may be typed in either spelling — the wrkq handle an agent
  // uses (`cody@agent-spaces:T-07962`) or HRC's canonical session ref — and the
  // seam that already reconciles the two is the one to reuse.
  const targetSessionRef = targetSessionRefForLedgerScope(value)
  if (targetSessionRef === undefined) {
    throw new Error(
      `unrecognized mail inspect target "${target}": expected EN-xxxxx, an agent handle or session ref, or rt-<id>`
    )
  }
  return { kind: 'scope', targetSessionRef }
}

/** The envelope ids a query covers — what the caller must fetch from the ledger. */
export function mailInspectEnvelopeIds(db: HrcDatabase, query: MailInspectQuery): string[] {
  if (query.kind === 'envelope') return [query.envelopeId]
  const receipts =
    query.kind === 'runtime'
      ? db.mailDrives.presentationsForRuntime(query.runtimeId)
      : db.mailDrives.presentationsForTarget(query.targetSessionRef)
  const ids: string[] = []
  const seen = new Set<string>()
  // Newest first, then trimmed: a long-lived scope has thousands of receipts
  // and the question is always about recent traffic.
  for (const receipt of [...receipts].reverse()) {
    if (seen.has(receipt.envelopeId)) continue
    seen.add(receipt.envelopeId)
    ids.push(receipt.envelopeId)
    if (ids.length >= SCOPE_QUERY_ENVELOPE_LIMIT) break
  }
  return ids
}

function runFor(db: HrcDatabase, runId: string): MailInspectRun | undefined {
  const run = db.runs.getByRunId(runId)
  if (run === null || run === undefined) return undefined
  return {
    runId: run.runId,
    status: run.status,
    updatedAt: run.updatedAt,
    ...(run.dispatchedInputId === undefined ? {} : { dispatchedInputId: run.dispatchedInputId }),
    ...(run.acceptedAt === undefined ? {} : { acceptedAt: run.acceptedAt }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.errorCode === undefined ? {} : { errorCode: String(run.errorCode) }),
    ...(run.errorMessage === undefined ? {} : { errorMessage: run.errorMessage }),
  }
}

function attemptsFor(
  db: HrcDatabase,
  envelopeId: string,
  projectTurnResponse: MailInspectTurnResponseProjector | undefined
): MailInspectAttempt[] {
  return db.mailDrives.attemptsForEnvelope(envelopeId).map((receipt) => {
    const { attempt } = receipt
    const runtime =
      attempt.runtimeId === undefined
        ? undefined
        : (db.runtimes.getByRuntimeId(attempt.runtimeId) ?? undefined)
    const run = runFor(db, attempt.runId)
    const intent = db.mailDrives.getAutoReplyIntent(attempt.driveAttemptId)
    const response =
      projectTurnResponse === undefined || attempt.runId === undefined
        ? undefined
        : projectTurnResponse(attempt.runId).body
    return {
      attempt,
      presentedAt: receipt.presentedAt,
      ...(run === undefined ? {} : { run }),
      ...(runtime === undefined ? {} : { runtimeStatus: runtime.status }),
      ...(intent === undefined ? {} : { autoReplyIntent: intent }),
      ...(response === undefined || response.length === 0 ? {} : { canonicalResponse: response }),
    }
  })
}

function buildTimeline(
  envelope: MailInspectEnvelope['ledger'],
  attempts: readonly MailInspectAttempt[],
  reminders: readonly HrcMailEnvelopeReminder[],
  notices: readonly HrcMailFailureNotice[]
): MailInspectEvent[] {
  const events: MailInspectEvent[] = []
  if (envelope !== undefined) {
    events.push({
      at: envelope.createdAt,
      kind: 'envelope.created',
      detail: `${envelope.from.scopeRef ?? envelope.from.principalRef} -> ${
        envelope.to?.scopeRef ?? envelope.to?.principalRef ?? '(unaddressed)'
      } ${envelope.obligation} in ${envelope.roomKey}`,
    })
  }
  for (const entry of attempts) {
    const { attempt } = entry
    events.push({
      at: attempt.claimedAt,
      kind: 'attempt.claimed',
      detail: `${attempt.driveAttemptId} wake=${attempt.wakeReason} run=${attempt.runId}`,
    })
    events.push({
      at: entry.presentedAt,
      kind: 'presentation',
      detail: `${attempt.driveAttemptId} presented to ${attempt.runtimeId ?? '(no runtime)'}`,
    })
    if (attempt.startedAt !== undefined) {
      events.push({
        at: attempt.startedAt,
        kind: 'attempt.started',
        detail: `${attempt.driveAttemptId} turn started`,
      })
    }
    if (entry.run !== undefined) {
      const run = entry.run
      events.push({
        // `updatedAt` and not `acceptedAt`: a run that failed without ever
        // starting has only the former, and placing it at acceptance would put
        // the failure before the presentation that caused it.
        at: run.completedAt ?? run.updatedAt,
        kind: `run.${run.status}`,
        detail: `${run.runId} dispatchedInputId=${run.dispatchedInputId ?? 'null'}${
          run.errorCode === undefined ? '' : ` errorCode=${run.errorCode}`
        }${run.errorMessage === undefined ? '' : ` (${run.errorMessage})`}`,
      })
    }
    if (attempt.completedAt !== undefined) {
      events.push({
        at: attempt.completedAt,
        kind: `attempt.${attempt.state}`,
        detail: `${attempt.driveAttemptId}${
          attempt.terminalEventKind === undefined ? '' : ` via ${attempt.terminalEventKind}`
        }${attempt.lastError === undefined ? '' : ` (${attempt.lastError})`}`,
      })
    }
    if (entry.autoReplyIntent !== undefined) {
      const intent = entry.autoReplyIntent
      events.push({
        at: intent.terminalAt ?? intent.updatedAt,
        kind: `auto_reply.${intent.state}`,
        detail: `${intent.driveAttemptId} room=${intent.roomKey} to=${intent.counterpartyRef}${
          intent.lastError === undefined ? '' : ` (${intent.lastError})`
        }`,
      })
    }
  }
  for (const reminder of reminders) {
    events.push({
      at: reminder.createdAt,
      kind: 'reminder.armed',
      detail: `runtime=${reminder.runtimeId} remindAt=${reminder.remindAt}`,
    })
    if (reminder.deliveredAt !== undefined) {
      events.push({
        at: reminder.deliveredAt,
        kind: 'reminder.delivered',
        detail: `runtime=${reminder.runtimeId}`,
      })
    }
  }
  for (const notice of notices) {
    events.push({
      at: notice.createdAt,
      kind: 'failure_notice.queued',
      detail: `${notice.targetSessionRef}: ${notice.notice}`,
    })
    if (notice.deliveredAt !== undefined) {
      events.push({
        at: notice.deliveredAt,
        kind: 'failure_notice.delivered',
        detail: notice.targetSessionRef,
      })
    }
  }
  // Parsed, not lexicographic: HRC writes millisecond stamps and wrkq writes
  // second-resolution ones, and `2026-09-03T22:56:50Z` string-sorts AFTER
  // `2026-09-03T22:56:50.706Z` — which put the envelope's own creation below
  // its first presentation in the first cut of this timeline.
  return events.sort((left, right) => {
    const delta = (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0)
    return delta !== 0 ? delta : left.at < right.at ? -1 : left.at > right.at ? 1 : 0
  })
}

function clock(iso: string | undefined): string {
  if (iso === undefined) return 'unknown time'
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return match?.[1] ?? iso
}

/** The attempt whose receipt the ledger currently regards as authoritative. */
function owningAttempt(
  envelope: WrkqEnvelope | undefined,
  attempts: readonly MailInspectAttempt[]
): MailInspectAttempt | undefined {
  const newest = envelope === undefined ? undefined : newestPresentationReceipt(envelope)
  if (newest?.driveAttemptId !== undefined) {
    const match = attempts.find((entry) => entry.attempt.driveAttemptId === newest.driveAttemptId)
    if (match !== undefined) return match
  }
  return attempts.at(-1)
}

function isLive(attempt: HrcMailDriveAttempt): boolean {
  return attempt.state === 'held' || attempt.state === 'claimed' || attempt.state === 'started'
}

/**
 * One line that says what became of the obligation, and why.
 *
 * The ledger's own state is the trunk of the decision — HRC never overrules it
 * — and the local rows only explain a `presented` that is not moving.
 */
function verdictFor(
  row: MailInspectLedgerRow | undefined,
  attempts: readonly MailInspectAttempt[],
  reminders: readonly HrcMailEnvelopeReminder[],
  notices: readonly HrcMailFailureNotice[]
): { code: MailInspectVerdictCode; line: string } {
  if (row === undefined || !row.ok) {
    const reason = row === undefined ? 'not read' : row.error
    return {
      code: 'ledger_unavailable',
      line: `ledger_unavailable: wrkq envelope row could not be read (${reason}); HRC rows below are all that is known`,
    }
  }
  const envelope = row.envelope
  if (envelope.state === 'acked') {
    return { code: 'discharged', line: `discharged: envelope acked ${clock(envelope.updatedAt)}` }
  }
  if (envelope.state === 'failed') {
    return {
      code: 'failed',
      line: `failed: envelope failed ${clock(envelope.updatedAt)} reason=${
        envelope.failureReason ?? 'unknown'
      }${notices.length > 0 ? ', sender notice queued' : ', NO sender notice'}`,
    }
  }
  if (envelope.state !== 'presented') {
    return {
      code: 'awaiting_delivery',
      line: `awaiting_delivery: envelope ${envelope.state}, ${attempts.length} local attempt(s)`,
    }
  }

  const owner = owningAttempt(envelope, attempts)
  if (owner === undefined) {
    return {
      code: 'no_hrc_record',
      line: 'no_hrc_record: envelope presented, but this node holds no drive attempt for it',
    }
  }
  if (isLive(owner.attempt)) {
    return {
      code: 'awaiting_turn',
      line: `awaiting_turn: attempt ${owner.attempt.driveAttemptId} is ${owner.attempt.state}, run ${
        owner.run?.status ?? 'absent'
      }${owner.run?.dispatchedInputId === undefined ? ' with NO dispatched input' : ''}`,
    }
  }

  const pendingIntent = attempts.find((entry) => entry.autoReplyIntent?.state === 'pending')
  if (pendingIntent !== undefined) {
    return {
      code: 'auto_reply_pending',
      line: `auto_reply_pending: reply intent for ${pendingIntent.attempt.driveAttemptId} has not minted yet`,
    }
  }
  const delivered = reminders.find((reminder) => reminder.deliveredAt !== undefined)
  if (delivered !== undefined) {
    return {
      code: 'reminder_delivered',
      line: `reminder_delivered: reminder shown ${clock(delivered.deliveredAt)}, envelope still presented`,
    }
  }
  if (reminders.length > 0) {
    return {
      code: 'reminder_armed',
      line: `reminder_armed: reminder due ${clock(reminders[0]?.remindAt)}, envelope still presented`,
    }
  }
  return {
    code: 'stranded',
    line: `stranded: attempt ${owner.attempt.state} ${clock(
      owner.attempt.completedAt ?? owner.attempt.updatedAt
    )}, envelope presented, no reminder, no reply`,
  }
}

/** Join the HRC rows for these envelopes with the ledger rows the caller read. */
export function buildMailInspection(
  db: HrcDatabase,
  query: MailInspectQuery,
  envelopeIds: readonly string[],
  ledgerRows: ReadonlyMap<string, MailInspectLedgerRow>,
  projectTurnResponse?: MailInspectTurnResponseProjector
): MailInspection {
  return {
    query,
    generatedAt: new Date().toISOString(),
    envelopes: envelopeIds.map((envelopeId) => {
      const attempts = attemptsFor(db, envelopeId, projectTurnResponse)
      const reminders = db.mailDrives.remindersForEnvelope(envelopeId)
      const notices = db.mailDrives.failureNoticesForEnvelope(envelopeId)
      const row = ledgerRows.get(envelopeId)
      const ledger = row?.ok === true ? row.envelope : undefined
      return {
        envelopeId,
        ...(ledger === undefined ? {} : { ledger }),
        ...(row !== undefined && !row.ok ? { ledgerError: row.error } : {}),
        attempts,
        reminders,
        failureNotices: notices,
        timeline: buildTimeline(ledger, attempts, reminders, notices),
        verdict: verdictFor(row, attempts, reminders, notices),
      }
    }),
  }
}
