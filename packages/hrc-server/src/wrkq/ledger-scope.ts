import { formatScopeRef, parseScopeHandle } from 'agent-scope'

import { normalizeTargetSessionRef } from '../messages.js'

/**
 * Translate between wrkq's scope spelling and HRC's.
 *
 * The two systems name the same scope differently on purpose. wrkq stores and
 * returns the HANDLE (`cody@wrkq:primary`) — the short form an agent types —
 * while HRC keys its execution state on the canonical session ref with its lane
 * (`agent:cody:project:wrkq:task:primary/lane:main`). Neither owns the other's
 * grammar, so the conversion lives on the seam rather than inside either.
 *
 * Going the OTHER way needs no function: wrkq accepts a raw `HRC_SESSION_REF`,
 * lane suffix and all, and strips the lane itself. HRC must not pre-trim it
 * (T-07613 C-16385) — a lane is execution vocabulary, and guessing at wrkq's
 * normalization is how the two spellings drift apart.
 */
export function targetSessionRefForLedgerScope(scopeRef: string): string | undefined {
  const value = scopeRef.trim()
  if (value.length === 0) return undefined
  // A ledger scope never carries a lane -- wrkq strips it -- so the default
  // lane is restored here rather than assumed anywhere downstream.
  for (const candidate of [value, `${value}/lane:main`]) {
    try {
      return normalizeTargetSessionRef(candidate)
    } catch {
      // Not a session ref in this spelling; try the next.
    }
  }
  try {
    return normalizeTargetSessionRef(`${formatScopeRef(parseScopeHandle(value))}/lane:main`)
  } catch {
    return undefined
  }
}
