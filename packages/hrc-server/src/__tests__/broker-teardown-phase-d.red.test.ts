/**
 * T-05086 / T-05078 Phase D reds.
 *
 * These fixtures intentionally model an ordinary durable broker-headless runtime:
 * transport:'headless', controllerKind:'harness-broker', activeInvocationId set,
 * and NO leased-tmux viewer windows. The prior viewer regression only proved the
 * codex-app-server presentation path. Phase D requires the public stop/dispose
 * path for every broker-backed headless runtime to reach the HRC-owned broker
 * controller instead of only mutating HRC rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  interruptHeadlessRuntime,
  interruptRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
} from '../runtime-control-handlers/interrupt-terminate'

const HOST_SESSION_ID = 'hsid_phase_d'
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05086'
const LANE_REF = 'main'
const GENERATION = 7

let dir: string
let db: HrcDatabase

type DisposeCall = { runtimeId: string; reason?: string | undefined }
type InterruptCall = { runtimeId: string; runId: string; generation: number }

function nowTs(): string {
  return '2026-06-22T20:50:00.000Z'
}

function seedSession(): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

function seedBrokerRuntime(input: {
  runtimeId: string
  runId: string
  invocationId: string
  generation?: number | undefined
}): HrcRuntimeSnapshot {
  const now = nowTs()
  const generation = input.generation ?? GENERATION
  db.runtimes.insert({
    runtimeId: input.runtimeId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    transport: 'headless',
    harness: 'codex',
    provider: 'codex',
    status: 'busy',
    supportsInflightInput: false,
    adopted: false,
    activeRunId: input.runId,
    controllerKind: 'harness-broker',
    activeInvocationId: input.invocationId,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: input.runtimeId,
      hostSessionId: HOST_SESSION_ID,
      generation,
      status: 'busy',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(dir, 'bipc', `${input.runtimeId}.sock`),
          attachTokenRef: { kind: 'file', path: join(dir, 'bipc', 'token'), redacted: true },
        },
        generation,
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })

  db.runs.insert({
    runId: input.runId,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: input.runtimeId,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation,
    transport: 'headless',
    status: 'started',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
  })

  db.brokerInvocations.insert({
    invocationId: input.invocationId,
    operationId: `op-${input.invocationId}`,
    runtimeId: input.runtimeId,
    runId: input.runId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex',
    invocationState: 'turn_active',
    capabilitiesJson: JSON.stringify({ input: true, stop: true, dispose: true }),
    specHash: `spec-${input.invocationId}`,
    startRequestHash: `start-${input.invocationId}`,
    selectedProfileHash: `profile-${input.invocationId}`,
    createdAt: now,
    updatedAt: now,
  })

  const runtime = db.runtimes.getByRuntimeId(input.runtimeId)
  if (!runtime) throw new Error(`failed to seed runtime ${input.runtimeId}`)
  return runtime
}

function makeFakeThis(input?: {
  activeRuntimeIds?: string[] | undefined
  disposeCalls?: DisposeCall[] | undefined
  interruptCalls?: InterruptCall[] | undefined
}): unknown {
  const active = new Map<string, true>((input?.activeRuntimeIds ?? []).map((id) => [id, true]))
  const disposeCalls = input?.disposeCalls ?? []
  const interruptCalls = input?.interruptCalls ?? []

  return {
    db,
    notifyEvent() {},
    interruptHeadlessRuntime,
    terminateHeadlessRuntime,
    activeBrokerRuntimeIds: active,
    getHarnessBrokerController() {
      return {
        hasActive(runtimeId: string) {
          return active.has(runtimeId)
        },
        async dispose(runtimeId: string, opts?: { reason?: string }) {
          disposeCalls.push({ runtimeId, reason: opts?.reason })
          active.delete(runtimeId)
          const runtime = db.runtimes.getByRuntimeId(runtimeId)
          if (runtime?.activeInvocationId) {
            db.brokerInvocations.update(runtime.activeInvocationId, {
              invocationState: 'disposed',
              updatedAt: nowTs(),
            })
          }
          db.runtimes.update(runtimeId, {
            activeInvocationId: undefined,
            updatedAt: nowTs(),
          })
          return { ok: true as const, response: { disposed: true as const } }
        },
        async interrupt(runtimeId: string, options: { runId: string; generation: number }) {
          interruptCalls.push({ runtimeId, runId: options.runId, generation: options.generation })
          return {
            ok: true as const,
            response: { accepted: true as const, effect: 'turn_interrupted' as const },
          }
        },
      }
    },
  }
}

function invocation(invocationId: string): HrcBrokerInvocationRecord | null {
  return db.brokerInvocations.getByInvocationId(invocationId)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-broker-teardown-phase-d-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  seedSession()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-05086 Phase D broker-aware teardown', () => {
  it('test 18/24: dispose of ordinary broker-headless runtime reaches broker controller and leaves no live invocation', async () => {
    const runtime = seedBrokerRuntime({
      runtimeId: 'rt-dispose',
      runId: 'run-dispose',
      invocationId: 'inv-dispose',
    })
    const disposeCalls: DisposeCall[] = []
    const fakeThis = makeFakeThis({
      activeRuntimeIds: ['rt-dispose'],
      disposeCalls,
    }) as { activeBrokerRuntimeIds: Map<string, true> }

    const res = await (
      terminateRuntime as unknown as (
        this: unknown,
        runtime: HrcRuntimeSnapshot,
        opts: { reason: string; dropContinuation: boolean }
      ) => Promise<Response>
    ).call(fakeThis, runtime, {
      reason: 'agent_session_dispose',
      dropContinuation: true,
    })

    expect(res.status).toBe(200)
    expect(disposeCalls).toEqual([{ runtimeId: 'rt-dispose', reason: 'agent_session_dispose' }])
    expect(fakeThis.activeBrokerRuntimeIds.has('rt-dispose')).toBe(false)
    expect(db.runtimes.getByRuntimeId('rt-dispose')?.activeInvocationId).toBeUndefined()
    expect(invocation('inv-dispose')?.invocationState).toBe('disposed')
    expect(db.runtimes.getByRuntimeId('rt-dispose')?.status).toBe('terminated')
    expect(db.runs.getByRunId('run-dispose')?.status).toBe('failed')
  })

  it('test 19: stop/interrupt reaches the broker controller with the active run and generation', async () => {
    const runtime = seedBrokerRuntime({
      runtimeId: 'rt-interrupt',
      runId: 'run-active',
      invocationId: 'inv-active',
    })
    const interruptCalls: InterruptCall[] = []

    const res = await (
      interruptRuntime as unknown as (
        this: unknown,
        runtime: HrcRuntimeSnapshot,
        hard: boolean
      ) => Promise<Response>
    ).call(makeFakeThis({ activeRuntimeIds: ['rt-interrupt'], interruptCalls }), runtime, false)

    expect(res.status).toBe(200)
    expect(interruptCalls).toEqual([
      { runtimeId: 'rt-interrupt', runId: 'run-active', generation: GENERATION },
    ])
    expect(db.runtimes.getByRuntimeId('rt-interrupt')?.status).toBe('busy')
    expect(db.runs.getByRunId('run-active')?.status).toBe('started')
    expect(invocation('inv-active')?.invocationState).toBe('turn_active')
  })

  it('test 19 negative guard: stale run/generation snapshot is rejected with STALE_CONTEXT and no broker side effect', async () => {
    const staleSnapshot = seedBrokerRuntime({
      runtimeId: 'rt-stale',
      runId: 'run-old',
      invocationId: 'inv-stale',
    })
    const now = nowTs()
    db.runs.insert({
      runId: 'run-current',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: 'rt-stale',
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: GENERATION + 1,
      transport: 'headless',
      status: 'started',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
    db.runtimes.update('rt-stale', {
      generation: GENERATION + 1,
      activeRunId: 'run-current',
      updatedAt: now,
      lastActivityAt: now,
    })
    const interruptCalls: InterruptCall[] = []

    let caught: unknown
    try {
      await (
        interruptRuntime as unknown as (
          this: unknown,
          runtime: HrcRuntimeSnapshot,
          hard: boolean
        ) => Promise<Response>
      ).call(makeFakeThis({ activeRuntimeIds: ['rt-stale'], interruptCalls }), staleSnapshot, false)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HrcConflictError)
    expect((caught as HrcConflictError).code).toBe(HrcErrorCode.STALE_CONTEXT)
    expect(interruptCalls).toEqual([])
    expect(db.runs.getByRunId('run-old')?.status).toBe('started')
    expect(db.runs.getByRunId('run-current')?.status).toBe('started')
    expect(db.runtimes.getByRuntimeId('rt-stale')?.activeRunId).toBe('run-current')
  })
})
