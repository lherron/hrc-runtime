import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import { handleInteractiveTmuxBrokerDispatchTurn } from '../broker-interactive-handlers'
import type { SpawnBrokerHeadlessViewerOptions } from '../broker-interactive-handlers/controller-factory'

function session(): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-t05881',
    sessionRef: 'agent:clod:project:hrc-runtime:task:T-05881',
    scopeRef: 'agent:clod:project:hrc-runtime:task:T-05881',
    laneRef: 'main',
    generation: 1,
    status: 'ready',
    createdAt: '2026-07-07T05:00:00.000Z',
    updatedAt: '2026-07-07T05:00:00.000Z',
  } as HrcSessionRecord
}

function intent(): HrcRuntimeIntent {
  return {
    placement: { kind: 'inline' },
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
    execution: { preferredMode: 'interactive' },
  } as HrcRuntimeIntent
}

function runtime(): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-t05881',
    hostSessionId: 'hsid-t05881',
    scopeRef: 'agent:clod:project:hrc-runtime:task:T-05881',
    laneRef: 'main',
    generation: 1,
    provider: 'anthropic',
    harnessId: 'claude-code',
    transport: 'tmux',
    status: 'ready',
    createdAt: '2026-07-07T05:00:00.000Z',
    updatedAt: '2026-07-07T05:00:00.000Z',
  } as HrcRuntimeSnapshot
}

describe('T-05881 operator attach viewer suppression', () => {
  it('passes operatorAttachPending to claude viewer spawn for attached prompt dispatch', async () => {
    const spawnCalls: Array<SpawnBrokerHeadlessViewerOptions | undefined> = []
    const mockThis = {
      startInteractiveTmuxBrokerRuntime: async () => runtime(),
      spawnBrokerHeadlessViewer: async (
        _runtime: HrcRuntimeSnapshot,
        options?: SpawnBrokerHeadlessViewerOptions
      ) => {
        spawnCalls.push(options)
      },
    }

    const response = await handleInteractiveTmuxBrokerDispatchTurn.call(
      mockThis as Parameters<typeof handleInteractiveTmuxBrokerDispatchTurn.call>[0],
      session(),
      intent(),
      'hi',
      'run-t05881',
      {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER',
        allowedBrokerDriver: 'claude-code-tmux',
        waitForCompletion: false,
        attachBeforeInvocationStart: { pendingStartId: 'attached-t05881' },
      }
    )

    expect(response.status).toBe(200)
    expect(spawnCalls).toEqual([{ operatorAttachPending: true }])
  })

  it('does not mark non-attached claude dispatch as operator-attached', async () => {
    const spawnCalls: Array<SpawnBrokerHeadlessViewerOptions | undefined> = []
    const mockThis = {
      startInteractiveTmuxBrokerRuntime: async () => runtime(),
      spawnBrokerHeadlessViewer: async (
        _runtime: HrcRuntimeSnapshot,
        options?: SpawnBrokerHeadlessViewerOptions
      ) => {
        spawnCalls.push(options)
      },
    }

    const response = await handleInteractiveTmuxBrokerDispatchTurn.call(
      mockThis as Parameters<typeof handleInteractiveTmuxBrokerDispatchTurn.call>[0],
      session(),
      intent(),
      'hi',
      'run-t05881',
      {
        flagEnvName: 'HRC_CLAUDE_CODE_TMUX_BROKER',
        allowedBrokerDriver: 'claude-code-tmux',
        waitForCompletion: false,
      }
    )

    expect(response.status).toBe(200)
    expect(spawnCalls).toEqual([{ operatorAttachPending: false }])
  })
})
