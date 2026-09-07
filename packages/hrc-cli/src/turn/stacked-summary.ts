import type { HrcLifecycleEvent, HrcRuntimeIntent, HrcSubmissionResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { resolveLaunchTarget } from './resolve-intent.js'
import {
  isRecord,
  mechanicalSummary,
  redactSecrets,
  stringValue,
  truncateBytes,
  truncateChars,
} from './stacked-shared.js'
import { FlushReason, Phase, type Summarizer, type SummarizerInput } from './stacked-types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DIGEST_BYTES = 24_000
const DEFAULT_MAX_EVENTS = 120
const TEXT_PREVIEW_CHARS = 500
const CLEANUP_REASON = 'stacked summarizer cleanup'
const CLEANUP_SOURCE = 'hrc turn'

type SummaryTarget = {
  sessionRef: string
  scopeRef: string
  runtimeIntent: HrcRuntimeIntent
  parsedScopeJson: Record<string, unknown>
}

export type StackedSummaryClient = Pick<
  HrcClient,
  'ensureTarget' | 'invoke' | 'listRuntimes' | 'terminate' | 'dropContinuation'
>

export type StackedSummarizerOptions = {
  client: StackedSummaryClient
  targetProjectId: string
  observedAgentId: string
  runId: string
  timeoutMs?: number | undefined
  maxDigestBytes?: number | undefined
  maxEvents?: number | undefined
  resolveTarget?: ((handle: string) => SummaryTarget) | undefined
  setTimeout?: ((callback: () => void, ms: number) => unknown) | undefined
  clearTimeout?: ((handle: unknown) => void) | undefined
  stderr?: Pick<NodeJS.WriteStream, 'write'> | undefined
}

export interface StackedSeatSummarizer extends Summarizer {
  cleanup(): Promise<void>
}

export function createStackedSummarizer(options: StackedSummarizerOptions): StackedSeatSummarizer {
  return new SeatStackedSummarizer(options)
}

class SeatStackedSummarizer implements StackedSeatSummarizer {
  private readonly options: StackedSummarizerOptions
  private readonly timeoutMs: number
  private readonly maxDigestBytes: number
  private readonly maxEvents: number
  private readonly recursionGuarded: boolean
  private target: SummaryTarget | undefined
  private ensurePromise: Promise<void> | undefined
  private hostSessionId: string | undefined
  private readonly runtimeIds = new Set<string>()
  private cleanupPromise: Promise<void> | undefined

  constructor(options: StackedSummarizerOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDigestBytes = options.maxDigestBytes ?? DEFAULT_MAX_DIGEST_BYTES
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
    this.recursionGuarded = options.observedAgentId === 'summarizer'
  }

  async summarize(input: SummarizerInput): Promise<string> {
    const events =
      input.phase === Phase.Final || input.flush === FlushReason.Final
        ? (input.wholeTurnEvents ?? input.events)
        : input.events
    if (this.recursionGuarded || events.length === 0) {
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
      const target = this.resolveTarget()
      await this.ensureSession(target)

      // Live preflight on 2026-09-07 used the public `invoke` door against the
      // max3 daemon and compared its keys with HrcSubmissionResponse. A virgin
      // session returned 503 runtime_unavailable; `ensureTarget` minted only the
      // session, after which invoke cold-born the runtime and returned the
      // admitted response plus terminal.finalMessage. We use that two-step door
      // to avoid spending a dummy summarizer turn through semanticTurnHandoff.
      const invocation = this.options.client
        .invoke({
          target: target.sessionRef,
          body: prompt,
          origin: { principalRef: 'agent:summarizer' },
          runtimeIntent: target.runtimeIntent,
          wait: true,
          turnPolicy: 'guarded',
        })
        .then((response) => {
          this.captureInvocation(response)
          return response
        })
      const response = await withTimeout(
        invocation,
        this.timeoutMs,
        this.options.setTimeout ?? setTimeout,
        this.options.clearTimeout ??
          ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
      )
      if (response.admission !== 'admitted') {
        return mechanicalSummary(events, input.phase)
      }
      const finalMessage = response.terminal?.finalMessage?.trim()
      return finalMessage ? finalMessage : mechanicalSummary(events, input.phase)
    } catch {
      return mechanicalSummary(events, input.phase)
    }
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.cleanupOnce()
    return this.cleanupPromise
  }

  private resolveTarget(): SummaryTarget {
    if (this.target !== undefined) {
      return this.target
    }
    const handle = `summarizer@${this.options.targetProjectId}:stacked/${this.options.runId.slice(0, 8)}`
    if (this.options.resolveTarget) {
      this.target = this.options.resolveTarget(handle)
      return this.target
    }
    const resolved = resolveLaunchTarget(handle)
    this.target = {
      sessionRef: resolved.sessionRef,
      scopeRef: resolved.resolved.scopeRef,
      runtimeIntent: resolved.runtimeIntent,
      parsedScopeJson: resolved.resolved.parsed as unknown as Record<string, unknown>,
    }
    return this.target
  }

  private ensureSession(target: SummaryTarget): Promise<void> {
    this.ensurePromise ??= this.options.client
      .ensureTarget({
        sessionRef: target.sessionRef,
        runtimeIntent: target.runtimeIntent,
        parsedScopeJson: target.parsedScopeJson,
      })
      .then((ensured) => {
        this.hostSessionId = ensured.activeHostSessionId
        if (ensured.runtime?.runtimeId) {
          this.runtimeIds.add(ensured.runtime.runtimeId)
        }
      })
    return this.ensurePromise
  }

  private captureInvocation(response: HrcSubmissionResponse): void {
    if ('hostSessionId' in response && typeof response.hostSessionId === 'string') {
      this.hostSessionId = response.hostSessionId
    }
    if ('runtimeId' in response && typeof response.runtimeId === 'string') {
      this.runtimeIds.add(response.runtimeId)
    }
  }

  private async cleanupOnce(): Promise<void> {
    if (this.recursionGuarded || this.target === undefined) {
      return
    }

    try {
      await this.ensurePromise?.catch(() => undefined)
      if (this.runtimeIds.size === 0) {
        const runtimes = await this.options.client.listRuntimes({ scope: this.target.scopeRef })
        for (const runtime of runtimes) {
          this.runtimeIds.add(runtime.runtimeId)
          this.hostSessionId ??= runtime.hostSessionId
        }
      }

      if (this.runtimeIds.size > 0) {
        for (const runtimeId of this.runtimeIds) {
          await this.options.client.terminate(runtimeId, {
            dropContinuation: true,
            reason: CLEANUP_REASON,
            source: CLEANUP_SOURCE,
          })
        }
        return
      }

      if (this.hostSessionId !== undefined) {
        await this.options.client.dropContinuation({
          hostSessionId: this.hostSessionId,
          reason: CLEANUP_REASON,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const sink = this.options.stderr ?? process.stderr
      sink.write(`hrc: stacked summarizer cleanup failed: ${message}\n`)
    }
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

export function buildPrompt(input: {
  events: HrcLifecycleEvent[]
  phase: string
  flush: string
  windowMs: number
  maxEvents: number
  maxDigestBytes: number
}): string {
  const windowLabel = formatWindow(input.windowMs)
  const prefix = `window=${windowLabel} phase=${input.phase} flush=${input.flush}\n<events>\n`
  const suffix = '\n</events>'
  const wrapperBytes = new TextEncoder().encode(prefix + suffix).byteLength
  const digest = redactSecrets(buildDigest(input.events, input.maxEvents))
  const boundedDigest = truncateBytes(digest, Math.max(0, input.maxDigestBytes - wrapperBytes))
  return `${prefix}${boundedDigest}${suffix}`
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
