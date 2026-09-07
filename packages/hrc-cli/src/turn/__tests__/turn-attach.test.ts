import { afterEach, describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { CliUsageError } from 'cli-kit'

import {
  ATTACH_CATCH_UP_DEADLINE_MS,
  TURN_EXIT_INFRA,
  TURN_EXIT_NOTHING_TO_ATTACH,
  TURN_EXIT_SIGINT,
  TURN_EXIT_STALL,
  type TurnCommandDependencies,
  TurnExitError,
  type TurnOptions,
  cmdTurn,
} from '../commands/turn.js'
import { resolveMessagingScope as resolveMessagingScopeDefault } from '../normalize.js'

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

function lifecycle(
  hrcSeq: number,
  eventKind: string,
  payload: Record<string, unknown> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: '2026-09-07T17:00:00Z',
    hostSessionId: 'hsid-attached',
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-08200:role:smoke',
    laneRef: 'main',
    generation: 7,
    runId: 'run-attached',
    category: 'turn',
    transport: 'sdk',
    replayed: false,
    eventKind,
    payload,
  }
}

type AttachClientOptions = {
  sessionFound?: boolean
  runtimeIds?: string[]
  activeRunIds?: Array<string | null>
  runStatus?: string
  replay?: HrcLifecycleEvent[]
  live?: HrcLifecycleEvent[]
  dispatchedInputId?: string
  follow?: ((options?: WatchOptions) => AsyncIterable<HrcLifecycleEvent>) | undefined
}

function attachClient(
  options: AttachClientOptions = {},
  watchCalls: WatchOptions[] = []
): HrcClient {
  const runtimeIds = options.runtimeIds ?? ['rt-attached']
  const activeRunIds = options.activeRunIds ?? ['run-attached']
  const replay = options.replay ?? [lifecycle(10, 'run_queued'), lifecycle(42, 'turn.tool_call')]
  return {
    async resolveSession() {
      return options.sessionFound === false
        ? { found: false, hostSessionId: null, generation: null, created: false, session: null }
        : {
            found: true,
            hostSessionId: 'hsid-attached',
            generation: 7,
            created: false,
            session: {},
          }
    },
    async listRuntimes() {
      return runtimeIds.map((runtimeId) => ({ runtimeId }))
    },
    async inspectRuntime({ runtimeId }) {
      const index = runtimeIds.indexOf(runtimeId)
      return {
        runtimeId,
        hostSessionId: 'hsid-attached',
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-08200:role:smoke',
        laneRef: 'main',
        generation: 7,
        activeRunId: activeRunIds[index] ?? null,
      }
    },
    async getRun(runId: string) {
      if (options.runStatus === 'missing') return null
      return {
        runId,
        status: options.runStatus ?? 'running',
        dispatchedInputId: options.dispatchedInputId,
      }
    },
    async *watch(watchOptions?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
      watchCalls.push(watchOptions ?? {})
      if (watchOptions?.follow === false) {
        yield* replay
        return
      }
      if (options.follow !== undefined) {
        yield* options.follow(watchOptions)
        return
      }
      yield* options.live ?? replay
    },
  } as HrcClient
}

type CommandResult = { exitCode: number; stdout: string; stderr: string }

async function runAttach(
  client: HrcClient,
  opts: TurnOptions = { attach: true, stacked: '1h' },
  positionals = ['cody@hrc-runtime:T-08200/smoke'],
  dependencies: TurnCommandDependencies = fakeDependencies()
): Promise<CommandResult> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  process.env['ASP_PROJECT'] = 'hrc-runtime'
  Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    await cmdTurn(client, opts, positionals, dependencies)
  } catch (error) {
    if (error instanceof TurnExitError) {
      exitCode = error.exitCode
      stderr += `hrc: ${error.message}\n`
    } else if (error instanceof CliUsageError) {
      exitCode = 2
      stderr += `hrc: ${error.message}\n`
    } else {
      throw error
    }
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
  return { exitCode, stdout, stderr }
}

function fakeDependencies(): TurnCommandDependencies {
  return {
    createStackedSummarizer() {
      return {
        summarize: async () => 'Summarizes the attached test turn.',
        cleanup: async () => undefined,
      }
    },
  }
}

function stackedLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
      once: true,
    })
  })
}

describe('hrc turn --attach', () => {
  it('uses live identity and the two-read boundary without building a launch intent', async () => {
    const watchCalls: WatchOptions[] = []
    let launchCalls = 0
    const replay = [
      lifecycle(10, 'turn.started', { inputId: 'input-from-ledger' }),
      lifecycle(42, 'turn.tool_call'),
    ]
    const result = await runAttach(
      attachClient(
        { replay, live: [...replay, lifecycle(43, 'turn.completed', { body: 'done' })] },
        watchCalls
      ),
      undefined,
      undefined,
      {
        ...fakeDependencies(),
        resolveMessagingScope(input, options) {
          process.stderr.write('hrc: warning: task worktree association is ambiguous\n')
          return resolveMessagingScopeDefault(input, options)
        },
        resolveLaunchTarget() {
          launchCalls += 1
          throw new Error('attach constructed a launch intent')
        },
      }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('task worktree association is ambiguous')
    expect(launchCalls).toBe(0)
    expect(watchCalls).toHaveLength(2)
    expect(watchCalls[0]).toMatchObject({ runId: 'run-attached', fromSeq: 1, follow: false })
    expect(watchCalls[1]).toMatchObject({ runId: 'run-attached', fromSeq: 10, follow: true })
    const lines = stackedLines(result.stdout)
    expect(lines[0]).toMatchObject({
      flush: 'attach',
      hrcSeqRange: { from: 10, to: 42 },
      messageId: 'input-from-ledger',
      sessionRef: 'agent:cody:project:hrc-runtime:task:T-08200:role:smoke/lane:main',
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-08200:role:smoke',
      laneRef: 'main',
      runId: 'run-attached',
      generation: 7,
    })
    expect(lines.at(-1)).toMatchObject({ flush: 'final', result: 'success' })
  })

  it('uses the fixed 30 second catch-up deadline', () => {
    expect(ATTACH_CATCH_UP_DEADLINE_MS).toBe(30_000)
  })

  it('exits 6 without a frame for every no-admitted-run shape', async () => {
    const cases: Array<[AttachClientOptions, string]> = [
      [{ sessionFound: false }, 'session not found'],
      [{ runtimeIds: [] }, 'session has no runtime'],
      [{ activeRunIds: [null] }, 'no runtime has an active run'],
      [
        { runtimeIds: ['rt-a', 'rt-b'], activeRunIds: ['run-a', 'run-b'] },
        '2 runtimes have active runs',
      ],
      [{ runStatus: 'completed' }, 'has status completed'],
      [{ replay: [] }, 'run has no ledger events'],
    ]
    for (const [options, reason] of cases) {
      const result = await runAttach(attachClient(options))
      expect(result.exitCode).toBe(TURN_EXIT_NOTHING_TO_ATTACH)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('turn: no active turn')
      expect(result.stderr).toContain(reason)
    }
  })

  it('rejects dispatch-only flags and prompt sources', async () => {
    const flags: Array<[TurnOptions, string]> = [
      [{ new: true }, '--new'],
      [{ dryRun: true }, '--dry-run'],
      [{ steer: true }, '--steer'],
      [{ preempt: true }, '--preempt'],
      [{ wait: 'final' }, '--wait'],
      [{ ttl: '1m' }, '--ttl'],
      [{ replyTo: 'msg-1' }, '--reply-to'],
      [{ crossScopeReply: true }, '--cross-scope-reply'],
      [{ responseFormatJsonSchema: '{}' }, '--response-format-json-schema'],
      [{ as: 'human' }, '--as'],
      [{ quiet: true }, '--quiet'],
    ]
    for (const [flag, name] of flags) {
      const result = await runAttach(attachClient(), { attach: true, ...flag })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain(name)
    }
    const promptSources: Array<[TurnOptions, string[]]> = [
      [{ attach: true }, ['cody@hrc-runtime:T-08200/smoke', 'prompt']],
      [{ attach: true }, ['cody@hrc-runtime:T-08200/smoke', '-']],
      [{ attach: true, file: '/tmp/prompt' }, ['cody@hrc-runtime:T-08200/smoke']],
    ]
    for (const [opts, positionals] of promptSources) {
      const result = await runAttach(attachClient(), opts, positionals)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--attach cannot be combined with a prompt')
    }
  })

  it('suppresses stall during catch-up and arms it at the boundary', async () => {
    const replay = Array.from({ length: 33 }, (_, index) =>
      lifecycle(index + 10, index === 0 ? 'run_queued' : 'turn.tool_call')
    )
    const result = await runAttach(
      attachClient({
        replay,
        follow: async function* (options) {
          yield* replay.slice(0, 11)
          await new Promise((resolve) => setTimeout(resolve, 40))
          yield* replay.slice(11)
          await waitForAbort(options?.signal)
        },
      }),
      { attach: true, stacked: '1h', stallAfter: '20ms' },
      undefined,
      { ...fakeDependencies(), attachCatchUpDeadlineMs: 500 }
    )
    expect(result.exitCode).toBe(TURN_EXIT_STALL)
    const lines = stackedLines(result.stdout)
    expect(lines.map((line) => line['flush'])).toEqual(['attach', 'stall'])
    expect(lines[0]).toMatchObject({ hrcSeqRange: { from: 10, to: 42 } })
  })

  it('exits 3 without a frame when catch-up misses its deadline', async () => {
    const replay = Array.from({ length: 33 }, (_, index) => lifecycle(index + 10, 'turn.tool_call'))
    const result = await runAttach(
      attachClient({
        replay,
        follow: async function* (options) {
          yield* replay.slice(0, 11)
          await waitForAbort(options?.signal)
        },
      }),
      { attach: true, stacked: '1h', stallAfter: '1ms' },
      undefined,
      { ...fakeDependencies(), attachCatchUpDeadlineMs: 20 }
    )
    expect(result.exitCode).toBe(TURN_EXIT_INFRA)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('received through seq 20 of 42')
  })

  it('holds non-stacked replay output until catch-up completes', async () => {
    const replay = Array.from({ length: 33 }, (_, index) => lifecycle(index + 10, 'turn.tool_call'))
    const result = await runAttach(
      attachClient({
        replay,
        follow: async function* (options) {
          yield* replay.slice(0, 11)
          await waitForAbort(options?.signal)
        },
      }),
      { attach: true, format: 'ndjson', stallAfter: '1ms' },
      undefined,
      { ...fakeDependencies(), attachCatchUpDeadlineMs: 20 }
    )
    expect(result.exitCode).toBe(TURN_EXIT_INFRA)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('received through seq 20 of 42')
  })

  it('exits 130 without a frame on SIGINT during catch-up', async () => {
    const replay = Array.from({ length: 33 }, (_, index) => lifecycle(index + 10, 'turn.tool_call'))
    const result = await runAttach(
      attachClient({
        replay,
        follow: async function* (options) {
          yield* replay.slice(0, 11)
          setTimeout(() => process.emit('SIGINT'), 0)
          await waitForAbort(options?.signal)
        },
      })
    )
    expect(result.exitCode).toBe(TURN_EXIT_SIGINT)
    expect(result.stdout).toBe('')
  })

  it('emits one terminal frame when the run ends before subscribe', async () => {
    const replay = [lifecycle(10, 'run_queued'), lifecycle(42, 'turn.completed', { body: 'done' })]
    const result = await runAttach(attachClient({ replay, live: replay }))
    expect(result.exitCode).toBe(0)
    expect(stackedLines(result.stdout)).toEqual([
      expect.objectContaining({
        flush: 'final',
        result: 'success',
        hrcSeqRange: { from: 10, to: 42 },
      }),
    ])
  })

  it('preserves permission, error, and runtime-dead outcomes after catch-up', async () => {
    const replay = [lifecycle(10, 'turn.tool_call')]
    const cases: Array<[HrcLifecycleEvent[], number, string]> = [
      [
        [
          lifecycle(11, 'permission_request', {
            requestId: 'perm-attached',
            toolName: 'Bash',
          }),
          lifecycle(12, 'turn_end'),
        ],
        5,
        'permission_blocked',
      ],
      [[lifecycle(11, 'run_failed', { message: 'failed' })], 4, 'turn_error'],
      [[lifecycle(11, 'runtime_exited')], 4, 'runtime_dead'],
    ]
    for (const [tail, exitCode, expectedResult] of cases) {
      const result = await runAttach(attachClient({ replay, live: [...replay, ...tail] }))
      expect(result.exitCode).toBe(exitCode)
      expect(stackedLines(result.stdout).at(-1)).toMatchObject({ result: expectedResult })
    }
  })
})
