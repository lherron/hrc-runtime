/** Shared mock client and command runner for the `hrc turn` suites. */
import { afterEach, expect, jest } from 'bun:test'
import { resolveQualifiedScopeInput } from 'agent-scope'
import type {
  EnqueueSubmissionRequest,
  HrcLifecycleEvent,
  HrcSubmissionResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
  SemanticTurnHandoffStartedResponse,
  SteerSubmissionRequest,
} from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { CliUsageError } from 'cli-kit'

import {
  type TurnCommandDependencies,
  TurnExitError,
  type TurnOptions,
  cmdTurn,
} from '../commands/turn.js'

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
  ASP_AGENTS_ROOT: process.env['ASP_AGENTS_ROOT'],
}

afterEach(() => {
  restoreEnv('ASP_PROJECT', savedEnv.ASP_PROJECT)
  restoreEnv('HRC_SESSION_REF', savedEnv.HRC_SESSION_REF)
  restoreEnv('ASP_AGENTS_ROOT', savedEnv.ASP_AGENTS_ROOT)
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name)
  } else {
    process.env[name] = value
  }
}

// -- Mock infrastructure ------------------------------------------------------

export type MockWatchEvents = HrcLifecycleEvent[]

export function makeHandoff(
  overrides: Partial<SemanticTurnHandoffStartedResponse> = {}
): SemanticTurnHandoffStartedResponse {
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

export function makeLifecycleEvent(
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

export function makeSteerResponse(overrides: Record<string, unknown> = {}): HrcSubmissionResponse {
  return {
    submissionId: 'submission_inv-test_1',
    admission: 'admitted',
    runId: 'run-steer',
    hostSessionId: 'hsid-test',
    runtimeId: 'rt-test',
    generation: 3,
    transport: 'tmux',
    status: 'accepted',
    observation: {
      lifecycle: {
        selector: { runId: 'run-steer', runtimeId: 'rt-test', generation: 3 },
        fromSeq: 500,
      },
    },
    ...overrides,
  } as HrcSubmissionResponse
}

export function createTurnClient(options: {
  handoff?: SemanticTurnHandoffResponse
  events?: MockWatchEvents
  handoffCalls?: SemanticTurnHandoffRequest[]
  /** A warm seat's session row exists; absent means the target was never born. */
  sessionFound?: boolean
  steer?: HrcSubmissionResponse
  steerCalls?: SteerSubmissionRequest[]
  enqueueCalls?: EnqueueSubmissionRequest[]
}): HrcClient {
  const handoffCalls = options.handoffCalls ?? []

  return {
    async resolveSession(request: ResolveSessionRequest): Promise<ResolveSessionResponse> {
      expect(request.create).toBe(false)
      return (
        options.sessionFound === true
          ? { found: true, hostSessionId: 'hsid-test', generation: 3, created: false }
          : { found: false, hostSessionId: null, generation: null, created: false, session: null }
      ) as ResolveSessionResponse
    },
    async steer(request: SteerSubmissionRequest): Promise<HrcSubmissionResponse> {
      options.steerCalls?.push(request)
      return options.steer ?? makeSteerResponse()
    },
    async enqueue(request: EnqueueSubmissionRequest): Promise<HrcSubmissionResponse> {
      options.enqueueCalls?.push(request)
      return makeSteerResponse({ submissionId: 'submission_inv-test_q' })
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

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  error?: Error | undefined
}

export async function runTurnCommand(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[],
  dependencies: TurnCommandDependencies = fakeTurnDependencies()
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
    await cmdTurn(client, { as: 'human', ...opts }, positionals, dependencies)
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

export function fakeTurnDependencies(cleanups?: string[]): TurnCommandDependencies {
  return {
    readTaskState: async () => null,
    createStackedSummarizer() {
      return {
        async summarize() {
          return 'Summarizes the observed test turn.'
        },
        async cleanup() {
          cleanups?.push('cleanup')
        },
      }
    },
  }
}

/** Run timer-driven command behavior without wall time or placement-daemon I/O. */
export async function runClockedTurnCommand(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[],
  dependencies: TurnCommandDependencies = fakeTurnDependencies()
): Promise<CommandResult> {
  const clockedDependencies: TurnCommandDependencies = {
    async resolveLaunchTarget(input) {
      const base = resolveQualifiedScopeInput(input, { projectId: 'agent-spaces' })
      return {
        resolved: {
          ...base,
          projectOrigin: 'explicit',
          placement: {
            agentRoot: '/tmp/turn-fixture/agent',
            projectRoot: '/tmp/turn-fixture/project',
            cwd: '/tmp/turn-fixture/project',
            warnings: [],
            resolution: { source: 'explicit-override', reason: 'in-memory turn fixture' },
          },
        },
        sessionRef: `${base.scopeRef}/lane:${base.laneId}`,
        runtimeIntent: {
          placement: {
            agentRoot: '/tmp/turn-fixture/agent',
            cwd: '/tmp/turn-fixture/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: base.parsed.agentId },
          },
          harness: { interactive: false },
        },
      }
    },
    ...dependencies,
  }
  jest.useFakeTimers()
  jest.setSystemTime(Date.parse('2026-05-13T18:00:00.000Z'))
  try {
    let settled = false
    const pending = runTurnCommand(client, opts, positionals, clockedDependencies)
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    // Drain command/iterator microtasks before advancing to the next timer.
    // The bound also catches a watch or interval that never terminates.
    for (let cycle = 0; cycle < 100 && !settled; cycle++) {
      for (let micro = 0; micro < 100 && !settled; micro++) await Promise.resolve()
      if (!settled && jest.getTimerCount() > 0) jest.advanceTimersToNextTimer()
    }
    expect(settled).toBe(true)
    const result = await pending
    expect(jest.getTimerCount()).toBe(0)
    return result
  } finally {
    jest.clearAllTimers()
    jest.useRealTimers()
  }
}
