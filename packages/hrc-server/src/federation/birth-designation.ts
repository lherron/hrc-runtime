/**
 * Tier-5 birth designation: which node is a VIRGIN scope born on? (T-07655)
 *
 * THE DEFECT THIS CLOSES. Since wave 3 every daemon's mail kicker tails the
 * same wrkq ledger, and tier 5 answered "here" on every node. One insert
 * addressed to a virgin scope therefore made every live kicker attempt a local
 * birth at the same instant; the registry arbitrated first-commit-wins and the
 * losers logged `drive_failed "… became bound on <winner>"`. Three task scopes
 * dispatched from max3 seats on 2026-08-28 were born on three different nodes.
 *
 * THE RULE. The registry host — the collective's single writer, already
 * serialized per scope — answers once, and every node asks it. The answer
 * follows the home of the scope that SENT the target's birth envelope, because
 * a conversation's reply belongs where the conversation lives.
 *
 * WHY IT IS NOT AN AMBIENT CALLER ASSERTION. The forbidden thing is inferring
 * placement from the caller's transport, node, or environment. Nothing here
 * reads any of those. The sender is a field of a durable ledger row that the
 * HOST reads for itself, and the sender's home is a registry fact recorded when
 * that scope was established. The request carries only the target scope, so a
 * caller cannot name a sender and cannot steer the answer.
 *
 * IT IS A DEFAULT, NOT A CONSTRAINT. It is consulted only where tiers 1-4 are
 * silent, and any tier-1-4 establishment supersedes it — atomically, inside the
 * registry transaction that writes the binding (federation-repositories.ts).
 * The establish fence refuses only ANOTHER tier-5 birth that disagrees with it.
 */

import type { BindingRegistry, BirthDesignationResult } from 'hrc-store-sqlite'

/** The wrkq birth-envelope read, as the host performs it. Null means none. */
export type BirthEnvelopeReader = (scopeRef: string) => Promise<{
  envelopeId: string
  seq: number
  from: { principalRef: string; scopeRef?: string | undefined }
} | null>

/** wrkq could not be reached. Retryable, and NEVER a reason to designate locally. */
export class BirthEnvelopeUnavailableError extends Error {
  readonly retryable = true

  constructor(
    readonly scopeRef: string,
    cause: unknown
  ) {
    super(
      `cannot read the birth envelope for ${scopeRef}: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'BirthEnvelopeUnavailableError'
  }
}

export type DesignateBirthHostDeps = {
  registry: Pick<BindingRegistry, 'liveDesignation' | 'recordDesignation' | 'getRecord'>
  /** Absent when this host has no ledger client; every designation is then `none`. */
  birthEnvelopeFor?: BirthEnvelopeReader | undefined
  now?: (() => string) | undefined
}

/**
 * The registry host's half of `designateBirth`.
 *
 * ORDER IS THE LATENCY CONTRACT (C-16787 rollout note). The live-designation
 * read comes first, so the common repeat ask — every other node asking about a
 * scope already designated — costs one local SQLite read and no network at all.
 * The wrkq read then happens OUTSIDE any per-scope serialization, and only the
 * immutable result it produced is carried into the serialized record step. The
 * birth envelope cannot change once it exists, so nothing is lost by reading it
 * unserialized, and a slow or wedged wrkq can never hold the registry's
 * per-scope lock.
 */
export async function designateBirthOnHost(
  deps: DesignateBirthHostDeps,
  scopeRef: string
): Promise<BirthDesignationResult> {
  const live = deps.registry.liveDesignation(scopeRef)
  if (live !== undefined) return { kind: 'designated', designation: live }

  const read = deps.birthEnvelopeFor
  if (read === undefined) return { kind: 'none' }

  let birthEnvelope: Awaited<ReturnType<BirthEnvelopeReader>>
  try {
    birthEnvelope = await read(scopeRef)
  } catch (error) {
    // wrkq is the sole durable envelope authority. Unreachable means the host
    // does not KNOW the answer, which is a reason to refuse retryably — never
    // to fall back to a local birth, because that fallback fires on every node
    // at once and is the exact race this designation exists to prevent.
    throw new BirthEnvelopeUnavailableError(scopeRef, error)
  }

  // Nothing has ever fired at the scope, or its sender is a scope-less
  // principal (a human). Neither names a placeable home, and per the spec
  // NOTHING is recorded: a decision must not be taken before the sender's
  // capability to answer it is known.
  const senderScopeRef = birthEnvelope?.from.scopeRef
  if (birthEnvelope === null || senderScopeRef === undefined || senderScopeRef.length === 0) {
    return { kind: 'none' }
  }

  const sender = deps.registry.getRecord(senderScopeRef)
  if (sender === undefined) return { kind: 'none' }

  const now = (deps.now ?? (() => new Date().toISOString()))()
  const designation =
    sender.state === 'retired'
      ? deps.registry.recordDesignation({
          scopeRef,
          homeNodeId: sender.retiredHomeNodeId,
          provenance: 'default_home_node(sender-retired)',
          birthEnvelopeId: birthEnvelope.envelopeId,
          senderScopeRef,
          now,
        })
      : deps.registry.recordDesignation({
          scopeRef,
          homeNodeId: sender.homeNodeId,
          provenance: 'default_home_node(sender)',
          birthEnvelopeId: birthEnvelope.envelopeId,
          senderScopeRef,
          now,
        })
  return { kind: 'designated', designation }
}
