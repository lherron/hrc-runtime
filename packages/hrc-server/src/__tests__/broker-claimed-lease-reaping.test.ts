import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'

import { BrokerControllerError } from '../broker/controller'
import { invalidateHostContext } from '../runtime-control-handlers'
import {
  clearBrokerRecovery,
  isBrokerRecoveryExhausted,
  recordBrokerRecoveryFailure,
  sweepOrphanedBrokerTmuxLeases,
} from '../startup-reconcile/lease-identity'
import { createTmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let db: HrcDatabase
const sockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('claimed-lease-')
  db = openHrcDatabase(fixture.dbPath)
})

afterEach(async () => {
  db.close()
  for (const socketPath of sockets.splice(0)) {
    await Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  }
  await fixture.cleanup()
})

async function createDurableLease(runtimeId: string, options: { interactive?: boolean } = {}) {
  const root = join(fixture.runtimeRoot, 'btmux')
  await mkdir(root, { recursive: true })
  const socketPath = join(root, `${runtimeId}.sock`)
  const sessionName = `hrc-cx-${runtimeId}`
  const endpointSocketPath = join(fixture.runtimeRoot, 'bipc', runtimeId, 'b.sock')
  const brokerCommand = `exec '${process.execPath}' -e 'setInterval(() => {}, 60000)' harness-broker --runtime-id '${runtimeId}' --socket '${endpointSocketPath}'`
  sockets.push(socketPath)
  expect(
    await Bun.spawn(
      [
        'tmux',
        '-S',
        socketPath,
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-n',
        'broker',
        brokerCommand,
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    ).exited
  ).toBe(0)
  const manager = createTmuxManager({ socketPath })
  const brokerWindow = await manager.inspectWindow({
    sessionName,
    windowName: 'broker',
  })
  if (!brokerWindow) throw new Error('expected broker window')
  const brokerProcess = await manager.inspectPaneProcess(brokerWindow.paneId)
  if (!brokerProcess || brokerProcess.dead || brokerProcess.pid <= 0) {
    throw new Error('expected live broker process')
  }
  if (options.interactive) {
    expect(
      await Bun.spawn(
        ['tmux', '-S', socketPath, 'new-window', '-d', '-t', `=${sessionName}`, '-n', 'tui'],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)
  }
  const tuiWindow = options.interactive
    ? await createTmuxManager({ socketPath }).inspectWindow({
        sessionName,
        windowName: 'tui',
      })
    : null
  if (options.interactive && !tuiWindow) throw new Error('expected tui window')
  return {
    socketPath,
    sessionName,
    endpointSocketPath,
    brokerCommand,
    brokerProcess,
    brokerWindow,
    tuiWindow,
  }
}

function seedRuntime(
  runtimeId: string,
  lease: Awaited<ReturnType<typeof createDurableLease>>,
  options: {
    status?: string
    updatedAt?: string
    paneId?: string
    tuiPaneId?: string
    interactive?: boolean
    endpointDir?: string
    lifecycleOwner?: 'external'
  } = {}
): HrcRuntimeSnapshot {
  const now = options.updatedAt ?? new Date().toISOString()
  const hostSessionId = `hs-${runtimeId}`
  const endpointDir = options.endpointDir ?? join(fixture.runtimeRoot, 'bipc', runtimeId)
  db.sessions.insert({
    hostSessionId,
    scopeRef: `agent:cody:project:hrc-runtime:task:T-05337:${runtimeId}`,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  return db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef: `agent:cody:project:hrc-runtime:task:T-05337:${runtimeId}`,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: options.status ?? 'ready',
    statusChangedAt: now,
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      ...(options.lifecycleOwner === undefined ? {} : { lifecycleOwner: options.lifecycleOwner }),
      broker: {
        brokerCommand: lease.brokerCommand,
        brokerPid: lease.brokerProcess.pid,
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: join(endpointDir, 'b.sock'),
          attachTokenRef: { kind: 'file', path: join(endpointDir, 'token'), redacted: true },
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: lease.socketPath,
          sessionName: lease.sessionName,
          brokerWindow: {
            sessionId: lease.brokerWindow.sessionId,
            windowId: lease.brokerWindow.windowId,
            paneId: options.paneId ?? lease.brokerWindow.paneId,
          },
          generation: 1,
          eventLedgerPath: join(endpointDir, 'events.ndjson'),
        },
        presentation:
          options.interactive && lease.tuiWindow
            ? {
                kind: 'tmux-tui',
                tuiWindow: {
                  sessionId: lease.tuiWindow.sessionId,
                  windowId: lease.tuiWindow.windowId,
                  paneId: options.tuiPaneId ?? lease.tuiWindow.paneId,
                },
                operatorAttachTarget: true,
                attachCommand: `tmux -S ${lease.socketPath} attach -t ${lease.sessionName}:tui`,
              }
            : { kind: 'none' },
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
}

function sweepOptions(extra: Partial<Parameters<typeof sweepOrphanedBrokerTmuxLeases>[2]> = {}) {
  return {
    graceMs: 0,
    removeDeadSocketFiles: true,
    killLiveLeaseServers: true,
    listBrokerProcessCommands: async () => [],
    ...extra,
  }
}

describe('claimed broker lease classification', () => {
  it('preserves a live exact durable identity and keeps the compatibility alias exact', async () => {
    const lease = await createDurableLease('live')
    seedRuntime('live', lease)

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.skippedClaimed).toBe(result.preservedClaimed)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(
      await createTmuxManager({ socketPath: lease.socketPath }).inspectWindow({
        sessionName: lease.sessionName,
        windowName: 'broker',
      })
    ).not.toBeNull()
  })

  it('preserves an interactive lease only when both broker and TUI identities match', async () => {
    const lease = await createDurableLease('interactive', { interactive: true })
    seedRuntime('interactive', lease, { interactive: true })

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(
      await createTmuxManager({ socketPath: lease.socketPath }).inspectWindow({
        sessionName: lease.sessionName,
        windowName: 'tui',
      })
    ).not.toBeNull()
  })

  it('preserves broker pane-id drift when the observed pane still runs this runtime broker', async () => {
    const lease = await createDurableLease('mismatch')
    seedRuntime('mismatch', lease, { paneId: '%not-the-live-pane' })

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(result.staledClaimedRuntimes).toBe(0)
    expect(db.runtimes.getByRuntimeId('mismatch')?.status).toBe('ready')
  })

  it('preserves a missing TUI window when the broker pane is still live', async () => {
    const lease = await createDurableLease('missing-tui', { interactive: true })
    seedRuntime('missing-tui', lease, { interactive: true })
    expect(
      await Bun.spawn(
        ['tmux', '-S', lease.socketPath, 'kill-window', '-t', `=${lease.sessionName}:tui`],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(db.runtimes.getByRuntimeId('missing-tui')?.status).toBe('ready')
  })

  it('preserves a renamed broker window when its recorded pane still runs the broker', async () => {
    const lease = await createDurableLease('renamed')
    seedRuntime('renamed', lease)
    expect(
      await Bun.spawn(
        [
          'tmux',
          '-S',
          lease.socketPath,
          'rename-window',
          '-t',
          `=${lease.sessionName}:broker`,
          'worker',
        ],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(db.runtimes.getByRuntimeId('renamed')?.status).toBe('ready')
  })

  it('reaps when the live lease socket contains a different session identity', async () => {
    const lease = await createDurableLease('wrong-session')
    seedRuntime('wrong-session', lease)
    expect(
      await Bun.spawn(
        [
          'tmux',
          '-S',
          lease.socketPath,
          'rename-session',
          '-t',
          `=${lease.sessionName}`,
          'hrc-cx-someone-else',
        ],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.reapedClaimedOrphans).toBe(1)
    expect(result.killedLiveLeaseServers).toBe(1)
    expect(result.staledClaimedRuntimes).toBe(1)
    expect(db.runtimes.getByRuntimeId('wrong-session')?.status).toBe('stale')
  })

  it('reaps when the claimed broker pane is positively observed dead', async () => {
    const lease = await createDurableLease('dead-pane')
    seedRuntime('dead-pane', lease)
    expect(
      await Bun.spawn(
        [
          'tmux',
          '-S',
          lease.socketPath,
          'set-window-option',
          '-t',
          `=${lease.sessionName}:broker`,
          'remain-on-exit',
          'on',
        ],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)
    expect(
      await Bun.spawn(
        [
          'tmux',
          '-S',
          lease.socketPath,
          'respawn-pane',
          '-k',
          '-t',
          lease.brokerWindow.paneId,
          'exit 0',
        ],
        { stdout: 'ignore', stderr: 'ignore' }
      ).exited
    ).toBe(0)
    await Bun.sleep(50)

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.reapedClaimedOrphans).toBe(1)
    expect(result.killedLiveLeaseServers).toBe(1)
    expect(result.staledClaimedRuntimes).toBe(1)
    expect(db.runtimes.getByRuntimeId('dead-pane')?.status).toBe('stale')
  })

  it('preserves an external-owner claim without probing identity or reaping its substrate', async () => {
    const lease = await createDurableLease('external-owner')
    seedRuntime('external-owner', lease, {
      paneId: '%deliberately-not-the-live-pane',
      lifecycleOwner: 'external',
    })

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(result.staledClaimedRuntimes).toBe(0)
    expect(db.runtimes.getByRuntimeId('external-owner')?.status).toBe('ready')
    expect(
      await createTmuxManager({ socketPath: lease.socketPath }).inspectWindow({
        sessionName: lease.sessionName,
        windowName: 'broker',
      })
    ).not.toBeNull()
  })

  it('preserves a matching terminal substrate inside the passive-continuation TTL', async () => {
    const lease = await createDurableLease('terminal')
    seedRuntime('terminal', lease, {
      status: 'terminated',
      updatedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
    })

    const result = await sweepOrphanedBrokerTmuxLeases(
      db,
      fixture.runtimeRoot,
      sweepOptions({ terminalLeaseTtlMs: 15 * 60_000 })
    )

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
  })

  it('lets any exact claim protect a multiply-claimed lease', async () => {
    const lease = await createDurableLease('shared')
    seedRuntime('shared-valid', lease)
    seedRuntime('shared-invalid', lease, { paneId: '%wrong' })

    const result = await sweepOrphanedBrokerTmuxLeases(db, fixture.runtimeRoot, sweepOptions())

    expect(result.preservedClaimed).toBe(1)
    expect(result.staledClaimedRuntimes).toBe(0)
  })

  it('re-reads a claim before mutation and preserves on a concurrent fingerprint change', async () => {
    const lease = await createDurableLease('race')
    seedRuntime('race', lease, { paneId: '%wrong' })

    const result = await sweepOrphanedBrokerTmuxLeases(
      db,
      fixture.runtimeRoot,
      sweepOptions({
        beforeClaimMutation: async () => {
          db.runtimes.update('race', { updatedAt: new Date(Date.now() + 1000).toISOString() })
        },
      })
    )

    expect(result.preservedClaimed).toBe(1)
    expect(result.reapedClaimedOrphans).toBe(0)
    expect(db.runtimes.getByRuntimeId('race')?.status).toBe('ready')
  })
})

describe('broker recovery budget', () => {
  it('persists failures by lease fingerprint, exhausts only after count and elapsed time, and clears', async () => {
    const lease = await createDurableLease('budget')
    let runtime = seedRuntime('budget', lease)
    const start = Date.now() - 61_000

    runtime = recordBrokerRecoveryFailure(
      db,
      runtime,
      'ipc-unreachable',
      new Date(start).toISOString()
    )
    runtime = recordBrokerRecoveryFailure(
      db,
      runtime,
      'ipc-unreachable',
      new Date(start + 30_000).toISOString()
    )
    runtime = recordBrokerRecoveryFailure(
      db,
      runtime,
      'ipc-unreachable',
      new Date(start + 61_000).toISOString()
    )

    expect(isBrokerRecoveryExhausted(runtime, start + 61_000)).toBe(true)
    clearBrokerRecovery(db, runtime)
    expect(
      isBrokerRecoveryExhausted(
        db.runtimes.getByRuntimeId(runtime.runtimeId) as HrcRuntimeSnapshot,
        start + 61_000
      )
    ).toBe(false)
  })

  it('lets the shared sweep stale and reap an exact lease after recovery exhaustion', async () => {
    const lease = await createDurableLease('exhausted')
    let runtime = seedRuntime('exhausted', lease)
    const start = Date.now() - 61_000
    for (const elapsedMs of [0, 30_000, 61_000]) {
      runtime = recordBrokerRecoveryFailure(
        db,
        runtime,
        'ipc-unreachable',
        new Date(start + elapsedMs).toISOString()
      )
    }

    const result = await sweepOrphanedBrokerTmuxLeases(
      db,
      fixture.runtimeRoot,
      sweepOptions({ now: start + 61_000 })
    )

    expect(result.reapedClaimedOrphans).toBe(1)
    expect(result.staledClaimedRuntimes).toBe(1)
    const staled = db.runtimes.getByRuntimeId(runtime.runtimeId)
    expect(staled?.status).toBe('stale')
    expect(
      (
        (staled?.runtimeStateJson?.['control'] as Record<string, unknown>)?.[
          'lastAttachError'
        ] as Record<string, unknown>
      )?.['code']
    ).toBe('broker_claimed_lease_ipc_recovery_exhausted')
  })
})

describe('broker IPC directory GC', () => {
  it('removes only old dirs with no durable reference, process argv, or live broker health', async () => {
    const root = join(fixture.runtimeRoot, 'bipc')
    const orphan = join(root, 'orphan')
    const referenced = join(root, 'referenced')
    const argvHeld = join(root, 'argv-held')
    const healthHeld = join(root, 'health-held')
    for (const dir of [orphan, referenced, argvHeld, healthHeld]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'b.sock'), '')
    }
    const lease = await createDurableLease('ipc-ref')
    seedRuntime('ipc-ref', lease, { endpointDir: referenced })

    const result = await sweepOrphanedBrokerTmuxLeases(
      db,
      fixture.runtimeRoot,
      sweepOptions({
        listBrokerProcessCommands: async () => [`broker --state-dir ${argvHeld}`],
        probeBrokerHealth: async (socketPath) =>
          socketPath.startsWith(healthHeld) ? 'ok' : 'unreachable',
      })
    )

    expect(result.removedBrokerIpcDirs).toBe(1)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(referenced)).toBe(true)
    expect(existsSync(argvHeld)).toBe(true)
    expect(existsSync(healthHeld)).toBe(true)
  })

  it('preserves an external-owner IPC reference after ordinary terminal TTL expiry', async () => {
    const root = join(fixture.runtimeRoot, 'bipc')
    const referenced = join(root, 'external-owner')
    await mkdir(referenced, { recursive: true })
    await writeFile(join(referenced, 'b.sock'), '')
    const lease = await createDurableLease('external-ipc')
    seedRuntime('external-ipc', lease, {
      status: 'terminated',
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      endpointDir: referenced,
      lifecycleOwner: 'external',
    })

    const result = await sweepOrphanedBrokerTmuxLeases(
      db,
      fixture.runtimeRoot,
      sweepOptions({
        terminalLeaseTtlMs: 1,
        probeBrokerHealth: async () => 'unreachable',
      })
    )

    expect(result.removedBrokerIpcDirs).toBe(0)
    expect(existsSync(referenced)).toBe(true)
  })
})

describe('explicit lifecycle cleanup', () => {
  it('context invalidation tears down a durable headless lease even when broker dispose fails', async () => {
    const lease = await createDurableLease('dispose')
    const runtime = seedRuntime('dispose', lease)
    const disposeCalls: string[] = []
    const fakeServer = {
      db,
      options: { runtimeRoot: fixture.runtimeRoot },
      tmux: createTmuxManager({ socketPath: join(fixture.runtimeRoot, 'default.sock') }),
      getHarnessBrokerController() {
        return {
          async dispose(runtimeId: string) {
            disposeCalls.push(runtimeId)
            return {
              ok: false as const,
              error: new BrokerControllerError('broker_dispose_failed', 'scripted failure'),
            }
          },
        }
      },
    }

    const result = await (
      invalidateHostContext as unknown as (
        this: typeof fakeServer,
        hostSessionId: string,
        reason: string
      ) => Promise<{ runtimesTerminated: number }>
    ).call(fakeServer, runtime.hostSessionId, 'context-rotation')

    expect(disposeCalls).toEqual([runtime.runtimeId])
    expect(result.runtimesTerminated).toBe(1)
    expect(db.runtimes.getByRuntimeId(runtime.runtimeId)?.status).toBe('terminated')
    expect(
      await createTmuxManager({ socketPath: lease.socketPath }).inspectWindow({
        sessionName: lease.sessionName,
        windowName: 'broker',
      })
    ).toBeNull()
  })
})
