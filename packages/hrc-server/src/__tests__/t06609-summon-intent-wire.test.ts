/**
 * T-06609 — the wire surface for `summonIntent`, and the race it deliberately
 * does NOT win.
 *
 * Two separate claims live here:
 *
 * 1. ABSENT MEANS IMPLICIT, and the field is validated rather than coerced. A
 *    caller who typos the value gets a 400, not a silent downgrade to implicit
 *    — a silent downgrade would turn an operator's placement declaration into a
 *    policy-routed summon with no signal that it happened.
 *
 * 2. RACES HAVE NO PRIORITY RULE (§5). Explicit intent decides *where a virgin
 *    scope is designated*, never *who wins a concurrent establishment*. First
 *    registry CAS wins either way; the loser is told bound-elsewhere. Rebind is
 *    the remedy for lost human intent — a priority rule here would reopen the
 *    linearization point the registry exists to close.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcDomainError } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { establishLocalPlacement } from '../federation/establishment.js'
import { parseResolveSessionRequest } from '../parsers/messages.js'

const SESSION_REF = 'agent:mable:project:hrc-runtime:task:T-06609/lane:main'
const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06609'

describe('parseResolveSessionRequest — typed summonIntent', () => {
  test('absent summonIntent is left absent, and means implicit downstream', async () => {
    const parsed = parseResolveSessionRequest({ sessionRef: SESSION_REF, create: true })
    expect(parsed.summonIntent).toBeUndefined()
  })

  test('explicit_local survives the wire', async () => {
    const parsed = parseResolveSessionRequest({
      sessionRef: SESSION_REF,
      create: true,
      summonIntent: 'explicit_local',
    })
    expect(parsed.summonIntent).toBe('explicit_local')
  })

  test('implicit survives the wire', async () => {
    const parsed = parseResolveSessionRequest({
      sessionRef: SESSION_REF,
      create: true,
      summonIntent: 'implicit',
    })
    expect(parsed.summonIntent).toBe('implicit')
  })

  test('an unknown value is a 400, never a silent downgrade to implicit', () => {
    expect(() =>
      parseResolveSessionRequest({
        sessionRef: SESSION_REF,
        create: true,
        summonIntent: 'explicit',
      })
    ).toThrow(HrcDomainError)
  })

  test('a non-string value is a 400', () => {
    expect(() =>
      parseResolveSessionRequest({ sessionRef: SESSION_REF, create: true, summonIntent: true })
    ).toThrow(HrcDomainError)
  })
})

describe('races have no priority rule: first registry write wins', () => {
  let tempDir: string | undefined

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  async function harness() {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t06609-race-'))
    // ONE registry, two nodes — the collective's single linearization point.
    const registry = openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
    const max3 = openHrcDatabase(join(tempDir, 'max3.sqlite'))
    const lab = openHrcDatabase(join(tempDir, 'lab.sqlite'))
    return {
      registry,
      max3Ledger: createPlacementLedgerRepository(max3.sqlite),
      labLedger: createPlacementLedgerRepository(lab.sqlite),
      close() {
        registry.close()
        max3.close()
        lab.close()
      },
    }
  }

  test('explicit_local does NOT beat an implicit summon that arrived first', async () => {
    const h = await harness()
    try {
      // The implicit summon lands first.
      const implicitFirst = await establishLocalPlacement({
        registry: h.registry,
        ledger: h.labLedger,
        request: {
          scopeRef: SCOPE,
          homeNodeId: 'lab',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'default_home_node' },
          establishmentProvenance: 'default_home_node',
          now: '2026-07-20T00:00:00.000Z',
        },
      })
      expect(implicitFirst.outcome).toBe('established')

      // The operator's explicit start arrives second and LOSES.
      const explicitSecond = await establishLocalPlacement({
        registry: h.registry,
        ledger: h.max3Ledger,
        request: {
          scopeRef: SCOPE,
          homeNodeId: 'max3',
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'explicit_local' },
          establishmentProvenance: 'explicit_local',
          now: '2026-07-20T00:00:01.000Z',
        },
      })

      expect(explicitSecond.outcome).toBe('bound-elsewhere')
      expect(explicitSecond.binding.homeNodeId).toBe('lab')
      // The loser installs NOTHING locally — never two authorities.
      expect(h.max3Ledger.activeAuthority(SCOPE)).toBeUndefined()
    } finally {
      h.close()
    }
  })

  test('concurrent explicit-vs-implicit establishment yields exactly one winner', async () => {
    const h = await harness()
    try {
      const [explicit, implicit] = await Promise.all([
        establishLocalPlacement({
          registry: h.registry,
          ledger: h.max3Ledger,
          request: {
            scopeRef: SCOPE,
            homeNodeId: 'max3',
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'explicit_local' },
            establishmentProvenance: 'explicit_local',
            now: '2026-07-20T00:00:00.000Z',
          },
        }),
        establishLocalPlacement({
          registry: h.registry,
          ledger: h.labLedger,
          request: {
            scopeRef: SCOPE,
            homeNodeId: 'lab',
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'default_home_node' },
            establishmentProvenance: 'default_home_node',
            now: '2026-07-20T00:00:00.000Z',
          },
        }),
      ])

      const outcomes = [explicit.outcome, implicit.outcome].sort()
      expect(outcomes).toEqual(['bound-elsewhere', 'established'])

      // Both nodes agree on the single registered binding.
      const winner = h.registry.get(SCOPE)
      expect(winner).toBeDefined()
      expect(explicit.binding.homeNodeId).toBe(winner!.homeNodeId)
      expect(implicit.binding.homeNodeId).toBe(winner!.homeNodeId)

      // Exactly one node holds local authority.
      const holders = [
        h.max3Ledger.activeAuthority(SCOPE) === undefined ? 0 : 1,
        h.labLedger.activeAuthority(SCOPE) === undefined ? 0 : 1,
      ]
      expect(holders[0]! + holders[1]!).toBe(1)
    } finally {
      h.close()
    }
  })
})
