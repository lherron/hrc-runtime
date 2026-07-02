import type { HrcTargetView } from 'hrc-core'

import type { HrcTopPrimaryActionKind } from './action-policy.js'

/**
 * Ph4 — `hrc top` `/` text filter (spec §Search and Filtering).
 *
 * This is a PURE row filter: given the visible rows and an operator query it
 * HIDES non-matching rows (it never moves the cursor or mutates a target). The
 * TUI feeds the filtered set to the Ph3 nav-state so selection, movement, and
 * marks all operate on the narrowed rows.
 *
 * Invariants:
 * - Match is case-insensitive across the visible target text, agent, project,
 *   task, lane, state, action, runtime id, host session id, and continuation
 *   provider/key when loaded.
 * - Space-separated terms are ANDed (`/wrkq cody`).
 * - A blank query is inactive and restores every row (in source order).
 * - The result exposes footer counts (`visibleRows`/`totalRows`).
 *
 * MVP stays text-first — structured filters are post-MVP command-mode work.
 */

export type HrcTopFilterRow = {
  /** Stable row identity (HrcTopVisibleRow-compatible). */
  id: string
  /** Rendered target handle / label text. */
  visibleTargetText?: string | undefined
  /** Target truth carrying agent/project/task/lane/state/runtime/continuation. */
  target: HrcTargetView
  /** Recommended primary-action kind text. */
  action?: HrcTopPrimaryActionKind | string | undefined
}

export type HrcTopFilterResult<T extends HrcTopFilterRow> = {
  /** Stable-ordered visible row set for nav-state. */
  rows: readonly T[]
  /** Trimmed operator query (empty when inactive). */
  query: string
  /** False only for an empty/blank query. */
  active: boolean
  /** Footer numerator. */
  visibleRows: number
  /** Footer denominator. */
  totalRows: number
}

export function applyFilter<T extends HrcTopFilterRow>(
  rows: readonly T[],
  query: string
): HrcTopFilterResult<T> {
  const rawTerms = query
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
  const terms = rawTerms.map((term) => term.toLowerCase())

  if (terms.length === 0) {
    return {
      rows,
      query: '',
      active: false,
      visibleRows: rows.length,
      totalRows: rows.length,
    }
  }

  const visible = rows.filter((row) => {
    const haystack = filterableText(row)
    return terms.every((term) => haystack.includes(term))
  })

  return {
    rows: visible,
    query: rawTerms.join(' '),
    active: true,
    visibleRows: visible.length,
    totalRows: rows.length,
  }
}

function filterableText(row: HrcTopFilterRow): string {
  const target = row.target
  const parts: (string | undefined)[] = [
    row.visibleTargetText,
    typeof row.action === 'string' ? row.action : undefined,
    target.sessionRef,
    target.scopeRef,
    target.laneRef,
    target.state,
    target.activeHostSessionId,
    target.runtime?.runtimeId,
    target.continuation?.provider,
    target.continuation?.key,
  ]
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .toLowerCase()
}
