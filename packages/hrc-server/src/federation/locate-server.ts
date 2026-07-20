/**
 * Server-side wiring for `hrc target locate` and the doctor skew scan (T-06613).
 *
 * Locate has to run on the DAEMON, not in the CLI, for three reasons that all
 * point the same way: the placement ledger lives in the daemon's own SQLite; a
 * registry consult needs a peer token, and `registry-client.ts` is the single
 * sanctioned egress site for one; and observed-runtime truth is daemon state.
 * A CLI-side implementation would have to reach into all three and would put a
 * second, subtly different placement reader next to the gate's.
 *
 * WORKS WHEN THE GATE IS DARK. `assertSummonAuthority` returns early on an
 * unconfigured daemon, but locate must still answer — "federation is off here,
 * nothing is bound, this is what policy would say" is a real and common answer,
 * and an operator setting federation up needs it BEFORE the gate is live.
 * So this builds its own deps rather than reusing the gate's memoized context.
 *
 * READ-ONLY. Nothing here establishes, rebinds, or writes.
 */

import { formatCanonicalScopeRef } from 'hrc-core'
import type { LocateBindingsReport } from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase, PlacementLedgerRecord } from 'hrc-store-sqlite'

import { resolveLocalBirthAncestor } from './birth-credential.js'
import { deriveNodeIdFromHostname } from './federation-config.js'
import type { FederationConfig } from './federation-config.js'
import {
  type LocateDeps,
  type LocateObservedRuntime,
  type ScopeLocation,
  locateScope,
  projectBirthChain,
  scanLedgerForSkew,
} from './locate.js'
import { resolvePlacementPolicy } from './placement-policy.js'
import type { PlacementPolicyResolution } from './placement-policy.js'
import type { BindingRegistryClient } from './registry-client.js'
import {
  createUnavailableRegistryClient,
  resolveFederationRegistryClient,
} from './registry-resolution.js'

export type LocateServerContext = {
  readonly db: HrcDatabase
  readonly options?: { readonly federationConfig?: FederationConfig | undefined } | undefined
  readonly federationConfig?: FederationConfig | undefined
  /** Injected by tests; production derives one from the federation config. */
  readonly registryClient?: BindingRegistryClient | undefined
  /** Production local-authority client owned by the registry endpoint. */
  readonly bindingRegistryEndpoint?: { readonly registryClient: BindingRegistryClient } | undefined
  readonly policyFor?: ((scopeRef: string) => Promise<PlacementPolicyResolution>) | undefined
  readonly observedFor?: ((scopeRef: string) => readonly LocateObservedRuntime[]) | undefined
}

function configOf(server: LocateServerContext): FederationConfig | undefined {
  return server.federationConfig ?? server.options?.federationConfig
}

/**
 * Picks the same registry client as the summon gate. Every ambiguity resolves
 * to an UNAVAILABLE client rather than a guess: locate reporting "registry
 * unknown, here is why" is correct, and reading the wrong registry is not.
 */
function locateRegistryClient(
  config: FederationConfig | undefined,
  localRegistryClient?: BindingRegistryClient | undefined
): BindingRegistryClient {
  if (config === undefined || !config.sourceExists) {
    return createUnavailableRegistryClient('federation is not configured on this node')
  }
  return resolveFederationRegistryClient(config, localRegistryClient)
}

/**
 * Local-node observation: what is actually running here for this scope.
 *
 * F0 truth only. A scope bound elsewhere with no local runtime is the normal,
 * healthy case, so an empty list is information rather than a problem.
 */
function defaultObservedFor(
  server: LocateServerContext
): (scopeRef: string) => readonly LocateObservedRuntime[] {
  return (scopeRef: string) => {
    const canonical = formatCanonicalScopeRef({ scopeRef })
    return server.db.runtimes
      .listAll()
      .filter((row) => sameScope(row.scopeRef, canonical))
      .map((row) => ({
        runtimeId: row.runtimeId,
        laneRef: row.laneRef,
        status: row.status,
        transport: row.transport,
        updatedAt: row.updatedAt,
      }))
  }
}

/** Compares runtime rows to the located scope in canonical form on both sides. */
function sameScope(rowScopeRef: string, canonical: string): boolean {
  try {
    return formatCanonicalScopeRef({ scopeRef: rowScopeRef }) === canonical
  } catch {
    return rowScopeRef === canonical
  }
}

function buildLocateDeps(server: LocateServerContext): LocateDeps {
  const config = configOf(server)
  const federationConfigured = config?.sourceExists === true
  const ledger = createPlacementLedgerRepository(server.db.sqlite)

  return {
    localNodeId: config?.nodeId ?? deriveNodeIdFromHostname(),
    federationConfigured,
    gateMode: config?.gate.mode ?? 'off',
    ledger,
    registry:
      server.registryClient ??
      locateRegistryClient(config, server.bindingRegistryEndpoint?.registryClient),
    policyFor: server.policyFor ?? (async (scopeRef) => resolvePlacementPolicy(scopeRef)),
    observedFor: server.observedFor ?? defaultObservedFor(server),
    retirementFor: (scopeRef) => readScopeRetirement(server.db.sqlite, scopeRef),
    resolveBirthChain: (scopeRef) => projectBirthChain(resolveLocalBirthAncestor(ledger, scopeRef)),
  }
}

export async function locateScopeOnServer(
  server: LocateServerContext,
  scopeRef: string
): Promise<ScopeLocation> {
  return locateScope({ scopeRef, deps: buildLocateDeps(server) })
}

/**
 * The whole-ledger skew sweep behind the doctor surface.
 *
 * Scans this node's ledger only. That is the right F0 scope AND the right
 * doctor scope: a doctor reports on the node it is run against, and pin skew is
 * detectable from any node that holds the binding.
 */
export async function scanServerLedgerForSkew(
  server: LocateServerContext
): Promise<LocateBindingsReport> {
  const config = configOf(server)
  const ledger = createPlacementLedgerRepository(server.db.sqlite)
  let bindings: readonly PlacementLedgerRecord[] = []
  try {
    bindings = ledger.list()
  } catch {
    // A pre-federation database has no placement table. Nothing bound here is
    // an honest answer, not an error worth failing a health check over.
    bindings = []
  }

  const localNodeId = config?.nodeId ?? deriveNodeIdFromHostname()
  return {
    localNodeId,
    federationConfigured: config?.sourceExists === true,
    gateMode: config?.gate.mode ?? 'off',
    scan: await scanLedgerForSkew({
      bindings,
      localNodeId,
      policyFor: server.policyFor ?? (async (scopeRef) => resolvePlacementPolicy(scopeRef)),
    }),
  }
}
