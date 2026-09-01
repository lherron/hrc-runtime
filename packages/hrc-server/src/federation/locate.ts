import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateDeclaredPolicy,
  LocateDesignationView,
  LocateLedgerView,
  LocateNote,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
} from 'hrc-core'
import type {
  PlacementBinding,
  PlacementLedgerRecord,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

export type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateDeclaredPolicy,
  LocateDesignationView,
  LocateLedgerView,
  LocateNote,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
}

import { isReservedNodeId } from './node-id.js'
import type { PlacementPolicyResolution } from './placement-policy.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'
import { placementHomeDeclaration, placementPinKey } from './summon-gate.js'
import type { SummonGateMode } from './summon-gate.js'

export type LocateDeps = {
  localNodeId: string
  federationConfigured: boolean
  gateMode: SummonGateMode
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'get'>
  registry: BindingRegistryClient
  policyFor: (scopeRef: string) => Promise<PlacementPolicyResolution>
  observedFor: (scopeRef: string) => readonly LocateObservedRuntime[]
}

export type LocateRequest = { scopeRef: string; deps: LocateDeps }

function toRecord(binding: PlacementBinding | PlacementLedgerRecord): LocateBindingRecord {
  return {
    homeNodeId: binding.homeNodeId,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

function describeDeclaredPolicy(
  scopeRef: string,
  resolution: PlacementPolicyResolution
): LocateDeclaredPolicy {
  if (resolution.outcome === 'unreadable') {
    return { source: 'unavailable', detail: resolution.detail }
  }
  if (resolution.outcome === 'not-an-agent-scope' || resolution.outcome === 'no-profile') {
    return { source: 'none', detail: resolution.detail }
  }
  const { policy, profilePath } = resolution
  const placement = policy.placement
  if (placement === undefined && policy.provisioning?.node === undefined) {
    return { source: 'none', detail: `${profilePath} declares no placement.`, profilePath }
  }
  const pinKey = placementPinKey(scopeRef)
  const pin = pinKey === undefined ? undefined : placement?.pins[pinKey]
  if (pinKey !== undefined && pin !== undefined) {
    if (isReservedNodeId(pin)) {
      return {
        source: 'pin-invalid',
        pinKey,
        rawValue: pin,
        profilePath,
        detail: `Placement pin "${pinKey}" must name a real node.`,
      }
    }
    return { source: 'pin', pinKey, nodeId: pin, profilePath }
  }
  const home = placementHomeDeclaration(scopeRef, placement?.homes)
  if (home !== undefined) {
    if (isReservedNodeId(home.nodeId)) {
      return {
        source: 'task-default-invalid',
        taskKey: home.key,
        rawValue: home.nodeId,
        profilePath,
        detail: `Placement home "${home.key}" must name a real node.`,
      }
    }
    return { source: 'task-default', taskKey: home.key, nodeId: home.nodeId, profilePath }
  }
  const fallback = policy.provisioning?.node
  if (fallback === undefined) {
    return {
      source: 'none',
      detail: `${profilePath} declares no home for this scope.`,
      profilePath,
    }
  }
  if (fallback === 'local') {
    return { source: 'default_home_node(local)', nodeId: 'local', profilePath }
  }
  return { source: 'default_home_node', nodeId: fallback, profilePath }
}

function assessSkew(
  declared: LocateDeclaredPolicy,
  authority: LocateAuthority
): { skew?: LocateSkew; notes: LocateNote[] } {
  const notes: LocateNote[] = []
  if (authority.state !== 'bound') return { notes }
  const boundNodeId = authority.record.homeNodeId
  if (declared.source === 'pin') {
    if (declared.nodeId === boundNodeId) {
      notes.push({ code: 'pin-honored', detail: `Pin "${declared.pinKey}" matches the binding.` })
      return { notes }
    }
    return {
      skew: {
        kind: 'pin-vs-binding',
        pinKey: declared.pinKey,
        pinnedNodeId: declared.nodeId,
        boundNodeId,
        detail: `Pin names "${declared.nodeId}" but the durable binding names "${boundNodeId}".`,
      },
      notes,
    }
  }
  if (declared.source === 'task-default') {
    if (declared.nodeId === boundNodeId) {
      notes.push({
        code: 'task-default-honored',
        detail: `Task default "${declared.taskKey}" matches the binding.`,
      })
      return { notes }
    }
    return {
      skew: {
        kind: 'task-default-vs-binding',
        taskKey: declared.taskKey,
        taskDefaultNodeId: declared.nodeId,
        boundNodeId,
        detail: `Task default names "${declared.nodeId}" but the durable binding names "${boundNodeId}".`,
      },
      notes,
    }
  }
  const defaultNode =
    declared.source === 'default_home_node' || declared.source === 'default_home_node(local)'
      ? declared.nodeId
      : undefined
  if (defaultNode !== undefined) {
    notes.push({
      code:
        defaultNode === boundNodeId
          ? 'unpinned-established-locally'
          : 'unpinned-established-elsewhere',
      detail:
        defaultNode === boundNodeId
          ? `Default home "${defaultNode}" matches the binding.`
          : `Not skew: the default home is "${defaultNode}" while the existing binding names "${boundNodeId}".`,
    })
  }
  return { notes }
}

async function consultRegistry(scopeRef: string, deps: LocateDeps): Promise<LocateRegistryView> {
  try {
    const result = await deps.registry.consult(scopeRef)
    return result.outcome === 'bound'
      ? { outcome: 'bound', record: toRecord(result.binding) }
      : { outcome: 'unbound' }
  } catch (error) {
    if (error instanceof RegistryRefusedError) {
      return { outcome: 'unknown', detail: error.message, retryable: false }
    }
    return {
      outcome: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
      retryable: error instanceof RegistryUnreachableError,
    }
  }
}

async function readDesignation(scopeRef: string, deps: LocateDeps): Promise<LocateDesignationView> {
  if (!deps.federationConfigured) {
    return { outcome: 'not-consulted', detail: 'Federation is not configured.' }
  }
  if (deps.registry.readDesignation === undefined) {
    return { outcome: 'not-consulted', detail: 'Registry designation reads are unavailable.' }
  }
  try {
    const result = await deps.registry.readDesignation(scopeRef)
    return result.outcome === 'none'
      ? { outcome: 'none' }
      : { outcome: result.outcome, record: result.designation }
  } catch (error) {
    return {
      outcome: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
      retryable: error instanceof RegistryUnreachableError,
    }
  }
}

export async function locateScope(request: LocateRequest): Promise<ScopeLocation> {
  const { deps } = request
  const scopeRef = formatCanonicalScopeRef({ scopeRef: request.scopeRef })
  const declared = describeDeclaredPolicy(scopeRef, await deps.policyFor(scopeRef))
  const local = deps.ledger.get(scopeRef)
  const ledger: LocateLedgerView =
    local === undefined ? { state: 'absent' } : { state: local.state, record: toRecord(local) }
  const registry: LocateRegistryView =
    local?.state === 'active'
      ? { outcome: 'not-consulted', detail: 'The active local ledger is authoritative.' }
      : local?.state === 'retired'
        ? {
            outcome: 'not-consulted',
            detail: 'The permanent local retirement fence is authoritative.',
          }
        : !deps.federationConfigured
          ? { outcome: 'not-consulted', detail: 'Federation is not configured.' }
          : await consultRegistry(scopeRef, deps)
  let authority: LocateAuthority
  if (local?.state === 'active') {
    authority = { state: 'bound', source: 'ledger', record: toRecord(local), isLocal: true }
  } else if (local?.state === 'retired') {
    authority = { state: 'unbound' }
  } else if (registry.outcome === 'bound') {
    authority = {
      state: 'bound',
      source: 'registry',
      record: registry.record,
      isLocal: registry.record.homeNodeId === deps.localNodeId,
    }
  } else if (registry.outcome === 'unknown') {
    authority = { state: 'unknown', detail: registry.detail, retryable: registry.retryable }
  } else {
    authority = { state: 'unbound' }
  }
  const { skew, notes } = assessSkew(declared, authority)
  const retirement =
    local?.state === 'retired' &&
    local.retiredAt !== undefined &&
    local.retirementReason !== undefined
      ? {
          retiredNodeId: deps.localNodeId,
          reason: local.retirementReason,
          retiredAt: local.retiredAt,
        }
      : undefined
  if (retirement !== undefined) {
    notes.push({
      code: 'scope-retired',
      detail: `This node permanently retired the scope (${retirement.reason}).`,
    })
  }
  const runtimes = deps.observedFor(scopeRef)
  return {
    scopeRef,
    localNodeId: deps.localNodeId,
    federationConfigured: deps.federationConfigured,
    gateMode: deps.gateMode,
    declared,
    ledger,
    registry,
    designation: await readDesignation(scopeRef, deps),
    authority,
    observed: {
      scope: 'local-node-only',
      nodeId: deps.localNodeId,
      runtimeCount: runtimes.length,
      runtimes,
    },
    ...(skew === undefined ? {} : { skew }),
    notes,
    ...(retirement === undefined ? {} : { retirement }),
  }
}

export async function scanLedgerForSkew(options: {
  bindings: readonly PlacementLedgerRecord[]
  localNodeId: string
  policyFor: (scopeRef: string) => Promise<PlacementPolicyResolution>
}): Promise<LedgerSkewScan> {
  const skewed: { scopeRef: string; skew: LocateSkew }[] = []
  const unreadable: { scopeRef: string; detail: string }[] = []
  let scanned = 0
  for (const binding of options.bindings) {
    if (binding.state !== 'active') continue
    scanned += 1
    const declared = describeDeclaredPolicy(
      binding.scopeRef,
      await options.policyFor(binding.scopeRef)
    )
    if (declared.source === 'unavailable') {
      unreadable.push({ scopeRef: binding.scopeRef, detail: declared.detail })
      continue
    }
    const { skew } = assessSkew(declared, {
      state: 'bound',
      source: 'ledger',
      record: toRecord(binding),
      isLocal: binding.homeNodeId === options.localNodeId,
    })
    if (skew !== undefined) skewed.push({ scopeRef: binding.scopeRef, skew })
  }
  return { scanned, skewed, unreadable }
}
