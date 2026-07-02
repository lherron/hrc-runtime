import { describe, expect, it } from 'bun:test'
import type { HrcTargetView } from 'hrc-core'

import { buildReadModel, loadReadModel, projectTargetRow } from './read-model.js'

const capabilities: HrcTargetView['capabilities'] = {
  state: 'busy',
  modesSupported: ['headless'],
  defaultMode: 'headless',
  dmReady: true,
  sendReady: true,
  peekReady: false,
}

function target(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:hrc-runtime:task:primary/lane:main',
    scopeRef: 'agent:cody:project:hrc-runtime:task:primary',
    laneRef: 'main',
    state: 'busy',
    activeHostSessionId: 'hsid-1',
    generation: 3,
    runtime: {
      runtimeId: 'rt-1',
      transport: 'tmux',
      status: 'busy',
      supportsLiteralSend: true,
      supportsCapture: true,
      activeRunId: 'run-1',
      lastActivityAt: '2026-07-02T12:00:00.000Z',
    },
    continuation: { provider: 'openai', key: 'conv-1' },
    capabilities,
    ...overrides,
  }
}

describe('hrc-top read model', () => {
  it('projects rows from HrcTargetView without recomputing target facts', () => {
    const source = target()
    const row = projectTargetRow(source)

    expect(row.id).toBe('rt-1')
    expect(row.target).toBe(source)
    expect(row.sessionRef).toBe(source.sessionRef)
    expect(row.state).toBe('busy')
    expect(row.runtime).toEqual({ runtimeId: 'rt-1', status: 'busy' })
    expect(row.hasContinuation).toBe(true)
    expect(row.capabilities).toBe(capabilities)
    expect(row.last).toEqual({
      source: 'runtime.lastActivityAt',
      at: '2026-07-02T12:00:00.000Z',
    })
  })

  it('uses an explicit unknown last-activity fallback when target view lacks a timestamp', () => {
    const row = projectTargetRow(target({ runtime: undefined }))
    expect(row.last).toEqual({ source: 'unknown', at: undefined })
  })

  it('builds live and dormant header counts from target states', () => {
    const model = buildReadModel(
      [
        target({ state: 'bound' }),
        target({ state: 'summoned', sessionRef: 'agent:a/lane:main' }),
        target({ state: 'dormant', sessionRef: 'agent:b/lane:main' }),
        target({ state: 'broken', sessionRef: 'agent:c/lane:main' }),
      ],
      new Date('2026-07-02T12:05:00.000Z')
    )

    expect(model.counts).toEqual({ live: 2, dormant: 1 })
    expect(model.refreshedAt).toBe('2026-07-02T12:05:00.000Z')
  })

  it('loads current-project targets with dormant rows included by the producer', async () => {
    const calls: unknown[] = []
    const client = {
      async listTargets(filter: unknown): Promise<HrcTargetView[]> {
        calls.push(filter)
        return [target()]
      },
    }

    await loadReadModel(client, { projectId: 'hrc-runtime' })
    await loadReadModel(client, { projectId: 'hrc-runtime', allProjects: true })

    expect(calls).toEqual([
      { projectId: 'hrc-runtime', lane: undefined, includeDormant: true },
      { projectId: undefined, lane: undefined, includeDormant: true },
    ])
  })
})
