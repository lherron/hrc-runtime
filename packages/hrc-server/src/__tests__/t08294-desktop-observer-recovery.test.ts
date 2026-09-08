/**
 * T-08294 — losing the observer, and getting it back.
 *
 * The earlier recovery test terminated a runtime row by hand, which is NOT how a
 * desktop observer actually dies. Both real mechanisms leave `status: 'ready'`
 * untouched, because the lifecycle handlers return early for external ownership
 * on purpose — HRC must not assert a terminal fact about a subject it does not
 * own. So a hand-terminated row exercised a path production never takes, and the
 * predicate it "proved" would have declared a dead observer healthy forever.
 *
 * These tests drive the real handlers:
 *   `markBrokerCrashTerminal` — the broker serving the observer crashed;
 *   `failReplayStale`         — attach/replay found a retention gap.
 * and then ask the supervisor to recover, asserting that reattach is preferred,
 * that no second observer appears when reattach works, and that nothing anywhere
 * says anything about the desktop thread.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { BrokerControllerError } from '../broker/controller/errors'
import { failReplayStale, markBrokerCrashTerminal } from '../broker/controller/lifecycle'
import type { LifecycleContext } from '../broker/controller/lifecycle'
import {
  currentDesktopObserverRuntime,
  desktopObserverAttachmentHealth,
  scheduleDesktopObserverAttachment,
} from '../desktop/observer-supervisor'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-09-08T12:00:00.000Z'
const SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'
const HOST_SESSION = 'hsid-desktop'
const THREAD = '01a08138-7d09-7e12-b8ba-d82b744d9a1e'

let dir: string
let db: HrcDatabase
let server: HrcServerInstanceForHandlers
let attachCalls: number
let reattachResults: Array<{ state: string }>
let reattachCalls: HrcRuntimeSnapshot[]
let rolloutPath: string
let bundlePath: string

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function lifecycleCtx(): LifecycleContext {
  const active = new Map<string, { client: unknown }>()
  active.set('rt-observer', { client: { id: 'dead-client' } })
  return {
    db,
    now: () => NOW,
    serverInstanceId: 'server-test',
    logger: {},
    getActiveInvocationId: () => 'inv-observer',
    getActiveClient: (runtimeId: string) => active.get(runtimeId)?.client,
    deleteActive: (runtimeId: string) => {
      active.delete(runtimeId)
    },
    markBrokerClosing: () => undefined,
    intentionalCloseReason: () => undefined,
    fireBrokerTmuxLeaseReap: () => undefined,
  } as unknown as LifecycleContext
}

function seedRegisteredObserver(): void {
  db.sessions.insert({
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 2,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  db.continuities.upsert({
    scopeRef: SCOPE,
    laneRef: 'main',
    activeHostSessionId: HOST_SESSION,
    updatedAt: NOW,
  })
  db.desktopThreadRegistrations.insert({
    registrationKey: 'key-live',
    homeIdentity: join(dir, 'codex'),
    sqliteHome: join(dir, 'codex'),
    nativeThreadId: THREAD,
    scopeRef: SCOPE,
    agentId: 'stella',
    projectId: 'hrc-ios',
    slotToken: 'primary-nova',
    laneRef: 'main',
    hostSessionId: HOST_SESSION,
    projectRoot: dir,
    workspaceCwd: dir,
    rolloutPath,
    bundlePath,
    registeredVia: 'startup',
    createdAt: NOW,
    updatedAt: NOW,
  })
  // A STALE PREVIOUS-GENERATION row, ready and never terminated. This is the
  // T-07650 shape: without a generation filter it is the row a naive lookup
  // finds first, and it would answer "attached" forever.
  db.runtimes.insert({
    runtimeId: 'rt-observer-gen1',
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
    createdAt: NOW,
    updatedAt: NOW,
    runtimeStateJson: { lifecycleOwner: 'external', control: { brokerAttached: true } },
  })
  db.runtimes.insert({
    runtimeId: 'rt-observer',
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 2,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    activeInvocationId: 'inv-observer',
    createdAt: NOW,
    updatedAt: NOW,
    runtimeStateJson: {
      lifecycleOwner: 'external',
      control: { mode: 'broker-ipc', brokerAttached: true },
    },
  })
  db.brokerInvocations.insert({
    invocationId: 'inv-observer',
    operationId: 'op-observer',
    runtimeId: 'rt-observer',
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-desktop',
    invocationState: 'ready',
    capabilitiesJson: '{}',
    specHash: 'spec',
    startRequestHash: 'startreq',
    selectedProfileHash: 'profile',
    specProjectionJson: '{}',
    startRequestProjectionJson: '{}',
    ownerServerInstanceId: 'server-test',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08294-recovery-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  rolloutPath = join(dir, 'rollout.jsonl')
  bundlePath = join(dir, 'codex-bundle')
  await writeFile(rolloutPath, '{}\n')
  await writeFile(bundlePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  attachCalls = 0
  reattachCalls = []
  reattachResults = [{ state: 'reattached' }]
  server = {
    db,
    options: {},
    attachDesktopObserver: () => {
      attachCalls += 1
      return Promise.resolve({ attached: false as const, reason: 'stub', detail: 'no broker' })
    },
    reattachDurableBrokerSessionForOpen: (runtime: HrcRuntimeSnapshot) => {
      reattachCalls.push(runtime)
      return Promise.resolve(reattachResults.shift() ?? { state: 'unavailable' })
    },
  } as unknown as HrcServerInstanceForHandlers
  seedRegisteredObserver()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

const registration = () => db.desktopThreadRegistrations.getByRegistrationKey('key-live')!

describe('observer loss is detected by the REAL mechanisms', () => {
  it('ignores a stale previous-generation ready row (T-07650 shape)', () => {
    // Both rows are `ready` and neither is terminated. Only the generation
    // separates them, and the wrong one would make every later check lie.
    expect(currentDesktopObserverRuntime(server, registration())?.runtimeId).toBe('rt-observer')
  })

  it('CONTROL: a healthy observer reports attached and schedules nothing', () => {
    expect(desktopObserverAttachmentHealth(server, registration()).state).toBe('attached')
    const disposition = scheduleDesktopObserverAttachment(server, registration())
    expect(disposition.scheduled).toBe(false)
    expect(!disposition.scheduled && disposition.reason).toBe('already_attached')
  })

  it('a broker CRASH leaves status ready but is seen as detached', () => {
    markBrokerCrashTerminal(
      lifecycleCtx(),
      'rt-observer',
      new BrokerControllerError('broker_transport_closed', 'socket closed')
    )
    const runtime = db.runtimes.getByRuntimeId('rt-observer')!
    // The invariant that must NOT change: no terminal fact about the subject.
    expect(runtime.status).toBe('ready')
    expect(runtime.lifecycleTerminalReason).toBeUndefined()
    expect(isExternalLifecycleOwner(runtime)).toBe(true)
    // The fact that must now be recorded: HRC is not attached.
    expect(desktopObserverAttachmentHealth(server, registration())).toMatchObject({
      state: 'detached',
      reason: 'broker_crash',
    })
  })

  it('a REPLAY-STALE detach leaves status ready but is seen as detached', async () => {
    await failReplayStale(
      lifecycleCtx(),
      db.runtimes.getByRuntimeId('rt-observer')!,
      db.brokerInvocations.getByInvocationId('inv-observer')!,
      { close: async () => undefined } as never,
      new BrokerControllerError('broker_replay_retention_gap', 'gap')
    )
    const runtime = db.runtimes.getByRuntimeId('rt-observer')!
    expect(runtime.status).toBe('ready')
    expect(runtime.lifecycleTerminalReason).toBeUndefined()
    expect(desktopObserverAttachmentHealth(server, registration())).toMatchObject({
      state: 'detached',
      reason: 'replay_stale',
    })
  })
})

describe('recovery prefers durable reattachment', () => {
  it('reattaches the EXISTING invocation instead of starting a second observer', async () => {
    markBrokerCrashTerminal(
      lifecycleCtx(),
      'rt-observer',
      new BrokerControllerError('broker_transport_closed', 'socket closed')
    )
    const disposition = scheduleDesktopObserverAttachment(server, registration())
    expect(disposition.scheduled).toBe(true)
    await settle()

    expect(reattachCalls.map((runtime) => runtime.runtimeId)).toEqual(['rt-observer'])
    // No second observer: the durable invocation was resumed, so history is
    // replayed from its cursor rather than re-projected as new work.
    expect(attachCalls).toBe(0)
    expect(db.runtimes.listByHostSessionId(HOST_SESSION)).toHaveLength(2)
    expect(desktopObserverAttachmentHealth(server, registration()).state).toBe('attached')
    // Still nothing terminal, and the address is untouched.
    expect(db.runtimes.getByRuntimeId('rt-observer')?.status).toBe('ready')
    expect(db.desktopThreadRegistrations.getByScopeRef(SCOPE)?.nativeThreadId).toBe(THREAD)
  })

  it('starts a fresh observer only when the broker is genuinely gone', async () => {
    reattachResults = [{ state: 'unavailable' }]
    markBrokerCrashTerminal(
      lifecycleCtx(),
      'rt-observer',
      new BrokerControllerError('broker_transport_closed', 'socket closed')
    )
    expect(scheduleDesktopObserverAttachment(server, registration()).scheduled).toBe(true)
    await settle()

    expect(reattachCalls).toHaveLength(1)
    expect(attachCalls).toBe(1)
    // The superseded observer is recorded as such — by HRC, about HRC — and is
    // still not terminated, still externally owned.
    const superseded = db.runtimes.getByRuntimeId('rt-observer')!
    expect(superseded.status).toBe('ready')
    expect(superseded.lifecycleTerminalReason).toBeUndefined()
    expect(superseded.runtimeStateJson?.['observerAttachment']).toMatchObject({
      state: 'superseded',
    })
    expect(isExternalLifecycleOwner(superseded)).toBe(true)
  })

  it('does not stack a second recovery while one is in flight', async () => {
    reattachResults = [{ state: 'unavailable' }, { state: 'unavailable' }]
    markBrokerCrashTerminal(
      lifecycleCtx(),
      'rt-observer',
      new BrokerControllerError('broker_transport_closed', 'socket closed')
    )
    expect(scheduleDesktopObserverAttachment(server, registration()).scheduled).toBe(true)
    const second = scheduleDesktopObserverAttachment(server, registration())
    expect(second.scheduled).toBe(false)
    expect(!second.scheduled && second.reason).toBe('attachment_in_flight')
    await settle()
    expect(attachCalls).toBe(1)
  })
})
