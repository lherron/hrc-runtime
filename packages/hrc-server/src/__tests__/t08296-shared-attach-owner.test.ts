/**
 * One attach per runtime, across startup warmup AND desktop registration
 * recovery (T-08296, Astra EN-08595).
 *
 * Why a map entry was never a fence. `attachAndReplay` publishes the new client
 * with `setActive` — which only clears the seat monitor and REPLACES
 * `active`'s entry — and then subscribes a live event consumer on that client.
 * Nothing closes the previous client and nothing cancels its consumer. So two
 * concurrent attaches leave two sockets and two consumers draining the same
 * broker stream forever; the store stays correct because projection is
 * idempotent, which is exactly why the leak is invisible in the data.
 *
 * The overlap here is a DETERMINISTIC IN-PROCESS BARRIER at the existing
 * client-factory seam — the factory blocks until both callers have entered — not
 * a millisecond race. No production test door: the factory is already an
 * injectable dependency of the reattach path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { type BrokerReattachOutcome, attachDurableBrokerShared } from '../startup-reconcile.js'

const RUNTIME = 'rt-t08296-shared'
const HOST = 'hsid-t08296-shared'
const SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'
const INVOCATION = 'inv-t08296-shared'

let dir: string
let db: HrcDatabase
let inFlight: Map<string, Promise<BrokerReattachOutcome>>

/** Every client this run handed out, and whether a live consumer was started. */
type FakeClient = { id: number; streamed: number; closed: boolean }
let clients: FakeClient[]
let activeInvocation: string | undefined

/**
 * A gate the client factory holds open until the test releases it.
 *
 * NOT a "both parties reached the factory" barrier — that deadlocks against the
 * very property under test. Once the callers share an owner the SECOND one never
 * enters the factory at all: it joins the in-flight promise. So the overlap is
 * staged from outside instead: start the owner, wait until it is provably
 * in flight, start the joiner, then release. That is a real overlap and it is
 * deterministic, with no timing assumptions.
 */
function makeGate() {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait: () => open, release: () => release() }
}

/** Resolves once the shared owner has an in-flight attach for this runtime. */
async function whenOwnerInFlight(): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (inFlight.has(RUNTIME)) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('no attach ever went in flight')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't08296-shared-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  inFlight = new Map()
  clients = []
  activeInvocation = undefined
  const now = new Date().toISOString()
  db.sessions.insert({
    hostSessionId: HOST,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME,
    hostSessionId: HOST,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    createdAt: now,
    updatedAt: now,
    activeInvocationId: INVOCATION,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME,
      hostSessionId: HOST,
      generation: 1,
      status: 'ready',
      lifecycleOwner: 'external',
      control: { mode: 'broker-ipc', brokerAttached: true },
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: 'hrc-server:1',
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(dir, 'broker.sock'),
          attachTokenRef: { kind: 'file', path: join(dir, 'attach.token'), redacted: true },
        },
        generation: 1,
        brokerPid: 4242,
        brokerWindow: brokerWindow(),
      },
    },
  })
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

/** The lease window shape the real reattach path matches identity against. */
function brokerWindow() {
  return {
    socketPath: join(dir, 'tmux.sock'),
    sessionName: 'hrc-t08296',
    windowName: 'broker',
    sessionId: '$1',
    windowId: '@10',
    paneId: '%10',
  }
}

function runtime(): HrcRuntimeSnapshot {
  const found = db.runtimes.getByRuntimeId(RUNTIME)
  if (found === null) throw new Error('fixture runtime missing')
  return found
}

/**
 * Deps whose controller records what an attach would really do: publish a client
 * and subscribe a consumer on it. `activeClientInvocationId` reads the same
 * in-memory answer the real controller does.
 */
function deps(gate?: { wait(): Promise<void> }) {
  return {
    runtimeRoot: dir,
    controller: {
      attachAndReplay: async (input: { runtimeId: string; client: unknown }) => {
        const client = input.client as FakeClient
        activeInvocation = INVOCATION
        client.streamed += 1
        return { ok: true as const, brokerAttached: true as const }
      },
      activeClientInvocationId: (runtimeId: string) =>
        runtimeId === RUNTIME ? activeInvocation : undefined,
    },
    brokerUnixClientFactory: async () => {
      const client: FakeClient = { id: clients.length + 1, streamed: 0, closed: false }
      clients.push(client)
      // The seam: hold the caller inside the factory until the test releases it,
      // so the overlap window is controlled rather than raced.
      if (gate) await gate.wait()
      return client
    },
    resolveAttachToken: async () => 'token',
    probeBrokerLease: async () => ({
      brokerSocketLive: true,
      brokerWindow: brokerWindow(),
    }),
    inFlightOperations: inFlight,
  } as unknown as Parameters<typeof attachDurableBrokerShared>[2]
}

describe('startup warmup and registration recovery share one attach owner', () => {
  it('overlapping callers produce ONE client and ONE live consumer', async () => {
    const gate = makeGate()
    // The owner enters and blocks inside the client factory.
    const first = attachDurableBrokerShared(db, runtime(), deps(gate))
    await whenOwnerInFlight()
    // The joiner arrives while that attach is genuinely in flight.
    const second = attachDurableBrokerShared(db, runtime(), deps(gate))
    gate.release()
    const [a, b] = await Promise.all([first, second])

    // Exactly one client was ever constructed, so there is one socket and one
    // consumer — the property `setActive` does not provide.
    expect(clients).toHaveLength(1)
    expect(clients[0]?.streamed).toBe(1)
    // Both callers converge on the same outcome; neither is refused.
    expect(a.state).toBe('broker-attached')
    expect(b.state).toBe('broker-attached')
  })

  it('a LATE caller after the flight completed does not start a second attach', async () => {
    await attachDurableBrokerShared(db, runtime(), deps())
    expect(clients).toHaveLength(1)
    expect(inFlight.size).toBe(0)

    // The map is empty now, so joining is not what protects this one — the
    // current-client recheck is.
    const late = await attachDurableBrokerShared(db, runtime(), deps())
    expect(late.state).toBe('broker-attached')
    expect(clients).toHaveLength(1)
  })

  it('preserves the durable runtime and invocation; no replacement', async () => {
    const gate = makeGate()
    const first = attachDurableBrokerShared(db, runtime(), deps(gate))
    await whenOwnerInFlight()
    const second = attachDurableBrokerShared(db, runtime(), deps(gate))
    gate.release()
    await Promise.all([first, second])
    const after = runtime()
    expect(after.runtimeId).toBe(RUNTIME)
    expect(after.activeInvocationId).toBe(INVOCATION)
    expect(db.runtimes.listByHostSessionId(HOST)).toHaveLength(1)
  })

  it('CONTROL: without the shared owner, both callers build their own client', async () => {
    // The same overlap with two SEPARATE in-flight maps — what startup warmup and
    // registration recovery were before they shared one. This is the state the
    // fix removes, asserted rather than described.
    const gate = makeGate()
    const separateA = { ...(deps(gate) as Record<string, unknown>), inFlightOperations: new Map() }
    const separateB = { ...(deps(gate) as Record<string, unknown>), inFlightOperations: new Map() }
    // Both enter the factory, because neither can see the other's flight.
    setTimeout(() => gate.release(), 25)
    await Promise.all([
      attachDurableBrokerShared(
        db,
        runtime(),
        separateA as unknown as Parameters<typeof attachDurableBrokerShared>[2]
      ),
      attachDurableBrokerShared(
        db,
        runtime(),
        separateB as unknown as Parameters<typeof attachDurableBrokerShared>[2]
      ),
    ])
    expect(clients).toHaveLength(2)
    expect(clients.filter((client) => client.streamed > 0)).toHaveLength(2)
  })
})
