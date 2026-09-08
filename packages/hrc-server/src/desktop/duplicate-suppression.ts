/**
 * Ingest-side duplicate suppression for a replaced desktop observer (T-08294).
 *
 * The recovery contract puts the restart decision on the driver, because only it
 * knows what normalization it is still holding. The consequence, agreed with the
 * observation leg, is that a replacement observer replays the ENTIRE historical
 * prefix from byte zero. That is safe only if HRC refuses to project what it has
 * already committed — otherwise recovery re-presents the whole conversation, the
 * exact 22-turns-becoming-44 result the first real chart produced.
 *
 * Three properties are load-bearing, each of them a way to get this wrong:
 *
 *  - **Identity must survive the replacement.** A replayed event arrives on a
 *    NEW invocation with a NEW broker seq and, in general, a new capture epoch.
 *    So the key is content-anchored — the raw record's `rawSha256` plus the
 *    normalized `type` plus the item/native id that distinguishes siblings from
 *    one record. Never the broker seq, never `rawRecordId`, which is an ordinal
 *    within one capture and would silently mismatch after a partial replay.
 *
 *  - **A suppressed event must still be REMEMBERED.** With two successive
 *    replacements, a set built only from the previous invocation's `applied`
 *    rows forgets everything that invocation itself suppressed — and the third
 *    observer would re-admit all of it. So the durable row is written with
 *    status `duplicate`, and the set is built from `applied` AND `duplicate`
 *    across every prior invocation of the session.
 *
 *  - **Broker progress must not stall.** A suppressed event is still delivered
 *    and still acknowledged: the caller records its disposition and advances the
 *    contiguous projection cursor exactly as the fenced path does. Suppression
 *    means "do not project", never "do not consume".
 */

import type { HrcDatabase } from 'hrc-store-sqlite'

/** Statuses that mean "HRC has already accounted for this native projection". */
const ACCOUNTED: ReadonlySet<string> = new Set(['applied', 'duplicate'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Content-anchored identity of one normalized projection.
 *
 * Returns undefined when the envelope carries no source provenance — an event
 * HRC cannot identify across invocations is never suppressed, because a missed
 * duplicate is a cosmetic repeat while a wrong suppression is lost history.
 */
export function desktopProjectionIdentity(envelopeJson: string | undefined): string | undefined {
  if (envelopeJson === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(envelopeJson)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const provenance = parsed['provenance']
  if (!isRecord(provenance)) return undefined
  // `rawSha256` is the raw record's content hash: stable across capture epochs,
  // replays and re-normalization. `rawRecordId` is deliberately NOT a fallback —
  // it is an ordinal within one capture, so it would match different records
  // whenever a replay starts anywhere other than the very beginning.
  const rawSha256 = provenance['rawSha256']
  if (typeof rawSha256 !== 'string' || rawSha256.length === 0) return undefined
  const type = parsed['type']
  if (typeof type !== 'string') return undefined
  const sibling =
    (typeof parsed['itemId'] === 'string' ? parsed['itemId'] : undefined) ??
    (typeof provenance['nativeId'] === 'string' ? provenance['nativeId'] : undefined) ??
    (typeof parsed['turnId'] === 'string' ? parsed['turnId'] : undefined) ??
    ''
  return `${rawSha256}|${type}|${sibling}`
}

/**
 * Every projection identity HRC has already accounted for on this session,
 * excluding the invocation currently ingesting.
 *
 * Scoped by host session rather than by the previous invocation alone: with two
 * successive replacements the third observer must still know about projections
 * the FIRST one committed, which the second only ever saw as duplicates.
 */
export function committedDesktopIdentities(
  db: HrcDatabase,
  hostSessionId: string,
  currentInvocationId: string
): Set<string> {
  const identities = new Set<string>()
  for (const runtime of db.runtimes.listByHostSessionId(hostSessionId)) {
    for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
      if (invocation.invocationId === currentInvocationId) continue
      for (const event of db.brokerInvocationEvents.listByInvocationId(invocation.invocationId)) {
        if (!ACCOUNTED.has(event.projectionStatus)) continue
        const identity = desktopProjectionIdentity(event.brokerEnvelopeJson)
        if (identity !== undefined) identities.add(identity)
      }
    }
  }
  return identities
}

/**
 * Per-invocation memo of the suppression set.
 *
 * Built once on the first event of a replacement invocation and reused for the
 * rest of the replay, which is what keeps a full historical re-delivery from
 * becoming a per-event table scan. Bounded because a long-lived daemon may see
 * many invocations; the set is cheap to rebuild after eviction or restart.
 */
const MEMO_LIMIT = 8
const memo = new Map<string, Set<string>>()

export function suppressionSetFor(
  db: HrcDatabase,
  hostSessionId: string,
  invocationId: string
): Set<string> {
  const cached = memo.get(invocationId)
  if (cached !== undefined) return cached
  const identities = committedDesktopIdentities(db, hostSessionId, invocationId)
  if (memo.size >= MEMO_LIMIT) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(invocationId, identities)
  return identities
}

/** Test seam: drop the memo so a fixture's fresh rows are observed immediately. */
export function resetDesktopSuppressionMemo(): void {
  memo.clear()
}

/**
 * Should this envelope be suppressed as an already-committed duplicate?
 *
 * Only for an externally-owned desktop observer. Applying this to an ordinary
 * runtime would be wrong: a normal harness legitimately re-emits similar content
 * across turns, and nothing else in HRC replays a whole history into a fresh
 * invocation by design.
 */
export function shouldSuppressDesktopDuplicate(input: {
  readonly db: HrcDatabase
  readonly lifecycleOwner: unknown
  readonly brokerDriver: string | undefined
  readonly hostSessionId: string
  readonly invocationId: string
  readonly envelopeJson: string | undefined
}): boolean {
  if (input.lifecycleOwner !== 'external') return false
  if (input.brokerDriver !== 'codex-desktop') return false
  const identity = desktopProjectionIdentity(input.envelopeJson)
  if (identity === undefined) return false
  return suppressionSetFor(input.db, input.hostSessionId, input.invocationId).has(identity)
}
