import { afterEach, describe, expect, it } from 'bun:test'
import { CliUsageError } from 'cli-kit'
import type {
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  ListMessagesResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
  SemanticTurnHandoffStartedResponse,
} from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { type TurnOptions, cmdTurn } from '../commands/turn.js'
import { type WaitFinalResult, buildDmWaitResult } from '../wait-final.js'

// -- Env scaffolding ----------------------------------------------------------

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
  process.exitCode = 0
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name)
  } else {
    process.env[name] = value
  }
}

// -- Fixtures -----------------------------------------------------------------

const SESSION: HrcMessageAddress = {
  kind: 'session',
  sessionRef: 'agent:clod:project:hrc-runtime/lane:main',
}

function makeRecord(overrides: Partial<HrcMessageRecord> = {}): HrcMessageRecord {
  return {
    messageSeq: 100,
    messageId: 'msg-request',
    createdAt: '2026-06-20T00:00:00Z',
    kind: 'dm',
    phase: 'request',
    from: { kind: 'entity', entity: 'human' },
    to: SESSION,
    rootMessageId: 'msg-request',
    body: 'hi',
    bodyFormat: 'text/plain',
    execution: { state: 'pending' },
    ...overrides,
  }
}

function makeReply(overrides: Partial<HrcMessageRecord> = {}): HrcMessageRecord {
  return makeRecord({
    messageSeq: 101,
    messageId: 'msg-reply',
    phase: 'response',
    from: SESSION,
    to: { kind: 'entity', entity: 'human' },
    replyToMessageId: 'msg-request',
    rootMessageId: 'msg-request',
    body: 'chat-follow validation done',
    ...overrides,
  })
}

// -- buildDmWaitResult (pure) -------------------------------------------------

describe('buildDmWaitResult', () => {
  it('reports responded with reply_to correlation when reply threads to the request', () => {
    const result = buildDmWaitResult({
      request: makeRecord(),
      waited: { matched: true, record: makeReply() },
      target: SESSION,
      elapsedMs: 1234,
    })
    expect(result.status).toBe('responded')
    expect(result.sentMessageId).toBe('msg-request')
    expect(result.target).toBe('clod@hrc-runtime')
    expect(result.elapsedMs).toBe(1234)
    expect(result.correlation).toEqual({ mode: 'reply_to', afterSeq: 100 })
    expect(result.response).toEqual({
      messageId: 'msg-reply',
      from: 'clod@hrc-runtime',
      text: 'chat-follow validation done',
    })
  })

  it('falls back to after_seq correlation when the reply is not threaded', () => {
    const reply = makeReply({ replyToMessageId: undefined, rootMessageId: 'msg-reply' })
    const result = buildDmWaitResult({
      request: makeRecord(),
      waited: { matched: true, record: reply },
      target: SESSION,
      elapsedMs: 10,
    })
    expect(result.status).toBe('responded')
    expect(result.correlation).toEqual({ mode: 'after_seq', afterSeq: 100 })
    expect(result.response?.messageId).toBe('msg-reply')
  })

  it('reports timeout with a lastSeq cursor when no reply arrives', () => {
    const result = buildDmWaitResult({
      request: makeRecord(),
      waited: { matched: false, reason: 'timeout' },
      target: SESSION,
      elapsedMs: 1_200_000,
    })
    expect(result.status).toBe('timeout')
    expect(result.sentMessageId).toBe('msg-request')
    expect(result.lastSeq).toBe(100)
    expect(result.response).toBeUndefined()
    expect(result.correlation).toBeUndefined()
  })

  it('reports error with errorCode/errorMessage when the dispatch failed', () => {
    const result = buildDmWaitResult({
      request: makeRecord({
        execution: { state: 'failed', errorCode: 'busy_headless', errorMessage: 'runtime busy' },
      }),
      waited: undefined,
      target: SESSION,
      elapsedMs: 5,
    })
    expect(result.status).toBe('error')
    expect(result.errorCode).toBe('busy_headless')
    expect(result.errorMessage).toBe('runtime busy')
    expect(result.lastSeq).toBe(100)
  })

  it('reports a local terminal federation delivery failure without waiting for timeout', () => {
    const result = buildDmWaitResult({
      request: makeRecord(),
      waited: {
        matched: false,
        reason: 'delivery_failed',
        messageId: 'msg-request',
        errorCode: 'retry_window_exhausted',
        errorMessage: 'peer remained unreachable',
      },
      target: SESSION,
      elapsedMs: 25,
    })
    expect(result).toMatchObject({
      status: 'error',
      sentMessageId: 'msg-request',
      errorCode: 'retry_window_exhausted',
      errorMessage: 'peer remained unreachable',
    })
  })
})

// -- cmdTurn --wait final -----------------------------------------------------

function makeHandoff(
  overrides: Partial<SemanticTurnHandoffStartedResponse> = {}
): SemanticTurnHandoffStartedResponse {
  return {
    messageId: 'msg-request',
    sessionRef: 'agent:clod:project:hrc-runtime/lane:main',
    scopeRef: 'agent:clod:project:hrc-runtime',
    laneRef: 'main',
    hostSessionId: 'hsid-test',
    runtimeId: 'rt-test',
    runId: 'run-test',
    generation: 1,
    fromSeq: 100,
    ...overrides,
  }
}

function lifecycle(eventKind: string): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-06-20T00:00:00Z',
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:clod:project:hrc-runtime',
    laneRef: 'main',
    generation: 1,
    runId: 'run-test',
    category: 'turn',
    replayed: false,
    payload: {},
    eventKind,
  }
}

function createTurnWaitClient(options: {
  events: HrcLifecycleEvent[]
  reply?: HrcMessageRecord | undefined
  blockUntilAbort?: boolean
}): HrcClient {
  return {
    async semanticTurnHandoff(
      _request: SemanticTurnHandoffRequest
    ): Promise<SemanticTurnHandoffResponse> {
      return makeHandoff()
    },
    async listMessages(): Promise<ListMessagesResponse> {
      return { messages: options.reply ? [options.reply] : [] }
    },
    async *watch(watchOptions?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
      for (const event of options.events) {
        yield event
      }
      if (options.blockUntilAbort) {
        // Hold the stream open so the wait's own timeout/SIGINT drives closure,
        // mirroring a live turn that has not yet reached a terminal event.
        await new Promise<void>((resolve) => {
          watchOptions?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    },
  } as HrcClient
}

async function runTurn(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number; error?: Error }> {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write
  const origErr = process.stderr.write
  process.exitCode = 0
  process.env['ASP_PROJECT'] = 'hrc-runtime'
  Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += String(c)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += String(c)
    return true
  }) as typeof process.stderr.write
  let error: Error | undefined
  try {
    await cmdTurn(client, { as: 'human', ...opts }, positionals)
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err))
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { stdout, stderr, exitCode: process.exitCode ?? 0, error }
}

describe('hrcchat turn --wait final', () => {
  it('returns a durable federated reply without waiting for local lifecycle events', async () => {
    const request = makeRecord({
      execution: {
        state: 'started',
        runId: 'run-test',
        runtimeId: 'rt-test',
        hostSessionId: 'hsid-test',
        generation: 1,
      },
      metadataJson: { federationSemanticTurnOrigin: true },
    })
    const reply = makeReply({
      execution: {
        state: 'completed',
        runId: 'run-test',
        runtimeId: 'rt-test',
        hostSessionId: 'hsid-test',
        generation: 1,
      },
    })
    const client = {
      async semanticTurnHandoff(): Promise<SemanticTurnHandoffResponse> {
        return makeHandoff()
      },
      async listMessages(filter?: HrcMessageFilter): Promise<ListMessagesResponse> {
        return {
          messages: filter?.messageId === request.messageId ? [request] : [reply],
        }
      },
      async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    } as HrcClient

    const { stdout } = await runTurn(client, { wait: 'final', timeout: '100ms' }, [
      'clod@hrc-runtime:primary',
      'do the remote thing',
    ])

    expect(JSON.parse(stdout.trim())).toMatchObject({
      status: 'responded',
      response: { messageId: 'msg-reply', text: 'chat-follow validation done' },
    })
  })

  it('emits one responded JSON object with the durable reply, no stderr', async () => {
    const client = createTurnWaitClient({
      events: [lifecycle('turn_end')],
      reply: makeReply(),
    })
    const { stdout, stderr } = await runTurn(client, { wait: 'final', timeout: '45m' }, [
      'clod@hrc-runtime:primary',
      'do the thing',
    ])
    expect(stderr).toBe('')
    const lines = stdout.trimEnd().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] ?? '{}') as WaitFinalResult
    expect(parsed.status).toBe('responded')
    expect(parsed.sentMessageId).toBe('msg-request')
    expect(parsed.target).toBe('clod@hrc-runtime')
    expect(parsed.correlation).toEqual({ mode: 'reply_to', afterSeq: 100 })
    expect(parsed.response?.text).toBe('chat-follow validation done')
  })

  it('ignores same-thread decoy responses unless they exactly match the handoff identity', async () => {
    const validReply = makeReply({
      messageId: 'msg-terminal',
      body: 'terminal turn response',
      execution: {
        state: 'completed',
        runId: 'run-test',
        hostSessionId: 'hsid-test',
        generation: 1,
      },
    })
    const operatorDecoy = makeReply({
      messageId: 'msg-operator-decoy',
      from: { kind: 'entity', entity: 'human' },
      to: SESSION,
      body: 'operator mid-flight reply that must not complete the turn wait',
      execution: {
        state: 'completed',
        runId: 'run-other',
        hostSessionId: 'hsid-test',
        generation: 1,
      },
    })
    const wrongRunDecoy = makeReply({
      messageId: 'msg-wrong-run-decoy',
      body: 'same-thread response from a different run',
      execution: {
        state: 'completed',
        runId: 'run-other',
        hostSessionId: 'hsid-test',
        generation: 1,
      },
    })
    const observedFilters: HrcMessageFilter[] = []
    const client = {
      async semanticTurnHandoff(): Promise<SemanticTurnHandoffResponse> {
        return makeHandoff()
      },
      async listMessages(filter?: HrcMessageFilter): Promise<ListMessagesResponse> {
        if (filter) observedFilters.push(filter)
        // T-05588 regression guard: a loose same-thread lookup sees decoys before
        // the real terminal turn response. Only exact handoff correlation returns
        // the valid response.
        const hasExactHandoffFilter =
          filter?.from !== undefined &&
          filter.to !== undefined &&
          (filter as HrcMessageFilter & { replyToMessageId?: string }).replyToMessageId ===
            'msg-request' &&
          (filter as HrcMessageFilter & { runId?: string }).runId === 'run-test' &&
          filter.hostSessionId === 'hsid-test' &&
          filter.generation === 1
        return {
          messages: hasExactHandoffFilter
            ? [validReply]
            : [operatorDecoy, wrongRunDecoy, validReply],
        }
      },
      async *watch(): AsyncIterable<HrcLifecycleEvent> {
        yield lifecycle('turn_end')
      },
    } as HrcClient

    const { stdout } = await runTurn(client, { wait: 'final', timeout: '45m' }, [
      'clod@hrc-runtime:primary',
      'do the thing',
    ])

    const parsed = JSON.parse(stdout.trim()) as WaitFinalResult
    expect(parsed.status).toBe('responded')
    expect(parsed.response).toEqual({
      messageId: 'msg-terminal',
      from: 'clod@hrc-runtime',
      text: 'terminal turn response',
    })
    expect(observedFilters).toContainEqual(
      expect.objectContaining({
        phases: ['response'],
        from: SESSION,
        to: { kind: 'entity', entity: 'human' },
        hostSessionId: 'hsid-test',
        generation: 1,
        limit: 1,
      })
    )
    const exactFilter = observedFilters.find(
      (filter) =>
        (filter as HrcMessageFilter & { replyToMessageId?: string }).replyToMessageId ===
        'msg-request'
    ) as (HrcMessageFilter & { replyToMessageId?: string; runId?: string }) | undefined
    expect(exactFilter?.runId).toBe('run-test')
  })

  it('reports error with a cursor when the runtime dies before completion', async () => {
    const client = createTurnWaitClient({ events: [lifecycle('runtime_exited')] })
    const { stdout, exitCode } = await runTurn(client, { wait: 'final' }, [
      'clod@hrc-runtime:primary',
      'x',
    ])
    const parsed = JSON.parse(stdout.trim()) as WaitFinalResult
    expect(parsed.status).toBe('error')
    expect(parsed.errorCode).toBe('runtime_dead')
    expect(parsed.lastSeq).toBe(100)
    expect(exitCode).toBe(4)
  })

  it('reports timeout with a cursor when the budget elapses', async () => {
    const client = createTurnWaitClient({ events: [], blockUntilAbort: true })
    const { stdout, stderr, exitCode } = await runTurn(client, { wait: 'final', timeout: '1s' }, [
      'clod@hrc-runtime:primary',
      'x',
    ])
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout.trim()) as WaitFinalResult
    expect(parsed.status).toBe('timeout')
    expect(parsed.lastSeq).toBe(100)
    expect(exitCode).toBe(1)
  })

  it('rejects --wait combined with --follow (streaming) as mutually exclusive', async () => {
    const client = createTurnWaitClient({ events: [lifecycle('turn_end')] })
    const { error } = await runTurn(client, { wait: 'final', follow: '10s' }, [
      'clod@hrc-runtime:primary',
      'x',
    ])
    expect(error).toBeInstanceOf(CliUsageError)
    expect(error?.message).toMatch(/mutually exclusive/)
  })

  it('rejects an unsupported --wait mode for turn', async () => {
    const client = createTurnWaitClient({ events: [] })
    const { error } = await runTurn(client, { wait: 'response' }, ['clod@hrc-runtime:primary', 'x'])
    expect(error).toBeInstanceOf(CliUsageError)
    expect(error?.message).toMatch(/unsupported --wait mode/)
  })
})
