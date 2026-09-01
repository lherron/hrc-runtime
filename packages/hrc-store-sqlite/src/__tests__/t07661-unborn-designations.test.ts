import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from '../index.js'
import type { BindingRegistry, BirthDesignationEstablishmentDecision } from '../index.js'

/**
 * T-07661 — the registry's answer to "which virgin births does that node owe?".
 *
 * It exists because a designated scope whose establish was refused has no other
 * wake source at all: the kicker's ledger tail consumed its one insert wake, and
 * the periodic sweep only looks at scopes a node already seats. Nobody seats a
 * scope that was never born.
 *
 * The property that is easy to get wrong, and is asserted first: a designation
 * stays `live` after the tier-5 birth it authorised — nothing supersedes it —
 * so "live and naming me" alone names every scope this node has EVER borne, and
 * grows without bound. The binding is what says the birth already happened.
 */

const SENDER = 'agent:mable:project:wrkq:task:primary'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function registry(): Promise<BindingRegistry> {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07661-registry-'))
  return openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
}

function designate(store: BindingRegistry, scopeRef: string, homeNodeId: string) {
  return store.recordDesignation({
    scopeRef,
    homeNodeId,
    provenance: 'default_home_node(sender)',
    birthEnvelopeId: 'EN-00745',
    senderScopeRef: SENDER,
    now: '2026-08-28T07:00:00.000Z',
  })
}

function establish(
  store: BindingRegistry,
  scopeRef: string,
  homeNodeId: string,
  birthDesignation?: BirthDesignationEstablishmentDecision
) {
  return store.establish({
    scopeRef,
    homeNodeId,
    ...(birthDesignation === undefined ? {} : { birthDesignation }),
    now: '2026-08-28T07:01:00.000Z',
  })
}

const UNBORN = 'agent:cody:project:hrc-runtime:task:T-07661-a'
const BORN = 'agent:cody:project:hrc-runtime:task:T-07661-b'
const ELSEWHERE = 'agent:cody:project:hrc-runtime:task:T-07661-c'
const RETIRED = 'agent:cody:project:hrc-runtime:task:T-07661-d'

describe('T-07661 — unborn designations for a node', () => {
  test('names a designated scope with no binding, and nothing else', async () => {
    const store = await registry()
    try {
      designate(store, UNBORN, 'max3')
      designate(store, BORN, 'max3')
      designate(store, ELSEWHERE, 'lab')
      // The birth its own designation authorised. The designation is STILL
      // live afterwards — a tier-5 establish agrees with it rather than
      // superseding it — so only the binding can retire it from this answer.
      establish(store, BORN, 'max3', { action: 'enforce-designated-home' })
      expect(store.liveDesignation(BORN)?.state).toBe('live')

      expect(store.listUnbornDesignationsForNode('max3').map((row) => row.scopeRef)).toEqual([
        UNBORN,
      ])
      expect(store.listUnbornDesignationsForNode('lab').map((row) => row.scopeRef)).toEqual([
        ELSEWHERE,
      ])
      // The whole record travels, because the kicker's log line names the
      // sender and the envelope an operator would otherwise have to find.
      expect(store.listUnbornDesignationsForNode('max3')[0]).toMatchObject({
        homeNodeId: 'max3',
        provenance: 'default_home_node(sender)',
        birthEnvelopeId: 'EN-00745',
        senderScopeRef: SENDER,
        designationEpoch: 1,
        state: 'live',
      })
    } finally {
      store.close()
    }
  })

  test('a retired scope is not a virgin birth', async () => {
    const store = await registry()
    try {
      designate(store, RETIRED, 'max3')
      establish(store, RETIRED, 'max3', { action: 'enforce-designated-home' })
      const retired = store.deleteBinding({
        scopeRef: RETIRED,
        expectedHomeNodeId: 'max3',
        retiredAt: '2026-08-28T07:02:00.000Z',
      })
      expect(retired.outcome).toBe('deleted')

      // Retirement clears the live designation so the old home is never
      // re-woken as though it still owed the original birth.
      expect(store.listUnbornDesignationsForNode('max3')).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test('a superseded designation is not owed to anybody', async () => {
    const store = await registry()
    try {
      designate(store, UNBORN, 'max3')
      // A tier-1-4 establishment wins and supersedes the designation in the
      // same transaction. The scope is bound, so it leaves the answer for two
      // independent reasons; assert the designation state moved as well.
      establish(store, UNBORN, 'lab', { action: 'supersede', supersededBy: 'pin' })
      expect(store.liveDesignation(UNBORN)).toBeUndefined()
      expect(store.listUnbornDesignationsForNode('max3')).toHaveLength(0)
      expect(store.listUnbornDesignationsForNode('lab')).toHaveLength(0)
    } finally {
      store.close()
    }
  })
})
