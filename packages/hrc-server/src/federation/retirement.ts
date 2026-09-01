import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  FederationRetirementRequest,
  FederationRetirementResult,
  LocateBindingRecord,
  LocateLedgerView,
} from 'hrc-core'
import type { PlacementLedgerRecord, PlacementLedgerRepository } from 'hrc-store-sqlite'

import { withScopeAuthorityLock } from './authority-lock.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryUnreachableError } from './registry-client.js'

type RetirementLog = (
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  detail: Record<string, unknown>
) => void

export type FederationRetirementDependencies = {
  readonly owner: object
  readonly localNodeId: string
  readonly ledger: Pick<PlacementLedgerRepository, 'get' | 'retire'>
  readonly registry: Pick<BindingRegistryClient, 'deleteBinding'>
  readonly liveRuntimeIds: (scopeRef: string) => readonly string[]
  readonly log: RetirementLog
  readonly now?: (() => string) | undefined
}

function bindingView(
  record: Pick<PlacementLedgerRecord, 'homeNodeId' | 'createdAt' | 'updatedAt'>
): LocateBindingRecord {
  return {
    homeNodeId: record.homeNodeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function ledgerView(record: PlacementLedgerRecord | undefined): LocateLedgerView | undefined {
  return record === undefined ? undefined : { state: record.state, record: bindingView(record) }
}

function makeResult(
  request: FederationRetirementRequest,
  fields: Omit<FederationRetirementResult, 'request'>
): FederationRetirementResult {
  return { request, ...fields }
}

/**
 * Federation v1.3 ordered retirement: the old home fences itself permanently
 * before it conditionally deletes the shared binding. A failed registry write
 * therefore leaves the scope unavailable and safely retryable, never live on
 * two homes.
 */
export async function retireFederationScope(
  deps: FederationRetirementDependencies,
  rawRequest: FederationRetirementRequest
): Promise<FederationRetirementResult> {
  const request = {
    scopeRef: formatCanonicalScopeRef({ scopeRef: rawRequest.scopeRef }),
    reason: rawRequest.reason.trim(),
  }
  if (request.reason.length === 0) throw new Error('retirement reason must not be empty')

  return await withScopeAuthorityLock(deps.owner, request.scopeRef, async () => {
    const before = deps.ledger.get(request.scopeRef)
    if (before === undefined || before.homeNodeId !== deps.localNodeId) {
      return makeResult(request, {
        ok: false,
        outcome: 'refused',
        state: 'unchanged',
        retryable: false,
        detail: 'retirement must be performed by the scope old home',
        ...(before === undefined ? {} : { ledger: ledgerView(before) }),
      })
    }

    if (before.state === 'active') {
      const liveRuntimeIds = [...deps.liveRuntimeIds(request.scopeRef)]
      if (liveRuntimeIds.length > 0) {
        return makeResult(request, {
          ok: false,
          outcome: 'live-runtime-present',
          state: 'old-home-live',
          retryable: true,
          detail: 'old-home runtimes must terminate before retirement',
          ledger: ledgerView(before),
          liveRuntimeIds,
        })
      }
    }

    const retiredAt = before.retiredAt ?? deps.now?.() ?? new Date().toISOString()
    const local = deps.ledger.retire({
      scopeRef: request.scopeRef,
      expectedHomeNodeId: deps.localNodeId,
      reason: request.reason,
      retiredAt,
    })
    if (
      local.outcome === 'conflict' ||
      local.outcome === 'not_found' ||
      local.record === undefined
    ) {
      return makeResult(request, {
        ok: false,
        outcome: 'conflict',
        state: 'unchanged',
        retryable: false,
        detail: 'local placement authority changed during retirement',
        ...(local.record === undefined ? {} : { ledger: ledgerView(local.record) }),
      })
    }

    try {
      const deleted = await deps.registry.deleteBinding({
        scopeRef: request.scopeRef,
        expectedHomeNodeId: deps.localNodeId,
        retiredAt: local.record.retiredAt ?? retiredAt,
      })
      if (deleted.outcome === 'conflict') {
        deps.log('ERROR', 'federation.retirement.registry_conflict', {
          scopeRef: request.scopeRef,
          localNodeId: deps.localNodeId,
          registryHomeNodeId: deleted.binding?.homeNodeId,
        })
        return makeResult(request, {
          ok: false,
          outcome: 'conflict',
          state: 'fenced-registry-pending',
          retryable: false,
          detail: 'registry binding no longer names the retiring old home',
          ledger: ledgerView(local.record),
          ...(deleted.binding === undefined ? {} : { binding: bindingView(deleted.binding) }),
        })
      }
      const outcome =
        local.outcome === 'idempotent' && deleted.outcome === 'idempotent'
          ? 'idempotent'
          : 'retired'
      deps.log('INFO', `federation.retirement.${outcome}`, {
        scopeRef: request.scopeRef,
        localNodeId: deps.localNodeId,
      })
      return makeResult(request, {
        ok: true,
        outcome,
        state: 'retired',
        retryable: false,
        detail: 'old home is permanently fenced and the registry binding is absent',
        ledger: ledgerView(local.record),
      })
    } catch (error) {
      if (!(error instanceof RegistryUnreachableError)) throw error
      deps.log('WARN', 'federation.retirement.registry_unavailable', {
        scopeRef: request.scopeRef,
        localNodeId: deps.localNodeId,
      })
      return makeResult(request, {
        ok: false,
        outcome: 'registry-unavailable',
        state: 'fenced-registry-pending',
        retryable: true,
        detail: 'old home is fenced; retry retirement to delete the registry binding',
        ledger: ledgerView(local.record),
      })
    }
  })
}
