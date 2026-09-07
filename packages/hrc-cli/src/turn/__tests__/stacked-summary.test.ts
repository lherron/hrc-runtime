import { describe, expect, it } from 'bun:test'
import type {
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSubmissionResponse,
} from 'hrc-core'

import {
  type StackedSummarizerOptions,
  type StackedSummaryClient,
  createStackedSummarizer,
} from '../stacked-summary.js'

function event(
  hrcSeq: number,
  eventKind: string,
  payload: Record<string, unknown> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date(Date.parse('2026-05-13T18:00:00.000Z') + hrcSeq).toISOString(),
    hostSessionId: 'hsid-observed',
    scopeRef: 'agent:larry:project:hrc-runtime:task:T-08199',
    laneRef: 'main',
    generation: 1,
    runId: 'run-observed',
    category: 'turn',
    transport: 'sdk',
    replayed: false,
    eventKind,
    payload,
  }
}

const runtimeIntent = {} as HrcRuntimeIntent

function admitted(finalMessage = 'Reads stacked-summary.ts and validates the SDK response.') {
  return {
    submissionId: 'submission-summary',
    admission: 'admitted',
    runId: 'run-summary',
    runtimeId: 'rt-summary',
    hostSessionId: 'hsid-summary',
    generation: 1,
    transport: 'tmux',
    status: 'completed',
    startIdentity: { kind: 'broker', invocationId: 'inv-summary' },
    observation: {
      lifecycle: {
        selector: { runId: 'run-summary', runtimeId: 'rt-summary', generation: 1 },
        fromSeq: 1,
      },
    },
    disposition: { type: 'executed', turnId: 'turn-summary' },
    terminal: { turnId: 'turn-summary', status: 'completed', finalMessage },
  } as HrcSubmissionResponse
}

type FakeOverrides = {
  invoke?: ((request: unknown) => Promise<HrcSubmissionResponse>) | undefined
  listRuntimes?: (() => Promise<HrcRuntimeSnapshot[]>) | undefined
}

function fakeClient(overrides: FakeOverrides = {}) {
  const calls = {
    ensured: [] as unknown[],
    invoked: [] as unknown[],
    listed: [] as unknown[],
    terminated: [] as Array<{ runtimeId: string; options: unknown }>,
    dropped: [] as unknown[],
  }
  const client = {
    async ensureTarget(request: unknown) {
      calls.ensured.push(request)
      return {
        sessionRef: 'agent:summarizer:project:hrc-runtime:task:stacked:role:run-abcd/lane:main',
        scopeRef: 'agent:summarizer:project:hrc-runtime:task:stacked:role:run-abcd',
        laneRef: 'main',
        state: 'summoned',
        activeHostSessionId: 'hsid-summary',
        capabilities: {
          state: 'summoned',
          modesSupported: ['nonInteractive'],
          defaultMode: 'nonInteractive',
          dmReady: true,
          sendReady: false,
          peekReady: false,
        },
      }
    },
    async invoke(request: unknown) {
      calls.invoked.push(request)
      return overrides.invoke ? overrides.invoke(request) : admitted()
    },
    async listRuntimes(filter: unknown) {
      calls.listed.push(filter)
      return overrides.listRuntimes ? overrides.listRuntimes() : []
    },
    async terminate(runtimeId: string, options: unknown) {
      calls.terminated.push({ runtimeId, options })
      return { ok: true, runtimeId, hostSessionId: 'hsid-summary', droppedContinuation: true }
    },
    async dropContinuation(request: unknown) {
      calls.dropped.push(request)
      return {
        ok: true,
        hostSessionId: 'hsid-summary',
        dropped: true,
        previousContinuationKey: null,
      }
    },
  } as unknown as StackedSummaryClient
  return { client, calls }
}

function summaryOptions(
  client: StackedSummaryClient,
  handles: string[],
  overrides: Partial<StackedSummarizerOptions> = {}
): StackedSummarizerOptions {
  return {
    client,
    targetProjectId: 'hrc-runtime',
    observedAgentId: 'larry',
    runId: 'run-abcdef012345',
    resolveTarget(handle) {
      handles.push(handle)
      const scopeRef = `agent:summarizer:project:hrc-runtime:task:stacked:role:${handle.split('/').at(-1)}`
      return {
        sessionRef: `${scopeRef}/lane:main`,
        scopeRef,
        runtimeIntent,
        parsedScopeJson: { agentId: 'summarizer', projectId: 'hrc-runtime' },
      }
    },
    ...overrides,
  }
}

const input = {
  events: [event(11, 'turn.tool_call', { toolName: 'Read', input: 'stacked-summary.ts' })],
  phase: 'progress',
  flush: 'interval',
  windowMs: 20_000,
}

describe('seat-based stacked turn summaries', () => {
  it('ensures one scoped seat and reads the waited invoke finalMessage', async () => {
    const { client, calls } = fakeClient()
    const handles: string[] = []
    const summarizer = createStackedSummarizer(summaryOptions(client, handles))

    expect(await summarizer.summarize(input)).toBe(
      'Reads stacked-summary.ts and validates the SDK response.'
    )
    expect(handles).toEqual(['summarizer@hrc-runtime:stacked/run-abcd'])
    expect(calls.ensured).toHaveLength(1)
    expect(calls.invoked).toHaveLength(1)
    expect(calls.invoked[0]).toMatchObject({
      origin: { principalRef: 'agent:summarizer' },
      wait: true,
      turnPolicy: 'guarded',
    })
    const body = (calls.invoked[0] as { body: string }).body
    expect(body).toStartWith('window=20 seconds phase=progress flush=interval\n<events>\n')
    expect(body).toEndWith('\n</events>')
    expect(body).toContain('seq=11 kind=turn.tool_call tool=Read detail=stacked-summary.ts')
  })

  it('falls back mechanically after the 30 second call timeout', async () => {
    let timeoutMs = 0
    const runtime = {
      runtimeId: 'rt-timeout',
      hostSessionId: 'hsid-summary',
    } as HrcRuntimeSnapshot
    const { client, calls } = fakeClient({
      invoke: () => new Promise(() => undefined),
      listRuntimes: async () => [runtime],
    })
    const summarizer = createStackedSummarizer(
      summaryOptions(client, [], {
        setTimeout(callback, ms) {
          timeoutMs = ms
          callback()
          return 1
        },
        clearTimeout() {},
      })
    )

    expect(await summarizer.summarize(input)).toBe('1 events; last tool: Read; phase: progress')
    expect(timeoutMs).toBe(30_000)
    await summarizer.cleanup()
    expect(calls.terminated).toEqual([
      {
        runtimeId: 'rt-timeout',
        options: {
          dropContinuation: true,
          reason: 'stacked summarizer cleanup',
          source: 'hrc turn',
        },
      },
    ])
  })

  it('falls back mechanically for rejected admission and drops the ensured continuation', async () => {
    const { client, calls } = fakeClient({
      invoke: async () => ({
        submissionId: 'submission-rejected',
        admission: 'rejected',
        reason: 'busy',
        disposition: { type: 'rejected', reason: 'busy' },
      }),
    })
    const summarizer = createStackedSummarizer(summaryOptions(client, []))

    expect(await summarizer.summarize(input)).toBe('1 events; last tool: Read; phase: progress')
    await summarizer.cleanup()
    expect(calls.dropped).toEqual([
      { hostSessionId: 'hsid-summary', reason: 'stacked summarizer cleanup' },
    ])
  })

  it('cleans a successful seat exactly once even when cleanup is requested twice', async () => {
    const { client, calls } = fakeClient()
    const summarizer = createStackedSummarizer(summaryOptions(client, []))
    await summarizer.summarize(input)

    await Promise.all([summarizer.cleanup(), summarizer.cleanup()])

    expect(calls.terminated).toHaveLength(1)
    expect(calls.terminated[0]?.runtimeId).toBe('rt-summary')
  })

  it('uses a mechanical summary and births nothing when observing summarizer', async () => {
    const { client, calls } = fakeClient()
    const handles: string[] = []
    const summarizer = createStackedSummarizer(
      summaryOptions(client, handles, { observedAgentId: 'summarizer' })
    )

    expect(await summarizer.summarize(input)).toBe('1 events; last tool: Read; phase: progress')
    await summarizer.cleanup()
    expect(handles).toEqual([])
    expect(calls.ensured).toEqual([])
    expect(calls.invoked).toEqual([])
    expect(calls.terminated).toEqual([])
    expect(calls.dropped).toEqual([])
  })

  it('reuses one seat within a turn and selects a different seat for another turn', async () => {
    const { client } = fakeClient()
    const handles: string[] = []
    const first = createStackedSummarizer(summaryOptions(client, handles))
    const second = createStackedSummarizer(
      summaryOptions(client, handles, { runId: 'run-fedcba987654' })
    )

    await first.summarize(input)
    await first.summarize(input)
    await second.summarize(input)

    expect(handles).toEqual([
      'summarizer@hrc-runtime:stacked/run-abcd',
      'summarizer@hrc-runtime:stacked/run-fedc',
    ])
  })

  it('redacts and bounds the whole-turn digest while preserving the event block', async () => {
    const { client, calls } = fakeClient()
    const summarizer = createStackedSummarizer(
      summaryOptions(client, [], { maxDigestBytes: 500, maxEvents: 2 })
    )
    const wholeTurnEvents = Array.from({ length: 5 }, (_, index) =>
      event(index + 1, 'turn.tool_result', {
        toolName: 'Bash',
        output: `token=secret-${index} ${'x'.repeat(300)}`,
      })
    )

    await summarizer.summarize({
      events: [wholeTurnEvents.at(-1)!],
      wholeTurnEvents,
      phase: 'final',
      flush: 'final',
      windowMs: 20_000,
    })

    const body = (calls.invoked[0] as { body: string }).body
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(500)
    expect(body).toContain('[truncated]')
    expect(body).not.toContain('token=secret')
    expect(body).toEndWith('\n</events>')
  })
})
