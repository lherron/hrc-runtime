import type { WrkqEnvelope } from './ledger-types.js'

/**
 * The section 7 injection format (T-07612).
 *
 *   [T-07604 · cody@hrc-runtime:T-07604 (gen 3) → you · reply required]
 *   history: wrkc log T-07604   (14 messages · last 2h ago)
 *   <body>
 *   reply: wrkc say T-07604 --to cody@hrc-runtime:T-07604 - <<'EOF'
 *   …
 *   EOF
 *
 * Header, optional history cue, body, one reply line. NO ROOM HISTORY IS EVER
 * INJECTED: the cue is a pointer the agent pulls on, which is the whole reason
 * the ledger exists rather than a bigger context window.
 *
 * The envelope's `EN-xxxxx` id is INTERNAL. It appears in `wrkc inbox`, `show`
 * and `log`; it never appears here, because the addressing token an agent needs
 * is the ROOM KEY, not the row id.
 */

/** Body clip. The room holds the full text; the injection is a summons to it. */
const MAX_BODY_CHARS = 4_000

export type PresentableEnvelope = {
  envelope: WrkqEnvelope
  /** wrkq's cue decision, keyed to the RUNTIME rather than the generation. */
  historyHint: boolean
  messageCount: number
  lastMessageAt?: string | undefined
  /**
   * The ad-hoc room's subject, so a pair room's header is distinguishable.
   * Derived rooms have none: their key already IS the work identity.
   */
  roomSubject?: string | undefined
  /**
   * The sender's live generation, when this node homes the sender and can see
   * it. It is HRC's own execution state, not the ledger's -- wrkq stores a
   * generation for the PRESENTATION (the recipient side) and deliberately none
   * for the sender -- so it is omitted rather than guessed when unknown.
   */
  senderGeneration?: number | undefined
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
  const lines = [formatHeader(presentable)]
  const history = formatHistoryLine(presentable, now)
  if (history !== undefined) lines.push(history)
  lines.push(clipBody(envelope.body))
  const reply = formatReplyLine(envelope)
  if (reply !== undefined) lines.push(reply)
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

function formatHeader(presentable: PresentableEnvelope): string {
  const { envelope } = presentable
  const obligation = envelope.obligation === 'fyi' ? 'fyi' : 'reply required'
  return `[${formatRoomToken(presentable)} · ${formatSender(presentable)} → you · ${obligation}]`
}

/**
 * The room's addressing token, which is its KEY and never its row id.
 *
 * A task room reads `T-07604` and a campaign room reads its path, because for
 * the derived kinds the key IS the work identity. An ad-hoc room quotes its
 * subject after the key so a reader can tell one pair room from another.
 */
function formatRoomToken(presentable: PresentableEnvelope): string {
  const key = presentable.envelope.roomKey
  const subject = presentable.roomSubject?.trim()
  if (presentable.envelope.roomKind !== 'adhoc' || subject === undefined || subject.length === 0) {
    return key
  }
  return `${key} "${subject}"`
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
function formatReplyLine(envelope: WrkqEnvelope): string | undefined {
  if (envelope.obligation !== 'reply_required') return undefined
  const to = replyAddressee(envelope)
  if (to === undefined) return undefined
  return [`reply: wrkc say ${envelope.roomKey} --to ${to} - <<'EOF'`, '…', 'EOF'].join('\n')
}

function replyAddressee(envelope: WrkqEnvelope): string | undefined {
  const scope = envelope.from.scopeRef
  if (scope !== undefined && scope.trim().length > 0) return formatScopeHandle(scope)
  // A human is a scope-less principal: `--to lance` is already exact.
  return formatPrincipalName(envelope.from.principalRef)
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
  if (body.length <= MAX_BODY_CHARS) return body
  return `${body.slice(0, MAX_BODY_CHARS)}…`
}
