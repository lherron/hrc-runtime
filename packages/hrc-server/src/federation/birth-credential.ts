import { HRC_BIRTH_CREDENTIAL_ENV, HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  BirthAuthorityProvenance,
  HrcDatabase,
  PlacementLedgerRecord,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

export { HRC_BIRTH_CREDENTIAL_ENV }

export type ChildBirthAuthorityProvenance = BirthAuthorityProvenance & {
  readonly kind: 'child-birth'
  readonly parentScopeRef: string
  readonly parentRuntimeId: string
  readonly parentRunId: string
}

export type BirthCredentialRefusalReason = 'invalid-birth-credential' | 'zombie-runtime'

export type BirthCredentialValidation =
  | { valid: true; provenance: ChildBirthAuthorityProvenance }
  | {
      valid: false
      reason: BirthCredentialRefusalReason
      diagnostic: string
    }

/** Apply after caller-controlled env merging so the daemon value always wins. */
export function injectRuntimeBirthCredential(
  env: Record<string, string>,
  runtimeId: string
): Record<string, string> {
  return { ...env, [HRC_BIRTH_CREDENTIAL_ENV]: runtimeId }
}

function isActiveRunStatus(status: string): boolean {
  return status === 'accepted' || status === 'started' || status === 'running'
}

function isDeadRuntimeStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale'
}

/**
 * Validate a caller's opaque credential exclusively against daemon-owned state.
 *
 * The immediate transaction is the child-birth linearization point. Runtime and
 * current-run rows are read as one snapshot; if a terminal write wins first the
 * birth refuses, and if this transaction wins first it returns an immutable
 * birth permit naming the run that was live at that instant. Completion may
 * occur after the permit is returned without retroactively invalidating it.
 */
export function validateRuntimeBirthCredential(
  db: HrcDatabase,
  credential: string
): BirthCredentialValidation {
  const normalized = credential.trim()
  if (normalized.length === 0) {
    return {
      valid: false,
      reason: 'invalid-birth-credential',
      diagnostic: 'The supplied birth credential is empty; refusing child-birth.',
    }
  }

  return db.sqlite
    .transaction((): BirthCredentialValidation => {
      // The credential is intentionally the daemon-issued runtime identity. No
      // caller-supplied parent scope/run assertions are accepted at this seam.
      const runtime = db.runtimes.getByRuntimeId(normalized)
      if (runtime === null) {
        return {
          valid: false,
          reason: 'invalid-birth-credential',
          diagnostic:
            'The supplied birth credential does not identify a runtime known to this daemon; refusing child-birth.',
        }
      }

      const activeRunId = runtime.activeRunId
      if (isDeadRuntimeStatus(runtime.status) || activeRunId === undefined) {
        return {
          valid: false,
          reason: 'zombie-runtime',
          diagnostic: `Runtime ${runtime.runtimeId} is not executing a live run; refusing zombie child-birth.`,
        }
      }

      const run = db.runs.getByRunId(activeRunId)
      if (
        run === null ||
        !isActiveRunStatus(run.status) ||
        run.runtimeId !== runtime.runtimeId ||
        run.scopeRef !== runtime.scopeRef
      ) {
        return {
          valid: false,
          reason: 'zombie-runtime',
          diagnostic: `Runtime ${runtime.runtimeId} has no live current run ${activeRunId}; refusing zombie child-birth.`,
        }
      }

      return {
        valid: true,
        provenance: {
          kind: 'child-birth',
          parentScopeRef: runtime.scopeRef,
          parentRuntimeId: runtime.runtimeId,
          parentRunId: run.runId,
        },
      }
    })
    .immediate()
}

/** Strict parser shared by every HTTP surface that can mint a session. */
export function parseOptionalBirthCredential(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'birthCredential must be a non-empty string',
      { field: 'birthCredential' }
    )
  }
  return value.trim()
}

export type LocalBirthResolution = {
  /** Child-to-parent order, including the terminating ancestor. */
  chain: PlacementLedgerRecord[]
  /** The first policy-born or claim-born row. */
  ancestor: PlacementLedgerRecord
}

function childParentScope(row: PlacementLedgerRecord): string | undefined {
  const provenance = row.authorityProvenance
  return provenance.kind === 'child-birth' && typeof provenance['parentScopeRef'] === 'string'
    ? provenance['parentScopeRef']
    : undefined
}

/**
 * Resolve node-local mechanism birth provenance for the F0 locate seam.
 * Peer lookup is deliberately absent (F1); every row in this chain was born on
 * the same node as its parent, so a complete local ledger must terminate at a
 * policy-born or claim-born ancestor.
 */
export function resolveLocalBirthAncestor(
  ledger: Pick<PlacementLedgerRepository, 'get'>,
  scopeRef: string
): LocalBirthResolution {
  const chain: PlacementLedgerRecord[] = []
  const seen = new Set<string>()
  let currentScopeRef = scopeRef

  while (true) {
    if (seen.has(currentScopeRef)) {
      throw new Error(`birth provenance cycle detected at ${currentScopeRef}`)
    }
    seen.add(currentScopeRef)

    const row = ledger.get(currentScopeRef)
    if (row === undefined) {
      throw new Error(`birth provenance is incomplete: no local ledger row for ${currentScopeRef}`)
    }
    chain.push(row)

    if (row.birthClass === 'policy-born' || row.authorityProvenance.kind === 'claim-birth') {
      return { chain, ancestor: row }
    }

    const parentScopeRef = childParentScope(row)
    if (parentScopeRef === undefined) {
      throw new Error(
        `mechanism-born scope ${row.scopeRef} has no child-birth parent or claim-birth authority`
      )
    }
    currentScopeRef = parentScopeRef
  }
}
