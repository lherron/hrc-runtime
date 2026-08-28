/**
 * hrcchat -> wrkc migration surface (T-07612 §9.2, flag day T-07616).
 *
 * wrkq owns collaboration; HRC owns execution. Every hrcchat verb therefore
 * either moved to `wrkc` (talk) or to `hrc` (execution). `dm` is the one verb
 * kept executable as a FORWARDING shim for the burn-in window, because it is
 * scripted in dozens of places across the collective and a hard break on flag
 * day would strand every one of them mid-turn.
 *
 * The mapping is a pure function so the argv contract is testable without
 * spawning anything.
 */

/** Human principals are ordinary `agent:<id>` principals; Lance is `agent:lance`. */
const HUMAN_PRINCIPAL = 'lance'

export type DmForwardOptions = {
  as?: string | undefined
  respondTo?: string | undefined
  replyTo?: string | undefined
  crossScopeReply?: boolean | undefined
  steer?: boolean | undefined
  urgent?: boolean | undefined
  queue?: boolean | undefined
  mode?: string | undefined
  file?: string | undefined
  follow?: string | undefined
  wait?: string | undefined
  timeout?: string | undefined
  quiet?: boolean | undefined
  json?: boolean | undefined
}

export type DmForwardPlan =
  | { kind: 'forward'; argv: string[]; notices: string[] }
  | { kind: 'refuse'; message: string }

/**
 * HRC birth directives ride the say REF verbatim (wrkq stores them as
 * `materialization_intent` and never parses them), but they are not part of the
 * addressee identity, so `--to` gets the bare handle.
 */
export function stripBirthDirectives(target: string): string {
  return target
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('+'))
    .join(' ')
}

/** hrcchat accepted bare agent names and the literal "human"; wrkq wants principals. */
function normalizePrincipal(value: string): string {
  if (value === 'human') return `agent:${HUMAN_PRINCIPAL}`
  if (value.startsWith('agent:')) return value
  return `agent:${value}`
}

export function mapDmToWrkcSay(
  target: string,
  message: string | undefined,
  opts: DmForwardOptions
): DmForwardPlan {
  if (opts.follow !== undefined) {
    return {
      kind: 'refuse',
      message:
        'hrcchat dm --follow is gone: streaming progress is execution, not talk. Send with `wrkc say <ref> --to <agent>`, then stream the presented envelope with `hrc monitor watch EN-xxxxx`.',
    }
  }
  if (target === 'system') {
    return {
      kind: 'refuse',
      message:
        'hrcchat dm system is gone: a note addressed to nobody is now a room log entry. Use `wrkc say <room>` with no --to.',
    }
  }

  const notices: string[] = []
  const ref = target === 'human' ? HUMAN_PRINCIPAL : target
  const to = target === 'human' ? HUMAN_PRINCIPAL : stripBirthDirectives(target)

  const argv = ['say', ref, ...(message !== undefined ? [message] : []), '--to', to]

  // T-07612 rev 4: one delivery class. `--steer`/`--urgent` are accepted and
  // dropped — every say reaches the seat in-flight; nothing waits for idle.
  if (opts.steer || opts.urgent) {
    notices.push(
      'hrcchat: --steer/--urgent dropped: every wrkc say delivers in-flight (T-07612 rev 4)'
    )
  }
  if (opts.wait !== undefined) argv.push('--wait')
  if (opts.timeout !== undefined) argv.push('--timeout', opts.timeout)
  if (opts.json) argv.push('--json')
  if (opts.as !== undefined) argv.push('--as', normalizePrincipal(opts.as))
  if (opts.respondTo !== undefined) {
    // hrcchat's --respond-to took a KIND (human|agent|system); wrkc takes a
    // principal. Only the human kind has a principal to name.
    if (opts.respondTo === 'human') argv.push('--respond-to', `agent:${HUMAN_PRINCIPAL}`)
    else if (opts.respondTo === 'agent' || opts.respondTo === 'system') {
      notices.push(`--respond-to ${opts.respondTo} dropped: wrkc addresses principals, not kinds`)
    } else argv.push('--respond-to', normalizePrincipal(opts.respondTo))
  }

  if (opts.replyTo !== undefined) {
    notices.push(
      '--reply-to dropped: in a room the reply IS the ack, so `--to` already disposes the obligation it answers'
    )
  }
  if (opts.crossScopeReply)
    notices.push('--cross-scope-reply dropped: rooms are not scoped threads')
  if (opts.queue) notices.push('--queue dropped: queued delivery is the wrkc default')
  if (opts.mode !== undefined) {
    notices.push(
      `--mode ${opts.mode} dropped: put birth directives in the target (+node=, +model=)`
    )
  }
  if (opts.quiet) notices.push('--quiet dropped: wrkc say emits no progress output')

  return { kind: 'forward', argv, notices }
}

export function formatForwardNotice(plan: {
  argv: string[]
  notices: string[]
}): string {
  const lines = [
    'hrcchat dm is a forwarding shim for `wrkc say` (T-07612 flag day). Call wrkc directly;',
    'this shim is removed after the burn-in window.',
    `  forwarded: wrkc ${plan.argv.map(quoteForDisplay).join(' ')}`,
  ]
  for (const notice of plan.notices) lines.push(`  ${notice}`)
  return `${lines.join('\n')}\n`
}

function quoteForDisplay(arg: string): string {
  return /[\s'"]/.test(arg) ? JSON.stringify(arg) : arg
}

/**
 * A room closes with its work, so a seat on a completed task refuses a `say`
 * until the room is deliberately reopened (spec §3.1). `hrcchat dm` used to be
 * the SEPARATE path people fell back to when that happened; after the flag day
 * it is the same path, so the caller needs the recovery spelled out rather than
 * just the state.
 *
 * The wording deliberately says WHY the room is closed. An agent that reads only
 * "reopen it" reopens reflexively, and a closure that is always reopened stops
 * meaning anything (clod@hrc-runtime:primary, T-07616).
 */
export function closedRoomRecoveryHint(stderrText: string, ref: string): string | undefined {
  if (!/WRKQ_WRONG_STATE|room .* is closed/i.test(stderrText)) return undefined
  return [
    '',
    'hrcchat dm: that room is closed, and closing was deliberate — a task room closes',
    'when its task reaches a terminal state, so reopening it says the work has more to say.',
    'If it does:',
    `  wrkc reopen ${ref}`,
    `  wrkc say ${ref} --to <agent> -`,
    'If it does not, address the agent on work that is still open instead.',
    '',
  ].join('\n')
}
