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

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { desktopObserverAttachmentHealth } from '../desktop/observer-supervisor.js'
import { currentDesktopObserverRuntimeIds } from '../desktop/observer-supervisor.js'

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
  /**
   * Explicit creation instant. `listByHostSessionId` orders
   * `created_at ASC, runtime_id ASC`, so two rows minted in the same millisecond
   * are separated by ID alone — and this fixture's ids happen to sort the
   * SUPERSEDED row last, which made the selection case pass or fail depending on
   * whether the clock ticked between two inserts. Real observers are created
   * seconds apart; the fixture now says so instead of racing.
   */
  createdAt?: string | undefined
}): void {
  if (db.sessions.getByHostSessionId(input.hostSessionId) === null) {
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
  }
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
    createdAt: input.createdAt ?? now(),
    updatedAt: input.createdAt ?? now(),
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

describe('the warmup population: the CURRENT desktop observer, and nothing else', () => {
  it('selects one observer per registration and excludes superseded, EPR and ordinary rows', () => {
    registerDesktop()
    // A SUPERSEDED observer for the same registration. §5 leaves it `ready` and
    // externally owned on purpose, so a scope-only predicate matches it too and
    // a restart would dial its endpoint alongside the live one. It shares the
    // host session, which is what makes it the same conversation's history.
    insertRuntime({
      runtimeId: 'rt-t08296-superseded',
      scopeRef: DESKTOP_SCOPE,
      hostSessionId: DESKTOP_HOST,
      createdAt: '2026-09-08T00:00:00.000Z',
      state: {
        lifecycleOwner: 'external',
        observerAttachment: { state: 'superseded' },
        control: { mode: 'broker-ipc', brokerAttached: true },
      },
      activeInvocationId: 'inv-t08296-superseded',
    })
    insertRuntime({
      runtimeId: DESKTOP_RUNTIME,
      scopeRef: DESKTOP_SCOPE,
      hostSessionId: DESKTOP_HOST,
      createdAt: '2026-09-08T01:00:00.000Z',
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

    const eligible = currentDesktopObserverRuntimeIds(db)
    // Exactly one per registration — the CURRENT observer.
    expect([...eligible]).toEqual([DESKTOP_RUNTIME])
    expect(eligible.has('rt-t08296-superseded')).toBe(false)
    expect(eligible.has('rt-t08296-epr')).toBe(false)
    expect(eligible.has('rt-t08296-ordinary')).toBe(false)

    // The gap this case exists for, stated positively so it cannot quietly stop
    // discriminating: selecting by "the scope has a desktop registration" — the
    // first cut of this fix — admits the superseded row as well, because §5
    // leaves it `ready` and externally owned on purpose.
    const scopeOnly = db.runtimes
      .listAll()
      .filter((row) => db.desktopThreadRegistrations.getByScopeRef(row.scopeRef) !== null)
      .map((row) => row.runtimeId)
      .sort()
    expect(scopeOnly).toEqual(['rt-t08296-superseded', DESKTOP_RUNTIME].sort())
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
