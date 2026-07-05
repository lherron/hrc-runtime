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

  it('resolves latest durable message context by active run before participant fallback', async () => {
    const calls: unknown[] = []
    const activeRunTarget = target()
    const participantTarget = target({
      sessionRef: 'agent:clod:project:hrc-runtime:task:primary/lane:main',
      scopeRef: 'agent:clod:project:hrc-runtime:task:primary',
      runtime: {
        ...target().runtime!,
        runtimeId: 'rt-2',
        activeRunId: undefined,
      },
    })
    const client = {
      async listTargets(): Promise<HrcTargetView[]> {
        return [activeRunTarget, participantTarget]
      },
      async listMessages(filter: unknown): Promise<unknown[]> {
        calls.push(filter)
        if ((filter as { runId?: string }).runId === 'run-1') {
          return [
            {
              messageId: 'msg-active-run',
              messageSeq: 40,
              createdAt: '2026-07-04T12:00:00.000Z',
              phase: 'queued',
              from: { kind: 'session', sessionRef: 'operator@hrc-runtime:primary' },
              to: { kind: 'session', sessionRef: activeRunTarget.sessionRef },
              body: 'active run request body',
            },
          ]
        }
        return [
          {
            messageId: 'msg-participant',
            messageSeq: 41,
            createdAt: '2026-07-04T12:01:00.000Z',
            phase: 'delivered',
            from: { kind: 'session', sessionRef: 'operator@hrc-runtime:primary' },
            to: { kind: 'session', sessionRef: participantTarget.sessionRef },
            body: 'participant fallback body',
          },
        ]
      },
    }

    // T-05462 red bar: read-model message context must be bounded to the
    // selected row's current run first, then its own participant/host/generation
    // facts. A previous or different target message must not bleed across rows.
    const model = await loadReadModel(client as never, { projectId: 'hrc-runtime' })

    expect(model.rows[0]).toMatchObject({
      message: {
        messageId: 'msg-active-run',
        messageSeq: 40,
        bodyPreview: 'active run request body',
      },
    })
    expect(model.rows[1]).toMatchObject({
      message: {
        messageId: 'msg-participant',
        messageSeq: 41,
        bodyPreview: 'participant fallback body',
      },
    })
    expect(calls).toEqual([
      { runId: 'run-1', phase: 'request', order: 'desc', limit: 1 },
      {
        participant: { kind: 'session', sessionRef: participantTarget.sessionRef },
        hostSessionId: 'hsid-1',
        generation: 3,
        order: 'desc',
        limit: 1,
      },
    ])
  })

  it('does not attach message context when durable records lack a concrete message id', async () => {
    const client = {
      async listTargets(): Promise<HrcTargetView[]> {
        return [target()]
      },
      async listMessages(): Promise<unknown[]> {
        return [
          {
            messageId: '',
            messageSeq: 42,
            createdAt: '2026-07-04T12:02:00.000Z',
            phase: 'queued',
            from: { kind: 'session', sessionRef: 'operator@hrc-runtime:primary' },
            to: { kind: 'session', sessionRef: target().sessionRef },
            body: 'missing id must not advertise actions',
          },
        ]
      },
    }

    const model = await loadReadModel(client as never, { projectId: 'hrc-runtime' })

    expect(model.rows[0]).not.toHaveProperty('message')
  })
})
