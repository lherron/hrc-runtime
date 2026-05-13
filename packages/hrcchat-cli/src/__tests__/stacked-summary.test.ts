import { describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

type FakeAnthropicClient = {
  messages: {
    create: (request: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }
}

async function loadSummaryModule(): Promise<{
  createStackedSummarizer: (options: unknown) => {
    summarize: (input: {
      events: HrcLifecycleEvent[]
      wholeTurnEvents?: HrcLifecycleEvent[]
      phase: string
      flush: string
      windowMs: number
    }) => Promise<string>
  }
}> {
  return await import('../stacked-summary.js')
}

function event(
  hrcSeq: number,
  eventKind: string,
  payload: Record<string, unknown> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date(Date.parse('2026-05-13T18:00:00.000Z') + hrcSeq).toISOString(),
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
    laneRef: 'main',
    generation: 1,
    runId: 'run-test',
    category: 'turn',
    transport: 'sdk',
    replayed: false,
    eventKind,
    payload,
  }
}

function extractPrompt(request: unknown): string {
  const content = (request as { messages?: Array<{ content?: string }> }).messages?.[0]?.content
  if (typeof content !== 'string') {
    throw new Error(`unexpected Anthropic request shape: ${JSON.stringify(request)}`)
  }
  return content
}

describe('stacked turn summaries', () => {
  it('falls back mechanically when the Haiku request times out', async () => {
    const { createStackedSummarizer } = await loadSummaryModule()
    const summarizer = createStackedSummarizer({
      apiKey: 'test-key',
      timeoutMs: 5_000,
      createAnthropicClient(): FakeAnthropicClient {
        return {
          messages: {
            create: () => new Promise(() => undefined),
          },
        }
      },
      setTimeout(callback: () => void) {
        callback()
        return 1
      },
      clearTimeout() {},
    })

    const summary = await summarizer.summarize({
      events: [event(11, 'turn.tool_call', { toolName: 'Bash' })],
      phase: 'progress',
      flush: 'interval',
      windowMs: 60_000,
    })

    expect(summary).toBe('1 events; last tool: Bash; phase: progress')
  })

  it('warns exactly once and uses mechanical fallback when the Consul key is missing', async () => {
    const warnings: string[] = []
    const { createStackedSummarizer } = await loadSummaryModule()
    const summarizer = createStackedSummarizer({
      consulKey: 'cfg/dev/anthropic/api_key',
      consulKvGet: async () => undefined,
      stderr: { write: (line: string) => warnings.push(line) },
    })

    const input = {
      events: [event(11, 'turn.tool_call', { toolName: 'Read' })],
      phase: 'progress',
      flush: 'interval',
      windowMs: 60_000,
    }
    expect(await summarizer.summarize(input)).toBe('1 events; last tool: Read; phase: progress')
    expect(await summarizer.summarize(input)).toBe('1 events; last tool: Read; phase: progress')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Consul')
  })

  it('bounds the digest sent to Haiku for huge event buffers', async () => {
    const capturedPrompts: string[] = []
    const hugeEvents = Array.from({ length: 1_100 }, (_, index) =>
      event(100 + index, 'turn.tool_result', {
        toolName: 'Bash',
        output: `chunk-${index} ${'x'.repeat(5_000)}`,
      })
    )
    const { createStackedSummarizer } = await loadSummaryModule()
    const summarizer = createStackedSummarizer({
      apiKey: 'test-key',
      maxDigestBytes: 24_000,
      createAnthropicClient(): FakeAnthropicClient {
        return {
          messages: {
            async create(request: unknown) {
              capturedPrompts.push(extractPrompt(request))
              return { content: [{ type: 'text', text: 'bounded summary' }] }
            },
          },
        }
      },
    })

    expect(
      await summarizer.summarize({
        events: hugeEvents,
        phase: 'progress',
        flush: 'interval',
        windowMs: 60_000,
      })
    ).toBe('bounded summary')
    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]!.length).toBeLessThanOrEqual(24_000)
    expect(capturedPrompts[0]).toContain('[truncated]')
  })

  it('redacts likely secrets before sending a digest to Haiku', async () => {
    const capturedPrompts: string[] = []
    const { createStackedSummarizer } = await loadSummaryModule()
    const summarizer = createStackedSummarizer({
      apiKey: 'test-key',
      createAnthropicClient(): FakeAnthropicClient {
        return {
          messages: {
            async create(request: unknown) {
              capturedPrompts.push(extractPrompt(request))
              return { content: [{ type: 'text', text: 'redacted summary' }] }
            },
          },
        }
      },
    })

    await summarizer.summarize({
      events: [
        event(11, 'turn.tool_call', {
          toolName: 'Bash',
          input: {
            command:
              'echo AKIA1234567890ABCDEF sk-ant-api03-secret Bearer eyJhbGciOiJIUzI1NiIs password=hunter2 api_key=secret',
          },
        }),
      ],
      phase: 'progress',
      flush: 'interval',
      windowMs: 60_000,
    })

    const prompt = capturedPrompts.join('\n')
    expect(prompt).not.toContain('AKIA1234567890ABCDEF')
    expect(prompt).not.toContain('sk-ant-api03-secret')
    expect(prompt).not.toContain('Bearer eyJhbGciOiJIUzI1NiIs')
    expect(prompt).not.toContain('password=hunter2')
    expect(prompt).not.toContain('api_key=secret')
    expect(prompt).toContain('[REDACTED]')
  })

  it('uses the whole-turn buffer for final-window summarization', async () => {
    const capturedPrompts: string[] = []
    const { createStackedSummarizer } = await loadSummaryModule()
    const summarizer = createStackedSummarizer({
      apiKey: 'test-key',
      createAnthropicClient(): FakeAnthropicClient {
        return {
          messages: {
            async create(request: unknown) {
              capturedPrompts.push(extractPrompt(request))
              return { content: [{ type: 'text', text: 'whole turn summary' }] }
            },
          },
        }
      },
    })

    await summarizer.summarize({
      events: [event(99, 'turn.completed', { body: 'done' })],
      wholeTurnEvents: [
        event(11, 'turn.tool_call', { toolName: 'Read', input: { file_path: 'README.md' } }),
        event(12, 'turn.tool_result', { toolName: 'Read', output: 'contents' }),
        event(99, 'turn.completed', { body: 'done' }),
      ],
      phase: 'final',
      flush: 'final',
      windowMs: 60_000,
    })

    expect(capturedPrompts[0]).toContain('README.md')
    expect(capturedPrompts[0]).toContain('turn.completed')
  })
})
