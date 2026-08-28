import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBindingRegistry } from 'hrc-store-sqlite'
import type { BindingRegistry } from 'hrc-store-sqlite'

import {
  BirthEnvelopeUnavailableError,
  designateBirthOnHost,
} from '../federation/birth-designation.js'
import type { BirthEnvelopeReader } from '../federation/birth-designation.js'
import {
  HttpBindingRegistryClient,
  RegistryUnreachableError,
} from '../federation/registry-client.js'

/**
 * T-07655 — the registry HOST's designation routine.
 *
 * The property under test throughout is that the host decides from things the
 * CALLER cannot touch: a ledger row it reads itself, and its own registry.
 */

const TARGET = 'agent:cody:project:hrc-runtime:task:T-07655'
const SENDER = 'agent:mable:project:wrkq:task:primary'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function registry(): Promise<BindingRegistry> {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t07655-host-'))
  return openBindingRegistry(join(tempDir, 'binding-registry.sqlite'))
}

function bindSender(store: BindingRegistry, homeNodeId: string): void {
  store.establish({
    scopeRef: SENDER,
    homeNodeId,
    placementEpoch: 1,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'pin',
    now: '2026-08-28T04:00:00.000Z',
  })
}

const envelopeFrom = (scopeRef: string | undefined): BirthEnvelopeReader => {
  return async () => ({
    envelopeId: 'EN-00722',
    seq: 722,
    from: { principalRef: 'agent:mable', ...(scopeRef === undefined ? {} : { scopeRef }) },
  })
}

describe('T-07655 designateBirthOnHost', () => {
  // Acceptance 1(b). This is the rev-3 flaw daedalus rejected: a caller that
  // could name the sender could name any node it liked. The request carries the
  // target and nothing else, and the host reads the sender for itself.
  test('the sender comes from the ledger row the host reads, never from the caller', async () => {
    const store = await registry()
    try {
      bindSender(store, 'max3')
      const asked: string[] = []
      const result = await designateBirthOnHost(
        {
          registry: store,
          birthEnvelopeFor: async (scopeRef) => {
            asked.push(scopeRef)
            return {
              envelopeId: 'EN-00722',
              seq: 722,
              from: { principalRef: 'agent:mable', scopeRef: SENDER },
            }
          },
        },
        TARGET
      )

      // The host asked wrkq about the TARGET; the sender it followed came back
      // in the answer. There is no parameter a caller could have supplied.
      expect(asked).toEqual([TARGET])
      expect(result).toMatchObject({
        kind: 'designated',
        designation: {
          homeNodeId: 'max3',
          provenance: 'default_home_node(sender)',
          senderScopeRef: SENDER,
          birthEnvelopeId: 'EN-00722',
          designationEpoch: 1,
        },
      })
    } finally {
      store.close()
    }
  })

  /**
   * The spelling the LEDGER actually uses.
   *
   * wrkq stores `from_scope_ref` as the HANDLE an agent types
   * (`clod@hrc-runtime:T-07655`); the registry keys every row on the canonical
   * ref. Feeding the handle straight to `getRecord` throws
   * `ScopeRef must start with "agent:<agentId>"`, which `designateBirthOnHost`
   * then wrapped as an unavailable registry — so on the live fleet EVERY
   * designation refused retryably and no upgraded node could birth a virgin
   * scope at all. Observed on svc 2026-08-28T05:58:15Z.
   *
   * The unit fixtures above did not catch it because they were hand-written in
   * canonical form: a double built from my own idea of the wire agreed with my
   * own mistake. This case is written in the spelling the ledger really emits.
   */
  test('the sender arrives in wrkq HANDLE spelling and still resolves', async () => {
    const store = await registry()
    try {
      bindSender(store, 'max3')
      const result = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: envelopeFrom('mable@wrkq:primary') },
        TARGET
      )
      expect(result).toMatchObject({
        kind: 'designated',
        designation: { homeNodeId: 'max3', provenance: 'default_home_node(sender)' },
      })
      // Recorded canonically, so it compares directly against a binding row.
      expect(result.kind === 'designated' ? result.designation.senderScopeRef : undefined).toBe(
        SENDER
      )
    } finally {
      store.close()
    }
  })

  test('a lane suffix on the sender is execution vocabulary, not part of the scope', async () => {
    const store = await registry()
    try {
      bindSender(store, 'svc')
      const result = await designateBirthOnHost(
        {
          registry: store,
          birthEnvelopeFor: envelopeFrom('agent:mable:project:wrkq:task:primary/lane:main'),
        },
        TARGET
      )
      expect(result).toMatchObject({ kind: 'designated', designation: { homeNodeId: 'svc' } })
    } finally {
      store.close()
    }
  })

  // A sender that names no parseable scope is the `none` class, NOT an outage:
  // reporting it as unavailable would refuse the birth on every node forever.
  test('an unparseable sender designates nothing and is not an outage', async () => {
    const store = await registry()
    try {
      bindSender(store, 'max3')
      const result = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: envelopeFrom('not a scope at all') },
        TARGET
      )
      expect(result).toEqual({ kind: 'none' })
      expect(store.designationHistory(TARGET)).toEqual([])
    } finally {
      store.close()
    }
  })

  // Acceptance 1(d), bound sender.
  test('a bound sender designates its own home', async () => {
    const store = await registry()
    try {
      bindSender(store, 'svc')
      const result = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: envelopeFrom(SENDER) },
        TARGET
      )
      expect(result).toMatchObject({
        kind: 'designated',
        designation: { homeNodeId: 'svc', provenance: 'default_home_node(sender)' },
      })
    } finally {
      store.close()
    }
  })

  // Acceptance 1(d), retired sender. A retirement still names where the sender
  // LIVED, which is still where the conversation is.
  test('a retired sender designates its retired home', async () => {
    const store = await registry()
    try {
      bindSender(store, 'lab')
      store.retire({
        scopeRef: SENDER,
        expectedHomeNodeId: 'lab',
        expectedPlacementEpoch: 1,
        successorNodeId: null,
        reason: 'test',
        retiredAt: '2026-08-28T04:30:00.000Z',
      })

      const result = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: envelopeFrom(SENDER) },
        TARGET
      )
      expect(result).toMatchObject({
        kind: 'designated',
        designation: { homeNodeId: 'lab', provenance: 'default_home_node(sender-retired)' },
      })
    } finally {
      store.close()
    }
  })

  // Acceptance 1(d), the three `none` cases. Recording NOTHING is the point:
  // rev 3 was rejected for persisting a first-asker's decision before the
  // sender's capability to place anything was known.
  test.each([
    ['no birth envelope', async () => null, undefined],
    ['a scope-less sender', envelopeFrom(undefined), undefined],
    ['an unbound sender', envelopeFrom(SENDER), 'unbound'],
  ])('%s designates nothing and records nothing', async (_label, reader, senderState) => {
    const store = await registry()
    try {
      if (senderState !== 'unbound') bindSender(store, 'max3')
      // For the unbound case the sender is deliberately never established.
      const result = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: reader as BirthEnvelopeReader },
        TARGET
      )
      expect(result).toEqual({ kind: 'none' })
      expect(store.designationHistory(TARGET)).toEqual([])
    } finally {
      store.close()
    }
  })

  // Acceptance 1(g). An unread ledger is not evidence that nothing designated
  // this scope. Answering `none` on an outage would send EVERY node back to a
  // local birth simultaneously — the exact race this exists to prevent.
  test('an unreachable wrkq throws retryably and records nothing', async () => {
    const store = await registry()
    try {
      bindSender(store, 'max3')
      const failure = designateBirthOnHost(
        {
          registry: store,
          birthEnvelopeFor: async () => {
            throw new Error('wrkq rpc child exited')
          },
        },
        TARGET
      )
      await expect(failure).rejects.toThrow(BirthEnvelopeUnavailableError)
      await failure.catch((error: unknown) => {
        expect((error as BirthEnvelopeUnavailableError).retryable).toBe(true)
      })
      expect(store.designationHistory(TARGET)).toEqual([])
    } finally {
      store.close()
    }
  })

  // Acceptance 1(c) end-to-end, and the C-16787 latency note: the repeat ask —
  // which is every OTHER node on the same ledger insert — costs one local read
  // and never touches wrkq at all.
  test('a scope already designated is answered without reading wrkq again', async () => {
    const store = await registry()
    try {
      bindSender(store, 'max3')
      let reads = 0
      const counting: BirthEnvelopeReader = async () => {
        reads += 1
        return {
          envelopeId: 'EN-00722',
          seq: 722,
          from: { principalRef: 'agent:mable', scopeRef: SENDER },
        }
      }

      const first = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: counting },
        TARGET
      )
      const second = await designateBirthOnHost(
        { registry: store, birthEnvelopeFor: counting },
        TARGET
      )

      expect(reads).toBe(1)
      expect(second).toEqual(first)
      expect(store.designationHistory(TARGET)).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

/**
 * Rollout safety across a mixed fleet.
 *
 * The registry HOST is one node (mini/svc); every other node is a client. The
 * prescribed rollout upgrades max3 first, so for the length of that window an
 * upgraded client asks a host that has never heard of the route. If that 404
 * read as "unreachable", the gate would refuse every virgin implicit birth on
 * the upgraded node — a fleet-wide dispatch outage caused by the very change
 * meant to make births orderly.
 */
describe('T-07655 mixed-fleet rollout', () => {
  function httpClientAgainst(status: number, body: unknown = { ok: false, error: 'not_found' }) {
    return new HttpBindingRegistryClient(
      {
        nodeId: 'svc',
        endpoint: 'http://100.64.0.1:9/',
        registryEndpoint: 'http://100.64.0.1:9/',
        token: { reveal: () => 'secret', matches: () => true },
      } as unknown as ConstructorParameters<typeof HttpBindingRegistryClient>[0],
      {
        fetch: async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        log: () => {},
      }
    )
  }

  test('a registry host that predates the route designates nothing, and is not an outage', async () => {
    const client = httpClientAgainst(404)
    expect(await client.designateBirth?.('agent:cody:project:hrc-runtime:task:T-07655')).toEqual({
      kind: 'none',
    })
    expect(await client.readDesignation?.('agent:cody:project:hrc-runtime:task:T-07655')).toEqual({
      outcome: 'none',
    })
  })

  test('a host that CAN read designations but cannot read wrkq is still an outage', async () => {
    // The distinction is the whole point: 404 is "no such capability here",
    // 503 is "I have the capability and could not use it". Only the second may
    // ever be answered by falling back to a local birth — and it is not.
    const client = httpClientAgainst(503, { ok: false, error: 'runtime_unavailable' })
    await expect(
      client.designateBirth?.('agent:cody:project:hrc-runtime:task:T-07655')
    ).rejects.toThrow(RegistryUnreachableError)
  })
})
