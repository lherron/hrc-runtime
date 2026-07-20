/**
 * T-06609 — typed `summonIntent` and explicit-start-wins placement (spec §5).
 *
 * The question this task answers is one T-06608 could not: *who* is asking for
 * this session? Today's `create` / `createIfMissing` booleans cannot say. They
 * do not even agree with each other — dm and turn-handoff default to create
 * (`!== false`), selector-dispatch defaults to no-create (`=== true`) — and
 * `handleResolveSession` serves `hrc run`/`hrc start` AND generic SDK callers
 * through the same `create: true`. §5 forbids conflating those two, because an
 * operator's explicit start IS a one-shot placement declaration and an SDK
 * create must never be one.
 *
 * So intent becomes typed request data, carried only on the surface operators
 * actually enter through, and the gate consumes it instead of guessing.
 */

import { describe, expect, test } from 'bun:test'

import type { PlacementBinding } from 'hrc-store-sqlite'

import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import {
  SUMMON_GATE_REFUSAL_EVENT,
  type SummonGateDeps,
  evaluateSummonGate,
} from '../federation/summon-gate.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06609'
const LOCAL = 'max3'
const REMOTE = 'lab'

function binding(overrides: Partial<PlacementBinding> = {}): PlacementBinding {
  return {
    scopeRef: SCOPE,
    homeNodeId: LOCAL,
    placementEpoch: 1,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'default_home_node' },
    establishmentProvenance: 'default_home_node',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  } as PlacementBinding
}

function registryStub(behavior: RegistryConsultResult | Error): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      if (behavior instanceof Error) throw behavior
      return behavior
    },
    async establish() {
      throw new Error('establish must not be called from the gate evaluation path')
    },
  }
}

function ledgerStub(row: PlacementBinding | undefined) {
  return {
    activeAuthority(_scopeRef: string) {
      return row === undefined ? undefined : { ...row, state: 'active' as const }
    },
  }
}

function deps(overrides: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'advisory',
    federationConfigured: true,
    localNodeId: LOCAL,
    ledger: ledgerStub(undefined),
    registry: registryStub({ outcome: 'unbound' }),
    policyFor: async () => ({
      placement: { pins: {}, defaultHomeNode: REMOTE },
      claimsTask: false,
    }),
    ...overrides,
  } as SummonGateDeps
}

// -- Explicit start wins for VIRGIN, UNPINNED scopes --------------------------

describe('explicit-start-wins: the operator start is the placement declaration', () => {
  test('explicit_local establishes HERE even though default_home_node names another node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps(),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') return
    expect(result.evaluation.reason).toBe('virgin-establishment')
    expect(result.evaluation.homeNodeId).toBe(LOCAL)
    // Provenance keeps the binding explainable (§5): this is expected state,
    // not skew, precisely because it records WHY it landed here.
    expect(result.evaluation.establishmentProvenance).toBe('explicit_local')
  })

  test('the SAME scope and policy under implicit intent routes away', async () => {
    // The control for the test above. If this ever passes as an allow, the
    // typed field has stopped separating operators from SDK callers.
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps(),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('routed-elsewhere')
    expect(result.evaluation.homeNodeId).toBe(REMOTE)
  })

  test('explicit_local establishes HERE with no [placement] stanza at all', async () => {
    // An undeclared profile has no pins, so there is nothing for the operator's
    // one-shot declaration to contradict. The undeclared-placement refusal
    // exists to stop IMPLICIT summons falling back silently (§5) — an explicit
    // start is not a fallback, it is a declaration.
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({ policyFor: async () => undefined }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') return
    expect(result.evaluation.establishmentProvenance).toBe('explicit_local')
  })

  test('implicit with no [placement] stanza still refuses, naming the stanza line', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps({ policyFor: async () => undefined }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('undeclared-placement')
    expect(result.evaluation.diagnostic).toContain('[placement]')
  })

  test('explicit_local wins over default_home_node = "local" and records itself', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'local' },
          claimsTask: false,
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') return
    // Both routes land on this node, but provenance must say which authority
    // put it here — the operator, not the policy default.
    expect(result.evaluation.establishmentProvenance).toBe('explicit_local')
  })
})

// -- The guardrails: explicitness is not a master key -------------------------

describe('explicit_local binds ONLY while the registry is truly UNBOUND', () => {
  test('pinned elsewhere: an explicit start at the wrong node refuses', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        policyFor: async () => ({
          placement: {
            pins: { 'hrc-runtime:T-06609': REMOTE },
            defaultHomeNode: LOCAL,
          },
          claimsTask: false,
        }),
      }),
    })

    // Pins are hard constraints on EVERY path (§5).
    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('pin-mismatch')
    expect(result.evaluation.homeNodeId).toBe(REMOTE)
  })

  test('registry already bound elsewhere: explicit start refuses, never rebinds', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        registry: registryStub({ outcome: 'bound', binding: binding({ homeNodeId: REMOTE }) }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('bound-elsewhere')
    expect(result.evaluation.homeNodeId).toBe(REMOTE)
  })

  test('local ledger row homed elsewhere: explicit start refuses (rebind is the remedy)', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({ ledger: ledgerStub(binding({ homeNodeId: REMOTE, placementEpoch: 3 })) }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('bound-elsewhere')
  })

  test('rebuild state: old-home revoked but registry still names the old node -> refuse', async () => {
    // Revocation alone is not unbound. A revoked local row reads as absent
    // (`activeAuthority` returns undefined), so the registry is what stops the
    // explicit start from establishing a second authority mid-rebuild.
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub({ outcome: 'bound', binding: binding({ homeNodeId: REMOTE }) }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('bound-elsewhere')
  })

  test('rebuild state: registry names THIS node, local row absent -> idempotent activation', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        ledger: ledgerStub(undefined),
        registry: registryStub({
          outcome: 'bound',
          binding: binding({ homeNodeId: LOCAL, placementEpoch: 2 }),
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('allow')
    if (result.evaluation.decision !== 'allow') return
    // Finishing an activation at the registry's existing epoch — NOT a virgin
    // birth, so no establishment provenance is claimed for it.
    expect(result.evaluation.reason).toBe('registry-bound-local')
    expect(result.evaluation.establishmentProvenance).toBeUndefined()
  })

  test('a retired scope refuses an explicit start too', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        retirementFor: () => ({
          retiredNodeId: LOCAL,
          successorNodeId: REMOTE,
          retiredPlacementEpoch: 4,
          reason: 'namespace reconciliation',
        }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('scope-retired')
  })

  test('registry unreachable: an explicit start fails closed like any other', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({ registry: registryStub(new Error('boom')) }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('registry-unreachable')
    expect(result.evaluation.retryable).toBe(true)
  })

  test('policy resolution failure refuses even for explicit_local (a pin may exist)', async () => {
    // Without a readable policy the gate cannot prove the scope is UNPINNED,
    // and explicit-start-wins applies only to unpinned scopes. Allowing here
    // would let an unreadable config silently override a pin.
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        policyFor: async () => {
          throw new Error('profile unreadable')
        },
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('policy-unavailable')
    expect(result.evaluation.retryable).toBe(true)
  })
})

// -- Archived successors: explicitness cannot resurrect or move them ----------

describe('archived-continuation successors follow the binding regardless of intent', () => {
  test('explicit_local cannot move an archived successor off its bound node', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'archived-successor',
      intent: 'explicit_local',
      deps: deps({
        registry: registryStub({ outcome: 'bound', binding: binding({ homeNodeId: REMOTE }) }),
      }),
    })

    expect(result.evaluation.decision).toBe('refuse')
    if (result.evaluation.decision !== 'refuse') return
    expect(result.evaluation.reason).toBe('bound-elsewhere')
  })
})

// -- Provenance in the soak stream --------------------------------------------

describe('gate events carry the typed intent', () => {
  test('the refusal event reports intent and a typed intentSource', async () => {
    const events: Array<Record<string, unknown>> = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'implicit',
      deps: deps({
        log: (_level, event, details) => {
          if (event === SUMMON_GATE_REFUSAL_EVENT) events.push(details ?? {})
        },
      }),
    })

    expect(events.length).toBe(1)
    expect(events[0]?.['intent']).toBe('implicit')
    // The T-06608 provisional derivation is retired: soak data now records a
    // signal the caller actually sent rather than one the gate inferred.
    expect(events[0]?.['intentSource']).toBe('typed')
  })

  test('an explicit_local refusal is attributable to the operator', async () => {
    const events: Array<Record<string, unknown>> = []
    await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'resolve-session',
      intent: 'explicit_local',
      deps: deps({
        policyFor: async () => ({
          placement: { pins: { 'hrc-runtime:T-06609': REMOTE } },
          claimsTask: false,
        }),
        log: (_level, event, details) => {
          if (event === SUMMON_GATE_REFUSAL_EVENT) events.push(details ?? {})
        },
      }),
    })

    expect(events[0]?.['intent']).toBe('explicit_local')
    expect(events[0]?.['intentSource']).toBe('typed')
  })
})
