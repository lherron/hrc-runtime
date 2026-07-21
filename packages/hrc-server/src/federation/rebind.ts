import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  FederationRebindRequest,
  FederationRebindResult,
  FederationRebindStep,
  LocateBindingRecord,
  LocateLedgerView,
  LocatePeerResolution,
} from 'hrc-core'
import type {
  PlacementBinding,
  PlacementLedgerRecord,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

import { withScopeAuthorityLock } from './authority-lock.js'
import type { PeerEntry } from './federation-config.js'
import { parseNodeId } from './node-id.js'
import { locatePeerScope } from './peer-observer.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'

type RebindLog = (
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  detail: Record<string, unknown>
) => void

export type FederationRebindDependencies = {
  readonly owner: object
  readonly localNodeId: string
  readonly ledger: Pick<PlacementLedgerRepository, 'get' | 'revoke' | 'installActive'>
  readonly registry: BindingRegistryClient
  readonly peerForNodeId: (nodeId: string) => PeerEntry | undefined
  readonly observePeerScope?:
    | ((peer: PeerEntry, scopeRef: string) => Promise<LocatePeerResolution>)
    | undefined
  readonly liveRuntimeIds: (scopeRef: string) => readonly string[]
  readonly log: RebindLog
  readonly now?: (() => string) | undefined
}

function bindingView(binding: PlacementBinding | PlacementLedgerRecord): LocateBindingRecord {
  return {
    homeNodeId: binding.homeNodeId,
    placementEpoch: binding.placementEpoch,
    birthClass: binding.birthClass,
    authorityProvenance: binding.authorityProvenance,
    establishmentProvenance: binding.establishmentProvenance,
    ...(binding.priorHomeNodeId === undefined ? {} : { priorHomeNodeId: binding.priorHomeNodeId }),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

function ledgerView(record: PlacementLedgerRecord | undefined): LocateLedgerView | undefined {
  return record === undefined ? undefined : { state: record.state, record: bindingView(record) }
}

export function normalizeFederationRebindRequest(
  request: FederationRebindRequest
): FederationRebindRequest {
  const normalized = {
    scopeRef: formatCanonicalScopeRef({ scopeRef: request.scopeRef }),
    expectedHomeNodeId: parseNodeId(request.expectedHomeNodeId, 'expectedHomeNodeId'),
    expectedPlacementEpoch: request.expectedPlacementEpoch,
    newHomeNodeId: parseNodeId(request.newHomeNodeId, 'newHomeNodeId'),
  }
  if (
    !Number.isSafeInteger(normalized.expectedPlacementEpoch) ||
    normalized.expectedPlacementEpoch < 1 ||
    normalized.expectedPlacementEpoch >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('expectedPlacementEpoch must be a positive safe integer with room for E+1')
  }
  if (normalized.expectedHomeNodeId === normalized.newHomeNodeId) {
    throw new Error('newHomeNodeId must differ from expectedHomeNodeId')
  }
  return normalized
}

function result(
  step: FederationRebindStep,
  request: FederationRebindRequest,
  fields: Omit<FederationRebindResult, 'step' | 'request'>
): FederationRebindResult {
  return { step, request, ...fields }
}

function logResult(deps: FederationRebindDependencies, value: FederationRebindResult): void {
  deps.log(value.ok ? 'INFO' : 'WARN', `federation.rebind.${value.step}`, {
    localNodeId: deps.localNodeId,
    scopeRef: value.request.scopeRef,
    expectedHomeNodeId: value.request.expectedHomeNodeId,
    expectedPlacementEpoch: value.request.expectedPlacementEpoch,
    newHomeNodeId: value.request.newHomeNodeId,
    outcome: value.outcome,
    state: value.state,
    retryable: value.retryable,
    detail: value.detail,
  })
}

function finish(
  deps: FederationRebindDependencies,
  value: FederationRebindResult
): FederationRebindResult {
  logResult(deps, value)
  return value
}

export async function revokeFederationRebind(
  deps: FederationRebindDependencies,
  rawRequest: FederationRebindRequest
): Promise<FederationRebindResult> {
  const request = normalizeFederationRebindRequest(rawRequest)
  return await withScopeAuthorityLock(deps.owner, request.scopeRef, async () => {
    if (deps.localNodeId !== request.expectedHomeNodeId) {
      return finish(
        deps,
        result('revoke', request, {
          ok: false,
          outcome: 'refused',
          state: 'unchanged',
          retryable: false,
          detail: `REVOKE must run on old home ${request.expectedHomeNodeId}; this node is ${deps.localNodeId}.`,
        })
      )
    }

    const liveRuntimeIds = [...deps.liveRuntimeIds(request.scopeRef)]
    if (liveRuntimeIds.length > 0) {
      return finish(
        deps,
        result('revoke', request, {
          ok: false,
          outcome: 'live-runtime-present',
          state: 'old-home-live',
          retryable: true,
          detail: `Terminate or archive ${liveRuntimeIds.length} live runtime(s) on ${deps.localNodeId} before retrying REVOKE.`,
          liveRuntimeIds,
        })
      )
    }

    const revoked = deps.ledger.revoke({
      scopeRef: request.scopeRef,
      expectedHomeNodeId: request.expectedHomeNodeId,
      expectedPlacementEpoch: request.expectedPlacementEpoch,
      updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
    })
    if (revoked.outcome === 'revoked' || revoked.outcome === 'idempotent') {
      return finish(
        deps,
        result('revoke', request, {
          ok: true,
          outcome: revoked.outcome,
          state: 'revoked-nowhere',
          retryable: true,
          detail:
            revoked.outcome === 'revoked'
              ? `Old tuple ${request.expectedHomeNodeId}@${request.expectedPlacementEpoch} is locally revoked; the scope is summonable nowhere until CAS and ACTIVATE complete.`
              : 'The exact old tuple was already revoked; continue or retry the CAS step.',
          ...(revoked.record === undefined ? {} : { ledger: ledgerView(revoked.record) }),
        })
      )
    }
    return finish(
      deps,
      result('revoke', request, {
        ok: false,
        outcome: 'conflict',
        state: 'unchanged',
        retryable: false,
        detail:
          revoked.outcome === 'not_found'
            ? 'No local placement row exists for the requested old tuple.'
            : 'The local placement row does not match the requested old tuple.',
        ...(revoked.record === undefined ? {} : { ledger: ledgerView(revoked.record) }),
      })
    )
  })
}

export async function casFederationRebind(
  deps: FederationRebindDependencies,
  rawRequest: FederationRebindRequest
): Promise<FederationRebindResult> {
  const request = normalizeFederationRebindRequest(rawRequest)
  return await withScopeAuthorityLock(deps.owner, request.scopeRef, async () => {
    if (deps.localNodeId !== request.newHomeNodeId) {
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: 'refused',
          state: 'unchanged',
          retryable: false,
          detail: `CAS must run on new home ${request.newHomeNodeId}; this node is ${deps.localNodeId}.`,
        })
      )
    }
    const oldPeer = deps.peerForNodeId(request.expectedHomeNodeId)
    if (oldPeer === undefined) {
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: 'refused',
          state: 'unchanged',
          retryable: false,
          detail: `Old home ${request.expectedHomeNodeId} is absent from this node's peer table.`,
        })
      )
    }

    const oldObservation = await (deps.observePeerScope ?? locatePeerScope)(
      oldPeer,
      request.scopeRef
    )
    if (oldObservation.state !== 'answered') {
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: oldObservation.state === 'unreachable' ? 'peer-unreachable' : 'refused',
          state: 'unchanged',
          retryable: oldObservation.state === 'unreachable',
          detail: `Cannot prove old-home revocation: ${oldObservation.detail}`,
        })
      )
    }
    const oldLedger = oldObservation.location.ledger
    if (
      oldLedger.state !== 'revoked' ||
      oldLedger.record.homeNodeId !== request.expectedHomeNodeId ||
      oldLedger.record.placementEpoch !== request.expectedPlacementEpoch
    ) {
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: 'conflict',
          state: 'unchanged',
          retryable: true,
          detail: `Old home has not revoked exact tuple ${request.expectedHomeNodeId}@${request.expectedPlacementEpoch}; run or retry REVOKE there first.`,
          ledger: oldLedger,
        })
      )
    }

    const compareAndSwap = deps.registry.compareAndSwap
    if (compareAndSwap === undefined) {
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: 'refused',
          state: 'revoked-nowhere',
          retryable: false,
          detail: 'The configured registry client does not expose fenced binding CAS.',
        })
      )
    }

    let changed: Awaited<ReturnType<NonNullable<BindingRegistryClient['compareAndSwap']>>>
    try {
      changed = await compareAndSwap.call(deps.registry, {
        ...request,
        now: (deps.now ?? (() => new Date().toISOString()))(),
      })
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      return finish(
        deps,
        result('cas', request, {
          ok: false,
          outcome: 'refused',
          state: 'revoked-nowhere',
          retryable: !refused,
          detail: `Registry CAS failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
    }

    if (
      (changed.outcome === 'updated' || changed.outcome === 'idempotent') &&
      changed.binding !== undefined
    ) {
      return finish(
        deps,
        result('cas', request, {
          ok: true,
          outcome: changed.outcome === 'updated' ? 'registry-updated' : 'idempotent',
          state: 'registry-moved-activation-pending',
          retryable: true,
          detail: `Registry now names ${request.newHomeNodeId}@${request.expectedPlacementEpoch + 1}; the scope remains summonable nowhere until ACTIVATE completes.`,
          binding: bindingView(changed.binding),
        })
      )
    }
    return finish(
      deps,
      result('cas', request, {
        ok: false,
        outcome: 'conflict',
        state: 'revoked-nowhere',
        retryable: false,
        detail: `Registry tuple mismatch (${changed.outcome}); no authority was activated.`,
        ...(changed.binding === undefined ? {} : { binding: bindingView(changed.binding) }),
      })
    )
  })
}

export async function activateFederationRebind(
  deps: FederationRebindDependencies,
  rawRequest: FederationRebindRequest
): Promise<FederationRebindResult> {
  const request = normalizeFederationRebindRequest(rawRequest)
  return await withScopeAuthorityLock(deps.owner, request.scopeRef, async () => {
    if (deps.localNodeId !== request.newHomeNodeId) {
      return finish(
        deps,
        result('activate', request, {
          ok: false,
          outcome: 'refused',
          state: 'unchanged',
          retryable: false,
          detail: `ACTIVATE must run on new home ${request.newHomeNodeId}; this node is ${deps.localNodeId}.`,
        })
      )
    }

    let consulted: Awaited<ReturnType<BindingRegistryClient['consult']>>
    try {
      consulted = await deps.registry.consult(request.scopeRef)
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      return finish(
        deps,
        result('activate', request, {
          ok: false,
          outcome: 'refused',
          state: 'registry-moved-activation-pending',
          retryable: !refused || error instanceof RegistryUnreachableError,
          detail: `Cannot verify the rebound registry tuple: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
    }
    const expectedEpoch = request.expectedPlacementEpoch + 1
    if (
      consulted.outcome !== 'bound' ||
      consulted.binding.homeNodeId !== request.newHomeNodeId ||
      consulted.binding.placementEpoch !== expectedEpoch ||
      consulted.binding.establishmentProvenance !== 'rebind' ||
      consulted.binding.priorHomeNodeId !== request.expectedHomeNodeId
    ) {
      return finish(
        deps,
        result('activate', request, {
          ok: false,
          outcome: 'conflict',
          state: 'unchanged',
          retryable: true,
          detail: `Registry does not hold exact rebound tuple ${request.newHomeNodeId}@${expectedEpoch} from ${request.expectedHomeNodeId}; run or retry CAS first.`,
          ...(consulted.outcome === 'bound' ? { binding: bindingView(consulted.binding) } : {}),
        })
      )
    }

    const current = deps.ledger.get(request.scopeRef)
    if (
      current?.state === 'active' &&
      current.homeNodeId === request.newHomeNodeId &&
      current.placementEpoch === expectedEpoch
    ) {
      return finish(
        deps,
        result('activate', request, {
          ok: true,
          outcome: 'idempotent',
          state: 'active-new-home',
          retryable: false,
          detail: 'The exact rebound tuple is already active locally.',
          binding: bindingView(consulted.binding),
          ledger: ledgerView(current),
        })
      )
    }

    const liveRuntimeIds = [...deps.liveRuntimeIds(request.scopeRef)]
    if (liveRuntimeIds.length > 0) {
      return finish(
        deps,
        result('activate', request, {
          ok: false,
          outcome: 'live-runtime-present',
          state: 'registry-moved-activation-pending',
          retryable: true,
          detail: 'Unexpected live runtimes exist before activation; drain them before retrying.',
          binding: bindingView(consulted.binding),
          liveRuntimeIds,
        })
      )
    }

    try {
      const installed = deps.ledger.installActive(consulted.binding)
      return finish(
        deps,
        result('activate', request, {
          ok: true,
          outcome: 'activated',
          state: 'active-new-home',
          retryable: false,
          detail: `Activated ${request.newHomeNodeId}@${expectedEpoch}; fresh continuity may now be created from the operator handoff seed.`,
          binding: bindingView(consulted.binding),
          ledger: ledgerView(installed),
        })
      )
    } catch (error) {
      return finish(
        deps,
        result('activate', request, {
          ok: false,
          outcome: 'conflict',
          state: 'registry-moved-activation-pending',
          retryable: true,
          detail: `Local activation did not commit: ${error instanceof Error ? error.message : String(error)}`,
          binding: bindingView(consulted.binding),
          ...(current === undefined ? {} : { ledger: ledgerView(current) }),
        })
      )
    }
  })
}
