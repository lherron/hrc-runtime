import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type PlacementBinding,
  createPlacementLedgerRepository,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import {
  HRC_BIRTH_CREDENTIAL_ENV,
  injectRuntimeBirthCredential,
  resolveLocalBirthAncestor,
  validateRuntimeBirthCredential,
} from '../federation/birth-credential.js'
import type { FederationConfig } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { assertSummonAuthority } from '../federation/summon-gate-server.js'
import { type SummonGateDeps, evaluateSummonGate } from '../federation/summon-gate.js'

const PARENT_SCOPE = 'agent:mable:project:hrc-runtime:task:T-06597'
const CHILD_SCOPE = 'agent:cody:project:hrc-runtime:task:T-06610'
const GRANDCHILD_SCOPE = 'agent:clod:project:hrc-runtime:task:T-06611'
const RUNTIME_ID = 'rt-parent-stable'
const RUN_A = 'run-parent-a'
const RUN_B = 'run-parent-b'
const NOW = '2026-07-20T06:30:00.000Z'

describe('T-06610 runtime-stable birth credential', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function database() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06610-birth-'))
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    db.sessions.insert({
      hostSessionId: 'hsid-parent',
      scopeRef: PARENT_SCOPE,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      runtimeKind: 'harness',
      hostSessionId: 'hsid-parent',
      scopeRef: PARENT_SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex',
      provider: 'openai',
      status: 'busy',
      supportsInflightInput: true,
      adopted: false,
      activeRunId: RUN_B,
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.runs.insert({
      runId: RUN_A,
      hostSessionId: 'hsid-parent',
      runtimeId: RUNTIME_ID,
      scopeRef: PARENT_SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      status: 'completed',
      completedAt: NOW,
      updatedAt: NOW,
    })
    db.runs.insert({
      runId: RUN_B,
      hostSessionId: 'hsid-parent',
      runtimeId: RUNTIME_ID,
      scopeRef: PARENT_SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      status: 'running',
      acceptedAt: NOW,
      startedAt: NOW,
      updatedAt: NOW,
    })
    return db
  }

  test('the injected credential is the runtime identity, never the rotating run identity', () => {
    expect(HRC_BIRTH_CREDENTIAL_ENV).toBe('HRC_BIRTH_CREDENTIAL')
    expect(RUNTIME_ID).not.toBe(RUN_A)
    expect(RUNTIME_ID).not.toBe(RUN_B)
    expect(
      injectRuntimeBirthCredential(
        { KEEP: 'yes', [HRC_BIRTH_CREDENTIAL_ENV]: 'caller-spoof' },
        RUNTIME_ID
      )
    ).toEqual({ KEEP: 'yes', [HRC_BIRTH_CREDENTIAL_ENV]: RUNTIME_ID })
  })

  test('after run A ends, the same credential derives current run B from daemon tables', async () => {
    const db = await database()
    try {
      const validation = validateRuntimeBirthCredential(db, RUNTIME_ID)
      expect(validation).toEqual({
        valid: true,
        provenance: {
          kind: 'child-birth',
          parentScopeRef: PARENT_SCOPE,
          parentRuntimeId: RUNTIME_ID,
          parentRunId: RUN_B,
        },
      })
    } finally {
      db.close()
    }
  })

  test('a dead runtime credential is a visible zombie refusal, never a placement fallback', async () => {
    const db = await database()
    try {
      db.runs.markCompleted(RUN_B, {
        status: 'completed',
        completedAt: NOW,
        updatedAt: NOW,
      })
      const validation = validateRuntimeBirthCredential(db, RUNTIME_ID)
      expect(validation.valid).toBe(false)
      if (validation.valid) throw new Error('unreachable')
      expect(validation.reason).toBe('zombie-runtime')
      expect(validation.diagnostic).toContain(RUNTIME_ID)
      expect(validation.diagnostic).toContain(RUN_B)
    } finally {
      db.close()
    }
  })

  test('the completion race linearizes: validation-first reserves run B; completion-first refuses', async () => {
    const db = await database()
    try {
      // Birth wins the serialization point. The immutable permit names the run
      // that was live at that point even if it completes immediately after.
      const birthFirst = validateRuntimeBirthCredential(db, RUNTIME_ID)
      expect(birthFirst.valid).toBe(true)
      db.runs.markCompleted(RUN_B, {
        status: 'completed',
        completedAt: NOW,
        updatedAt: NOW,
      })
      expect(birthFirst.valid && birthFirst.provenance.parentRunId).toBe(RUN_B)

      // Completion wins on the other interleaving. No dead-run birth permit is
      // produced, so callers cannot mint from a zombie.
      const completionFirst = validateRuntimeBirthCredential(db, RUNTIME_ID)
      expect(completionFirst.valid).toBe(false)
      if (completionFirst.valid) throw new Error('unreachable')
      expect(completionFirst.reason).toBe('zombie-runtime')
    } finally {
      db.close()
    }
  })

  test('a registry-first crash retry installs the exact existing child binding before mint', async () => {
    const db = await database()
    try {
      const existing = binding()
      const server = {
        db,
        federationConfig: {
          nodeId: 'max3',
          nodeIdProvenance: 'declared',
          sourcePath: '/tmp/federation.json',
          sourceExists: true,
          peers: new Map(),
          gate: { mode: 'enforce' },
          warnings: [],
        } as FederationConfig,
        registryClient: {
          async consult() {
            return { outcome: 'bound' as const, binding: existing }
          },
          async establish() {
            throw new Error('an existing registry binding must not be established again')
          },
        },
        policyFor: async () => {
          throw new Error('an existing registry binding must not consult policy')
        },
        capabilityFor: async () => ({ outcome: 'capable' as const }),
      }

      const result = await assertSummonAuthority(server, {
        scopeRef: CHILD_SCOPE,
        path: 'ensure-target',
        birthCredential: RUNTIME_ID,
      })

      expect(result?.evaluation.reason).toBe('registry-bound-local')
      expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(CHILD_SCOPE)).toEqual({
        ...existing,
        state: 'active',
      })
    } finally {
      db.close()
    }
  })
})

function binding(overrides: Partial<PlacementBinding> = {}): PlacementBinding {
  return {
    scopeRef: CHILD_SCOPE,
    homeNodeId: 'max3',
    placementEpoch: 1,
    birthClass: 'mechanism-born',
    authorityProvenance: {
      kind: 'child-birth',
      parentScopeRef: PARENT_SCOPE,
      parentRuntimeId: RUNTIME_ID,
      parentRunId: RUN_B,
    },
    establishmentProvenance: 'explicit_local',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function registryUnbound(): BindingRegistryClient {
  return {
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish(request) {
      return {
        outcome: 'created',
        binding: binding({
          scopeRef: request.scopeRef,
          homeNodeId: request.homeNodeId,
          birthClass: request.birthClass,
          authorityProvenance: request.authorityProvenance,
          establishmentProvenance: request.establishmentProvenance,
        }),
      }
    },
  }
}

describe('T-06610 child-birth at the summon gate', () => {
  function deps(
    validateBirthCredential: NonNullable<SummonGateDeps['validateBirthCredential']>
  ): SummonGateDeps {
    return {
      mode: 'enforce',
      federationConfigured: true,
      localNodeId: 'max3',
      ledger: { activeAuthority: () => undefined },
      registry: registryUnbound(),
      policyFor: async () => {
        throw new Error('placement policy must be ignored for child-birth')
      },
      capabilityFor: async () => ({ outcome: 'capable' }),
      validateBirthCredential,
    }
  }

  test('valid credential yields mechanism birth and never consults placement policy', async () => {
    let capabilityCalls = 0
    const provenance = {
      kind: 'child-birth' as const,
      parentScopeRef: PARENT_SCOPE,
      parentRuntimeId: RUNTIME_ID,
      parentRunId: RUN_B,
    }
    const gateDeps = deps(() => ({ valid: true, provenance }))
    gateDeps.capabilityFor = async () => {
      capabilityCalls += 1
      return { outcome: 'capable' }
    }
    const result = await evaluateSummonGate({
      scopeRef: CHILD_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: RUNTIME_ID,
      deps: gateDeps,
    })

    expect(result.evaluation).toEqual({
      decision: 'allow',
      reason: 'child-birth',
      homeNodeId: 'max3',
      birthClass: 'mechanism-born',
      authorityProvenance: provenance,
    })
    expect(capabilityCalls).toBe(1)
  })

  test('invalid supplied credential refuses instead of falling back to implicit placement', async () => {
    const result = await evaluateSummonGate({
      scopeRef: CHILD_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      birthCredential: 'spoofed',
      deps: deps(() => ({
        valid: false,
        reason: 'invalid-birth-credential',
        diagnostic: 'unknown birth credential',
      })),
    })

    expect(result.evaluation.decision).toBe('refuse')
    expect(result.evaluation.reason).toBe('invalid-birth-credential')
    expect(result.enforced).toBe(true)
  })

  test('missing credential follows summon intent and never invokes the validator', async () => {
    let calls = 0
    const result = await evaluateSummonGate({
      scopeRef: CHILD_SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: {
        ...deps(() => {
          calls += 1
          throw new Error('must not validate an absent credential')
        }),
        policyFor: async () => ({
          placement: { pins: {}, defaultHomeNode: 'lab' },
          claimsTask: false,
        }),
      },
    })

    expect(calls).toBe(0)
    expect(result.evaluation.reason).toBe('routed-elsewhere')
  })
})

describe('T-06610 local provenance-chain resolution', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  test('walks child -> child -> policy ancestor and terminates there', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06610-chain-'))
    const db = openHrcDatabase(join(tempDir, 'state.sqlite'))
    try {
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive({
        ...binding({
          scopeRef: PARENT_SCOPE,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'default_home_node' },
          establishmentProvenance: 'default_home_node',
        }),
        state: 'active',
      })
      ledger.installActive({ ...binding({ scopeRef: CHILD_SCOPE }), state: 'active' })
      ledger.installActive({
        ...binding({
          scopeRef: GRANDCHILD_SCOPE,
          authorityProvenance: {
            kind: 'child-birth',
            parentScopeRef: CHILD_SCOPE,
            parentRuntimeId: 'rt-child',
            parentRunId: 'run-child',
          },
        }),
        state: 'active',
      })

      const located = resolveLocalBirthAncestor(ledger, GRANDCHILD_SCOPE)
      expect(located.chain.map((row) => row.scopeRef)).toEqual([
        GRANDCHILD_SCOPE,
        CHILD_SCOPE,
        PARENT_SCOPE,
      ])
      expect(located.ancestor.scopeRef).toBe(PARENT_SCOPE)
      expect(located.ancestor.birthClass).toBe('policy-born')
    } finally {
      db.close()
    }
  })
})
