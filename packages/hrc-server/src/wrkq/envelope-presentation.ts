import { newestPresentationReceipt, obligationOwesReply } from './ledger-types.js'
import type { WrkqEnvelope, WrkqEnvelopeFailureReason } from './ledger-types.js'

/**
 * The rev 5.1 §4 injection formats (T-07612 rev 5.1, T-07702).
 *
 * The header grammar is FIXED across every form, and only its fourth clause
 * varies:
 *
 *   [<room key> · <counterparty> → you · <obligation>[ · <why>]]
 *
 * FULL FORM — the body, pushed once per envelope on the common path:
 *
 *   [T-07604 · cody@hrc-runtime:T-07604 (gen 3) → you · reply required]
 *   history: wrkc log T-07604   (14 messages · last 2h ago)
 *   <body>
 *   reply: wrkc say EN-01165 --to cody@hrc-runtime:T-07604 - <<'EOF'
 *   …
 *   EOF
 *   defer: wrkc defer EN-01165 --reason … [--retry-after 10m]
 *
 * POINTER FORM — every later surface. It carries NO BODY. That is a rule and
 * not a size optimization: the reminder goes to the runtime that already has
 * the body in context, and the defer retry goes to a reader who asked for it
 * back, so in both cases `wrkc show EN-xxxxx` is the read.
 *
 *   [T-07604 · cody@hrc-runtime:T-07604 → you · reply required · still owed — your turn ended 4m ago without a reply or defer]
 *   read: wrkc show EN-01165   ·   thread: wrkc log T-07604
 *   reply: … / defer: …
 *
 * NO ROOM HISTORY IS EVER INJECTED: the cue is a pointer the agent pulls on,
 * which is the whole reason the ledger exists rather than a bigger context
 * window.
 *
 * The envelope's `EN-xxxxx` id was internal under rev 4 and is NOT any more: a
 * pointer form has to name the row the reader is being sent to read, and the
 * `defer:` line has to name the row the reader is being asked to defer. The
 * ROOM KEY is the header's display token, but the reply line addresses the
 * ENVELOPE, not the room key — see formatReplyLine.
 */

/** Body clip. The room holds the full text; the injection is a summons to it. */
const MAX_BODY_CHARS = 4_000
/** The reader's own defer reason, quoted back in the retry header. */
const MAX_DEFER_REASON_CHARS = 120

/**
 * Which of the §4 forms this delivery is.
 *
 * It is decided by the LEDGER ROW and not by the caller's mood: `presented_to`
 * empty is the full form, and everything else is a pointer. The kicker passes
 * the discriminator explicitly because the two pointer variants differ in their
 * `why` clause, and only the kicker knows which one it is delivering.
 */
export type EnvelopePresentationForm = 'full' | 'reminder' | 'defer-retry'

export type PresentableEnvelope = {
  envelope: WrkqEnvelope
  /** wrkq's cue decision, keyed to the RUNTIME rather than the generation. */
  historyHint: boolean
  messageCount: number
  lastMessageAt?: string | undefined
  /**
   * The sender's live generation, when this node homes the sender and can see
   * it. It is HRC's own execution state, not the ledger's -- wrkq stores a
   * generation for the PRESENTATION (the recipient side) and deliberately none
   * for the sender -- so it is omitted rather than guessed when unknown.
   */
  senderGeneration?: number | undefined
  /** Defaults to the full form; see `EnvelopePresentationForm`. */
  form?: EnvelopePresentationForm | undefined
  /**
   * When the turn that left this obligation undisposed ended. It renders the
   * reminder's `why` clause ("your turn ended 4m ago"), and it is HRC's own
   * execution state — the ledger has no idea what a turn is.
   */
  turnEndedAt?: string | undefined
}

/**
 * Render one envelope for injection.
 *
 * `now` is injected so the "last 2h ago" clause is testable; it defaults to the
 * wall clock.
 */
export function formatEnvelopePresentation(
  presentable: PresentableEnvelope,
  now: Date = new Date()
): string {
  const { envelope } = presentable
  const lines = [formatHeader(presentable, now)]
  if (formOf(presentable) === 'full') {
    const history = formatHistoryLine(presentable, now)
    if (history !== undefined) lines.push(history)
    lines.push(clipBody(envelope.body))
  } else {
    lines.push(`read: wrkc show ${envelope.id}   ·   thread: wrkc log ${envelope.roomKey}`)
  }
  const reply = formatReplyLine(envelope)
  if (reply !== undefined) lines.push(reply)
  const defer = formatDeferLine(envelope)
  if (defer !== undefined) lines.push(defer)
  return lines.join('\n')
}

/** Compose the whole injection for one drive attempt. */
export function formatEnvelopePresentations(
  presentables: readonly PresentableEnvelope[],
  now: Date = new Date()
): string {
  return presentables
    .map((presentable) => formatEnvelopePresentation(presentable, now))
    .join('\n\n')
}

/**
 * The §5 sender-side failure notice.
 *
 * It is fyi-class and rendered FROM THE LEDGER ROW: no new envelope is minted,
 * no obligation is created, and nothing is owed back. A system-authored fyi
 * envelope in the room was considered and not chosen — it needs a system
 * principal the grammar does not have.
 *
 * The counterparty clause names the ADDRESSEE, because from the sender's side
 * that is who the obligation was owed by.
 */
export function formatEnvelopeFailureNotice(
  envelope: WrkqEnvelope,
  reason: WrkqEnvelopeFailureReason,
  options: { runtimeId?: string | undefined; now?: Date | undefined } = {}
): string {
  const now = options.now ?? new Date()
  const addressee = addresseeToken(envelope)
  const header = `[${envelope.roomKey} · your ${envelope.id} → ${addressee} · failed: ${reason}]`
  return [header, failureDetail(envelope, reason, addressee, options.runtimeId, now)].join('\n')
}

function failureDetail(
  envelope: WrkqEnvelope,
  reason: WrkqEnvelopeFailureReason,
  addressee: string,
  runtimeId: string | undefined,
  now: Date
): string {
  const resend = `Resend: wrkc say ${envelope.roomKey} --to ${addressee} -`
  const runtime = runtimeId ?? newestPresentationReceipt(envelope)?.runtimeId
  switch (reason) {
    case 'runtime_terminated': {
      const held = presentedForClause(envelope, now)
      const ended = runtime === undefined ? 'its runtime ended' : `runtime ${runtime} ended`
      return `presented${held}, undisposed; ${ended}. ${resend}`
    }
    case 'ignored': {
      const on = runtime === undefined ? '' : ` on ${runtime}`
      return `presented, reminded, 2 turns ended undisposed${on}. Resend or escalate.`
    }
    case 'undeliverable':
      return `never delivered; ${addressee} could not be seated. Resend or escalate.`
    case 'legacy':
      return `ended under the retired round bound. ${resend}`
  }
}

function presentedForClause(envelope: WrkqEnvelope, now: Date): string {
  const newest = newestPresentationReceipt(envelope)
  if (newest === undefined) return ''
  const at = Date.parse(newest.presentedAt)
  if (Number.isNaN(at)) return ''
  return ` ${formatDuration(Math.max(now.getTime() - at, 0))}`
}

function formOf(presentable: PresentableEnvelope): EnvelopePresentationForm {
  return presentable.form ?? 'full'
}

/**
 * The header clauses.
 *
 * Only a `reply_required` envelope carries an obligation clause. A `notify` —
 * the default addressed say since T-07746 — carries NONE: it is an ordinary
 * message that woke you, and there is nothing to designate. The old `fyi`
 * label is gone deliberately; naming a class that owes nothing told the reader
 * about our taxonomy rather than about their mail, and the absence of a
 * "reply required" clause already says everything a reader needs.
 *
 * A legacy `fyi` row renders the same way, for the same reason.
 */
function formatHeader(presentable: PresentableEnvelope, now: Date): string {
  const { envelope } = presentable
  const obligation = obligationOwesReply(envelope.obligation) ? 'reply required' : undefined
  const why = formatWhy(presentable, now)
  const clauses = [
    formatRoomToken(presentable),
    `${formatSender(presentable)} → you`,
    ...(obligation === undefined ? [] : [obligation]),
    ...(why === undefined ? [] : [why]),
  ]
  return `[${clauses.join(' · ')}]`
}

/**
 * The fourth header clause: WHY this surface exists, in the reader's terms.
 *
 * Absent on the full form — the first contact needs no justification — and
 * present on both pointer forms, because a body-less injection that does not
 * say why it arrived reads as noise.
 */
function formatWhy(presentable: PresentableEnvelope, now: Date): string | undefined {
  const form = formOf(presentable)
  if (form === 'full') return undefined
  if (form === 'reminder') {
    const ago = elapsedClause(presentable.turnEndedAt, now)
    return ago === undefined
      ? 'still owed — your turn ended without a reply or defer'
      : `still owed — your turn ended ${ago} ago without a reply or defer`
  }
  const reason = presentable.envelope.deferReason?.trim()
  const ago = elapsedClause(presentable.envelope.retryAt, now)
  const when = ago === undefined ? 'you deferred this' : `you deferred this ${ago} ago`
  if (reason === undefined || reason.length === 0) return when
  return `${when}: "${clip(reason, MAX_DEFER_REASON_CHARS)}"`
}

function elapsedClause(at: string | undefined, now: Date): string | undefined {
  if (at === undefined) return undefined
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return undefined
  return formatElapsed(Math.max(now.getTime() - parsed, 0))
}

/**
 * The room's addressing token, which is its KEY and never its row id.
 *
 * Every kind renders bare: a task room reads `T-07604`, a campaign room reads
 * its path, and an ad-hoc room reads `R-xxxxx`. An R- room is a pair channel
 * rather than a topic, so there is nothing to qualify the key with.
 */
function formatRoomToken(presentable: PresentableEnvelope): string {
  return presentable.envelope.roomKey
}

function formatSender(presentable: PresentableEnvelope): string {
  const scope = presentable.envelope.from.scopeRef
  if (scope === undefined || scope.trim().length === 0) {
    // A scope-less principal is a human: there is no generation to name.
    return formatPrincipalName(presentable.envelope.from.principalRef)
  }
  const handle = formatScopeHandle(scope)
  return presentable.senderGeneration === undefined
    ? handle
    : `${handle} (gen ${presentable.senderGeneration})`
}

function formatHistoryLine(presentable: PresentableEnvelope, now: Date): string | undefined {
  if (!presentable.historyHint) return undefined
  const key = presentable.envelope.roomKey
  const count = presentable.messageCount
  const messages = `${count} ${count === 1 ? 'message' : 'messages'}`
  const last = formatLastMessageClause(presentable.lastMessageAt, now)
  return `history: wrkc log ${key}   (${messages}${last})`
}

function formatLastMessageClause(lastMessage: string | undefined, now: Date): string {
  if (lastMessage === undefined) return ''
  const at = Date.parse(lastMessage)
  if (Number.isNaN(at)) return ''
  const elapsedMs = Math.max(now.getTime() - at, 0)
  return ` · last ${formatElapsed(elapsedMs)} ago`
}

function formatElapsed(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Elapsed WITH seconds, for the failure notice.
 *
 * A lapse is frequently sub-minute — the EN-01165 specimen was presented 61
 * seconds — and rounding that up to "1m" would erase the very thing the notice
 * exists to report: how briefly the obligation was actually held.
 */
function formatDuration(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 90) return `${seconds}s`
  return formatElapsed(elapsedMs)
}

/**
 * The reply line, which is also the ack: saying back into the room with `--to`
 * discharges every presented obligation from that sender (section 6). An `fyi`
 * is auto-acked at its own presentation and therefore carries no reply line.
 *
 * T-07638: it addresses the sender's EXACT scope, never the bare agent name.
 * A bare name resolves against the ROOM, and the room default is not always the
 * sender: in a task room `--to clod` resolves to `clod@<project>:<roomKey>`, so
 * a reply to any other clod-named seat in that room lands on the wrong scope
 * and — because reply-is-ack keys on the counterparty SCOPE — silently fails to
 * ack. Observed live on T-07616 (mable's reply to EN-00078 went to :T-07616).
 *
 * The exact scope is used unconditionally rather than only when it differs from
 * the room default, because deciding "differs" would mean reimplementing wrkq's
 * addressee resolver here. wrkq owns addressing; HRC owns the injection text.
 * Predicting that resolver and getting it wrong reintroduces exactly this bug,
 * in the silent direction.
 */
/**
 * The reply line names the ENVELOPE (`wrkc say EN-xxxxx`), never the room key.
 * A task room's key is a task id, and `wrkc say T-xxxxx` is not a stable
 * selector for that room: wrkq strict-coalesces a task say into the campaign
 * room the moment the task is enrolled (routeToTaskUUID), so a task room minted
 * before enrollment becomes unreachable by its own key. Observed live on
 * T-07731 (2026-08-30): EN-01499 landed in room T-07731 at 13:51, the campaign
 * hcs/build was minted at 13:59, and every hinted `wrkc say T-07731` reply
 * thereafter (EN-01504, EN-01511) landed in hcs/build and never acked. An
 * EN- selector resolves to the envelope's own room with its task tag, in every
 * room kind, so it cannot drift.
 */
function formatReplyLine(envelope: WrkqEnvelope): string | undefined {
  if (envelope.obligation !== 'reply_required') return undefined
  const to = replyAddressee(envelope)
  if (to === undefined) return undefined
  return [`reply: wrkc say ${envelope.id} --to ${to} - <<'EOF'`, '…', 'EOF'].join('\n')
}

/**
 * The defer line (rev 5.1 §4).
 *
 * It rides EVERY reply_required form, first contact included, so the reader
 * learns the verb before the obligation is already late. Not answering now is a
 * verb rather than a silence, and a reader who has never been shown it defaults
 * to the silence.
 */
function formatDeferLine(envelope: WrkqEnvelope): string | undefined {
  if (envelope.obligation !== 'reply_required') return undefined
  return `defer: wrkc defer ${envelope.id} --reason … [--retry-after 10m]`
}

function replyAddressee(envelope: WrkqEnvelope): string | undefined {
  const scope = envelope.from.scopeRef
  if (scope !== undefined && scope.trim().length > 0) return formatScopeHandle(scope)
  // A human is a scope-less principal: `--to lance` is already exact.
  return formatPrincipalName(envelope.from.principalRef)
}

/** The party the obligation was owed BY, as the sender would address them. */
function addresseeToken(envelope: WrkqEnvelope): string {
  const scope = envelope.to?.scopeRef
  if (scope !== undefined && scope.trim().length > 0) return formatScopeHandle(scope)
  const principal = envelope.to?.principalRef
  return principal === undefined ? 'the addressee' : formatPrincipalName(principal)
}

/**
 * `agent:cody:project:hrc-runtime:task:T-07604` → `cody@hrc-runtime:T-07604`.
 *
 * wrkq already stores the handle, so the common path is a pass-through; the
 * canonical form is still accepted because nothing on this seam should depend
 * on which spelling reached it.
 */
function formatScopeHandle(scopeRef: string): string {
  if (scopeRef.includes('@')) return scopeRef.split('/lane:')[0] ?? scopeRef
  const agent = agentNameFromScope(scopeRef)
  const project = /:project:([^:/]+)/.exec(scopeRef)?.[1]
  const task = /:task:([^:/]+)/.exec(scopeRef)?.[1]
  if (project === undefined) return scopeRef
  return `${agent}@${project}:${task ?? 'primary'}`
}

function agentNameFromScope(scopeRef: string): string {
  if (scopeRef.includes('@')) return scopeRef.split('@')[0] ?? scopeRef
  return /^agent:([^:/]+)/.exec(scopeRef)?.[1] ?? scopeRef
}

/** `agent:lance` → `lance`. Humans are ordinary principals with no HRC scope. */
function formatPrincipalName(principalRef: string): string {
  return principalRef.startsWith('agent:') ? principalRef.slice('agent:'.length) : principalRef
}

function clipBody(body: string): string {
  return clip(body, MAX_BODY_CHARS)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
