import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { deliverReassociatedBrokerTmuxInput } from '../broker-interactive-handlers'
import { isPathInsideRuntimeRoot } from '../broker/adoption-root'
import type { DurableBrokerClientLike } from '../broker/controller'
import { teardownBrokerLeasedTmux } from '../runtime-control-handlers/broker-dispose'
import {
  reassociateBrokerTmuxLease,
  reattachDurableBrokerForDispatch,
  reconcileDurableBrokerRuntimeReattach,
} from '../startup-reconcile'
import { type TmuxPaneState, createTmuxManager } from '../tmux'
import {
  type SocketScratch,
  assertShortSocketPath,
  createSocketScratch,
} from './fixtures/socket-scratch'

const HOST_SESSION_ID = 'hsid-runtime-root-guard'
const RUNTIME_ID = 'runtime-runtime-root-guard'

let fixtureRoot: string
let scratch: SocketScratch
let db: HrcDatabase
let leaseSockets: string[]

function seedSession(): void {
  const now = '2026-08-24T00:00:00.000Z'
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07503',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    ancestorScopeRefs: [],
    createdAt: now,
    updatedAt: now,
  })
}

function seedDurableRuntime(adoptionRoot: string): HrcRuntimeSnapshot {
  const now = '2026-08-24T00:00:00.000Z'
  const leaseSocketPath = join(adoptionRoot, 'btmux', `${RUNTIME_ID}.sock`)
  seedSession()
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07503',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      status: 'ready',
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          protocolVersion: 'harness-broker/0.2',
          socketPath: join(adoptionRoot, 'bipc', RUNTIME_ID, 'b.sock'),
          attachTokenRef: {
            kind: 'file',
            path: join(adoptionRoot, 'bipc', RUNTIME_ID, 'attach.token'),
            redacted: true,
          },
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: leaseSocketPath,
          sessionName: `hrc-codex-cli-${RUNTIME_ID}`,
          brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
          generation: 1,
          eventLedgerPath: join(adoptionRoot, 'bipc', RUNTIME_ID, 'events.ndjson'),
        },
        presentation: { kind: 'none' },
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error('runtime fixture was not persisted')
  return runtime
}

async function createLeaseSession(socketPath: string, sessionName: string): Promise<TmuxPaneState> {
  assertShortSocketPath(socketPath)
  await mkdir(dirname(socketPath), { recursive: true })
  leaseSockets.push(socketPath)
  const proc = Bun.spawn(
    ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await proc.exited).toBe(0)
  const pane = await createTmuxManager({ socketPath }).inspectSession(sessionName)
  if (!pane) throw new Error('synthetic lease session was not created')
  return pane
}

function seedLegacyRuntime(
  socketPath: string,
  sessionName: string,
  pane: TmuxPaneState
): HrcRuntimeSnapshot {
  const now = '2026-08-24T00:00:00.000Z'
  seedSession()
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07503',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'stale',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    tmuxJson: {
      socketPath,
      sessionName,
      windowName: pane.windowName,
      sessionId: pane.sessionId,
      windowId: pane.windowId,
      paneId: pane.paneId,
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error('legacy runtime fixture was not persisted')
  return runtime
}

beforeEach(async () => {
  scratch = await createSocketScratch('hrc-adopt-')
  fixtureRoot = scratch.root
  db = openHrcDatabase(join(fixtureRoot, 'state.sqlite'))
  leaseSockets = []
})

afterEach(async () => {
  for (const socketPath of leaseSockets) {
    await Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  }
  db.close()
  await scratch.cleanup()
})

describe('broker adoption runtime-root confinement', () => {
  it('rejects relative paths and sibling-prefix paths', () => {
    const runtimeRoot = join(fixtureRoot, 'runtime')
    expect(isPathInsideRuntimeRoot('bipc/runtime/b.sock', runtimeRoot)).toBe(false)
    expect(isPathInsideRuntimeRoot(join(fixtureRoot, 'runtime-copy', 'b.sock'), runtimeRoot)).toBe(
      false
    )
    expect(
      isPathInsideRuntimeRoot(join(runtimeRoot, 'bipc', 'runtime', 'b.sock'), runtimeRoot)
    ).toBe(true)
  })

  it('refuses an off-root persisted broker before any external adoption I/O', async () => {
    const runtimeRoot = join(fixtureRoot, 'copy-runtime')
    const runtime = seedDurableRuntime(join(fixtureRoot, 'live-runtime'))
    const calls: string[] = []

    const outcome = await reattachDurableBrokerForDispatch(db, runtime, {
      runtimeRoot,
      probeBrokerLease: async () => {
        calls.push('probe')
        return {
          brokerSocketLive: true,
          brokerWindow: null,
          tuiWindow: null,
        }
      },
      resolveAttachToken: async () => {
        calls.push('token')
        return 'secret'
      },
      brokerUnixClientFactory: async () => {
        calls.push('connect')
        return {} as DurableBrokerClientLike
      },
      controller: {
        attachAndReplay: async () => {
          calls.push('attach')
          return {
            ok: true,
            brokerAttached: true,
            replayedThroughSeq: 0,
            ackedThroughSeq: 0,
            acceptedInputIds: [],
          }
        },
      },
    })

    expect(calls).toEqual([])
    expect(outcome).toMatchObject({
      state: 'rejected-outside-runtime-root',
      reason: 'broker_adoption_path_outside_runtime_root',
    })
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('stale')
    expect(
      (
        db.runtimes.getByRuntimeId(RUNTIME_ID)?.runtimeStateJson?.['control'] as
          | { lastAttachError?: { code?: string } }
          | undefined
      )?.lastAttachError?.code
    ).toBe('broker_adoption_path_outside_runtime_root')
  })

  it('preserves adoption when every persisted broker path is inside runtimeRoot', async () => {
    const runtimeRoot = join(fixtureRoot, 'runtime')
    const runtime = seedDurableRuntime(runtimeRoot)
    const calls: string[] = []

    const outcome = await reconcileDurableBrokerRuntimeReattach(db, runtime, {
      runtimeRoot,
      probeBrokerLease: async () => {
        calls.push('probe')
        return {
          brokerSocketLive: true,
          brokerWindow: {
            socketPath: join(runtimeRoot, 'btmux', `${RUNTIME_ID}.sock`),
            sessionName: `hrc-codex-cli-${RUNTIME_ID}`,
            windowName: 'broker',
            sessionId: '$1',
            windowId: '@1',
            paneId: '%1',
          },
          tuiWindow: null,
        }
      },
      resolveAttachToken: async () => {
        calls.push('token')
        return 'secret'
      },
      brokerUnixClientFactory: async () => {
        calls.push('connect')
        return {} as DurableBrokerClientLike
      },
      controller: {
        attachAndReplay: async () => {
          calls.push('attach')
          return {
            ok: true,
            brokerAttached: true,
            replayedThroughSeq: 0,
            ackedThroughSeq: 0,
            acceptedInputIds: [],
          }
        },
      },
    })

    expect(calls).toEqual(['probe', 'token', 'connect', 'attach'])
    expect(outcome).toMatchObject({ state: 'broker-attached', brokerAttached: true })
  })

  it('does not reassociate a live off-root legacy lease, but permits the same in-root lease', async () => {
    const liveRoot = join(fixtureRoot, 'live-runtime')
    const copyRoot = join(fixtureRoot, 'copy-runtime')
    const socketPath = join(liveRoot, 'btmux', `${RUNTIME_ID}.sock`)
    const sessionName = `hrc-codex-cli-${RUNTIME_ID}`
    const pane = await createLeaseSession(socketPath, sessionName)
    const runtime = seedLegacyRuntime(socketPath, sessionName, pane)

    expect(await reassociateBrokerTmuxLease(runtime, copyRoot)).toBe(false)
    expect(await createTmuxManager({ socketPath }).inspectSession(sessionName)).not.toBeNull()
    expect(await reassociateBrokerTmuxLease(runtime, liveRoot)).toBe(true)
  })

  it('does not deliver direct tmux input through a live off-root legacy lease', async () => {
    const liveRoot = join(fixtureRoot, 'live-runtime')
    const copyRoot = join(fixtureRoot, 'copy-runtime')
    const socketPath = join(liveRoot, 'btmux', `${RUNTIME_ID}.sock`)
    const sessionName = `hrc-codex-cli-${RUNTIME_ID}`
    const pane = await createLeaseSession(socketPath, sessionName)
    const runtime = seedLegacyRuntime(socketPath, sessionName, pane)

    const delivered = await deliverReassociatedBrokerTmuxInput.call(
      { options: { runtimeRoot: copyRoot } } as never,
      {} as never,
      runtime,
      'must not be delivered',
      'run-off-root'
    )

    expect(delivered).toBe(false)
    expect(await createTmuxManager({ socketPath }).inspectSession(sessionName)).not.toBeNull()
  })

  it('preserves a live off-root lease during teardown and tears it down for its own root', async () => {
    const liveRoot = join(fixtureRoot, 'live-runtime')
    const copyRoot = join(fixtureRoot, 'copy-runtime')
    const socketPath = join(liveRoot, 'btmux', `${RUNTIME_ID}.sock`)
    const sessionName = `hrc-codex-cli-${RUNTIME_ID}`
    await createLeaseSession(socketPath, sessionName)
    const runtime = seedDurableRuntime(liveRoot)

    await teardownBrokerLeasedTmux(runtime, {
      runtimeRoot: copyRoot,
      logMessage: 'synthetic off-root teardown must be rejected',
    })
    expect(await createTmuxManager({ socketPath }).inspectSession(sessionName)).not.toBeNull()

    await teardownBrokerLeasedTmux(runtime, {
      runtimeRoot: liveRoot,
      logMessage: 'synthetic in-root teardown failed',
    })
    expect(await createTmuxManager({ socketPath }).inspectSession(sessionName)).toBeNull()
  })
})
