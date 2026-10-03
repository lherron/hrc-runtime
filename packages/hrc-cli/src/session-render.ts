import { Chalk } from 'chalk'
import type { ChalkInstance } from 'chalk'

import type { HrcSessionRecord } from 'hrc-core'

/**
 * TTY render for `hrc session list`. The raw session list runs to thousands of
 * rows (rotated generations are never deleted), so the human view is organised
 * around the durable identity — the scope lineage — rather than the opaque
 * hostSessionId. By default it shows active lineage heads updated recently,
 * grouped by agent, and collapses rotated generations to a one-line rollup.
 *
 * Pure and deterministic: `now` and `color` are injected so the output is
 * unit-testable without a clock or a TTY.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export type SessionRenderOptions = {
  /** Reference instant for relative-time rendering. */
  now: Date
  /** Emit ANSI colour. Tests pass false for stable snapshots. */
  color: boolean
  /** Include archived sessions and drop the recency window. */
  all: boolean
  /** Include dormant resumable archived heads alongside recent active heads. */
  dormant?: boolean | undefined
  /** Recency window for active heads, in ms. Ignored when `all`. Default 24h. */
  sinceMs?: number | undefined
  /** Expand rotated generations inline instead of collapsing to a rollup. */
  gens: boolean
  /** Group rows by agent (default) or by project. */
  groupBy?: 'agent' | 'project' | undefined
  /** Scope prefix the server already filtered on, for the header label. */
  scope?: string | undefined
}

type Parsed = {
  agent: string
  project?: string | undefined
  task?: string | undefined
  /** project:task style label, or a best-effort tail of the scopeRef. */
  scopeLabel: string
}

/** Historical sessions have no identity; preserve their raw address as the label. */
export function sessionIdentity(session: HrcSessionRecord): Parsed {
  const identity = session.identity
  const agent = identity?.agentId ?? '(historical)'
  const project = identity?.projectId
  const task = identity?.taskId
  const scopeLabel = project
    ? task
      ? `${project}:${task}`
      : project
    : identity
      ? '(agent root)'
      : session.scopeRef
  return { agent, project, task, scopeLabel }
}

const NO_PROJECT = '(no project)'

/** The eyebrow group key for a session under the active grouping. */
function groupKeyFor(p: Parsed, groupBy: 'agent' | 'project'): string {
  return groupBy === 'project' ? (p.project ?? NO_PROJECT) : p.agent
}

/**
 * The per-row identity label, minus the lane suffix. Under agent grouping the
 * agent is the eyebrow so the row leads with project:task; under project
 * grouping the project is the eyebrow so the row leads with the agent · task.
 * Returns both a colour-decorated string and its plain length for alignment.
 */
function rowLabel(
  c: ChalkInstance,
  p: Parsed,
  groupBy: 'agent' | 'project'
): { colored: string; width: number } {
  if (groupBy === 'project') {
    const task = p.task ?? (p.project ? 'primary' : p.scopeLabel)
    const plain = `${p.agent} · ${task}`
    return {
      colored: `${c.cyan(p.agent)} ${c.dim('·')} ${c.yellow.dim(task)}`,
      width: plain.length,
    }
  }
  return { colored: colorScope(c, p.scopeLabel), width: p.scopeLabel.length }
}

/** `hsid-ff6c1c65-…` → `ff6c1c65`; falls back to a short slice for odd ids. */
export function shortSessionId(hostSessionId: string): string {
  const stripped = hostSessionId.replace(/^hsid-/, '')
  const firstGroup = stripped.split('-')[0] ?? stripped
  return firstGroup.slice(0, 8)
}

/** Compact relative time: 2m, 4h, 3d, 6w, 2mo. Future/zero clamps to "now". */
export function relativeTime(from: Date, now: Date): string {
  const deltaMs = now.getTime() - from.getTime()
  if (deltaMs < 60_000) return 'now'
  const mins = Math.floor(deltaMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 9) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

const SINCE_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: DAY_MS,
  w: 7 * DAY_MS,
}

/** Parse a `--since` window like `30m`, `12h`, `7d`, `2w` into ms. */
export function parseSinceMs(input: string): number {
  const match = input.match(/^(\d+)(s|m|h|d|w)$/)
  if (!match) {
    throw new Error(`invalid --since duration: ${input} (expected e.g. 12h, 7d, 2w)`)
  }
  return Number.parseInt(match[1] as string, 10) * (SINCE_UNIT_MS[match[2] as string] as number)
}

function lineageKey(session: HrcSessionRecord): string {
  return `${session.scopeRef}\u0000${session.laneRef}`
}

function byUpdatedDesc(a: HrcSessionRecord, b: HrcSessionRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

type SessionRowState = 'active' | 'dormant' | 'archived' | 'other'

export function isDormantSession(session: HrcSessionRecord): boolean {
  return session.status === 'archived' && Boolean(session.continuation?.key)
}

function sessionRowState(session: HrcSessionRecord): SessionRowState {
  if (session.status === 'active') return 'active'
  if (isDormantSession(session)) return 'dormant'
  if (session.status === 'archived') return 'archived'
  return 'other'
}

/**
 * Stable, colourless, tab-separated output for scripts — the git "porcelain"
 * sense. One line per session, fixed column order, no header.
 */
export function renderPorcelain(sessions: HrcSessionRecord[]): string {
  return (
    sessions
      .map((s) =>
        [
          s.hostSessionId,
          s.scopeRef,
          s.laneRef,
          `g${s.generation}`,
          s.status,
          s.createdAt,
          s.updatedAt,
        ].join('\t')
      )
      .join('\n') + (sessions.length > 0 ? '\n' : '')
  )
}

export function renderSessions(sessions: HrcSessionRecord[], opts: SessionRenderOptions): string {
  const c = opts.color ? new Chalk() : new Chalk({ level: 0 })
  const sinceMs = opts.sinceMs ?? DAY_MS
  const windowLabel = opts.all ? 'all' : formatWindow(sinceMs)

  // Collapse each lineage (scopeRef + lane) to a single head — the newest
  // generation — plus its rotated predecessors. The head is what's listed;
  // predecessors are collapsed to a rollup (or expanded under --gens). This
  // holds for every mode, so --all only widens *which heads* qualify, it never
  // promotes a predecessor to its own row.
  const lineages = new Map<string, HrcSessionRecord[]>()
  for (const s of sessions) {
    const list = lineages.get(lineageKey(s)) ?? []
    list.push(s)
    lineages.set(lineageKey(s), list)
  }
  const olderOf = new Map<string, HrcSessionRecord[]>()
  const heads: HrcSessionRecord[] = []
  for (const [key, members] of lineages) {
    const ordered = [...members].sort(
      (a, b) => b.generation - a.generation || b.updatedAt.localeCompare(a.updatedAt)
    )
    const [head, ...older] = ordered
    if (!head) continue
    heads.push(head)
    olderOf.set(key, older)
  }

  const cutoff = opts.now.getTime() - sinceMs
  const visible = heads
    .filter((s) => {
      if (opts.all) return true
      const state = sessionRowState(s)
      if (state === 'active') {
        return new Date(s.updatedAt).getTime() >= cutoff
      }
      if (opts.dormant && state === 'dormant') return true
      return false
    })
    .sort(byUpdatedDesc)

  const total = sessions.length
  const archived = sessions.filter((s) => s.status === 'archived').length
  const dormantHeads = heads.filter(isDormantSession).length
  const hidden = total - visible.length

  if (sessions.length === 0) {
    return `${c.dim('No sessions.')}\n`
  }

  const scopeLabel = opts.scope ? ` · ${c.cyan(opts.scope)}` : ''
  const header =
    `${c.bold('hrc')} ${c.dim('·')} sessions${scopeLabel}` +
    `   ${c.green(`${visible.length} heads`)} ${c.dim(`· ${hidden} hidden · ${windowLabel}`)}`

  if (visible.length === 0) {
    const footer = footerLine(c, total, archived, dormantHeads, {
      all: opts.all,
      dormant: opts.dormant === true,
    })
    return `${header}\n\n${c.dim(`No active sessions in ${windowLabel}.`)}\n\n${footer}\n`
  }

  const groupBy = opts.groupBy ?? 'agent'

  // Group visible heads by the active key, groups ordered by most-recent activity.
  const groups = new Map<string, HrcSessionRecord[]>()
  for (const s of visible) {
    const key = groupKeyFor(sessionIdentity(s), groupBy)
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  const scopeWidth = Math.min(
    44,
    Math.max(
      ...visible.map(
        (s) =>
          (s.title === undefined
            ? rowLabel(c, sessionIdentity(s), groupBy).width
            : s.title.length) + laneSuffix(s).length
      )
    )
  )

  const lines: string[] = [header, '']
  for (const [groupName, rows] of groups) {
    lines.push(groupBy === 'project' ? c.magenta(groupName) : c.cyan(groupName))
    for (const s of rows) {
      const lane = laneSuffix(s)
      const fallback = rowLabel(c, sessionIdentity(s), groupBy)
      const colored = s.title === undefined ? fallback.colored : c.bold(s.title)
      const width = s.title === undefined ? fallback.width : s.title.length
      const label = colored + (lane ? c.yellow.bold(lane) : '')
      const pad = ' '.repeat(Math.max(1, scopeWidth - (width + lane.length) + 2))
      const state = sessionRowState(s)
      const marker = rowMarker(c, state)
      const stateLabel = rowStateLabel(c, s, state)
      const meta = [c.dim(`g${s.generation}`.padEnd(4)), c.dim(shortSessionId(s.hostSessionId))]
      if (stateLabel) meta.push(stateLabel)
      meta.push(c.dim(relativeTime(new Date(s.updatedAt), opts.now)))
      lines.push(`  ${marker} ${label}${pad}${meta.join('   ')}`)
      if (s.title !== undefined) {
        lines.push(`      ${c.dim(s.scopeRef)}`)
      }
      const older = olderOf.get(lineageKey(s)) ?? []
      if (older.length > 0) {
        if (opts.gens) {
          for (const o of older) {
            lines.push(
              c.dim(
                `      └ g${o.generation}  ${shortSessionId(o.hostSessionId)}  ${o.status}  ${relativeTime(new Date(o.updatedAt), opts.now)}`
              )
            )
          }
        } else {
          lines.push(
            c.dim(`      └ ${older.length} older generation${older.length === 1 ? '' : 's'}`)
          )
        }
      }
    }
    lines.push('')
  }

  lines.push(
    footerLine(c, total, archived, dormantHeads, {
      all: opts.all,
      dormant: opts.dormant === true,
    })
  )
  return `${lines.join('\n')}\n`
}

function colorScope(c: ChalkInstance, scopeLabel: string): string {
  const idx = scopeLabel.indexOf(':')
  if (idx === -1) return c.magenta(scopeLabel)
  return c.magenta(scopeLabel.slice(0, idx)) + c.yellow.dim(scopeLabel.slice(idx))
}

function laneSuffix(s: HrcSessionRecord): string {
  return s.laneRef && s.laneRef !== 'main' ? ` ⟜${s.laneRef}` : ''
}

function formatWindow(sinceMs: number): string {
  const hours = Math.round(sinceMs / (60 * 60 * 1000))
  if (hours % 24 === 0) {
    const days = hours / 24
    return `last ${days}d`
  }
  return `last ${hours}h`
}

function rowMarker(c: ChalkInstance, state: SessionRowState): string {
  if (state === 'active') return c.green('◆')
  return c.dim('◇')
}

function rowStateLabel(
  c: ChalkInstance,
  session: HrcSessionRecord,
  state: SessionRowState
): string | undefined {
  if (state === 'active') return undefined
  if (state === 'dormant') return c.dim('dormant')
  if (state === 'archived') return c.dim('archived')
  return c.dim(session.status)
}

function footerLine(
  c: ChalkInstance,
  total: number,
  archived: number,
  dormantHeads: number,
  opts: { all: boolean; dormant: boolean }
): string {
  const widen = opts.all
    ? '--scope <ref> · --json'
    : opts.dormant
      ? '--all · --scope <ref> · --json'
      : dormantHeads > 0
        ? '--dormant · --since 7d · --all · --scope <ref> · --json'
        : '--since 7d · --all · --scope <ref> · --json'
  const counts = [`${total} total`, `${archived} archived`]
  if (dormantHeads > 0) {
    counts.push(`${dormantHeads} dormant head${dormantHeads === 1 ? '' : 's'}`)
  }
  return `${c.dim('─'.repeat(76))}\n${c.dim(`${counts.join(' · ')} · widen: ${widen}`)}`
}
