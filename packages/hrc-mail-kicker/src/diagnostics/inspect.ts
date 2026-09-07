/**
 * "What happened to EN-xxxxx on the HRC side?" — answered by one read (§6).
 *
 * Before this existed the answer required joining four sources by hand: the
 * wrkq envelope row, `hrc-server.err.log`, several tables in `state.sqlite`,
 * and the broker ledger. A sender who cannot do that has no way to tell a reply
 * that is still coming from one that will never come, and on 2026-09-03 the
 * difference went unnoticed for an hour.
 *
 * The join is deliberately split in two so the caller owns the I/O: the store
 * side is synchronous and pure, the ledger side is a map the caller fills. That
 * keeps the whole verdict machine testable against a seeded store with no wrkq
 * anywhere near it, and it lets the CLI degrade to an HRC-only answer when the
 * ledger cannot be reached rather than failing the command.
 *
 * T-08094 re-pointed the HRC half from drive attempts to the two records that
 * replaced them. The questions are the same and now have shorter answers: an
 * OPEN INTENT is a delivery in flight, a PRESENTATION is a body that landed,
 * and a stranded obligation is a presentation nothing disposed.
 */
import type { HrcDatabase, HrcMailDeliveryIntent, HrcMailPresentation } from 'hrc-store-sqlite'
import type { HrcMailFailureNotice } from 'hrc-store-sqlite'

import { STALLED_DELIVERY_THRESHOLD_MS } from '../internal.js'
import { targetSessionRefForLedgerScope } from '../ledger/scope.js'
import { newestPresentationReceipt } from '../ledger/types.js'
import type { WrkqEnvelope } from '../ledger/types.js'
import { isRuntimeTerminal } from '../terminal/runtime-status.js'

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

/** One landed presentation, with the runtime status that explains it. */
export type MailInspectPresentation = {
  presentation: HrcMailPresentation
  runtimeStatus?: string | undefined
}

export type MailInspectEvent = {
  at: string
  kind: string
  detail: string
}

/**
 * What the join concluded. `stranded` is the one the command exists for: a
 * presented obligation whose newest receipt named a runtime that has since gone
 * quiet, with nothing armed and nothing failed behind it.
 */
export type MailInspectVerdictCode =
  | 'stranded'
  | 'stalled_delivery'
  | 'uncertain_delivery'
  | 'terminal_delivery_hold'
  | 'awaiting_landing'
  | 'reminder_armed'
  | 'reminder_delivered'
  | 'discharged'
  | 'failed'
  | 'awaiting_delivery'
  | 'no_hrc_record'
  | 'ledger_unavailable'

export type MailInspectEnvelope = {
  envelopeId: string
  ledger?: WrkqEnvelope | undefined
  ledgerError?: string | undefined
  presentations: MailInspectPresentation[]
  intent?: HrcMailDeliveryIntent | undefined
  failureNotices: HrcMailFailureNotice[]
  timeline: MailInspectEvent[]
  verdict: { code: MailInspectVerdictCode; line: string }
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
  // Newest first, then trimmed: a long-lived scope has thousands of receipts and
  // the question is always about recent traffic. The two reads differ in their
  // own order — the target query is already newest-first in SQL, the runtime one
  // is oldest-first — so normalize here rather than reversing one blindly.
  const presentations =
    query.kind === 'runtime'
      ? [...db.mailDelivery.presentationsForRuntime(query.runtimeId)].reverse()
      : db.mailDelivery.presentationsForTarget(query.targetSessionRef, SCOPE_QUERY_ENVELOPE_LIMIT)
  const ids: string[] = []
  const seen = new Set<string>()
  for (const presentation of presentations) {
    if (seen.has(presentation.envelopeId)) continue
    seen.add(presentation.envelopeId)
    ids.push(presentation.envelopeId)
    if (ids.length >= SCOPE_QUERY_ENVELOPE_LIMIT) break
  }
  // An envelope whose delivery is still in flight has no presentation yet, and
  // it is precisely the one an operator asks about. Open intents therefore ride
  // the same query rather than being invisible until they land.
  if (query.kind === 'scope') {
    for (const intent of db.mailDelivery.listOpenIntents(query.targetSessionRef)) {
      if (seen.has(intent.envelopeId)) continue
      seen.add(intent.envelopeId)
      ids.unshift(intent.envelopeId)
    }
  }
  return ids.slice(0, SCOPE_QUERY_ENVELOPE_LIMIT)
}

function presentationsFor(db: HrcDatabase, envelopeId: string): MailInspectPresentation[] {
  return db.mailDelivery.presentationsForEnvelope(envelopeId).map((presentation) => ({
    presentation,
    ...(() => {
      const runtime = db.runtimes.getByRuntimeId(presentation.runtimeId) ?? undefined
      return runtime === undefined ? {} : { runtimeStatus: runtime.status }
    })(),
  }))
}

function buildTimeline(
  envelope: WrkqEnvelope | undefined,
  presentations: readonly MailInspectPresentation[],
  intent: HrcMailDeliveryIntent | undefined,
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
  if (intent !== undefined) {
    events.push({
      at: intent.submittedAt,
      kind: 'delivery.intent',
      detail: `door=${intent.door} form=${intent.form} runtime=${
        intent.runtimeId ?? '(none)'
      } submission=${intent.submissionId ?? '(pending)'} id=${intent.presentationId}`,
    })
    if (intent.uncertainAt !== undefined) {
      events.push({
        at: intent.uncertainAt,
        kind: 'delivery.uncertain',
        detail: `${intent.uncertainCause ?? 'unknown'} evidence=${intent.lastEvidenceKind ?? 'unknown'}`,
      })
    }
    if (intent.terminalEnvelopeAt !== undefined) {
      events.push({
        at: intent.terminalEnvelopeAt,
        kind: 'delivery.terminal_hold',
        detail: `${intent.terminalEnvelopeCause ?? 'unknown'} cleanup=${intent.cleanupOutcome ?? 'unattempted'}`,
      })
    }
  }
  for (const entry of presentations) {
    const row = entry.presentation
    events.push({
      at: row.landedAt,
      kind: 'presentation.landed',
      detail: `${row.presentationId} landed on ${row.runtimeId} as ${row.deliveryOutcome} (seq ${row.landingHrcSeq})`,
    })
    if (row.reminderArmedAt !== undefined) {
      events.push({
        at: row.reminderArmedAt,
        kind: 'reminder.armed',
        detail: `runtime=${row.runtimeId} remindAt=${row.reminderDueAt ?? '(retired)'}`,
      })
    }
    if (row.reminderLandedAt !== undefined) {
      events.push({
        at: row.reminderLandedAt,
        kind: 'reminder.delivered',
        detail: `runtime=${row.runtimeId} seq=${row.reminderLandingHrcSeq ?? 'unknown'}`,
      })
    }
    if (row.disposedAt !== undefined) {
      events.push({
        at: row.disposedAt,
        kind: 'presentation.disposed',
        detail: `${row.disposition ?? 'unknown'} on ${row.runtimeId}`,
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

/** The presentation the ledger currently regards as authoritative. */
function owningPresentation(
  envelope: WrkqEnvelope | undefined,
  presentations: readonly MailInspectPresentation[]
): MailInspectPresentation | undefined {
  const newest = envelope === undefined ? undefined : newestPresentationReceipt(envelope)
  if (newest?.runtimeId !== undefined) {
    const match = presentations.find((entry) => entry.presentation.runtimeId === newest.runtimeId)
    if (match !== undefined) return match
  }
  return presentations.at(-1)
}

/**
 * One line that says what became of the obligation, and why.
 *
 * The ledger's own state is the trunk of the decision — HRC never overrules it
 * — and the local rows only explain a `presented` that is not moving.
 */
function verdictFor(
  row: MailInspectLedgerRow | undefined,
  presentations: readonly MailInspectPresentation[],
  intent: HrcMailDeliveryIntent | undefined,
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
  if (intent !== undefined) {
    if (intent.terminalEnvelopeAt !== undefined) {
      return {
        code: 'terminal_delivery_hold',
        line: `terminal_delivery_hold: ${intent.terminalEnvelopeCause ?? 'terminal'}; cleanup=${
          intent.cleanupOutcome ?? 'unattempted'
        }; no receipt or reinjection`,
      }
    }
    if (intent.uncertainAt !== undefined) {
      return {
        code: 'uncertain_delivery',
        line: `uncertain_delivery: ${intent.uncertainCause ?? 'possible write'}; fence retained for ${
          intent.submissionId ?? '(unidentified submission)'
        }`,
      }
    }
    // A submission is admitted and no landing fact has arrived. Below the
    // threshold that is an ordinary in-flight delivery; past it, the evidence
    // is not coming and the reconcile will redeliver once at TTL.
    const ageMs = Date.now() - (Date.parse(intent.submittedAt) || Date.now())
    if (ageMs > STALLED_DELIVERY_THRESHOLD_MS) {
      return {
        code: 'stalled_delivery',
        line: `stalled_delivery: ${intent.door} submission ${
          intent.submissionId ?? '(no id)'
        } admitted ${Math.round(ageMs / 60_000)}m ago with no landing fact`,
      }
    }
    return {
      code: 'awaiting_landing',
      line: `awaiting_landing: ${intent.door} submission ${
        intent.submissionId ?? '(no id)'
      } admitted ${clock(intent.submittedAt)}, no landing fact yet`,
    }
  }
  if (envelope.state !== 'presented') {
    return {
      code: 'awaiting_delivery',
      line: `awaiting_delivery: envelope ${envelope.state}, ${presentations.length} local presentation(s)`,
    }
  }

  const owner = owningPresentation(envelope, presentations)
  if (owner === undefined) {
    return {
      code: 'no_hrc_record',
      line: 'no_hrc_record: envelope presented, but this node holds no presentation record for it',
    }
  }
  const record = owner.presentation
  if (record.reminderLandedAt !== undefined) {
    return {
      code: 'reminder_delivered',
      line: `reminder_delivered: reminder landed ${clock(record.reminderLandedAt)}, envelope still presented`,
    }
  }
  if (record.reminderArmedAt !== undefined) {
    return {
      code: 'reminder_armed',
      line: `reminder_armed: reminder due ${clock(record.reminderDueAt)}, envelope still presented`,
    }
  }
  // A LIVE runtime is not a strand: D3 disposes what it is holding at that
  // runtime's next turn terminal, and calling that stranded would fire on every
  // healthy in-flight obligation on the node. A runtime that has gone terminal
  // is the real one — the lapse path should have failed it and did not.
  if (owner.runtimeStatus !== undefined && !isRuntimeTerminal(owner.runtimeStatus)) {
    return {
      code: 'awaiting_delivery',
      line: `awaiting_delivery: presented to ${record.runtimeId} (${owner.runtimeStatus}) ${clock(
        record.landedAt
      )}; disposal follows that runtime's next turn terminal`,
    }
  }
  return {
    code: 'stranded',
    line: `stranded: presented to ${record.runtimeId} ${clock(
      record.landedAt
    )}, envelope presented, no reminder, no reply`,
  }
}

/** Join the HRC rows for these envelopes with the ledger rows the caller read. */
export function buildMailInspection(
  db: HrcDatabase,
  query: MailInspectQuery,
  envelopeIds: readonly string[],
  ledgerRows: ReadonlyMap<string, MailInspectLedgerRow>
): MailInspection {
  return {
    query,
    generatedAt: new Date().toISOString(),
    envelopes: envelopeIds.map((envelopeId) => {
      const presentations = presentationsFor(db, envelopeId)
      const intent = db.mailDelivery.getIntent(envelopeId)
      const notices = db.mailDelivery.failureNoticesForEnvelope(envelopeId)
      const row = ledgerRows.get(envelopeId)
      const ledger = row?.ok === true ? row.envelope : undefined
      return {
        envelopeId,
        ...(ledger === undefined ? {} : { ledger }),
        ...(row !== undefined && !row.ok ? { ledgerError: row.error } : {}),
        presentations,
        ...(intent === undefined ? {} : { intent }),
        failureNotices: notices,
        timeline: buildTimeline(ledger, presentations, intent, notices),
        verdict: verdictFor(row, presentations, intent, notices),
      }
    }),
  }
}
