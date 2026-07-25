import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot, SweepRuntimesResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { resolveTmuxAgingEnabled } from '../option-resolvers'
import type { TmuxPaneState } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t06719-aging-')
  server = await createHrcServer(
    fixture.serverOpts({
      otelListenerEnabled: false,
      tmuxAgingEnabled: false,
      staleGenerationThresholdSec: 60 * 60,
    } as any)
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function oldTimestamp(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
}

function recentTimestamp(): string {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString()
}

function paneIdentity(runtimeId: string): TmuxPaneState {
  const suffix = runtimeId.replaceAll(/[^a-z0-9]/gi, '').slice(-6)
  return {
    socketPath: `${fixture.tmpDir}/${runtimeId}.sock`,
    sessionName: runtimeId,
    windowName: 'main',
    sessionId: `$${suffix.length + 10}`,
    windowId: `@${suffix.length + 20}`,
    paneId: `%${suffix.length + 30}`,
  }
}

type SeedOptions = {
  runtimeId: string
  status?: 'ready' | 'busy' | undefined
  createdAt?: string | undefined
  missingTmuxIdentity?: boolean | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  brokerPid?: number | undefined
  activeRun?: boolean | undefined
  nonterminalRun?: boolean | undefined
  invocationBrokerPid?: number | undefined
  invocationChildPid?: number | undefined
}

function seedRuntime(options: SeedOptions): HrcRuntimeSnapshot {
  const hostSessionId = `hs-${options.runtimeId}`
  const scopeRef = `agent:cody:project:hrc-runtime:task:${options.runtimeId}`
  fixture.seedSession(hostSessionId, scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const createdAt = options.createdAt ?? oldTimestamp()
  const identity = paneIdentity(options.runtimeId)
  const invocationId =
    options.invocationBrokerPid !== undefined || options.invocationChildPid !== undefined
      ? `inv-${options.runtimeId}`
      : undefined
  try {
    const runtime = db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: options.status ?? 'ready',
      ...(options.missingTmuxIdentity ? {} : { tmuxJson: identity }),
      ...(options.wrapperPid !== undefined ? { wrapperPid: options.wrapperPid } : {}),
      ...(options.childPid !== undefined ? { childPid: options.childPid } : {}),
      ...(options.brokerPid !== undefined
        ? { runtimeStateJson: { broker: { brokerPid: options.brokerPid } } }
        : {}),
      ...(invocationId !== undefined ? { activeInvocationId: invocationId } : {}),
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    })
    if (invocationId !== undefined) {
      db.brokerInvocations.insert({
        invocationId,
        operationId: `op-${options.runtimeId}`,
        runtimeId: options.runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'claude-code',
        ...(options.invocationBrokerPid !== undefined
          ? { brokerPid: options.invocationBrokerPid }
          : {}),
        ...(options.invocationChildPid !== undefined
          ? { childPid: options.invocationChildPid }
          : {}),
        invocationState: 'ready',
        capabilitiesJson: '{}',
        specHash: 'spec',
        startRequestHash: 'start',
        selectedProfileHash: 'profile',
        createdAt,
        updatedAt: createdAt,
      })
    }
    if (options.activeRun) {
      const runId = `run-${options.runtimeId}`
      db.runs.insert({
        runId,
        hostSessionId,
        runtimeId: options.runtimeId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        status: 'running',
        acceptedAt: createdAt,
        startedAt: createdAt,
        updatedAt: createdAt,
      })
      db.runtimes.update(options.runtimeId, {
        activeRunId: runId,
        status: options.status ?? 'ready',
        updatedAt: createdAt,
      })
    }
    if (options.nonterminalRun) {
      db.runs.insert({
        runId: `run-unbound-${options.runtimeId}`,
        hostSessionId,
        runtimeId: options.runtimeId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        status: 'accepted',
        acceptedAt: createdAt,
        updatedAt: createdAt,
      })
    }
    return runtime
  } finally {
    db.close()
  }
}

function runtime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function installTmuxProbe(
  probe: (input: { socketPath: string; sessionName: string; windowName: string }) =>
    | Promise<TmuxPaneState | null>
    | TmuxPaneState
    | null
): void {
  ;(server as any).brokerTmuxManagerFactory = ({ socketPath }: { socketPath: string }) => ({
    inspectWindow: ({ sessionName, windowName }: { sessionName: string; windowName: string }) =>
      probe({ socketPath, sessionName, windowName }),
  })
}

async function sweep(): Promise<SweepRuntimesResponse> {
  const response = await fixture.postJson('/v1/runtimes/sweep', {
    transport: 'tmux',
    status: ['ready', 'busy'],
    olderThan: '1h',
  })
  expect(response.status).toBe(200)
  return (await response.json()) as SweepRuntimesResponse
}

describe('T-06719 liveness-gated tmux aging', () => {
  it('uses a dedicated default-on aging gate independent of stale generation rotation', () => {
    const original = process.env['HRC_TMUX_AGING_ENABLED']
    try {
      process.env['HRC_TMUX_AGING_ENABLED'] = undefined
      expect(resolveTmuxAgingEnabled({ staleGenerationEnabled: false })).toBe(true)
      expect(
        resolveTmuxAgingEnabled({
          staleGenerationEnabled: true,
          tmuxAgingEnabled: false,
        })
      ).toBe(false)
    } finally {
      process.env['HRC_TMUX_AGING_ENABLED'] = original
    }
  })

  it('starts an immediate recurring pass and owns a maintenance timer', async () => {
    let calls = 0
    ;(server as any).tmuxAgingEnabled = true
    ;(server as any).runRecurringTmuxAging = async () => {
      calls += 1
    }
    ;(server as any).startTmuxAging()
    await Bun.sleep(0)

    expect(calls).toBe(1)
    expect((server as any).tmuxAgingTimer).toBeDefined()
    clearInterval((server as any).tmuxAgingTimer)
    ;(server as any).tmuxAgingTimer = undefined
  })

  it('stales only a fully-negative aged ready row and names every liveness skip', async () => {
    seedRuntime({ runtimeId: 'rt-orphan' })
    seedRuntime({ runtimeId: 'rt-live-child', childPid: process.pid })
    seedRuntime({ runtimeId: 'rt-live-wrapper', wrapperPid: process.pid })
    seedRuntime({ runtimeId: 'rt-live-broker', brokerPid: process.pid })
    seedRuntime({ runtimeId: 'rt-live-inv-broker', invocationBrokerPid: process.pid })
    seedRuntime({ runtimeId: 'rt-live-inv-child', invocationChildPid: process.pid })
    seedRuntime({ runtimeId: 'rt-live-tmux' })
    seedRuntime({ runtimeId: 'rt-busy', status: 'busy' })
    seedRuntime({ runtimeId: 'rt-active', activeRun: true })
    seedRuntime({ runtimeId: 'rt-unbound-run', nonterminalRun: true })
    seedRuntime({ runtimeId: 'rt-missing-identity', missingTmuxIdentity: true })
    seedRuntime({ runtimeId: 'rt-probe-error' })
    seedRuntime({ runtimeId: 'rt-identity-mismatch' })
    seedRuntime({ runtimeId: 'rt-recent', createdAt: recentTimestamp() })

    installTmuxProbe(({ sessionName }) => {
      if (sessionName === 'rt-live-tmux') return paneIdentity(sessionName)
      if (sessionName === 'rt-probe-error') throw new Error('tmux probe unavailable')
      if (sessionName === 'rt-identity-mismatch') {
        return { ...paneIdentity(sessionName), paneId: '%different' }
      }
      return null
    })

    const body = await sweep()
    const byId = new Map(body.results.map((result) => [result.runtimeId, result]))

    expect(body.summary).toMatchObject({ matched: 13, stale: 1, skipped: 12, errors: 0 })
    expect(byId.get('rt-orphan')).toMatchObject({ status: 'stale' })
    expect(byId.get('rt-live-child')).toMatchObject({
      status: 'skipped',
      reason: 'live_child_pid',
    })
    expect(byId.get('rt-live-wrapper')).toMatchObject({
      status: 'skipped',
      reason: 'live_wrapper_pid',
    })
    expect(byId.get('rt-live-broker')).toMatchObject({
      status: 'skipped',
      reason: 'live_broker_pid',
    })
    expect(byId.get('rt-live-inv-broker')).toMatchObject({
      status: 'skipped',
      reason: 'live_invocation_broker_pid',
    })
    expect(byId.get('rt-live-inv-child')).toMatchObject({
      status: 'skipped',
      reason: 'live_invocation_child_pid',
    })
    expect(byId.get('rt-live-tmux')).toMatchObject({
      status: 'skipped',
      reason: 'live_tmux',
    })
    expect(byId.get('rt-busy')).toMatchObject({ status: 'skipped', reason: 'busy' })
    expect(byId.get('rt-active')).toMatchObject({
      status: 'skipped',
      reason: 'active_run',
    })
    expect(byId.get('rt-unbound-run')).toMatchObject({
      status: 'skipped',
      reason: 'nonterminal_run',
    })
    expect(byId.get('rt-missing-identity')).toMatchObject({
      status: 'skipped',
      reason: 'missing_tmux_identity',
    })
    expect(byId.get('rt-probe-error')).toMatchObject({
      status: 'skipped',
      reason: 'tmux_probe_error',
    })
    expect(byId.get('rt-identity-mismatch')).toMatchObject({
      status: 'skipped',
      reason: 'tmux_identity_mismatch',
    })
    expect(byId.has('rt-recent')).toBe(false)
    expect(runtime('rt-orphan')?.status).toBe('stale')
    expect(runtime('rt-live-tmux')?.status).toBe('ready')
  })

  it('manual and recurring paths both lose a ready-to-busy ownership race', async () => {
    seedRuntime({ runtimeId: 'rt-manual-race' })

    const race = (runtimeId: string): void => {
      const db = openHrcDatabase(fixture.dbPath)
      const current = db.runtimes.getByRuntimeId(runtimeId)
      const runId = `run-${runtimeId}`
      try {
        if (current?.status !== 'ready') return
        db.runs.insert({
          runId,
          hostSessionId: current.hostSessionId,
          runtimeId,
          scopeRef: current.scopeRef,
          laneRef: current.laneRef,
          generation: current.generation,
          transport: 'tmux',
          status: 'running',
          acceptedAt: current.updatedAt,
          startedAt: current.updatedAt,
          updatedAt: current.updatedAt,
        })
        db.runtimes.update(runtimeId, {
          status: 'busy',
          activeRunId: runId,
          updatedAt: new Date().toISOString(),
        })
      } finally {
        db.close()
      }
    }

    installTmuxProbe(({ sessionName }) => {
      race(sessionName)
      return null
    })

    const manual = await sweep()
    expect(manual.results.find((result) => result.runtimeId === 'rt-manual-race')).toMatchObject({
      status: 'skipped',
      reason: 'runtime_changed',
    })
    expect(runtime('rt-manual-race')?.status).toBe('busy')

    seedRuntime({ runtimeId: 'rt-recurring-race' })
    const recurring = (await (server as any).runTmuxAgingOnce()) as SweepRuntimesResponse
    expect(
      recurring.results.find((result) => result.runtimeId === 'rt-recurring-race')
    ).toMatchObject({
      status: 'skipped',
      reason: 'runtime_changed',
    })
    expect(runtime('rt-recurring-race')?.status).toBe('busy')
  })

  it('uses the resolved stale threshold for both manual and recurring aging', async () => {
    seedRuntime({ runtimeId: 'rt-manual-threshold' })
    installTmuxProbe(() => null)

    const response = await fixture.postJson('/v1/runtimes/sweep', {
      transport: 'tmux',
      status: ['ready'],
    })
    expect(response.status).toBe(200)
    const manual = (await response.json()) as SweepRuntimesResponse
    expect(
      manual.results.find((result) => result.runtimeId === 'rt-manual-threshold')
    ).toMatchObject({ status: 'stale' })

    seedRuntime({ runtimeId: 'rt-recurring-threshold' })
    const recurring = (await (server as any).runTmuxAgingOnce()) as SweepRuntimesResponse
    expect(
      recurring.results.find((result) => result.runtimeId === 'rt-recurring-threshold')
    ).toMatchObject({ status: 'stale' })
  })

  it('singleflights recurring aging so overlapping ticks probe once', async () => {
    seedRuntime({ runtimeId: 'rt-singleflight' })
    let probes = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installTmuxProbe(async () => {
      probes += 1
      await gate
      return null
    })

    const first = (server as any).runRecurringTmuxAging() as Promise<void>
    while (probes === 0) await Bun.sleep(5)
    const second = (server as any).runRecurringTmuxAging() as Promise<void>
    await second
    expect(probes).toBe(1)

    release()
    await first
    expect(runtime('rt-singleflight')?.status).toBe('stale')
  })
})
