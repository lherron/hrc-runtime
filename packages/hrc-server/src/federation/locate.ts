/**
 * `hrc target locate` — where does this scope live, and why? (T-06613, §5/§10)
 *
 * THREE INDEPENDENT TRUTHS, REPORTED SEPARATELY. Declared policy (what the
 * `[placement]` stanza says), the binding (what the ledger/registry recorded
 * when the scope was actually established), and observation (what is running
 * here right now) are collected without letting any one of them overwrite
 * another. Collapsing them into a single "home node" is precisely what makes a
 * misplaced scope invisible: the operator would see an answer and no way to
 * tell which layer produced it.
 *
 * SKEW IS ONE THING AND ONLY ONE THING. Per §5, skew is a PIN disagreeing with
 * an established binding. It is not "the binding is somewhere other than
 * default_home_node" — an unpinned scope established away from the default is
 * EXPECTED, because `default_home_node` is a routing hint for where implicit
 * summons go, not a constraint on where a scope may live. An operator's
 * explicit start elsewhere is a legitimate declaration (`explicit_local`), and
 * flagging it would train operators to ignore the flag. That case gets an
 * explanatory NOTE instead, which is what establishment provenance is for.
 *
 * SKEW CHANGES NOTHING. The established home keeps summon authority; the new
 * pin value is not acted on; nothing here reconciles. Locate reports and stops.
 * The remedy is a deliberate manual rebuild (F3), so the diagnostic names that
 * rather than implying the next summon will fix it.
 *
 * READ-ONLY AND NON-THROWING. Every failure — unreadable profile, unreachable
 * registry — becomes a typed field. A locate that dies because the registry is
 * down is useless exactly when it is most needed, and an unreachable registry
 * must never be rendered as "unbound": that would report a scope as free when
 * its binding was merely unread.
 *
 * F0 SCOPE. Observation is local-node truth only; asking peers what they are
 * running is F1. The binding lookup already spans the collective, since the
 * registry consult is a network call by construction.
 */

import type {
  PlacementBinding,
  PlacementLedgerRecord,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateBirthChain,
  LocateBirthChainLink,
  LocateDeclaredPolicy,
  LocateLedgerView,
  LocateNote,
  LocateObservation,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
} from 'hrc-core'

/**
 * The locate DTOs live in hrc-core (federation-contracts.ts) because hrc-sdk
 * builds before hrc-server and still has to deserialize them. Re-exported here
 * so this module stays the one place a reader looks for locate's shape.
 */
export type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateBirthChain,
  LocateBirthChainLink,
  LocateDeclaredPolicy,
  LocateLedgerView,
  LocateNote,
  LocateObservation,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
}

import { isReservedNodeId } from './node-id.js'
import type { PlacementPolicyResolution } from './placement-policy.js'
import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'
import type { BindingRegistryClient } from './registry-client.js'
import { placementPinKey } from './summon-gate.js'
import type { ScopeRetirement, SummonGateMode } from './summon-gate.js'

export type LocateBirthChainResult = {
  chain: readonly LocateBirthChainLink[]
  ancestor: LocateBirthChainLink
}

export type LocateDeps = {
  localNodeId: string
  federationConfigured: boolean
  gateMode: SummonGateMode
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'get'>
  registry: BindingRegistryClient
  policyFor: (scopeRef: string) => Promise<PlacementPolicyResolution>
  observedFor: (scopeRef: string) => readonly LocateObservedRuntime[]
  retirementFor?: ((scopeRef: string) => ScopeRetirement | undefined) | undefined
  /**
   * Birth-provenance chain resolution (T-06610, cody). Absent until that lands;
   * locate then reports the chain as unresolved rather than pretending a
   * mechanism-born scope has no ancestry.
   *
   * Shaped to adapt T-06610's `resolveLocalBirthAncestor(ledger, scopeRef)`
   * (federation/birth-credential.ts), which returns
   * `{ chain: PlacementLedgerRecord[]; ancestor: PlacementLedgerRecord }` and
   * throws on a cycle or an incomplete local chain. Wiring is one line:
   *
   *   resolveBirthChain: (scopeRef) =>
   *     projectBirthChain(resolveLocalBirthAncestor(ledger, scopeRef))
   *
   * The throw is caught here and reported as `unresolved` — an unwalkable chain
   * is a diagnosis locate should print, not an error that kills the report.
   */
  resolveBirthChain?:
    | ((scopeRef: string) => LocateBirthChainResult | Promise<LocateBirthChainResult>)
    | undefined
}

/** Projects T-06610 ledger records onto locate's display shape. */
export function projectBirthChain(result: {
  chain: readonly PlacementLedgerRecord[]
  ancestor: PlacementLedgerRecord
}): LocateBirthChainResult {
  const toLink = (record: PlacementLedgerRecord): LocateBirthChainLink => ({
    scopeRef: record.scopeRef,
    birthClass: record.birthClass,
    homeNodeId: record.homeNodeId,
    authorityProvenance: record.authorityProvenance,
  })
  return { chain: result.chain.map(toLink), ancestor: toLink(result.ancestor) }
}

export type LocateRequest = {
  scopeRef: string
  deps: LocateDeps
}

function toRecord(binding: PlacementBinding | PlacementLedgerRecord): LocateBindingRecord {
  return {
    homeNodeId: binding.homeNodeId,
    placementEpoch: binding.placementEpoch,
    birthClass: binding.birthClass,
    establishmentProvenance: binding.establishmentProvenance,
    authorityProvenance: binding.authorityProvenance,
    ...(binding.priorHomeNodeId === undefined ? {} : { priorHomeNodeId: binding.priorHomeNodeId }),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

/**
 * Projects a policy resolution onto the scope actually being located.
 *
 * The pin table is agent-wide; only the entry keyed by THIS scope's
 * `project:task` is the declaration for it. Reporting the whole table would let
 * a pin for a sibling task read as a pin for this one.
 */
function describeDeclaredPolicy(
  scopeRef: string,
  resolution: PlacementPolicyResolution,
  localNodeId: string
): LocateDeclaredPolicy {
  if (resolution.outcome === 'unreadable') {
    return { source: 'unavailable', detail: resolution.detail }
  }
  if (resolution.outcome === 'not-an-agent-scope' || resolution.outcome === 'no-profile') {
    return { source: 'none', detail: resolution.detail }
  }

  const { policy, profilePath } = resolution
  const placement = policy.placement
  if (placement === undefined) {
    return {
      source: 'none',
      detail: `${profilePath} declares no [placement] stanza.`,
      profilePath,
    }
  }

  const pinKey = placementPinKey(scopeRef)
  const pin = pinKey === undefined ? undefined : placement.pins[pinKey]
  if (pinKey !== undefined && pin !== undefined) {
    // Mirrors the gate's own rejection: a pin meaning "wherever" is not a pin.
    if (isReservedNodeId(pin)) {
      return {
        source: 'pin-invalid',
        pinKey,
        rawValue: pin,
        profilePath,
        detail: `Placement pin "${pinKey}" = "${pin}" is invalid: "local" is the reserved default_home_node sentinel and cannot be used as a pin. Name a real node, or move the value to default_home_node.`,
      }
    }
    return { source: 'pin', pinKey, nodeId: pin, profilePath }
  }

  const taskKey = placementPinKey(scopeRef, 'task-default')
  const taskDefault = taskKey === undefined ? undefined : placement.taskDefaults?.[taskKey]
  if (taskKey !== undefined && taskDefault !== undefined) {
    if (isReservedNodeId(taskDefault)) {
      return {
        source: 'task-default-invalid',
        taskKey,
        rawValue: taskDefault,
        profilePath,
        detail: `Placement task default [placement.task-defaults] "${taskKey}" = "${taskDefault}" is invalid: "local" is the reserved default_home_node sentinel and cannot be used as a task default. Name a real node, or move the value to default_home_node.`,
      }
    }
    return { source: 'task-default', taskKey, nodeId: taskDefault, profilePath }
  }

  const fallback = placement.defaultHomeNode
  if (fallback === undefined) {
    return {
      source: 'none',
      detail:
        pinKey === undefined
          ? `${profilePath} declares no default_home_node, and this scope has no task component to pin.`
          : `${profilePath} declares no default_home_node and no pin for "${pinKey}".`,
      profilePath,
    }
  }
  if (isReservedNodeId(fallback)) {
    return { source: 'default_home_node(local)', nodeId: localNodeId, profilePath }
  }
  return { source: 'default_home_node', nodeId: fallback, profilePath }
}

function declaredHomeNodeId(declared: LocateDeclaredPolicy): string | undefined {
  switch (declared.source) {
    case 'pin':
    case 'task-default':
    case 'default_home_node':
    case 'default_home_node(local)':
      return declared.nodeId
    default:
      return undefined
  }
}

/**
 * Detects skew and, when there is none, explains any divergence that a reader
 * would otherwise mistake for skew.
 */
function assessSkew(
  declared: LocateDeclaredPolicy,
  authority: LocateAuthority
): { skew?: LocateSkew | undefined; notes: LocateNote[] } {
  const notes: LocateNote[] = []
  if (authority.state !== 'bound') return { notes }

  const bound = authority.record

  if (declared.source === 'pin') {
    if (declared.nodeId === bound.homeNodeId) {
      notes.push({
        code: 'pin-honored',
        detail: `Pin "${declared.pinKey}" = "${declared.nodeId}" matches the established binding.`,
      })
      return { notes }
    }
    return {
      skew: {
        kind: 'pin-vs-binding',
        pinKey: declared.pinKey,
        pinnedNodeId: declared.nodeId,
        boundNodeId: bound.homeNodeId,
        placementEpoch: bound.placementEpoch,
        establishmentProvenance: bound.establishmentProvenance,
        detail: [
          `SKEW: pin "${declared.pinKey}" = "${declared.nodeId}", but this scope is established on "${bound.homeNodeId}" (epoch ${bound.placementEpoch}, established by ${bound.establishmentProvenance}).`,
          `"${bound.homeNodeId}" keeps summon authority. The pin value is NOT acted on and nothing reconciles automatically.`,
          'To move the scope, rebuild the binding deliberately; editing the pin alone will not relocate an established scope.',
        ].join('\n'),
      },
      notes,
    }
  }

  if (declared.source === 'task-default') {
    if (declared.nodeId === bound.homeNodeId) {
      notes.push({
        code: 'task-default-honored',
        detail: `Task default [placement.task-defaults] "${declared.taskKey}" = "${declared.nodeId}" matches the established binding.`,
      })
      return { notes }
    }
    return {
      skew: {
        kind: 'task-default-vs-binding',
        taskKey: declared.taskKey,
        taskDefaultNodeId: declared.nodeId,
        boundNodeId: bound.homeNodeId,
        placementEpoch: bound.placementEpoch,
        establishmentProvenance: bound.establishmentProvenance,
        detail: [
          `SKEW: task default [placement.task-defaults] "${declared.taskKey}" = "${declared.nodeId}", but this scope is established on "${bound.homeNodeId}" (epoch ${bound.placementEpoch}, established by ${bound.establishmentProvenance}).`,
          `"${bound.homeNodeId}" keeps summon authority. The task-default value is NOT acted on and nothing reconciles automatically.`,
          'To move the scope, rebuild the binding deliberately; editing the task-default alone will not relocate an established scope.',
        ].join('\n'),
      },
      notes,
    }
  }

  // Everything below is EXPECTED state, per §5. It is noted, never flagged.
  const declaredHome = declaredHomeNodeId(declared)
  if (declaredHome !== undefined && declaredHome !== bound.homeNodeId) {
    notes.push({
      code: 'unpinned-established-elsewhere',
      detail: `Not skew: default_home_node is "${declaredHome}" but this scope is established on "${bound.homeNodeId}" (by ${bound.establishmentProvenance}). default_home_node routes implicit summons for scopes with no binding yet; it does not constrain where an established scope lives. Pin the scope if it must live on "${declaredHome}".`,
    })
  } else if (declaredHome !== undefined) {
    notes.push({
      code: 'unpinned-established-locally',
      detail: `default_home_node "${declaredHome}" matches the established binding.`,
    })
  }
  return { notes }
}

async function consultRegistry(scopeRef: string, deps: LocateDeps): Promise<LocateRegistryView> {
  try {
    const result = await deps.registry.consult(scopeRef)
    if (result.outcome === 'bound') return { outcome: 'bound', record: toRecord(result.binding) }
    if (result.outcome === 'retired') {
      const retired = result.retirement
      return {
        outcome: 'retired',
        record: {
          placementEpoch: retired.placementEpoch,
          retiredHomeNodeId: retired.retiredHomeNodeId,
          successorNodeId: retired.successorNodeId,
          birthClass: retired.birthClass,
          authorityProvenance: retired.authorityProvenance,
          createdAt: retired.createdAt,
          updatedAt: retired.updatedAt,
          retiredAt: retired.retiredAt,
          reason: retired.reason,
        },
      }
    }
    return { outcome: 'unbound' }
  } catch (error) {
    if (error instanceof RegistryRefusedError) {
      return { outcome: 'unknown', detail: error.message, retryable: false }
    }
    if (error instanceof RegistryUnreachableError) {
      return { outcome: 'unknown', detail: error.message, retryable: true }
    }
    return {
      outcome: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
  }
}

async function resolveBirthChain(
  scopeRef: string,
  authority: LocateAuthority,
  deps: LocateDeps
): Promise<{ chain: LocateBirthChain; note?: LocateNote | undefined }> {
  if (authority.state !== 'bound' || authority.record.birthClass !== 'mechanism-born') {
    return {
      chain: {
        state: 'not-applicable',
        detail:
          authority.state === 'bound'
            ? 'Policy-born scope: authority comes from placement policy, not from a birth chain.'
            : 'No established binding, so there is no birth chain to resolve.',
      },
    }
  }

  const resolver = deps.resolveBirthChain
  if (resolver === undefined) {
    const detail =
      'Mechanism-born scope: birth-provenance chain resolution is not wired on this daemon (T-06610). The recorded authorityProvenance is shown verbatim above.'
    return {
      chain: { state: 'unresolved', detail },
      note: { code: 'birth-chain-unresolved', detail },
    }
  }

  try {
    const resolved = await resolver(scopeRef)
    return {
      chain: { state: 'resolved', links: resolved.chain, ancestor: resolved.ancestor },
    }
  } catch (error) {
    const detail = `Birth-chain resolution failed: ${error instanceof Error ? error.message : String(error)}`
    return {
      chain: { state: 'unresolved', detail },
      note: { code: 'birth-chain-unresolved', detail },
    }
  }
}

/**
 * Collects declared policy, binding, and observation for one scope.
 *
 * Never throws: an operator reaching for locate is usually already in a bad
 * state, and a report with one unavailable section beats a stack trace.
 */
export async function locateScope(request: LocateRequest): Promise<ScopeLocation> {
  const { deps } = request
  const scopeRef = formatCanonicalScopeRef({ scopeRef: request.scopeRef })

  const policyResolution = await deps.policyFor(scopeRef)
  const declared = describeDeclaredPolicy(scopeRef, policyResolution, deps.localNodeId)

  const ledgerRow = deps.ledger.get(scopeRef)
  const ledger: LocateLedgerView =
    ledgerRow === undefined
      ? { state: 'absent' }
      : { state: ledgerRow.state, record: toRecord(ledgerRow) }
  const retirement = deps.retirementFor?.(scopeRef)
  const retiredHere = retirement?.retiredNodeId === deps.localNodeId

  // Ledger-first, matching the gate. The registry is consulted only when the
  // local ledger holds no ACTIVE authority — a revoked row is not authority, so
  // it still needs the collective's answer.
  const rawLocalAuthority = deps.ledger.activeAuthority(scopeRef)
  const localAuthority =
    retiredHere &&
    retirement !== undefined &&
    rawLocalAuthority !== undefined &&
    rawLocalAuthority.placementEpoch <= retirement.retiredPlacementEpoch
      ? undefined
      : rawLocalAuthority
  const registry: LocateRegistryView =
    localAuthority !== undefined
      ? {
          outcome: 'not-consulted',
          detail:
            'This node holds an active ledger binding, which is the authority the gate acts on.',
        }
      : !deps.federationConfigured
        ? {
            outcome: 'not-consulted',
            detail:
              'Federation is not configured on this node, so there is no registry to consult.',
          }
        : await consultRegistry(scopeRef, deps)

  let authority: LocateAuthority
  if (localAuthority !== undefined) {
    authority = {
      state: 'bound',
      source: 'ledger',
      record: toRecord(localAuthority),
      isLocal: localAuthority.homeNodeId === deps.localNodeId,
    }
  } else if (registry.outcome === 'bound') {
    authority = {
      state: 'bound',
      source: 'registry',
      record: registry.record,
      isLocal: registry.record.homeNodeId === deps.localNodeId,
    }
  } else if (registry.outcome === 'retired') {
    authority = {
      state: 'retired',
      placementEpoch: registry.record.placementEpoch,
      retiredHomeNodeId: registry.record.retiredHomeNodeId,
      successorNodeId: registry.record.successorNodeId,
      birthClass: registry.record.birthClass,
      authorityProvenance: registry.record.authorityProvenance,
    }
  } else if (registry.outcome === 'unbound') {
    authority = { state: 'unbound' }
  } else if (registry.outcome === 'unknown') {
    authority = { state: 'unknown', detail: registry.detail, retryable: registry.retryable }
  } else {
    authority = { state: 'unbound' }
  }

  // The summon gate checks a local retirement mark before the active ledger.
  // Locate/doctor must not describe that deliberately-retired ledger residue
  // as live pin skew: reconciliation keeps the row for history, but it no
  // longer grants summon authority on this node.
  const { skew, notes } = retiredHere ? { notes: [] } : assessSkew(declared, authority)

  if (retirement !== undefined) {
    notes.push({
      code: 'scope-retired',
      detail:
        retirement.successorNodeId === null
          ? `This node holds an epoch fence for ${scopeRef}: retired here at epoch ${retirement.retiredPlacementEpoch}, terminally barred (${retirement.reason}).`
          : `This node holds an epoch fence for ${scopeRef}: retired here at epoch ${retirement.retiredPlacementEpoch}, successor "${retirement.successorNodeId}" may activate at epoch ${retirement.retiredPlacementEpoch + 1} (${retirement.reason}).`,
    })
  }

  const { chain, note: chainNote } = await resolveBirthChain(scopeRef, authority, deps)
  if (chainNote !== undefined) notes.push(chainNote)

  return {
    scopeRef,
    localNodeId: deps.localNodeId,
    federationConfigured: deps.federationConfigured,
    gateMode: deps.gateMode,
    declared,
    ledger,
    registry,
    authority,
    observed: {
      scope: 'local-node-only',
      nodeId: deps.localNodeId,
      runtimes: deps.observedFor(scopeRef),
      runtimeCount: deps.observedFor(scopeRef).length,
    },
    ...(skew === undefined ? {} : { skew }),
    notes,
    ...(retirement === undefined ? {} : { retirement }),
    birthChain: chain,
  }
}

/**
 * Scans every binding this node's ledger knows for pin-vs-binding skew.
 *
 * The doctor surface needs "is anything skewed here?" without the operator
 * naming a scope, which is the whole reason skew is worth surfacing at all: a
 * pin edited to a new node produces no error anywhere until someone looks.
 */
export async function scanLedgerForSkew(options: {
  bindings: readonly PlacementLedgerRecord[]
  localNodeId: string
  policyFor: (scopeRef: string) => Promise<PlacementPolicyResolution>
  retirementFor?: ((scopeRef: string) => ScopeRetirement | undefined) | undefined
}): Promise<LedgerSkewScan> {
  const skewed: { scopeRef: string; skew: LocateSkew }[] = []
  const unreadable: { scopeRef: string; detail: string }[] = []

  for (const binding of options.bindings) {
    if (binding.state !== 'active') continue
    const retirement = options.retirementFor?.(binding.scopeRef)
    if (
      retirement?.retiredNodeId === options.localNodeId &&
      binding.placementEpoch <= retirement.retiredPlacementEpoch
    ) {
      continue
    }
    const resolution = await options.policyFor(binding.scopeRef)
    const declared = describeDeclaredPolicy(binding.scopeRef, resolution, options.localNodeId)
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

  return { scanned: options.bindings.length, skewed, unreadable }
}
