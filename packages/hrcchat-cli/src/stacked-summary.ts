import Anthropic from '@anthropic-ai/sdk'
import type { HrcLifecycleEvent } from 'hrc-core'

import { consulKvGet as defaultConsulKvGet } from './consul-secrets.js'
import {
  isRecord,
  mechanicalSummary,
  redactSecrets,
  stringValue,
  truncateBytes,
  truncateChars,
} from './stacked-shared.js'
import { FlushReason, Phase, type Summarizer, type SummarizerInput } from './stacked-types.js'

const MODEL = 'claude-haiku-4-5'
// Dedicated, narrowly-scoped key for the stacked-summary feature only — a
// restricted Anthropic key (haiku-tier, low limits) kept separate from the
// broadly-shared cfg/dev/_global/llm/anthropic/api_key.
const DEFAULT_CONSUL_KEY = 'cfg/dev/_global/hrcchat/stacked_summaries_api_key'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_DIGEST_BYTES = 24_000
const DEFAULT_MAX_EVENTS = 120
const TEXT_PREVIEW_CHARS = 500

type AnthropicLike = {
  messages: {
    create(request: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }>
  }
}

export type StackedSummarizerOptions = {
  apiKey?: string | undefined
  consulKey?: string | undefined
  consulKvGet?: ((key: string) => Promise<string | undefined>) | undefined
  timeoutMs?: number | undefined
  maxDigestBytes?: number | undefined
  maxEvents?: number | undefined
  createAnthropicClient?: ((apiKey: string) => AnthropicLike) | undefined
  setTimeout?: ((callback: () => void, ms: number) => unknown) | undefined
  clearTimeout?: ((handle: unknown) => void) | undefined
  stderr?: Pick<NodeJS.WriteStream, 'write'> | undefined
}

const warnedCredentialSinks = new WeakSet<object>()

export function createStackedSummarizer(options: StackedSummarizerOptions = {}): Summarizer {
  return new StackedSummarizer(options)
}

class StackedSummarizer implements Summarizer {
  private readonly options: StackedSummarizerOptions
  private readonly timeoutMs: number
  private readonly maxDigestBytes: number
  private readonly maxEvents: number

  constructor(options: StackedSummarizerOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDigestBytes = options.maxDigestBytes ?? DEFAULT_MAX_DIGEST_BYTES
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  }

  async summarize(input: SummarizerInput): Promise<string> {
    const events =
      input.phase === Phase.Final || input.flush === FlushReason.Final
        ? (input.wholeTurnEvents ?? input.events)
        : input.events
    const apiKey = await this.resolveApiKey()
    if (apiKey === undefined) {
      return mechanicalSummary(events, input.phase)
    }

    const prompt = buildPrompt({
      events,
      phase: input.phase,
      flush: input.flush,
      windowMs: input.windowMs,
      maxEvents: this.maxEvents,
      maxDigestBytes: this.maxDigestBytes,
    })

    try {
      const client = this.createClient(apiKey)
      const response = await withTimeout(
        client.messages.create({
          model: MODEL,
          max_tokens: 128,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
        this.timeoutMs,
        this.options.setTimeout ?? setTimeout,
        this.options.clearTimeout ??
          ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      )
      return extractText(response) ?? mechanicalSummary(events, input.phase)
    } catch {
      return mechanicalSummary(events, input.phase)
    }
  }

  private async resolveApiKey(): Promise<string | undefined> {
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
      return this.options.apiKey
    }

    const key = this.options.consulKey ?? DEFAULT_CONSUL_KEY
    const kvGet = this.options.consulKvGet ?? defaultConsulKvGet
    const apiKey = await kvGet(key)
    if (apiKey === undefined) {
      this.warnOnce(`hrcchat: stacked summaries disabled; Consul key unavailable: ${key}\n`)
    }
    return apiKey
  }

  private createClient(apiKey: string): AnthropicLike {
    if (this.options.createAnthropicClient) {
      return this.options.createAnthropicClient(apiKey)
    }
    return new Anthropic({ apiKey }) as AnthropicLike
  }

  private warnOnce(message: string): void {
    const sink = this.options.stderr ?? process.stderr
    if (warnedCredentialSinks.has(sink)) {
      return
    }
    warnedCredentialSinks.add(sink)
    sink.write(message)
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  setTimer: (callback: () => void, ms: number) => unknown,
  clearTimer: (handle: unknown) => void
): Promise<T> {
  let handle: unknown
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimer(() => reject(new Error('stacked summary timeout')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (handle !== undefined) {
      clearTimer(handle)
    }
  })
}

function extractText(response: { content: Array<{ type: 'text'; text: string }> }):
  | string
  | undefined {
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .find((line) => line.length > 0)
  return text
}

function buildPrompt(input: {
  events: HrcLifecycleEvent[]
  phase: string
  flush: string
  windowMs: number
  maxEvents: number
  maxDigestBytes: number
}): string {
  const digest = buildDigest(input.events, input.maxEvents)
  const windowLabel = formatWindow(input.windowMs)
  const prefix = `Summarize what this agent did in the past ${windowLabel}. One sentence, present tense, concrete. Phase: ${input.phase}. Flush: ${input.flush}. Events:\n`
  return truncateBytes(redactSecrets(`${prefix}${digest}`), input.maxDigestBytes)
}

function buildDigest(events: HrcLifecycleEvent[], maxEvents: number): string {
  const omitted = Math.max(0, events.length - maxEvents)
  const selected = events.slice(Math.max(0, events.length - maxEvents))
  const lines = selected.map((event) => {
    const payload = isRecord(event.payload) ? event.payload : {}
    const parts = [`seq=${event.hrcSeq}`, `kind=${event.eventKind}`]
    const toolName = stringValue(payload['toolName'] ?? payload['tool_name'] ?? payload['name'])
    if (toolName) {
      parts.push(`tool=${toolName}`)
    }
    const status = stringValue(payload['status'] ?? payload['decision'] ?? payload['level'])
    if (status) {
      parts.push(`status=${status}`)
    }
    const text = payloadPreview(payload)
    if (text) {
      parts.push(`detail=${text}`)
    }
    return parts.join(' ')
  })
  if (omitted > 0) {
    lines.unshift(`[truncated] omitted ${omitted} older events`)
  }
  return lines.join('\n')
}

function payloadPreview(payload: Record<string, unknown>): string {
  const interesting =
    payload['command'] ??
    payload['input'] ??
    payload['toolInput'] ??
    payload['output'] ??
    payload['result'] ??
    payload['body'] ??
    payload['message'] ??
    payload['error'] ??
    payload['messageText'] ??
    payload['textDelta']
  return truncateChars(stringifyValue(interesting), TEXT_PREVIEW_CHARS, '...[truncated]')
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatWindow(ms: number): string {
  if (ms % 60_000 === 0) {
    return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
  }
  if (ms % 1_000 === 0) {
    return `${ms / 1_000} second${ms === 1_000 ? '' : 's'}`
  }
  return `${ms}ms`
}
