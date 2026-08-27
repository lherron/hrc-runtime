/**
 * T-07236 — HRC→ACP reason-coded event bridge, emitter side.
 *
 * Law under test (`hrc-runtime.acp-event-bridge`): an enabled bridge observes
 * only committed, allowlisted reason-coded facts and emits the frozen schema-v1
 * envelope with node-qualified identity, recorded origin/causation, and a
 * pointer-only payload; emission is durably rate-bounded, cannot affect the
 * originating write, and v1 activation is confined to the ACP-co-resident node.
 *
 * The envelope cases run against a VENDORED copy of ACP's real parser
 * (fixtures/acp-webhook-parser.ts) and assert its REJECTIONS as well as its
 * acceptances — a stand-in more permissive than the real parser is the known
 * false-green trap.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT,
  HRC_FIRST_TURN_MISSING_EVENT,
  HRC_FIRST_TURN_MISSING_LATE_START_EVENT,
  type HrcLifecycleEvent,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  ACP_BRIDGE_DELIVERY_ATTEMPTS,
  ACP_BRIDGE_DELIVERY_BUDGET_MS,
  AcpEventBridge,
  buildAcpBridgeEnvelope,
  dispatchOriginFromMessageAddress,
  resolveAcpBridgeActivation,
  resolveBridgedOrigin,
} from '../acp-event-bridge'
import { appendHrcEvent } from '../hrc-event-helper'
import {
  vendoredIsAgentOriginEvent,
  vendoredParseAcpWebhookEvent,
} from './fixtures/acp-webhook-parser'

/**
 * CAPTURED PRODUCTION INPUT, not authored input.
 *
 * This is the real `first_turn_missing` row the live max3 ledger recorded at
 * hrc_seq 1259169 on 2026-08-14 (T-07235's first field trip), copied verbatim
 * from state.sqlite. T-07235 shipped three defects past green gates built on
 * imagined fixtures; the envelope builder is therefore exercised against what
 * the ledger ACTUALLY writes — including the fact that `invocationId` lives in
 * the payload and not in a column, and that `trippedAt` and the row's `ts` are
 * the same instant.
 */
const CAPTURED_TRIP_ROW = {
  hrc_seq: 1259169,
  ts: '2026-08-14T22:20:20.862Z',
  event_kind: 'first_turn_missing',
  runtime_id: 'rt-ff0cf9c7-9a9c-47a9-b836-331df84db0f7',
  run_id: 'run-bd4ea261-dedc-42f4-b1b2-0b668f6dcb27',
  scope_ref: 'agent:mneme:project:signal-pipeline:task:signal-cluster',
  lane_ref: 'main',
  generation: 3,
  host_session_id: 'hsid-66e7e347-cd8c-4be7-a2f7-1e3d75054204',
  error_code: 'first_turn_missing',
  payload_json:
    '{"runtimeId":"rt-ff0cf9c7-9a9c-47a9-b836-331df84db0f7","generation":3,"scopeRef":"agent:mneme:project:signal-pipeline:task:signal-cluster","hostSessionId":"hsid-66e7e347-cd8c-4be7-a2f7-1e3d75054204","runId":"run-bd4ea261-dedc-42f4-b1b2-0b668f6dcb27","invocationId":"inv-173392ff-49af-4659-8a6f-fd09c79d9af2","primingDispatchedAt":"2026-08-14T22:18:15.311Z","firstTurnDeadlineAt":"2026-08-14T22:20:15.311Z","trippedAt":"2026-08-14T22:20:20.862Z"}',
} as const

function capturedTripEvent(): HrcLifecycleEvent {
  return {
    hrcSeq: CAPTURED_TRIP_ROW.hrc_seq,
    streamSeq: CAPTURED_TRIP_ROW.hrc_seq,
    ts: CAPTURED_TRIP_ROW.ts,
    hostSessionId: CAPTURED_TRIP_ROW.host_session_id,
    scopeRef: CAPTURED_TRIP_ROW.scope_ref,
    laneRef: CAPTURED_TRIP_ROW.lane_ref,
    generation: CAPTURED_TRIP_ROW.generation,
    runtimeId: CAPTURED_TRIP_ROW.runtime_id,
    runId: CAPTURED_TRIP_ROW.run_id,
    category: 'runtime',
    eventKind: CAPTURED_TRIP_ROW.event_kind,
    errorCode: CAPTURED_TRIP_ROW.error_code,
    replayed: false,
    payload: JSON.parse(CAPTURED_TRIP_ROW.payload_json),
  }
}

const ENABLED_ENV: NodeJS.ProcessEnv = {
  HRC_ACP_WEBHOOK_URL: 'http://127.0.0.1:18470/v1/webhooks/events',
  HRC_ACP_NODE_ID: 'max3',
}
const DECLARED_MAX3 = { nodeId: 'max3', nodeIdProvenance: 'declared' } as const

describe('T-07236 activation', () => {
  it('is disabled when the URL is unset AND when it is empty — no inferred default', () => {
    expect(resolveAcpBridgeActivation({ env: {}, node: DECLARED_MAX3 })).toEqual({
      enabled: false,
      reason: 'url_unset',
    })
    expect(
      resolveAcpBridgeActivation({
        env: { HRC_ACP_WEBHOOK_URL: '', HRC_ACP_NODE_ID: 'max3' },
        node: DECLARED_MAX3,
      })
    ).toEqual({ enabled: false, reason: 'url_empty' })
    // Whitespace-only is empty: an operator who "cleared" the key by blanking
    // it must not accidentally leave the bridge enabled.
    expect(
      resolveAcpBridgeActivation({
        env: { HRC_ACP_WEBHOOK_URL: '   ', HRC_ACP_NODE_ID: 'max3' },
        node: DECLARED_MAX3,
      })
    ).toEqual({ enabled: false, reason: 'url_empty' })
  })

  it('refuses a non-loopback or malformed URL — v1 adds no auth or signing', () => {
    expect(
      resolveAcpBridgeActivation({
        env: {
          ...ENABLED_ENV,
          HRC_ACP_WEBHOOK_URL: 'http://max3.tailnet:18470/v1/webhooks/events',
        },
        node: DECLARED_MAX3,
      })
    ).toMatchObject({ enabled: false, reason: 'url_not_loopback' })
    expect(
      resolveAcpBridgeActivation({
        env: { ...ENABLED_ENV, HRC_ACP_WEBHOOK_URL: 'not-a-url' },
        node: DECLARED_MAX3,
      })
    ).toMatchObject({ enabled: false, reason: 'url_invalid' })
  })

  it('confines v1 to the DECLARED ACP-co-resident node, by configuration comparison', () => {
    // No declared co-resident node at all.
    expect(
      resolveAcpBridgeActivation({
        env: { HRC_ACP_WEBHOOK_URL: ENABLED_ENV['HRC_ACP_WEBHOOK_URL'] as string },
        node: DECLARED_MAX3,
      })
    ).toEqual({ enabled: false, reason: 'coresident_node_unset' })

    // A second node with the same URL must NOT enable.
    expect(
      resolveAcpBridgeActivation({
        env: ENABLED_ENV,
        node: { nodeId: 'mini', nodeIdProvenance: 'declared' },
      })
    ).toMatchObject({ enabled: false, reason: 'node_not_coresident' })

    // A hostname-derived identity that HAPPENS to match is a coincidence, not
    // a statement of co-residency.
    expect(
      resolveAcpBridgeActivation({
        env: ENABLED_ENV,
        node: { nodeId: 'max3', nodeIdProvenance: 'derived' },
      })
    ).toMatchObject({ enabled: false, reason: 'node_identity_not_declared' })
  })

  it('enables on the co-resident node with the documented defaults', () => {
    const activation = resolveAcpBridgeActivation({ env: ENABLED_ENV, node: DECLARED_MAX3 })
    expect(activation.enabled).toBe(true)
    if (!activation.enabled) return
    expect(activation.nodeId).toBe('max3')
    expect([...activation.allowlist]).toEqual([HRC_FIRST_TURN_MISSING_EVENT])
    expect(activation.rateCapPerWindow).toBe(3)
  })

  it('honors an explicit allowlist and rate cap', () => {
    const activation = resolveAcpBridgeActivation({
      env: {
        ...ENABLED_ENV,
        HRC_ACP_EVENT_ALLOWLIST: 'first_turn_missing, runtime.crashed',
        HRC_ACP_EVENT_RATE_CAP: '7',
      },
      node: DECLARED_MAX3,
    })
    expect(activation.enabled).toBe(true)
    if (!activation.enabled) return
    expect([...activation.allowlist].sort()).toEqual(['first_turn_missing', 'runtime.crashed'])
    expect(activation.rateCapPerWindow).toBe(7)
  })
})

describe('T-07236 envelope construction (captured production trip)', () => {
  it('builds a node-qualified, pointer-only envelope ACP accepts', () => {
    const envelope = buildAcpBridgeEnvelope({
      event: capturedTripEvent(),
      nodeId: 'max3',
      origin: { actor: 'agent:mable', kind: 'agent', causation_ref: 'jrun-42' },
    })
    expect(envelope).not.toBeNull()
    if (envelope === null) return

    expect(envelope.schema_version).toBe(1)
    expect(envelope.source).toBe('hrc')
    // Node-qualified: the local hrcSeq alone is a per-database autoincrement,
    // and ACP de-duplicates on source:event_id across every HRC node.
    expect(envelope.event_id).toBe('max3:1259169')
    expect(envelope.event_seq).toBe(1259169)
    expect(envelope.event).toBe('first_turn_missing')
    // The HRC-recorded timestamp, not send time.
    expect(envelope.occurred_at).toBe(CAPTURED_TRIP_ROW.ts)
    expect(envelope.subject).toEqual({ type: 'hrc-runtime', id: CAPTURED_TRIP_ROW.runtime_id })

    // Frozen payload key set, exactly — no more (no pane text, argv, or prompt
    // material can leak) and no less (the example job's templates read these).
    expect(Object.keys(envelope.payload).sort()).toEqual([
      'generation',
      'invocationId',
      'nodeId',
      'retrievalHint',
      'runId',
      'runtimeId',
      'scopeRef',
      'tripEventId',
    ])
    expect(envelope.payload.nodeId).toBe('max3')
    expect(envelope.payload.invocationId).toBe('inv-173392ff-49af-4659-8a6f-fd09c79d9af2')
    expect(envelope.payload.retrievalHint).toBe('hrc runtime diagnostics 1259169')
    expect(envelope.payload.tripEventId).toBe('1259169')

    const parsed = vendoredParseAcpWebhookEvent(envelope)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.event.canonical_event_id).toBe('hrc:max3:1259169')
    // The whole point of always-present origin: an agent-caused trip stays
    // subject to ACP's default agent-origin deny instead of dodging it.
    expect(vendoredIsAgentOriginEvent(parsed.event)).toBe(true)
  })

  it('carries the system residue for an unattributed dispatch, and ACP still accepts it', () => {
    const envelope = buildAcpBridgeEnvelope({
      event: capturedTripEvent(),
      nodeId: 'max3',
      origin: resolveBridgedOrigin(null),
    })
    expect(envelope?.origin).toEqual({ actor: 'system:hrc', kind: 'system' })
    const parsed = vendoredParseAcpWebhookEvent(envelope)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(vendoredIsAgentOriginEvent(parsed.event)).toBe(false)
  })

  it('emits nothing for a row with no addressable runtime', () => {
    const event = capturedTripEvent()
    expect(
      buildAcpBridgeEnvelope({
        event: { ...event, runtimeId: undefined, payload: {} },
        nodeId: 'max3',
        origin: resolveBridgedOrigin(null),
      })
    ).toBeNull()
  })
})

describe('T-07236 envelope conformance — the parser REJECTS these', () => {
  const base = () =>
    buildAcpBridgeEnvelope({
      event: capturedTripEvent(),
      nodeId: 'max3',
      origin: { actor: 'agent:mable', kind: 'agent' },
    }) as NonNullable<ReturnType<typeof buildAcpBridgeEnvelope>>

  it.each([
    ['absent schema_version', { schema_version: undefined }],
    ['wrong schema_version', { schema_version: 2 }],
    ['uppercased source', { source: 'HRC' }],
    ['empty event_id', { event_id: '' }],
    ['negative event_seq', { event_seq: -1 }],
    ['fractional event_seq', { event_seq: 1.2 }],
    ['empty event code', { event: '' }],
    ['array payload', { payload: [] }],
    ['non-object origin', { origin: 'agent:mable' }],
    ['unknown origin kind', { origin: { actor: 'agent:mable', kind: 'robot' } }],
    ['subject without type', { subject: { id: 'rt-1' } }],
    ['mismatched canonical id', { canonical_event_id: 'hrc:mini:1' }],
  ])('rejects %s', (_label, patch) => {
    const result = vendoredParseAcpWebhookEvent({ ...base(), ...(patch as object) })
    expect(result.ok).toBe(false)
  })
})

describe('T-07236 origin resolution table', () => {
  it('reads back the recorded principal, causation included', () => {
    expect(
      resolveBridgedOrigin({
        originActor: 'agent:cody',
        originKind: 'agent',
        originCausationRef: 'jrun-7',
      })
    ).toEqual({ actor: 'agent:cody', kind: 'agent', causation_ref: 'jrun-7' })
    expect(resolveBridgedOrigin({ originActor: 'human:lherron', originKind: 'human' })).toEqual({
      actor: 'human:lherron',
      kind: 'human',
    })
  })

  it('falls back to the system residue for a partial or absent record', () => {
    expect(resolveBridgedOrigin(undefined)).toEqual({ actor: 'system:hrc', kind: 'system' })
    // A row with an actor but no kind is not half-attributed; it is unusable.
    expect(resolveBridgedOrigin({ originActor: 'agent:cody' })).toEqual({
      actor: 'system:hrc',
      kind: 'system',
    })
  })

  it('derives the hrcchat sender from the durable message address', () => {
    expect(
      dispatchOriginFromMessageAddress({
        kind: 'session',
        sessionRef: 'agent:mable:project:hrc-runtime:task:primary',
      })
    ).toEqual({ actor: 'agent:mable', kind: 'agent' })
    expect(dispatchOriginFromMessageAddress({ kind: 'entity', entity: 'human' })).toEqual({
      actor: 'human',
      kind: 'human',
    })
    expect(dispatchOriginFromMessageAddress({ kind: 'entity', entity: 'system' })).toEqual({
      actor: 'system:hrc',
      kind: 'system',
    })
    // An unparseable sender leaves the run unattributed rather than inventing one.
    expect(dispatchOriginFromMessageAddress({ kind: 'session', sessionRef: 'nonsense' })).toBe(
      undefined
    )
  })
})

type Fixture = {
  db: ReturnType<typeof openHrcDatabase>
  dir: string
  cleanup: () => Promise<void>
}

const HOST_SESSION_ID = 'hsid-t07236'
const SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-07236'
const LANE_REF = 'default'
const RUNTIME_ID = 'rt-t07236'

async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-acp-bridge-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  const now = '2026-08-14T22:00:00.000Z'
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'starting',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: now,
    updatedAt: now,
  })
  return {
    db,
    dir,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function appendTrip(fixture: Fixture, runId?: string): HrcLifecycleEvent {
  return appendHrcEvent(fixture.db, HRC_FIRST_TURN_MISSING_EVENT, {
    ts: '2026-08-14T22:20:20.862Z',
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    runtimeId: RUNTIME_ID,
    ...(runId !== undefined ? { runId } : {}),
    errorCode: 'first_turn_missing',
    payload: { runtimeId: RUNTIME_ID, generation: 1, invocationId: 'inv-t07236' },
  })
}

type Capture = { url: string; body: unknown }

function stubFetch(responder: (call: number) => { ok: boolean; status: number } | Error): {
  calls: Capture[]
  impl: (input: string, init: RequestInit) => Promise<never | { ok: boolean; status: number }>
} {
  const calls: Capture[] = []
  return {
    calls,
    impl: async (input, init) => {
      calls.push({ url: input, body: JSON.parse(String(init.body)) })
      const result = responder(calls.length)
      if (result instanceof Error) throw result
      return result
    },
  }
}

describe('T-07236 emission', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })
  afterEach(async () => {
    await fixture.cleanup()
  })

  it('delivers an allowlisted committed fact and ignores everything else', async () => {
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
    })
    expect(bridge.enabled).toBe(true)

    bridge.observe(appendTrip(fixture))
    // Not on the allowlist: the bridge is deliberately small, not a firehose.
    bridge.observe(
      appendHrcEvent(fixture.db, 'turn.started', {
        ts: '2026-08-14T22:21:00.000Z',
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE_REF,
        laneRef: LANE_REF,
        generation: 1,
        runtimeId: RUNTIME_ID,
        payload: {},
      })
    )
    await bridge.drain()

    expect(fetchStub.calls).toHaveLength(1)
    expect(fetchStub.calls[0]?.url).toBe(ENABLED_ENV['HRC_ACP_WEBHOOK_URL'])
    expect(vendoredParseAcpWebhookEvent(fetchStub.calls[0]?.body).ok).toBe(true)
  })

  it('does not bridge the first_turn_missing SIBLING kinds (T-07630)', async () => {
    // The allowlist is exact-match on eventKind, so `first_turn_missing` never
    // covers `first_turn_missing.late_start` / `.diagnostics`. T-07630's false
    // late starts were therefore never bridged; this pins that so a future
    // prefix-matching "convenience" cannot quietly widen the wire face.
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
    })

    for (const kind of [
      HRC_FIRST_TURN_MISSING_LATE_START_EVENT,
      HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT,
    ]) {
      bridge.observe(
        appendHrcEvent(fixture.db, kind, {
          ts: '2026-08-27T21:28:17.665Z',
          hostSessionId: HOST_SESSION_ID,
          scopeRef: SCOPE_REF,
          laneRef: LANE_REF,
          generation: 1,
          runtimeId: RUNTIME_ID,
          payload: {},
        })
      )
    }
    await bridge.drain()

    expect(fetchStub.calls).toHaveLength(0)
  })

  it('sends nothing at all when disabled', async () => {
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: {},
      fetchImpl: fetchStub.impl,
    })
    expect(bridge.enabled).toBe(false)
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(0)
  })

  it('joins runId → dispatch record so the recorded origin reaches ACP', async () => {
    const now = '2026-08-14T22:19:00.000Z'
    fixture.db.runs.insert({
      runId: 'run-origin',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      originActor: 'agent:mable',
      originKind: 'agent',
      originCausationRef: 'jrun-99',
    })
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
    })
    bridge.observe(appendTrip(fixture, 'run-origin'))
    await bridge.drain()

    const parsed = vendoredParseAcpWebhookEvent(fetchStub.calls[0]?.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.event.origin).toEqual({
      actor: 'agent:mable',
      kind: 'agent',
      causation_ref: 'jrun-99',
    })
    expect(vendoredIsAgentOriginEvent(parsed.event)).toBe(true)
  })

  it('bounds the producer at the durable rate cap, independent of any consumer policy', async () => {
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: { ...ENABLED_ENV, HRC_ACP_EVENT_RATE_CAP: '2' },
      fetchImpl: fetchStub.impl,
    })
    for (let i = 0; i < 5; i += 1) bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(2)

    // The bound is durable: a fresh bridge (a restarted daemon) sees the same
    // consumed slots rather than starting the window over.
    const secondStub = stubFetch(() => ({ ok: true, status: 204 }))
    const restarted = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: { ...ENABLED_ENV, HRC_ACP_EVENT_RATE_CAP: '2' },
      fetchImpl: secondStub.impl,
    })
    restarted.observe(appendTrip(fixture))
    await restarted.drain()
    expect(secondStub.calls).toHaveLength(0)
  })

  it('does not let a re-emission of the same fact consume a second slot', async () => {
    const fetchStub = stubFetch(() => ({ ok: true, status: 204 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: { ...ENABLED_ENV, HRC_ACP_EVENT_RATE_CAP: '2' },
      fetchImpl: fetchStub.impl,
    })
    const trip = appendTrip(fixture)
    bridge.observe(trip)
    await bridge.drain()
    bridge.observe(trip)
    await bridge.drain()
    // Both delivered — same fact, same id, one slot.
    expect(fetchStub.calls).toHaveLength(2)
    expect(fetchStub.calls[0]?.body).toEqual(fetchStub.calls[1]?.body)

    // The slot ledger still has room for one DIFFERENT fact under a cap of 2.
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(3)
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(3)
  })

  it('produces a byte-identical envelope on re-emission (ACP dedupes on the id)', async () => {
    const fetchStub = stubFetch((call) =>
      call === 1 ? new Error('connection refused') : { ok: true, status: 204 }
    )
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
      sleep: async () => {},
    })
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(2)
    expect(JSON.stringify(fetchStub.calls[0]?.body)).toBe(JSON.stringify(fetchStub.calls[1]?.body))
  })

  it('honors the bounded retry budget when ACP is down, and never throws', async () => {
    const fetchStub = stubFetch(() => new Error('connection refused'))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
      sleep: async () => {},
    })
    const trip = appendTrip(fixture)
    bridge.observe(trip)
    await bridge.drain()

    expect(fetchStub.calls).toHaveLength(ACP_BRIDGE_DELIVERY_ATTEMPTS)
    // The ORIGINATING write is untouched by the failure: the ledger row is the
    // durable fact and it is still exactly where the trip put it.
    const reread = fixture.db.hrcEvents.listFromHrcSeq(trip.hrcSeq, { limit: 1 })
    expect(reread[0]?.hrcSeq).toBe(trip.hrcSeq)
    expect(reread[0]?.eventKind).toBe(HRC_FIRST_TURN_MISSING_EVENT)
  })

  it('stops immediately on a 4xx — a rejected envelope will not improve on retry', async () => {
    const fetchStub = stubFetch(() => ({ ok: false, status: 400 }))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: fetchStub.impl,
      sleep: async () => {},
    })
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(fetchStub.calls).toHaveLength(1)
  })

  it('abandons a slow ACP inside the delivery budget', async () => {
    const started = Date.now()
    const fetchStub = stubFetch(() => new Error('The operation timed out.'))
    const bridge = new AcpEventBridge({
      db: fixture.db,
      node: DECLARED_MAX3,
      env: ENABLED_ENV,
      fetchImpl: async (input, init) => {
        // Burn most of the budget on each attempt, as a hung listener would.
        await new Promise((resolve) => setTimeout(resolve, 40))
        return fetchStub.impl(input, init)
      },
      sleep: async () => {},
    })
    bridge.observe(appendTrip(fixture))
    await bridge.drain()
    expect(Date.now() - started).toBeLessThan(ACP_BRIDGE_DELIVERY_BUDGET_MS * 2)
    expect(fetchStub.calls.length).toBeLessThanOrEqual(ACP_BRIDGE_DELIVERY_ATTEMPTS)
  })
})
