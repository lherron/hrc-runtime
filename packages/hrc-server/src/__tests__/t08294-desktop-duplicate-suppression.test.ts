/**
 * T-08294 — HRC refuses to project what it already committed.
 *
 * The recovery contract puts the restart decision on the driver, so a
 * replacement observer replays the ENTIRE historical prefix from byte zero.
 * These tests own the half that makes that safe. Without it the first real chart
 * repeated itself exactly: 22 turns became 44.
 *
 * The case that drives the design is Astra's: TWO successive replacements. A
 * suppression set built from the previous invocation's `applied` rows alone
 * forgets everything that invocation itself suppressed, and the third observer
 * re-admits all of it. So a suppressed event is RECORDED as `duplicate` rather
 * than dropped, and the set spans every prior invocation of the session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import {
  committedDesktopIdentities,
  desktopProjectionIdentity,
  resetDesktopSuppressionMemo,
  shouldSuppressDesktopDuplicate,
} from '../desktop/duplicate-suppression'

const NOW = '2026-09-08T12:00:00.000Z'
const HOST_SESSION = 'hsid-desktop'
const SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'

let dir: string
let db: HrcDatabase

/** One normalized projection, shaped like the real observed envelopes. */
function envelope(input: {
  invocationId: string
  seq: number
  type: string
  rawSha256: string
  rawRecordId: string
  itemId?: string
  turnId?: string
}): string {
  return JSON.stringify({
    invocationId: input.invocationId,
    seq: input.seq,
    time: NOW,
    type: input.type,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    provenance: {
      rawRecordId: input.rawRecordId,
      sourceKind: 'provider-jsonl',
      sourceEpoch: `ep-${input.invocationId}`,
      sourceCursor: { byteOffset: input.seq * 100, line: input.seq },
      rawSha256: input.rawSha256,
      normalizer: { name: 'codex-desktop', version: '0.1.0' },
    },
  })
}

function seedObserver(runtimeId: string, invocationId: string): void {
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    activeInvocationId: invocationId,
    createdAt: NOW,
    updatedAt: NOW,
    runtimeStateJson: { lifecycleOwner: 'external' },
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId: `op-${invocationId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-desktop',
    invocationState: 'ready',
    capabilitiesJson: '{}',
    specHash: 'spec',
    startRequestHash: 'req',
    selectedProfileHash: 'profile',
    specProjectionJson: '{}',
    startRequestProjectionJson: '{}',
    ownerServerInstanceId: 'server-test',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function record(input: {
  invocationId: string
  runtimeId: string
  seq: number
  type: string
  rawSha256: string
  rawRecordId: string
  itemId?: string
  status: 'applied' | 'duplicate' | 'pending'
}): void {
  db.brokerInvocationEvents.appendEvent({
    invocationId: input.invocationId,
    seq: input.seq,
    time: NOW,
    type: input.type,
    runtimeId: input.runtimeId,
    payload: {},
    envelopeJson: envelope(input),
    projectionStatus: input.status,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08294-dedupe-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  resetDesktopSuppressionMemo()
  db.sessions.insert({
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
})

afterEach(async () => {
  db.close()
  resetDesktopSuppressionMemo()
  await rm(dir, { recursive: true, force: true })
})

describe('projection identity', () => {
  it('is content-anchored, so it survives a new invocation and capture epoch', () => {
    const first = desktopProjectionIdentity(
      envelope({
        invocationId: 'inv-1',
        seq: 7,
        type: 'assistant.message.completed',
        rawSha256: 'sha-A',
        rawRecordId: 'raw_000007',
        itemId: 'msg-1',
      })
    )
    // Same content, replayed on a different invocation, different seq, different
    // capture epoch, different ordinal. It must be the SAME identity.
    const replayed = desktopProjectionIdentity(
      envelope({
        invocationId: 'inv-2',
        seq: 1,
        type: 'assistant.message.completed',
        rawSha256: 'sha-A',
        rawRecordId: 'raw_000001',
        itemId: 'msg-1',
      })
    )
    expect(first).toBeDefined()
    expect(replayed).toBe(first!)
    // And it embeds no invocation-local ordinal or seq.
    expect(first).not.toContain('raw_000007')
    expect(first).not.toContain('inv-1')
  })

  it('distinguishes genuinely different projections from the SAME record', () => {
    const message = desktopProjectionIdentity(
      envelope({
        invocationId: 'inv-1',
        seq: 1,
        type: 'assistant.message.completed',
        rawSha256: 'sha-A',
        rawRecordId: 'raw_1',
        itemId: 'msg-1',
      })
    )
    const usage = desktopProjectionIdentity(
      envelope({
        invocationId: 'inv-1',
        seq: 2,
        type: 'usage.updated',
        rawSha256: 'sha-A',
        rawRecordId: 'raw_1',
        itemId: 'usage-1',
      })
    )
    expect(message).not.toBe(usage)
  })

  it('refuses to identify an envelope with no source provenance', () => {
    // A missed duplicate is a cosmetic repeat; a wrong suppression is lost
    // history. Unidentifiable events are always projected.
    expect(
      desktopProjectionIdentity(JSON.stringify({ type: 'turn.started', seq: 1 }))
    ).toBeUndefined()
    expect(desktopProjectionIdentity(undefined)).toBeUndefined()
    expect(desktopProjectionIdentity('not json')).toBeUndefined()
  })
})

describe('suppression across successive replacements', () => {
  const suppress = (invocationId: string, envelopeJson: string): boolean =>
    shouldSuppressDesktopDuplicate({
      db,
      lifecycleOwner: 'external',
      brokerDriver: 'codex-desktop',
      hostSessionId: HOST_SESSION,
      invocationId,
      envelopeJson,
    })

  it('suppresses a replayed event the FIRST observer committed', () => {
    seedObserver('rt-1', 'inv-1')
    record({
      invocationId: 'inv-1',
      runtimeId: 'rt-1',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'applied',
    })
    seedObserver('rt-2', 'inv-2')
    resetDesktopSuppressionMemo()

    const replayed = envelope({
      invocationId: 'inv-2',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
    })
    expect(suppress('inv-2', replayed)).toBe(true)

    // A genuinely NEW record on the same replacement is not suppressed.
    const fresh = envelope({
      invocationId: 'inv-2',
      seq: 2,
      type: 'turn.started',
      rawSha256: 'sha-NEW',
      rawRecordId: 'raw_2',
    })
    expect(suppress('inv-2', fresh)).toBe(false)
  })

  it('TWO successive replacements: the third still knows what the first committed', () => {
    // Astra's case. Observer 1 applies it. Observer 2 replays and SUPPRESSES it,
    // so observer 2 has no `applied` row for it. A set built only from observer
    // 2's applied rows would forget it entirely and observer 3 would re-admit
    // the whole history a second time.
    seedObserver('rt-1', 'inv-1')
    record({
      invocationId: 'inv-1',
      runtimeId: 'rt-1',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'applied',
    })
    seedObserver('rt-2', 'inv-2')
    record({
      invocationId: 'inv-2',
      runtimeId: 'rt-2',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'duplicate',
    })
    seedObserver('rt-3', 'inv-3')
    resetDesktopSuppressionMemo()

    expect(
      suppress(
        'inv-3',
        envelope({
          invocationId: 'inv-3',
          seq: 1,
          type: 'turn.started',
          rawSha256: 'sha-A',
          rawRecordId: 'raw_1',
        })
      )
    ).toBe(true)

    const identities = committedDesktopIdentities(db, HOST_SESSION, 'inv-3')
    expect(identities.size).toBe(1)
  })

  it('a PENDING row is not accounted for, so its event is re-delivered', () => {
    // The crash-between-projection-and-acknowledgement shape: captured, never
    // committed. Recovery exists to re-deliver exactly this.
    seedObserver('rt-1', 'inv-1')
    record({
      invocationId: 'inv-1',
      runtimeId: 'rt-1',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'pending',
    })
    seedObserver('rt-2', 'inv-2')
    resetDesktopSuppressionMemo()

    expect(
      suppress(
        'inv-2',
        envelope({
          invocationId: 'inv-2',
          seq: 1,
          type: 'turn.started',
          rawSha256: 'sha-A',
          rawRecordId: 'raw_1',
        })
      )
    ).toBe(false)
  })

  it('never suppresses within the ingesting invocation itself', () => {
    // Otherwise a legitimately re-delivered event inside one replay would be
    // dropped against its own earlier row.
    seedObserver('rt-1', 'inv-1')
    record({
      invocationId: 'inv-1',
      runtimeId: 'rt-1',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'applied',
    })
    resetDesktopSuppressionMemo()
    expect(
      suppress(
        'inv-1',
        envelope({
          invocationId: 'inv-1',
          seq: 1,
          type: 'turn.started',
          rawSha256: 'sha-A',
          rawRecordId: 'raw_1',
        })
      )
    ).toBe(false)
  })
})

describe('suppression is scoped to desktop observers only', () => {
  it('CONTROL: an ordinary runtime is never suppressed', () => {
    seedObserver('rt-1', 'inv-1')
    record({
      invocationId: 'inv-1',
      runtimeId: 'rt-1',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
      status: 'applied',
    })
    seedObserver('rt-2', 'inv-2')
    resetDesktopSuppressionMemo()
    const replayed = envelope({
      invocationId: 'inv-2',
      seq: 1,
      type: 'turn.started',
      rawSha256: 'sha-A',
      rawRecordId: 'raw_1',
    })
    const base = {
      db,
      hostSessionId: HOST_SESSION,
      invocationId: 'inv-2',
      envelopeJson: replayed,
    }
    // Both discriminators are required: HRC-owned lifecycle, or a different
    // driver, and nothing is suppressed. Only the desktop route replays a whole
    // history into a fresh invocation by design.
    expect(
      shouldSuppressDesktopDuplicate({
        ...base,
        lifecycleOwner: undefined,
        brokerDriver: 'codex-desktop',
      })
    ).toBe(false)
    expect(
      shouldSuppressDesktopDuplicate({
        ...base,
        lifecycleOwner: 'external',
        brokerDriver: 'codex-app-server',
      })
    ).toBe(false)
    // …and the positive control, so the two above are not passing vacuously.
    expect(
      shouldSuppressDesktopDuplicate({
        ...base,
        lifecycleOwner: 'external',
        brokerDriver: 'codex-desktop',
      })
    ).toBe(true)
  })
})
