/**
 * T-05358 — interactive turns reuse a broker runtime wedged in `stopping`.
 *
 * RCA (looper field report + wfrun trace): at turn-end the app-server reaches a
 * terminal/stopping transition; the next phase's reuse/reattach lands on the
 * runtime DURING the transient `stopping` window before HRC marks it stale, and
 * the broker rejects the input with `Cannot accept input in state: stopping`
 * (harness-broker invocation-manager: input is accepted only in ready/turn_active).
 *
 * Defect B: `getReusableHeadlessRuntimeForSession` excludes only TERMINAL
 * invocation states (exited/failed/disposed) and unavailable runtime STATUS
 * (terminated/dead/stale). `stopping` (and `starting`) are neither, so a
 * transitioning runtime is handed back for reuse and the input fails. The fix:
 * a runtime whose broker invocation is not input-acceptable (`stopping` /
 * `starting`) must NOT be selected for a new turn — same for the durable
 * reattach selector.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { isBrokerRuntimeInputDispatchable } from '../require-helpers.js'
import {
  getDurableHeadlessRuntimeForReattach,
  getReusableHeadlessRuntimeForSession,
} from '../runtime-select'

const HOST_SESSION_ID = 'hsid_t05358'
const SCOPE_REF = 'agent:curly:project:taskboard:task:T-05358'
const LANE_REF = 'main'

let dir: string
let db: HrcDatabase

function seedSession(): void {
  const now = new Date().toISOString()
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
}

type SeedOpts = {
  runtimeId: string
  /** runtime row status */
  status: string
  /** broker invocation lifecycle state */
  invocationState: string
  durable?: boolean
}

function seedRuntime(opts: SeedOpts): void {
  const now = new Date().toISOString()
  const { runtimeId, status, invocationState } = opts
  const durable = opts.durable ?? false
  const invocationId = `inv-${runtimeId}`
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'headless',
    harness: 'codex-app-server',
    provider: 'openai',
    status,
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeInvocationId: invocationId,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      status,
      broker: {
        protocolVersion: 'harness-broker/0.2',
        generation: 1,
        ...(durable
          ? {
              endpoint: {
                kind: 'unix-jsonrpc-ndjson',
                socketPath: `/tmp/hrc-t05358/${runtimeId}/b.sock`,
                attachTokenRef: {
                  kind: 'file',
                  path: `/tmp/hrc-t05358/${runtimeId}/attach.token`,
                  redacted: true,
                },
              },
              brokerWindow: {
                socketPath: `/tmp/hrc-t05358/${runtimeId}/btmux.sock`,
                sessionName: `hrc-codex-app-server-${runtimeId}`,
                sessionId: '$0',
                windowId: '@0',
                paneId: '%0',
              },
            }
          : {}),
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId: `op-${runtimeId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState,
    capabilitiesJson: JSON.stringify({ input: { user: true } }),
    specHash: `spec-${runtimeId}`,
    startRequestHash: `sr-${runtimeId}`,
    selectedProfileHash: `pf-${runtimeId}`,
    createdAt: now,
    updatedAt: now,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-t05358-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  seedSession()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-05358 stopping-state runtime reuse wedge', () => {
  it('does NOT hand back a runtime whose broker invocation is `stopping`', () => {
    // The runtime row status still reads `stopping` (or even `ready` mid-race);
    // the invocation is transitioning out and cannot accept input.
    seedRuntime({ runtimeId: 'rt-stopping', status: 'stopping', invocationState: 'stopping' })
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('does NOT hand back a runtime whose broker invocation is still `starting`', () => {
    seedRuntime({ runtimeId: 'rt-starting', status: 'starting', invocationState: 'starting' })
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('does NOT hand back a `ready`-ROW runtime whose active invocation is `stopping` (mixed state)', () => {
    // Daedalus: the live DB carries `ready|stopping` row/invocation pairs, so
    // status-only filtering is insufficient — invocation-state filtering is what
    // closes the race.
    seedRuntime({
      runtimeId: 'rt-ready-row-stopping-inv',
      status: 'ready',
      invocationState: 'stopping',
    })
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('STILL hands back a genuinely idle `ready` runtime (no regression)', () => {
    seedRuntime({ runtimeId: 'rt-ready', status: 'ready', invocationState: 'ready' })
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
        ?.runtimeId
    ).toBe('rt-ready')
  })

  it('STILL hands back a `turn_active` runtime (busy detection happens downstream)', () => {
    seedRuntime({ runtimeId: 'rt-busy', status: 'busy', invocationState: 'turn_active' })
    expect(
      getReusableHeadlessRuntimeForSession(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
        ?.runtimeId
    ).toBe('rt-busy')
  })

  it('durable reattach selector also skips a `stopping` durable runtime', () => {
    seedRuntime({
      runtimeId: 'rt-durable-stopping',
      status: 'stopping',
      invocationState: 'stopping',
      durable: true,
    })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('durable reattach selector skips a `ready`-ROW durable runtime with a `stopping` active invocation', () => {
    seedRuntime({
      runtimeId: 'rt-durable-ready-stopping-inv',
      status: 'ready',
      invocationState: 'stopping',
      durable: true,
    })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
    ).toBeNull()
  })

  it('PRESERVES T-01884: a durable `stale` runtime is still selected for reattach by hosting truth', () => {
    // The stale row carries no live/transitional active invocation (it was reaped
    // by startup reconcile), so the transition guard does not exclude it.
    seedRuntime({
      runtimeId: 'rt-durable-stale',
      status: 'stale',
      invocationState: 'exited',
      durable: true,
    })
    expect(
      getDurableHeadlessRuntimeForReattach(db, HOST_SESSION_ID, 'openai', 'codex-app-server')
        ?.runtimeId
    ).toBe('rt-durable-stale')
  })
})

describe('T-05358 isBrokerRuntimeInputDispatchable (interactive-gate predicate)', () => {
  const runtimeOf = (id: string) => {
    const r = db.runtimes.getByRuntimeId(id)
    if (!r) throw new Error(`missing ${id}`)
    return r
  }

  it('is FALSE for an active invocation in `stopping`', () => {
    seedRuntime({ runtimeId: 'rt-i-stopping', status: 'ready', invocationState: 'stopping' })
    expect(isBrokerRuntimeInputDispatchable(db, runtimeOf('rt-i-stopping'))).toBe(false)
  })

  it('is FALSE for an active invocation in `starting`', () => {
    seedRuntime({ runtimeId: 'rt-i-starting', status: 'ready', invocationState: 'starting' })
    expect(isBrokerRuntimeInputDispatchable(db, runtimeOf('rt-i-starting'))).toBe(false)
  })

  it('is FALSE for a terminal active invocation', () => {
    seedRuntime({ runtimeId: 'rt-i-exited', status: 'ready', invocationState: 'exited' })
    expect(isBrokerRuntimeInputDispatchable(db, runtimeOf('rt-i-exited'))).toBe(false)
  })

  it('is TRUE for a `ready` active invocation', () => {
    seedRuntime({ runtimeId: 'rt-i-ready', status: 'ready', invocationState: 'ready' })
    expect(isBrokerRuntimeInputDispatchable(db, runtimeOf('rt-i-ready'))).toBe(true)
  })

  it('is TRUE for a `turn_active` active invocation (busy handled downstream)', () => {
    seedRuntime({ runtimeId: 'rt-i-busy', status: 'busy', invocationState: 'turn_active' })
    expect(isBrokerRuntimeInputDispatchable(db, runtimeOf('rt-i-busy'))).toBe(true)
  })
})
