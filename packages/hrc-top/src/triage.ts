import type { HrcTargetOperatorDisplayState } from 'hrc-core'

/**
 * Ph — `hrc top` triage grouping + urgency sort (T-05412).
 *
 * This is PURE PRODUCT POLICY over ALREADY-PROJECTED rows. It does NOT
 * reclassify target truth: it consumes the Ph2 `displayState` (and the
 * projection's `hasValidContinuation`) and only decides which triage bucket a
 * row belongs to and the order buckets appear in. It never inspects raw
 * session/runtime lists and never re-derives a display state.
 *
 * Buckets, in urgency order:
 *   needsYou   — you are the blocker (awaiting-input)
 *   working    — running now (busy / starting)
 *   resumable  — dormant/stale WITH a captured continuation
 *   attention  — stuck: broken / ambiguous / dormant-or-stale w/o continuation
 *   idle       — the quiet majority (ready / headless); collapses by default
 */

export type HrcTopTriageBucket = 'needsYou' | 'working' | 'resumable' | 'attention' | 'idle'

export const TRIAGE_BUCKET_ORDER: readonly HrcTopTriageBucket[] = [
  'needsYou',
  'working',
  'resumable',
  'attention',
  'idle',
]

/** A row reduced to exactly the projected facts triage policy is allowed to see. */
export type HrcTopTriageRow = {
  id: string
  displayState: HrcTargetOperatorDisplayState
  hasValidContinuation: boolean
  /** ISO timestamp of last activity, or undefined when the read-model lacks it. */
  lastActivityAt?: string | undefined
}

export type HrcTopTriageGroup<T extends HrcTopTriageRow> = {
  bucket: HrcTopTriageBucket
  rows: T[]
}

export type HrcTopTriageCounts = Record<HrcTopTriageBucket, number>

/**
 * Assign a projected row to a triage bucket. Derived ONLY from the projected
 * display state and continuation validity — the two facts Ph2 already decided.
 */
export function triageBucketFor(row: {
  displayState: HrcTargetOperatorDisplayState
  hasValidContinuation: boolean
}): HrcTopTriageBucket {
  switch (row.displayState) {
    case 'input':
      return 'needsYou'
    case 'busy':
    case 'starting':
      return 'working'
    case 'dormant':
    case 'stale':
      return row.hasValidContinuation ? 'resumable' : 'attention'
    case 'broken':
    case 'ambiguous':
      return 'attention'
    case 'ready':
    case 'headless':
      return 'idle'
  }
}

/** True for buckets the operator should act on — everything but the idle sea. */
export function isActionableBucket(bucket: HrcTopTriageBucket): boolean {
  return bucket !== 'idle'
}

function activityMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Within-bucket urgency order:
 *  - needsYou: the request waiting LONGEST is most urgent → oldest activity first.
 *  - every other bucket: most recent activity first.
 * Rows without a timestamp sort last; ties break on stable `id` for determinism.
 */
function compareWithinBucket<T extends HrcTopTriageRow>(
  bucket: HrcTopTriageBucket,
  a: T,
  b: T
): number {
  const aMs = activityMs(a.lastActivityAt)
  const bMs = activityMs(b.lastActivityAt)
  if (aMs !== bMs) {
    if (aMs === undefined) return 1
    if (bMs === undefined) return -1
    return bucket === 'needsYou' ? aMs - bMs : bMs - aMs
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Group rows into triage buckets and urgency-sort within each. Buckets are
 * emitted in `TRIAGE_BUCKET_ORDER`; empty buckets are omitted.
 */
export function groupTriageRows<T extends HrcTopTriageRow>(
  rows: readonly T[]
): HrcTopTriageGroup<T>[] {
  const byBucket = new Map<HrcTopTriageBucket, T[]>()
  for (const row of rows) {
    const bucket = triageBucketFor(row)
    const list = byBucket.get(bucket)
    if (list) list.push(row)
    else byBucket.set(bucket, [row])
  }

  const groups: HrcTopTriageGroup<T>[] = []
  for (const bucket of TRIAGE_BUCKET_ORDER) {
    const list = byBucket.get(bucket)
    if (!list || list.length === 0) continue
    list.sort((a, b) => compareWithinBucket(bucket, a, b))
    groups.push({ bucket, rows: list })
  }
  return groups
}

/** Count rows per bucket (all buckets present, zeroed when empty). */
export function triageCounts(rows: readonly HrcTopTriageRow[]): HrcTopTriageCounts {
  const counts: HrcTopTriageCounts = {
    needsYou: 0,
    working: 0,
    resumable: 0,
    attention: 0,
    idle: 0,
  }
  for (const row of rows) counts[triageBucketFor(row)] += 1
  return counts
}
