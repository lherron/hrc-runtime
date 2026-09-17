/**
 * T-08566 stage 2 — one per-runtime exclusive owner shared by every live attach
 * path and retained-evidence recovery (SPEC §3.4.1, Daedalus EN-13378 F1).
 *
 * The existing attach single-flight map (`brokerReattachOperations`, owner kind
 * `attach`) stays the attach owner, so its callers are unchanged. Retained
 * recovery (owner kind `retained-recovery`) is a sidecar registry keyed on that
 * same map instance, which makes the two kinds one registry per server: exactly
 * one daemon owns a state root (`server.lock`), and nothing outside it attaches.
 *
 * Ordering law:
 *  - recovery that finds an attach owner does not wait: it refuses
 *    (`offline_read_attach_in_flight`), spawning nothing and moving no cursor;
 *  - an attach path that finds a recovery owner awaits its completion and then
 *    evaluates the retained-projection guard inside its own ownership, never on
 *    a value read before the recovery finished.
 */

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

type AttachOwnerMap = Map<string, Promise<unknown>>

const recoveryOwnersByAttachMap = new WeakMap<AttachOwnerMap, Map<string, Promise<void>>>()

function recoveryOwners(attachOwners: AttachOwnerMap): Map<string, Promise<void>> {
  let owners = recoveryOwnersByAttachMap.get(attachOwners)
  if (owners === undefined) {
    owners = new Map()
    recoveryOwnersByAttachMap.set(attachOwners, owners)
  }
  return owners
}

export type RetainedRecoveryOwnership =
  | { acquired: true; release: () => void }
  | { acquired: false; heldBy: 'attach' | 'retained-recovery' }

/** Try to take the runtime for one recovery attempt. Never waits. */
export function acquireRetainedRecoveryOwnership(
  attachOwners: AttachOwnerMap,
  runtimeId: string
): RetainedRecoveryOwnership {
  if (attachOwners.has(runtimeId)) return { acquired: false, heldBy: 'attach' }
  const owners = recoveryOwners(attachOwners)
  if (owners.has(runtimeId)) return { acquired: false, heldBy: 'retained-recovery' }
  let release!: () => void
  const flight = new Promise<void>((resolve) => {
    release = resolve
  })
  owners.set(runtimeId, flight)
  let released = false
  return {
    acquired: true,
    release: () => {
      if (released) return
      released = true
      if (owners.get(runtimeId) === flight) owners.delete(runtimeId)
      release()
    },
  }
}

/** Whether a retained recovery currently owns this runtime (synchronous). */
export function retainedRecoveryInFlight(attachOwners: AttachOwnerMap, runtimeId: string): boolean {
  return recoveryOwners(attachOwners).has(runtimeId)
}

/**
 * Await any in-flight retained recovery of this runtime. Loops so a caller
 * resumes only once no recovery owner exists; the caller must then acquire its
 * own ownership synchronously (no await between this return and that).
 */
export async function awaitRetainedRecoveryOwner(
  attachOwners: AttachOwnerMap,
  runtimeId: string
): Promise<void> {
  const owners = recoveryOwners(attachOwners)
  for (let flight = owners.get(runtimeId); flight !== undefined; flight = owners.get(runtimeId)) {
    await flight
  }
}

/** The durable irreversibility fact: at least one retained envelope committed. */
export function hasRetainedProjection(db: HrcDatabase, runtimeId: string): boolean {
  return (
    db.sqlite
      .query<{ one: number }, [string]>(
        `SELECT 1 AS one FROM broker_invocations
          WHERE runtime_id = ? AND retained_projected_through_seq IS NOT NULL
          LIMIT 1`
      )
      .get(runtimeId) !== null
  )
}

export class RetainedEvidenceProjectedError extends HrcDomainError {
  constructor(runtimeId: string, path: string) {
    super(
      HrcErrorCode.RUNTIME_RETAINED_EVIDENCE_PROJECTED,
      'runtime has committed retained-evidence projection; live control paths into it are refused',
      { runtimeId, path }
    )
    this.name = 'RetainedEvidenceProjectedError'
  }
}

/** Refuse a live path into a runtime whose retained projection has committed. */
export function assertNoRetainedProjection(db: HrcDatabase, runtimeId: string, path: string): void {
  if (hasRetainedProjection(db, runtimeId)) {
    throw new RetainedEvidenceProjectedError(runtimeId, path)
  }
}
