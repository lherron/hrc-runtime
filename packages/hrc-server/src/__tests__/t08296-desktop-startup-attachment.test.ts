/**
 * Desktop observer attachment after an HRC restart (T-08296, P-00502 §5).
 *
 * The defect these cover is one a row cannot show you. An HRC restart is not a
 * crash: nothing writes a detachment, so `observerAttachment` stays null and
 * `control.brokerAttached` keeps the `true` the PREVIOUS daemon wrote. Every
 * durable field therefore said "attached" while the new daemon held no socket —
 * the conversation went unobserved with its runtime row reading `ready`, and
 * every re-registration answered `already_attached`.
 *
 * Both cases below are paired against the populations that must NOT change:
 * genuine EPR keeps its exclusion, and an ordinary broker row is untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { desktopObserverAttachmentHealth } from '../desktop/observer-supervisor.js'
import { isRegisteredDesktopObserver } from '../startup-reconcile.js'

const DESKTOP_SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'
const DESKTOP_HOST = 'hsid-t08296-desktop'
const DESKTOP_RUNTIME = 'rt-t08296-desktop'
const DESKTOP_INVOCATION = 'inv-t08296-desktop'

let dir: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08296-attach-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

const now = (): string => new Date().toISOString()

function insertRuntime(input: {
  runtimeId: string
  scopeRef: string
  hostSessionId: string
  state: Record<string, unknown>
  activeInvocationId?: string | undefined
}): void {
  db.sessions.insert({
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: input.runtimeId,
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    createdAt: now(),
    updatedAt: now(),
    runtimeStateJson: input.state,
    ...(input.activeInvocationId === undefined
      ? {}
      : { activeInvocationId: input.activeInvocationId }),
  })
}

function registerDesktop(): void {
  db.desktopThreadRegistrations.insert({
    registrationKey: 'reg-t08296',
    homeIdentity: '/tmp/codex-home',
    sqliteHome: '/tmp/codex-home',
    nativeThreadId: '01a08138-7d09-7e12-b8ba-d82b744d9a1e',
    scopeRef: DESKTOP_SCOPE,
    agentId: 'stella',
    projectId: 'hrc-ios',
    slotToken: 'primary-nova',
    laneRef: 'main',
    hostSessionId: DESKTOP_HOST,
    projectRoot: '/tmp/workspace',
    workspaceCwd: '/tmp/workspace',
    registeredVia: 'startup',
    createdAt: now(),
    updatedAt: now(),
  })
}

/** The runtime as it looks after a restart: nothing marked it detached. */
function restartSurvivorState(): Record<string, unknown> {
  return {
    lifecycleOwner: 'external',
    // Written by the PREVIOUS daemon, and still `true` — this is the whole trap.
    control: { mode: 'broker-ipc', brokerAttached: true },
    broker: {
      endpoint: { kind: 'unix-jsonrpc-ndjson', socketPath: '/tmp/t08296.sock' },
      brokerPid: 4242,
      ownerServerInstanceId: 'hrc-server:39112',
    },
  }
}

function serverWith(
  activeClient: string | undefined
): Parameters<typeof desktopObserverAttachmentHealth>[0] {
  return {
    db,
    getHarnessBrokerController: () => ({ activeClientInvocationId: () => activeClient }),
  } as unknown as Parameters<typeof desktopObserverAttachmentHealth>[0]
}

describe('the warmup population: desktop is included, genuine EPR is not', () => {
  it('separates a registered desktop observer from EPR and from an ordinary row', () => {
    registerDesktop()
    insertRuntime({
      runtimeId: DESKTOP_RUNTIME,
      scopeRef: DESKTOP_SCOPE,
      hostSessionId: DESKTOP_HOST,
      state: restartSurvivorState(),
      activeInvocationId: DESKTOP_INVOCATION,
    })
    insertRuntime({
      runtimeId: 'rt-t08296-epr',
      scopeRef: 'agent:reg:project:hrc-runtime:task:reg-t08296',
      hostSessionId: 'hsid-t08296-epr',
      state: {
        lifecycleOwner: 'external',
        externalRegistration: { registrationId: 'reg-t08296' },
      },
    })
    insertRuntime({
      runtimeId: 'rt-t08296-ordinary',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-08296',
      hostSessionId: 'hsid-t08296-ordinary',
      state: { control: { mode: 'broker-ipc', brokerAttached: true } },
    })

    const runtime = (id: string): HrcRuntimeSnapshot => {
      const found = db.runtimes.getByRuntimeId(id)
      if (found === null) throw new Error(`fixture runtime ${id} missing`)
      return found
    }

    // Both externals; only the one HRC holds a registration for is a desktop
    // conversation, so the EPR exclusion survives intact.
    expect(isRegisteredDesktopObserver(db, runtime(DESKTOP_RUNTIME))).toBe(true)
    expect(isRegisteredDesktopObserver(db, runtime('rt-t08296-epr'))).toBe(false)
    expect(isRegisteredDesktopObserver(db, runtime('rt-t08296-ordinary'))).toBe(false)
  })
})

describe('attachment health is a live fact, not a persisted claim', () => {
  beforeEach(() => {
    registerDesktop()
    insertRuntime({
      runtimeId: DESKTOP_RUNTIME,
      scopeRef: DESKTOP_SCOPE,
      hostSessionId: DESKTOP_HOST,
      state: restartSurvivorState(),
      activeInvocationId: DESKTOP_INVOCATION,
    })
  })

  const registration = () => {
    const found = db.desktopThreadRegistrations.getByScopeRef(DESKTOP_SCOPE)
    if (found === null) throw new Error('fixture registration missing')
    return found
  }

  it('reports detached when this daemon holds no client, despite every row saying otherwise', () => {
    // Exactly the post-restart state: brokerAttached true, no observerAttachment,
    // status ready. The old predicate answered `attached` here and the
    // conversation stayed unobserved.
    const health = desktopObserverAttachmentHealth(serverWith(undefined), registration())
    expect(health.state).toBe('detached')
    expect(health.state === 'detached' ? health.reason : '').toBe(
      'serving_controller_client_absent'
    )
  })

  it('reports detached when the client belongs to a superseded invocation', () => {
    const health = desktopObserverAttachmentHealth(
      serverWith('inv-t08296-previous'),
      registration()
    )
    expect(health.state).toBe('detached')
    expect(health.state === 'detached' ? health.reason : '').toBe('serving_controller_client_stale')
  })

  it('reports attached only when the client matches the current invocation', () => {
    const health = desktopObserverAttachmentHealth(serverWith(DESKTOP_INVOCATION), registration())
    expect(health.state).toBe('attached')
  })
})
