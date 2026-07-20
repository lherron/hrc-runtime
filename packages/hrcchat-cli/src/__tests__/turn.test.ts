import { afterEach, describe, expect, it } from 'bun:test'
import type {
  ClearContextRequest,
  ClearContextResponse,
  HrcLifecycleEvent,
  HrcTargetView,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
} from 'hrc-core'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { CliUsageError } from 'cli-kit'

import {
  TURN_EXIT_RUNTIME_DEAD,
  TURN_EXIT_STALL,
  TurnExitError,
  type TurnOptions,
  cmdTurn,
} from '../commands/turn.js'

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
  ASP_AGENTS_ROOT: process.env['ASP_AGENTS_ROOT'],
  HRC_BIRTH_CREDENTIAL: process.env['HRC_BIRTH_CREDENTIAL'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
  restoreEnv('ASP_AGENTS_ROOT', savedEnv.ASP_AGENTS_ROOT)
  restoreEnv('HRC_BIRTH_CREDENTIAL', savedEnv.HRC_BIRTH_CREDENTIAL)
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name)
  } else {
    process.env[name] = value
  }
}

// -- Mock infrastructure ------------------------------------------------------

type MockWatchEvents = HrcLifecycleEvent[]

function makeHandoff(
  overrides: Partial<SemanticTurnHandoffResponse> = {}
): SemanticTurnHandoffResponse {
  return {
    messageId: 'msg-turn-test',
    sessionRef: 'agent:cody:project:agent-spaces/lane:main',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    hostSessionId: 'hsid-test',
    runtimeId: 'rt-test',
    runId: 'run-test',
    generation: 1,
    fromSeq: 0,
    ...overrides,
  }
}

function makeLifecycleEvent(
  overrides: Partial<HrcLifecycleEvent> & { eventKind: string }
): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-05-12T00:00:00Z',
    hostSessionId: 'hsid-test',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    runId: 'run-test',
    category: 'turn',
    transport: 'sdk',
    replayed: false,
    payload: {},
    ...overrides,
  }
}

function createTurnClient(options: {
  handoff?: SemanticTurnHandoffResponse
  events?: MockWatchEvents
  target?: HrcTargetView | null // null = target_not_found
  clearContextCalls?: ClearContextRequest[]
  handoffCalls?: SemanticTurnHandoffRequest[]
}): HrcClient {
  const clearContextCalls = options.clearContextCalls ?? []
  const handoffCalls = options.handoffCalls ?? []

  return {
    async getTarget(_sessionRef: string): Promise<HrcTargetView> {
      if (options.target === null) {
        throw new HrcDomainError(HrcErrorCode.UNKNOWN_SESSION, 'target not found')
      }
      return (
        options.target ?? {
          sessionRef: 'agent:cody:project:agent-spaces/lane:main',
          scopeRef: 'agent:cody:project:agent-spaces',
          laneRef: 'main',
          state: 'active',
          activeHostSessionId: 'hsid-existing',
          generation: 1,
        }
      )
    },
    async clearContext(request: ClearContextRequest): Promise<ClearContextResponse> {
      clearContextCalls.push(request)
      return {
        hostSessionId: request.hostSessionId,
        generation: 2,
        priorHostSessionId: request.hostSessionId,
      }
    },
    async semanticTurnHandoff(
      request: SemanticTurnHandoffRequest
    ): Promise<SemanticTurnHandoffResponse> {
      handoffCalls.push(request)
      return options.handoff ?? makeHandoff()
    },
    async *watch(_options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
      const events = options.events ?? [
        makeLifecycleEvent({ eventKind: 'turn_end', hrcSeq: 10, streamSeq: 10 }),
      ]
      for (const event of events) {
        yield event
      }
    },
  } as HrcClient
}

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  error?: Error
}

async function runTurnCommand(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[]
): Promise<CommandResult> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  process.env['ASP_PROJECT'] = 'agent-spaces'
  Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write

  let caughtError: Error | undefined
  try {
    await cmdTurn(client, opts, positionals)
  } catch (err) {
    if (err instanceof TurnExitError) {
      exitCode = err.exitCode
      stderr += `hrcchat: ${err.message}\n`
    } else if (err instanceof CliUsageError) {
      exitCode = 2
      stderr += `hrcchat: ${err.message}\n`
    } else if (err instanceof Error) {
      exitCode = 1
      caughtError = err
    } else {
      exitCode = 1
    }
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }

  return { exitCode, stdout, stderr, error: caughtError }
}

// -- Tests --------------------------------------------------------------------

describe('hrcchat turn — body mutex', () => {
  it('rejects when both positional prompt and --file are provided', async () => {
    const client = createTurnClient({})
    const result = await runTurnCommand(client, { file: '/tmp/some-file' }, [
      'cody@agent-spaces',
      'hello from positional',
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('only one body source allowed')
  })

  it('rejects when both stdin (-) and --file are provided', async () => {
    const client = createTurnClient({})
    const result = await runTurnCommand(client, { file: '/tmp/some-file' }, [
      'cody@agent-spaces',
      '-',
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('only one body source allowed')
  })

  it('rejects when no body is provided', async () => {
    const client = createTurnClient({})
    const result = await runTurnCommand(client, {}, ['cody@agent-spaces'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('turn requires a prompt')
  })

  it('rejects when target is missing', async () => {
    const client = createTurnClient({})
    const result = await runTurnCommand(client, {}, [])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('missing required argument')
  })
})

describe('hrcchat turn — stall-after', () => {
  it('exits 1 when stall-after fires on a long-running turn', async () => {
    // Create a watch that never completes — the stall timer should fire
    const client = {
      ...createTurnClient({
        events: [],
      }),
      async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
        // Simulate a long-running watch that respects abort signal
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000)
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new DOMException('aborted', 'AbortError'))
            })
          }
        })
        yield makeLifecycleEvent({ eventKind: 'message_start', hrcSeq: 1, streamSeq: 1 })
      },
    } as HrcClient

    const result = await runTurnCommand(client, { stallAfter: '1s' }, [
      'cody@agent-spaces',
      'hello',
    ])
    expect(result.exitCode).toBe(TURN_EXIT_STALL)
    expect(result.stderr).toContain('stall-after timeout reached')
  })
})

describe('hrcchat turn — --new flag', () => {
  it('calls clearContext with dropContinuation when target has active host', async () => {
    const clearContextCalls: ClearContextRequest[] = []
    const handoffCalls: SemanticTurnHandoffRequest[] = []
    const client = createTurnClient({
      clearContextCalls,
      handoffCalls,
      target: {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
        state: 'active',
        activeHostSessionId: 'hsid-dirty',
        generation: 3,
      },
    })

    const result = await runTurnCommand(client, { new: true }, ['cody@agent-spaces', 'fresh start'])

    expect(result.exitCode).toBe(0)
    expect(clearContextCalls).toHaveLength(1)
    expect(clearContextCalls[0]).toMatchObject({
      hostSessionId: 'hsid-dirty',
      dropContinuation: true,
    })
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]!.body).toBe('fresh start')
  })

  it('skips clearContext when target does not exist', async () => {
    const clearContextCalls: ClearContextRequest[] = []
    const client = createTurnClient({
      clearContextCalls,
      target: null, // → target_not_found
    })

    const result = await runTurnCommand(client, { new: true }, ['cody@agent-spaces', 'create new'])

    expect(result.exitCode).toBe(0)
    expect(clearContextCalls).toHaveLength(0)
  })

  it('skips clearContext when target has no active host session', async () => {
    const clearContextCalls: ClearContextRequest[] = []
    const client = createTurnClient({
      clearContextCalls,
      target: {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
        state: 'inactive',
        // No activeHostSessionId
      },
    })

    const result = await runTurnCommand(client, { new: true }, [
      'cody@agent-spaces',
      'dormant target',
    ])

    expect(result.exitCode).toBe(0)
    expect(clearContextCalls).toHaveLength(0)
  })
})

describe('hrcchat turn — exit codes', () => {
  it('exits 0 on turn_end event', async () => {
    const client = createTurnClient({
      events: [
        makeLifecycleEvent({
          eventKind: 'run_queued',
          hrcSeq: 1,
          streamSeq: 1,
          payload: {
            runId: 'run-test',
            projectId: 'agent-spaces',
            queuedAt: 1,
            input: { content: 'test' },
          },
        }),
        makeLifecycleEvent({
          eventKind: 'turn_end',
          hrcSeq: 2,
          streamSeq: 2,
        }),
      ],
    })

    const result = await runTurnCommand(client, {}, ['cody@agent-spaces', 'hello'])
    expect(result.exitCode).toBe(0)
  })

  it('exits 0 on turn.completed event', async () => {
    const client = createTurnClient({
      events: [
        makeLifecycleEvent({
          eventKind: 'turn.completed',
          hrcSeq: 1,
          streamSeq: 1,
        }),
      ],
    })

    const result = await runTurnCommand(client, {}, ['cody@agent-spaces', 'hello'])
    expect(result.exitCode).toBe(0)
  })

  it('exits 4 when runtime dies before turn completes', async () => {
    const client = createTurnClient({
      events: [
        makeLifecycleEvent({
          eventKind: 'run_queued',
          hrcSeq: 1,
          streamSeq: 1,
          payload: {
            runId: 'run-test',
            projectId: 'agent-spaces',
            queuedAt: 1,
            input: { content: 'test' },
          },
        }),
        makeLifecycleEvent({
          eventKind: 'runtime_exited',
          hrcSeq: 2,
          streamSeq: 2,
          category: 'runtime',
        }),
      ],
    })

    const result = await runTurnCommand(client, {}, ['cody@agent-spaces', 'hello'])
    expect(result.exitCode).toBe(TURN_EXIT_RUNTIME_DEAD)
  })
})

describe('hrcchat turn — handoff uses correct parameters', () => {
  it('passes body, target sessionRef, and createIfMissing to semanticTurnHandoff', async () => {
    const handoffCalls: SemanticTurnHandoffRequest[] = []
    const client = createTurnClient({ handoffCalls })

    await runTurnCommand(client, {}, ['cody@agent-spaces', 'my prompt'])

    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]!.body).toBe('my prompt')
    expect(handoffCalls[0]!.to).toMatchObject({ kind: 'session' })
    expect(handoffCalls[0]!.createIfMissing).toBe(true)
  })

  it('does not turn an ambient runtime credential into turn child-birth authority', async () => {
    process.env['HRC_BIRTH_CREDENTIAL'] = 'rt-ambient-parent'
    const handoffCalls: SemanticTurnHandoffRequest[] = []
    const client = createTurnClient({ handoffCalls })

    const result = await runTurnCommand(client, {}, ['cody@agent-spaces:T-06674', 'ordinary turn'])

    expect(result.exitCode).toBe(0)
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]).not.toHaveProperty('birthCredential')
  })

  it('passes --response-format-json-schema to semanticTurnHandoff', async () => {
    const handoffCalls: SemanticTurnHandoffRequest[] = []
    const client = createTurnClient({ handoffCalls })
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    }

    await runTurnCommand(client, { responseFormatJsonSchema: JSON.stringify(schema) }, [
      'cody@agent-spaces',
      'my prompt',
    ])

    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]!.responseFormat).toEqual({
      kind: 'json_schema',
      schema,
    })
  })

  it('watch uses runId and generation from handoff response (load-bearing filters)', async () => {
    let capturedWatchOptions: WatchOptions | undefined
    const handoff = makeHandoff({
      runId: 'run-specific',
      generation: 42,
      fromSeq: 100,
      scopeRef: 'agent:cody:project:agent-spaces',
      laneRef: 'main',
    })
    const client = {
      ...createTurnClient({ handoff }),
      async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
        capturedWatchOptions = options
        yield makeLifecycleEvent({ eventKind: 'turn_end' })
      },
    } as HrcClient

    await runTurnCommand(client, {}, ['cody@agent-spaces', 'test'])

    expect(capturedWatchOptions).toBeDefined()
    expect(capturedWatchOptions!.runId).toBe('run-specific')
    expect(capturedWatchOptions!.generation).toBe(42)
    expect(capturedWatchOptions!.fromSeq).toBe(100)
    expect(capturedWatchOptions!.scopeRef).toBe('agent:cody:project:agent-spaces')
    expect(capturedWatchOptions!.laneRef).toBe('main')
    expect(capturedWatchOptions!.follow).toBe(true)
  })
})

function parseStackedLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['type'] === 'turn_stacked')
}

describe('hrcchat turn — --stacked monitor stream', () => {
  it('--stacked 1s emits turn_stacked ndjson with version and monotonic stackSeq', async () => {
    const client = createTurnClient({
      handoff: makeHandoff({
        messageId: 'msg-request-1',
        sessionRef: 'agent:larry:project:agent-spaces:task:T-01449/lane:main',
        scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
      }),
      events: [
        makeLifecycleEvent({
          eventKind: 'turn.tool_call',
          hrcSeq: 11,
          streamSeq: 11,
          payload: { toolName: 'Read', input: { file_path: 'README.md' } },
        }),
        makeLifecycleEvent({
          eventKind: 'turn.completed',
          hrcSeq: 12,
          streamSeq: 12,
          payload: { body: 'done', replyMessageId: 'msg-reply-1' },
        }),
      ],
    })

    const result = await runTurnCommand(client, { stacked: '1s' } as TurnOptions, [
      'larry@agent-spaces:T-01449',
      'work on the task',
    ])

    expect(result.exitCode).toBe(0)
    const lines = parseStackedLines(result.stdout)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.every((line) => line['type'] === 'turn_stacked')).toBe(true)
    expect(lines.every((line) => line['version'] === 1)).toBe(true)
    expect(lines.map((line) => line['stackSeq'])).toEqual(
      Array.from({ length: lines.length }, (_, index) => index + 1)
    )
  })

  it('rejects --stacked with tree, compact, or --pretty formats', async () => {
    for (const opts of [
      { stacked: '1s', format: 'tree' },
      { stacked: '1s', format: 'compact' },
      { stacked: '1s', pretty: true },
    ]) {
      const result = await runTurnCommand(createTurnClient({}), opts as TurnOptions, [
        'larry@agent-spaces:T-01449',
        'hello',
      ])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--stacked')
    }
  })

  it('accepts --stacked with ndjson and json formats', async () => {
    for (const format of ['ndjson', 'json']) {
      const result = await runTurnCommand(
        createTurnClient({
          events: [makeLifecycleEvent({ eventKind: 'turn.completed', payload: { body: 'done' } })],
        }),
        { stacked: '1s', format } as TurnOptions,
        ['larry@agent-spaces:T-01449', 'hello']
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain('CliUsageError')
    }
  })

  it('propagates parseDuration errors for zero or invalid stacked durations', async () => {
    for (const stacked of ['0', 'not-a-duration']) {
      const result = await runTurnCommand(createTurnClient({}), { stacked } as TurnOptions, [
        'larry@agent-spaces:T-01449',
        'hello',
      ])

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toLowerCase()).toContain('duration')
    }
  })

  it('--reply-to is plumbed to semanticTurnHandoff without changing watch selectors', async () => {
    const handoffCalls: SemanticTurnHandoffRequest[] = []
    let capturedWatchOptions: WatchOptions | undefined
    const handoff = makeHandoff({
      messageId: 'msg-request-2',
      runId: 'run-from-handoff',
      generation: 7,
      fromSeq: 101,
      scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
      laneRef: 'main',
    })
    const client = {
      ...createTurnClient({ handoff, handoffCalls }),
      async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
        capturedWatchOptions = options
        yield makeLifecycleEvent({
          eventKind: 'turn.completed',
          hrcSeq: 102,
          payload: { body: 'done', replyMessageId: 'msg-reply-2' },
        })
      },
    } as HrcClient

    const result = await runTurnCommand(
      client,
      { stacked: '1s', replyTo: 'msg-prior-reply' } as TurnOptions,
      ['larry@agent-spaces:T-01449', 'follow up']
    )

    expect(result.exitCode).toBe(0)
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0]).toMatchObject({ replyToMessageId: 'msg-prior-reply' })
    expect(capturedWatchOptions).toMatchObject({
      scopeRef: handoff.scopeRef,
      laneRef: handoff.laneRef,
      runId: handoff.runId,
      generation: handoff.generation,
      fromSeq: handoff.fromSeq,
    })
    const finalLine = parseStackedLines(result.stdout).at(-1)
    expect(finalLine).toMatchObject({
      messageId: 'msg-request-2',
      replyMessageId: 'msg-reply-2',
      runId: 'run-from-handoff',
    })
  })

  it('puts truncated finalBody on the final line', async () => {
    const longBody = `${'final answer '.repeat(2_000)}tail`
    const client = createTurnClient({
      handoff: makeHandoff({ messageId: 'msg-request-3' }),
      events: [
        makeLifecycleEvent({
          eventKind: 'turn.completed',
          hrcSeq: 20,
          payload: { body: longBody, replyMessageId: 'msg-reply-3' },
        }),
      ],
    })

    const result = await runTurnCommand(client, { stacked: '1s' } as TurnOptions, [
      'larry@agent-spaces:T-01449',
      'finish',
    ])

    const finalLine = parseStackedLines(result.stdout).at(-1)
    expect(finalLine).toMatchObject({ phase: 'final', replyMessageId: 'msg-reply-3' })
    expect(finalLine?.['finalBody']).toContain('...[truncated]')
    expect(String(finalLine?.['finalBody']).length).toBeLessThan(longBody.length)
  })

  it('includes request messageId on every line and replyMessageId only on the final line', async () => {
    const client = createTurnClient({
      handoff: makeHandoff({ messageId: 'msg-request-4' }),
      events: [
        makeLifecycleEvent({
          eventKind: 'turn.tool_call',
          hrcSeq: 21,
          payload: { toolName: 'Read' },
        }),
        makeLifecycleEvent({
          eventKind: 'turn.completed',
          hrcSeq: 22,
          payload: { body: 'done', replyMessageId: 'msg-reply-4' },
        }),
      ],
    })

    const result = await runTurnCommand(client, { stacked: '1s' } as TurnOptions, [
      'larry@agent-spaces:T-01449',
      'finish',
    ])

    const lines = parseStackedLines(result.stdout)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.every((line) => line['messageId'] === 'msg-request-4')).toBe(true)
    for (const line of lines) {
      if (line['phase'] === 'final') {
        expect(line['replyMessageId']).toBe('msg-reply-4')
      } else {
        expect(line).not.toHaveProperty('replyMessageId')
      }
    }
  })

  it('extracts taskId from scoped targets and leaves it undefined when absent', async () => {
    const scoped = await runTurnCommand(
      createTurnClient({
        handoff: makeHandoff({
          sessionRef: 'agent:larry:project:agent-spaces:task:T-01449/lane:main',
          scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
        }),
        events: [makeLifecycleEvent({ eventKind: 'turn.completed', payload: { body: 'done' } })],
      }),
      { stacked: '1s' } as TurnOptions,
      ['larry@agent-spaces:T-01449', 'finish']
    )
    const unscoped = await runTurnCommand(
      createTurnClient({
        handoff: makeHandoff({
          sessionRef: 'agent:larry:project:agent-spaces/lane:main',
          scopeRef: 'agent:larry:project:agent-spaces',
        }),
        events: [makeLifecycleEvent({ eventKind: 'turn.completed', payload: { body: 'done' } })],
      }),
      { stacked: '1s' } as TurnOptions,
      ['larry@agent-spaces', 'finish']
    )

    expect(parseStackedLines(scoped.stdout).at(-1)).toMatchObject({ taskId: 'T-01449' })
    expect(parseStackedLines(unscoped.stdout).at(-1)).not.toHaveProperty('taskId')
  })

  it('emits terminal stacked flush before TurnExitError paths are reported', async () => {
    const client = createTurnClient({
      events: [
        makeLifecycleEvent({
          eventKind: 'permission_request',
          hrcSeq: 30,
          payload: {
            requestId: 'perm-1',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            toolInput: { command: 'rm -rf /tmp/example' },
          },
        }),
        makeLifecycleEvent({ eventKind: 'turn_end', hrcSeq: 31 }),
      ],
    })

    const result = await runTurnCommand(client, { stacked: '1s' } as TurnOptions, [
      'larry@agent-spaces:T-01449',
      'needs approval',
    ])

    expect(result.exitCode).toBe(5)
    const lines = parseStackedLines(result.stdout)
    expect(lines.at(-1)).toMatchObject({
      phase: 'permission',
      flush: 'permission',
      result: 'permission_blocked',
      exitCode: 5,
    })
    expect(result.stdout.indexOf('"turn_stacked"')).toBeGreaterThanOrEqual(0)
    expect(result.stderr).toContain('permission')
  })
})
