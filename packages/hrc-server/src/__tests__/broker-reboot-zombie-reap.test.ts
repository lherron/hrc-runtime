/**
 * T-04297 — reboot-zombie durable HEADLESS brokers must be reaped, not left
 * `ready` forever.
 *
 * After a host reboot the durable broker process AND its lease tmux server are
 * both dead; only stale socket files remain. The startup/warmup probe sees
 * IPC unreachable AND brokerWindow === null (lease tmux server gone). The old
 * T-01875 G5 branch unconditionally classified this `broker-ipc-unavailable`
 * (nonterminal) and left the runtime `ready`, so every subsequent dispatch
 * failed "headless broker connection was not live" with a "just retry"
 * recommendation that could never succeed.
 *
 * New contract (reconcileDurableBrokerRuntimeReattach):
 *  - IPC unreachable + lease 'broker' window OBSERVED alive → still nonterminal
 *    (`broker-ipc-unavailable`): the substrate may genuinely host a live broker
 *    and the probe may have lost a race. Unchanged.
 *  - IPC unreachable + lease window GONE (brokerWindow === null) → the broker
 *    can never be reattached (even a live socket without a window fails lease
 *    identity). Mark the runtime STALE (`broker_lease_substrate_gone`) so the
 *    next dispatch reprovisions a fresh broker on the same session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationId } from 'spaces-harness-broker-protocol'

import { HarnessBrokerController } from '../broker/controller'
import { isRuntimeUnavailableStatus } from '../server-util'
import * as reconcile from '../startup-reconcile'
import type { TmuxPaneState } from '../tmux'

const SERVER_INSTANCE_ID = 'hrc-server-zombie-reap-test'
const ATTACH_TOKEN = 'attach-token-secret'

const HOST_SESSION_ID = 'hsid_zombie'
const SCOPE_REF = 'agent:mneme:project:media-ingest:task:primary'
const LANE_REF = 'main'
const GENERATION = 1
const RUNTIME_ID = 'runtime_zombie'
const OPERATION_ID = 'op_zombie'
const INVOCATION_ID = 'invocation_zombie' as InvocationId
const RUN_ID = 'run_zombie'

const BROKER_SOCKET = '/tmp/hrc-zombie/bipc/b.sock'
const LEASE_SOCKET = '/tmp/hrc-zombie/btmux/codex-app-se-runtime_zombie.sock'
const SESSION_NAME = 'hrc-codex-app-server-runtime_zombie'

const BROKER_WINDOW: TmuxPaneState = {
  socketPath: LEASE_SOCKET,
  sessionName: SESSION_NAME,
  windowName: 'broker',
  sessionId: '$1',
  windowId: '@10',
  paneId: '%10',
}

let dir: string
let db: HrcDatabase

function nowTs(): string {
  return '2026-06-12T00:00:00.000Z'
}

/**
 * Durable HEADLESS runtime: flat broker block with a brokerWindow and NO
 * tuiWindow → parseBrokerRuntimeHostingState infers substrate=leased-tmux,
 * presentation=none (the shape the T-01875 G5 branch keys on).
 */
function seedDurableHeadlessRuntime(): void {
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
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'codex-app-server',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    activeInvocationId: INVOCATION_ID,
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: BROKER_SOCKET,
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-zombie/bipc/attach.token',
            redacted: true,
          },
        },
        generation: GENERATION,
        brokerWindow: BROKER_WINDOW,
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    status: 'completed',
    acceptedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-zombie',
    startRequestHash: 'sha256:req-zombie',
    selectedProfileHash: 'sha256:prof-zombie',
    createdAt: now,
    updatedAt: now,
  })
}

function readRuntime(): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)
  if (!runtime) throw new Error('runtime vanished')
  return runtime
}

function makeController(): HarnessBrokerController {
  return new HarnessBrokerController({
    db,
    now: () => nowTs(),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-zombie-reap-'))
  db = openHrcDatabase(join(dir, 'test.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('T-04297 durable headless reboot-zombie reap', () => {
  it('IPC unreachable + lease window ALIVE stays nonterminal (broker-ipc-unavailable, runtime ready)', async () => {
    seedDurableHeadlessRuntime()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not dial: IPC probe already reported unreachable')
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: false,
        brokerHealth: 'unreachable',
        brokerWindow: BROKER_WINDOW,
        tuiWindow: null,
      }),
    })

    expect(outcome.state).toBe('broker-ipc-unavailable')
    expect(outcome.brokerAttached).toBe(false)
    // The runtime keeps claiming its lease; the lazy dispatch reattach is the
    // recovery path for a transiently-unreachable-but-alive broker.
    expect(readRuntime().status).toBe('ready')
  })

  it('IPC unreachable + lease window GONE (host reboot) marks the runtime stale: broker_lease_substrate_gone', async () => {
    seedDurableHeadlessRuntime()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(db, readRuntime(), {
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not dial: IPC probe already reported unreachable')
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: false,
        brokerHealth: 'unreachable',
        brokerWindow: null,
        tuiWindow: null,
      }),
    })

    expect(outcome.state).toBe('stale')
    expect(outcome.reason).toBe('broker_lease_substrate_gone')
    expect(outcome.brokerAttached).toBe(false)
    // The row is unavailable, so getReusableHeadlessRuntimeForSession skips it
    // and the next dispatch flows into the reattach-failed terminate+reprovision
    // branch of handleHeadlessBrokerDispatchTurn (fresh broker, same session).
    expect(isRuntimeUnavailableStatus(readRuntime().status)).toBe(true)
  })

  it('reattachDurableBrokerForDispatch on a reboot-zombie returns false AND stales the row (no resurrect)', async () => {
    seedDurableHeadlessRuntime()

    const reattached = await reconcile.reattachDurableBrokerForDispatch(db, readRuntime(), {
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not dial: IPC probe already reported unreachable')
      },
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: false,
        brokerHealth: 'unreachable',
        brokerWindow: null,
        tuiWindow: null,
      }),
    })

    expect(reattached).toBe(false)
    expect(isRuntimeUnavailableStatus(readRuntime().status)).toBe(true)
  })
})
