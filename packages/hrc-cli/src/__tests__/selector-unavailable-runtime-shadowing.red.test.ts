import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import { cmdRuntimeList } from '../cli/handlers-runtime.js'
import {
  SelectorResolutionError,
  fetchSelectorSnapshot,
  resolveSelectorTarget,
} from '../selector-resolve'

const scopeRef = 'agent:room-coordinator:project:taskboard:task:T-05967'

function runtime(runtimeId: string, status: string): HrcRuntimeSnapshot {
  return {
    runtimeId,
    hostSessionId: 'hs-selector-history',
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'sdk',
    harness: 'agent-sdk',
    provider: 'anthropic',
    status,
    supportsInflightInput: true,
    adopted: false,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
}

async function runDefaultRuntimeList(runtimes: HrcRuntimeSnapshot[]): Promise<{
  output: HrcRuntimeSnapshot[]
  options: unknown
}> {
  const stdout: string[] = []
  const originalListRuntimes = HrcClient.prototype.listRuntimes
  const originalStdoutWrite = process.stdout.write
  let options: unknown

  HrcClient.prototype.listRuntimes = (async (input) => {
    options = input
    return runtimes
  }) as HrcClient['listRuntimes']
  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    stdout.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString()
    )
    return true
  }) as typeof process.stdout.write

  try {
    await cmdRuntimeList(['--json'])
    return { output: JSON.parse(stdout.join('')) as HrcRuntimeSnapshot[], options }
  } finally {
    HrcClient.prototype.listRuntimes = originalListRuntimes
    process.stdout.write = originalStdoutWrite
  }
}

describe('implicit runtime selector availability', () => {
  it('ignores unavailable history implicitly, preserves explicit IDs and live ambiguity, and leaves default inventory intact', async () => {
    const unavailable = [
      runtime('rt-selector-terminated', 'terminated'),
      runtime('rt-selector-dead', 'dead'),
      runtime('rt-selector-stale', 'stale'),
    ]
    const live = runtime('rt-selector-live', 'ready')
    const listedRuntimes = [...unavailable, live]
    const client = {
      listRuntimes: async () => listedRuntimes,
      listSessions: async () => [] as HrcSessionRecord[],
    } as Pick<HrcClient, 'listRuntimes' | 'listSessions'>

    const snapshot = await fetchSelectorSnapshot(client as HrcClient)
    const defaultInventory = await runDefaultRuntimeList(listedRuntimes)

    // The unfiltered/default inventory remains historical; filtering happens
    // only inside implicit selector resolution.
    expect(defaultInventory.options).toEqual({ json: true })
    expect(defaultInventory.output.map((entry) => entry.runtimeId)).toEqual(
      listedRuntimes.map((entry) => entry.runtimeId)
    )
    expect(snapshot.runtimes).toHaveLength(4)
    expect(snapshot.runtimes.map((entry) => entry.status)).toEqual([
      'terminated',
      'dead',
      'stale',
      'ready',
    ])
    expect(
      resolveSelectorTarget('room-coordinator@taskboard:T-05967', {
        expect: 'runtime',
        snapshot,
      })
    ).toEqual({ kind: 'runtime', runtimeId: live.runtimeId })

    for (const historical of unavailable) {
      expect(resolveSelectorTarget(historical.runtimeId, { expect: 'runtime', snapshot })).toEqual({
        kind: 'runtime',
        runtimeId: historical.runtimeId,
      })
      expect(
        resolveSelectorTarget(`runtime:${historical.runtimeId}`, {
          expect: 'runtime',
          snapshot,
        })
      ).toEqual({ kind: 'runtime', runtimeId: historical.runtimeId })
    }

    const twoLiveSnapshot = {
      ...snapshot,
      runtimes: [...snapshot.runtimes, runtime('rt-selector-live-2', 'busy')],
    }
    expect(() =>
      resolveSelectorTarget('room-coordinator@taskboard:T-05967', {
        expect: 'runtime',
        snapshot: twoLiveSnapshot,
      })
    ).toThrow(SelectorResolutionError)
    try {
      resolveSelectorTarget('room-coordinator@taskboard:T-05967', {
        expect: 'runtime',
        snapshot: twoLiveSnapshot,
      })
    } catch (error) {
      expect((error as SelectorResolutionError).code).toBe('ambiguous')
    }
  })
})
