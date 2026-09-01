import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from '../index.js'
import type { BindingRegistry, BirthDesignationEstablishmentDecision } from '../index.js'

/**
 * T-07655 — the registry half of the tier-5 birth designation.
 *
 * Everything asserted here happens inside ONE SQLite transaction with the
 * binding write, which is the whole reason the designation lives in the
 * registry database. A designation stored anywhere else could only be updated
 * after the binding committed, leaving a window in which the two disagree.
 */

const TARGET = 'agent:cody:project:hrc-runtime:task:T-07655'
const SENDER = 'agent:mable:project:wrkq:task:primary'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function registry(): Promise<BindingRegistry> {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07655-registry-'))
  return openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
}

function designate(store: BindingRegistry, homeNodeId: string, at = '2026-08-28T05:00:00.000Z') {
  return store.recordDesignation({
    scopeRef: TARGET,
    homeNodeId,
    provenance: 'default_home_node(sender)',
    birthEnvelopeId: 'EN-00722',
    senderScopeRef: SENDER,
    now: at,
  })
}

function establish(
  store: BindingRegistry,
  homeNodeId: string,
  birthDesignation?: BirthDesignationEstablishmentDecision,
  at = '2026-08-28T05:01:00.000Z'
) {
  return store.establish({
    scopeRef: TARGET,
    homeNodeId,
    ...(birthDesignation === undefined ? {} : { birthDesignation }),
    now: at,
  })
}

describe('T-07655 birth designation', () => {
  // Acceptance 1(c). Idempotency is what makes a designation a FACT about a
  // scope rather than an answer about whoever asked first: every node that
  // tailed the same ledger insert asks, and all of them must get one answer.
  test('a second designation for a live scope returns the first, and mints no second row', async () => {
    const store = await registry()
    try {
      const first = designate(store, 'max3')
      expect(first.designationEpoch).toBe(1)
      expect(first.state).toBe('live')

      // A later caller naming a DIFFERENT home cannot move it. This is the
      // shape of the sender having retired and reactivated between two asks.
      const second = store.recordDesignation({
        scopeRef: TARGET,
        homeNodeId: 'svc',
        provenance: 'default_home_node(sender-retired)',
        birthEnvelopeId: 'EN-99999',
        senderScopeRef: 'agent:someone:project:x:task:y',
        now: '2026-08-28T05:00:30.000Z',
      })
      expect(second).toEqual(first)
      expect(store.designationHistory(TARGET)).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  // Acceptance 1(f). The fence refuses ONE thing: another tier-5 birth that
  // disagrees. Nothing is written, so this is not a race lost — it is the
  // arbitration that stops the race.
  test('a tier-5 birth on a non-designated node is refused, and writes no binding', async () => {
    const store = await registry()
    try {
      designate(store, 'max3')
      const refused = establish(store, 'svc', { action: 'enforce-designated-home' })

      expect(refused.outcome).toBe('designation-mismatch')
      if (refused.outcome !== 'designation-mismatch') throw new Error('unreachable')
      expect(refused.designation.homeNodeId).toBe('max3')
      expect(refused.designation.senderScopeRef).toBe(SENDER)
      expect(store.get(TARGET)).toBeUndefined()
      // The designation is untouched: a refused establishment decides nothing.
      expect(store.liveDesignation(TARGET)?.state).toBe('live')
    } finally {
      store.close()
    }
  })

  test('the designated node births it, and the designation stays live as the record of why', async () => {
    const store = await registry()
    try {
      designate(store, 'max3')
      const created = establish(store, 'max3', { action: 'enforce-designated-home' })

      expect(created.outcome).toBe('created')
      if (created.outcome !== 'created') throw new Error('unreachable')
      expect(created.binding.homeNodeId).toBe('max3')
      expect(store.liveDesignation(TARGET)?.state).toBe('live')
    } finally {
      store.close()
    }
  })

  // Acceptance 1(e). A designation is a DEFAULT. Every declared tier wins
  // against it without asking, and clears it in the same transaction — there is
  // no operator revoke, and none is needed.
  test.each([
    ['pin' as const],
    ['task_default' as const],
    ['default_home_node' as const],
    ['explicit_local' as const],
  ])(
    'a %s establishment on another node succeeds and supersedes the designation',
    async (provenance) => {
      const store = await registry()
      try {
        designate(store, 'max3')
        const created = establish(store, 'svc', { action: 'supersede', supersededBy: provenance })

        expect(created.outcome).toBe('created')
        if (created.outcome !== 'created') throw new Error('unreachable')
        expect(created.binding.homeNodeId).toBe('svc')
        // Same transaction: the binding and the supersession are never observable
        // apart, so no reader can see a live designation contradicting a binding.
        expect(store.liveDesignation(TARGET)).toBeUndefined()
        expect(store.latestDesignation(TARGET)).toMatchObject({
          state: 'superseded',
          supersededBy: provenance,
          supersededAt: '2026-08-28T05:01:00.000Z',
          homeNodeId: 'max3',
        })
      } finally {
        store.close()
      }
    }
  )

  // The pre-existing tier 5 is explicitly OUT OF SCOPE: `default_home_node(local)`
  // is the CAS-arbitrated law for senders that name no home, and this change
  // neither refuses it nor lets it clear a designation.
  test('default_home_node(local) is neither fenced nor superseding', async () => {
    const store = await registry()
    try {
      designate(store, 'max3')
      const created = establish(store, 'svc')

      expect(created.outcome).toBe('created')
      expect(store.liveDesignation(TARGET)?.homeNodeId).toBe('max3')
    } finally {
      store.close()
    }
  })

  // The epoch is what re-arms the once-per-scope deferral line. Without it, a
  // scope whose designation was superseded and re-derived would go permanently
  // silent on every node that had already announced the first one.
  test('a designation minted after a supersession takes the next epoch', async () => {
    const store = await registry()
    try {
      designate(store, 'max3')
      establish(store, 'svc', { action: 'supersede', supersededBy: 'explicit_local' })
      expect(store.liveDesignation(TARGET)).toBeUndefined()

      const second = designate(store, 'lab', '2026-08-28T06:00:00.000Z')
      expect(second.designationEpoch).toBe(2)
      expect(second.state).toBe('live')
      expect(store.designationHistory(TARGET).map((row) => row.state)).toEqual([
        'superseded',
        'live',
      ])
    } finally {
      store.close()
    }
  })

  test('an existing registry file gains the designation table and the widened vocabulary', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07655-upgrade-'))
    const path = join(tempDir, 'binding-registry.sqlite')
    const first = openBindingRegistry(path)
    first.establish({
      scopeRef: 'agent:clod:project:hrc-runtime:task:T-00001',
      homeNodeId: 'max3',
      now: '2026-08-01T00:00:00.000Z',
    })
    first.close()

    // Reopening is the upgrade path a running daemon takes.
    const second = openBindingRegistry(path)
    try {
      expect(second.get('agent:clod:project:hrc-runtime:task:T-00001')?.homeNodeId).toBe('max3')
      expect(designate(second, 'max3').designationEpoch).toBe(1)
      expect(establish(second, 'max3', { action: 'enforce-designated-home' }).outcome).toBe(
        'created'
      )
    } finally {
      second.close()
    }
  })
})
