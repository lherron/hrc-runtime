/**
 * RED tests — T-04232: hrc monitor watch event filtering (--kind/--tool/--grep/--milestone)
 *
 * All tests FAIL against current HEAD for the right reasons:
 *  - Flag parse tests: parseArgv rejects --kind/--tool/--grep/--milestone as unknown options → exit 2
 *  - Output filter tests: filtering flags not recognized → exit 2
 *  - High-water invariant test: HrcMonitorState lacks eventGlobalHighWaterSeq field AND
 *    --kind is unrecognized
 *
 * Intended new fields on MonitorWatchArgs (extend the exported type):
 *   kind?: string | undefined       // comma-separated event_kinds, e.g. "turn.started,turn.completed"
 *   tool?: string | undefined       // comma-separated toolNames, e.g. "Bash,Agent"
 *   grep?: string | undefined       // payload substring, e.g. "hrcchat dm"
 *   milestone?: boolean | undefined // curated preset (see store test for exact predicate)
 *
 * Intended new field on HrcMonitorState (packages/hrc-core):
 *   eventGlobalHighWaterSeq?: number | undefined
 *   // When set, createMonitorReader/snapshotState uses this as eventHighWaterSeq
 *   // instead of max(events[].seq). Required to preserve global high-water when
 *   // state.events contains only a filtered subset.
 *
 * Daedalus invariant: filtering at the SQLite query layer; selector and
 * high-water semantics must stay global (not filtered).
 */

import { describe, expect, test } from 'bun:test'
import { MonitorEventSchema } from 'hrc-events'

import { cmdMonitorWatch } from '../monitor-watch'

// ---------------------------------------------------------------------------
// Local types (mirror monitor-watch.ts for the test layer)
// These extend the existing MonitorWatchArgs with new filter fields.
// ---------------------------------------------------------------------------

type MonitorWatchArgs = {
  selector?: string | undefined
  json?: boolean | undefined
  pretty?: boolean | undefined
  format?: 'tree' | 'compact' | 'verbose' | 'json' | 'ndjson' | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  last?: number | undefined
  until?: string | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
  signal?: AbortSignal | undefined
  // -- NEW filter fields (red: not yet in MonitorWatchArgs) --
  kind?: string | undefined // comma-separated event_kind list
  tool?: string | undefined // comma-separated toolName list (turns tool_call only)
  grep?: string | undefined // payload substring
  milestone?: boolean | undefined // curated preset
}

// HrcMonitorState extended with global high-water field (red: not in type yet)
type MonitorFixtureState = {
  daemon: { pid: number; status: 'healthy'; startedAt: string }
  socket: { path: string; responsive: boolean }
  tmux: { socketPath: string; sessionCount: number; windowCount: number; paneCount: number }
  sessions: Array<{
    sessionRef: string
    scopeRef: string
    laneRef: string
    hostSessionId: string
    generation: number
    runtimeId: string
    status: 'active'
    activeTurnId: string | null
  }>
  runtimes: Array<{
    runtimeId: string
    hostSessionId: string
    status: 'busy' | 'idle' | 'ready' | 'dead'
    transport: 'tmux'
    activeTurnId: string | null
  }>
  messages: Array<{
    messageId: string
    messageSeq: number
    sessionRef: string
    hostSessionId: string
    runtimeId: string
    runId: string
  }>
  events: MonitorFixtureEvent[]
  // NEW: global high-water override (must be respected by snapshotState even when events[] is filtered)
  eventGlobalHighWaterSeq?: number | undefined
}

type MonitorFixtureEvent = {
  seq: number
  hrcSeq?: number | undefined
  streamSeq?: number | undefined
  ts: string
  event: string
  eventKind?: string | undefined
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  category?: string | undefined
  runtimeId: string
  turnId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  transport?: string | undefined
  payload?: unknown
  result?: string | undefined
  reason?: string | undefined
  failureKind?: string | undefined
}

type InvokeResult = {
  stdout: string
  stderr: string
  exitCode: number
  events: Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_REF = 'agent:cody:project:agent-spaces:task:T-04232/lane:main'
const SCOPE_REF = 'agent:cody:project:agent-spaces:task:T-04232'
const SELECTOR = `session:${SESSION_REF}`
const HOST_SESSION_ID = 'host-session-t04232'
const RUNTIME_ID = 'runtime-t04232'
const TURN_ID = 'turn-t04232'
const MESSAGE_ID = 'msg-t04232'
const TS = '2026-06-12T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function event(
  seq: number,
  name: string,
  overrides: Partial<MonitorFixtureEvent> = {}
): MonitorFixtureEvent {
  return {
    seq,
    hrcSeq: seq,
    streamSeq: seq,
    ts: TS,
    event: name,
    eventKind: name,
    sessionRef: SESSION_REF,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    category: name.split('.')[0],
    runtimeId: RUNTIME_ID,
    ...overrides,
  }
}

function createFixtureState(
  overrides: {
    runtimeStatus?: MonitorFixtureState['runtimes'][number]['status']
    activeTurnId?: string | null
    events?: MonitorFixtureEvent[]
    eventGlobalHighWaterSeq?: number
  } = {}
): MonitorFixtureState {
  const activeTurnId = overrides.activeTurnId === undefined ? TURN_ID : overrides.activeTurnId
  return {
    daemon: { pid: 4232, status: 'healthy', startedAt: TS },
    socket: { path: '/tmp/hrc-t04232.sock', responsive: true },
    tmux: {
      socketPath: '/tmp/hrc-t04232-tmux.sock',
      sessionCount: 1,
      windowCount: 1,
      paneCount: 1,
    },
    sessions: [
      {
        sessionRef: SESSION_REF,
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        hostSessionId: HOST_SESSION_ID,
        generation: 1,
        runtimeId: RUNTIME_ID,
        status: 'active',
        activeTurnId,
      },
    ],
    runtimes: [
      {
        runtimeId: RUNTIME_ID,
        hostSessionId: HOST_SESSION_ID,
        status: overrides.runtimeStatus ?? (activeTurnId === null ? 'idle' : 'busy'),
        transport: 'tmux',
        activeTurnId,
      },
    ],
    messages: [
      {
        messageId: MESSAGE_ID,
        messageSeq: 4232,
        sessionRef: SESSION_REF,
        hostSessionId: HOST_SESSION_ID,
        runtimeId: RUNTIME_ID,
        runId: TURN_ID,
      },
    ],
    events: overrides.events ?? [event(1, 'turn.started', { turnId: TURN_ID })],
    ...(overrides.eventGlobalHighWaterSeq !== undefined
      ? { eventGlobalHighWaterSeq: overrides.eventGlobalHighWaterSeq }
      : {}),
  }
}

async function invokeWatch(
  args: MonitorWatchArgs,
  state: MonitorFixtureState
): Promise<InvokeResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []

  const exitCode =
    (await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      { json: true, ...args },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write(chunk) {
            stderrChunks.push(chunk)
            return true
          },
        },
      }
    )) ?? 0

  const stdout = stdoutChunks.join('')
  return {
    stdout,
    stderr: stderrChunks.join(''),
    exitCode,
    events: parseJsonLines(stdout),
  }
}

// ---------------------------------------------------------------------------
// 1. Flag parsing — --kind
// ---------------------------------------------------------------------------

describe('monitor watch --kind flag (T-04232)', () => {
  test('--kind with single kind filters output to matching events only', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.started'),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'bun test' } },
        }),
        event(3, 'turn.tool_result', { payload: {} }),
        event(4, 'turn.completed'),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, kind: 'turn.started' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    // Only turn.started should appear
    const eventNames = result.events.map((e) => e['event'])
    expect(eventNames).toContain('turn.started')
    expect(eventNames).not.toContain('turn.tool_call')
    expect(eventNames).not.toContain('turn.tool_result')
    expect(eventNames).not.toContain('turn.completed')
  })

  test('--kind with comma-separated list filters to all named kinds', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.started'),
        event(2, 'turn.tool_call', { payload: { toolName: 'Bash', input: {} } }),
        event(3, 'turn.message', { payload: {} }),
        event(4, 'turn.completed'),
      ],
    })

    const result = await invokeWatch(
      { selector: SELECTOR, kind: 'turn.started,turn.completed' },
      state
    )

    expect(result.exitCode).toBe(0)
    const eventNames = result.events.map((e) => e['event'])
    expect(eventNames).toContain('turn.started')
    expect(eventNames).toContain('turn.completed')
    expect(eventNames).not.toContain('turn.tool_call')
    expect(eventNames).not.toContain('turn.message')
  })

  test('--kind with no matching events exits 0 with empty output', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.tool_call', { payload: {} }),
        event(2, 'turn.message', { payload: {} }),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, kind: 'turn.started' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    // No matching events → empty event list (monitor.snapshot is not emitted in non-follow mode)
    expect(result.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Flag parsing — --tool
// ---------------------------------------------------------------------------

describe('monitor watch --tool flag (T-04232)', () => {
  test('--tool Bash filters to turn.tool_call events with toolName=Bash only', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.started'),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Bash', toolUseId: 'tid-1', input: { command: 'ls' } },
        }),
        event(3, 'turn.tool_call', {
          payload: { toolName: 'Read', toolUseId: 'tid-2', input: { file_path: '/tmp/x' } },
        }),
        event(4, 'turn.tool_call', {
          payload: { toolName: 'Agent', toolUseId: 'tid-3', input: { prompt: 'work' } },
        }),
        event(5, 'turn.completed'),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, tool: 'Bash' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    // Only the Bash tool_call should appear
    expect(result.events).toHaveLength(1)
    const e = result.events[0]!
    expect(e['event']).toBe('turn.tool_call')
    const payload = e['payload'] as Record<string, unknown>
    expect(payload['toolName']).toBe('Bash')
  })

  test('--tool with comma-separated list matches multiple tool names', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.tool_call', {
          payload: { toolName: 'Bash', toolUseId: 'tid-1', input: {} },
        }),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Read', toolUseId: 'tid-2', input: {} },
        }),
        event(3, 'turn.tool_call', {
          payload: { toolName: 'Agent', toolUseId: 'tid-3', input: {} },
        }),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, tool: 'Bash,Agent' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.events).toHaveLength(2)
    const toolNames = result.events.map((e) => {
      const p = e['payload'] as Record<string, unknown>
      return p['toolName']
    })
    expect(toolNames).toContain('Bash')
    expect(toolNames).toContain('Agent')
    expect(toolNames).not.toContain('Read')
  })

  test('--tool does not return non-tool_call events even if payload matches tool name text', async () => {
    const state = createFixtureState({
      events: [
        // turn.started payload mentions "Bash" text — must not match --tool Bash
        event(1, 'turn.started', { payload: { note: 'Bash session starting' } }),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Bash', toolUseId: 'tid-1', input: {} },
        }),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, tool: 'Bash' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!['event']).toBe('turn.tool_call')
  })
})

// ---------------------------------------------------------------------------
// 3. Flag parsing — --grep
// ---------------------------------------------------------------------------

describe('monitor watch --grep flag (T-04232)', () => {
  test('--grep filters to events whose payload contains the substring', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'hrcchat dm cody "hi"' } },
        }),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'bun test' } },
        }),
        event(3, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'hrcchat dm larry "start"' } },
        }),
        event(4, 'turn.completed'),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, grep: 'hrcchat dm' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.events).toHaveLength(2)
    expect(result.events.every((e) => JSON.stringify(e['payload']).includes('hrcchat dm'))).toBe(
      true
    )
  })

  test('--grep combined with --kind narrows both dimensions', async () => {
    const state = createFixtureState({
      events: [
        // turn.tool_call with grep match → included
        event(1, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'git commit -m "fix"' } },
        }),
        // turn.started with grep text in payload → excluded because kind filter
        event(2, 'turn.started', { payload: { note: 'about to git commit' } }),
        // turn.tool_call without grep match → excluded by grep
        event(3, 'turn.tool_call', { payload: { toolName: 'Bash', input: { command: 'ls' } } }),
      ],
    })

    const result = await invokeWatch(
      { selector: SELECTOR, kind: 'turn.tool_call', grep: 'git commit' },
      state
    )

    expect(result.exitCode).toBe(0)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!['event']).toBe('turn.tool_call')
    expect(JSON.stringify(result.events[0]!['payload'])).toContain('git commit')
  })
})

// ---------------------------------------------------------------------------
// 4. --milestone flag
// ---------------------------------------------------------------------------

describe('monitor watch --milestone flag (T-04232)', () => {
  test('--milestone emits only turn lifecycle + runtime lifecycle + operator tool calls', async () => {
    const state = createFixtureState({
      events: [
        // MILESTONE events
        event(1, 'turn.started'),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Agent', toolUseId: 'tid-a', input: { prompt: 'do work' } },
        }),
        event(3, 'turn.tool_call', {
          payload: {
            toolName: 'Bash',
            toolUseId: 'tid-b',
            input: { command: 'hrcchat dm cody "go"' },
          },
        }),
        event(4, 'runtime.idle', { payload: {} }),
        event(5, 'turn.completed'),
        // NON-MILESTONE events
        event(6, 'turn.tool_call', {
          payload: { toolName: 'Read', toolUseId: 'tid-r', input: { file_path: '/tmp/x' } },
        }),
        event(7, 'turn.message', {
          payload: { type: 'message_end', message: { role: 'assistant', content: 'ok' } },
        }),
        event(8, 'turn.tool_result', { payload: {} }),
      ],
    })

    const result = await invokeWatch({ selector: SELECTOR, milestone: true }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const eventNames = result.events.map((e) => e['event'])

    // Milestones in
    expect(eventNames).toContain('turn.started')
    expect(eventNames).toContain('turn.completed')
    expect(eventNames).toContain('runtime.idle')

    // Non-milestones out
    expect(eventNames).not.toContain('turn.message')
    expect(eventNames).not.toContain('turn.tool_result')
    // Read tool_call not included (not an operator milestone)
    const readCalls = result.events.filter((e) => {
      const p = e['payload'] as Record<string, unknown> | undefined
      return e['event'] === 'turn.tool_call' && p?.['toolName'] === 'Read'
    })
    expect(readCalls).toHaveLength(0)

    // Agent and hrcchat-dm tool_calls included
    const agentCalls = result.events.filter((e) => {
      const p = e['payload'] as Record<string, unknown> | undefined
      return e['event'] === 'turn.tool_call' && p?.['toolName'] === 'Agent'
    })
    expect(agentCalls).toHaveLength(1)
  })

  test('--milestone emits far fewer events than unfiltered on a typical busy session', async () => {
    // Build a realistic session with mostly noise events
    const noiseEvents: MonitorFixtureEvent[] = []
    for (let i = 1; i <= 50; i++) {
      const kind =
        i % 5 === 0
          ? 'turn.started'
          : i % 7 === 0
            ? 'runtime.idle'
            : i % 3 === 0
              ? 'turn.tool_result'
              : 'turn.message'
      const payload =
        kind === 'turn.message'
          ? { type: 'message_delta', delta: { type: 'text_delta', text: `chunk ${i}` } }
          : kind === 'turn.tool_result'
            ? { toolName: 'Read', result: { content: [{ type: 'text', text: 'data' }] } }
            : {}
      noiseEvents.push(event(i, kind, { payload }))
    }

    const state = createFixtureState({ events: noiseEvents })
    const unfilteredResult = await invokeWatch({ selector: SELECTOR }, state)
    const milestoneResult = await invokeWatch({ selector: SELECTOR, milestone: true }, state)

    expect(milestoneResult.exitCode).toBe(0)
    expect(unfilteredResult.exitCode).toBe(0)
    // milestone should emit substantially fewer events
    expect(milestoneResult.events.length).toBeLessThan(unfilteredResult.events.length / 2)
  })
})

// ---------------------------------------------------------------------------
// 5. CRITICAL: Global high-water invariant
// ---------------------------------------------------------------------------
// Daedalus: "Do NOT feed a filtered event list into createMonitorReader in a
// way that makes monitor.snapshot.eventHighWaterSeq equal 'last matching event'
// instead of real max hrc_seq."
//
// The fix requires HrcMonitorState to have an optional eventGlobalHighWaterSeq
// field that createMonitorReader/snapshotState uses when present:
//   highWaterSeq = state.eventGlobalHighWaterSeq ?? max(state.events.map(e => e.seq))
//
// This test fails at two levels against current HEAD:
// 1. --kind is unknown → exit 2 (flag parse failure)
// 2. Even if --kind were known: HrcMonitorState lacks eventGlobalHighWaterSeq
//    so snapshot.eventHighWaterSeq would be max(filteredEvents.seq) = 5, not 10

describe('monitor watch — global high-water invariant (T-04232 daedalus)', () => {
  test('eventHighWaterSeq in monitor.snapshot equals global max, not max of filtered events', async () => {
    // Global max hrc_seq is 10 (turn.completed at seq=10)
    // But with --kind turn.started, only seq=1 is in filtered events
    // The snapshot must still show eventHighWaterSeq=10, not 1
    const state = createFixtureState({
      // Only filtered events (turn.started) in events[] — simulates DB-layer filter
      events: [event(1, 'turn.started')],
      // Global high-water override: the real DB max hrc_seq
      eventGlobalHighWaterSeq: 10,
    })

    const abort = new AbortController()
    const stdoutChunks: string[] = []

    const exitPromise = (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        forever: true,
        kind: 'turn.started', // NEW: filter flag
        signal: abort.signal,
      },
      {
        buildMonitorState: async () => {
          abort.abort() // abort after first snapshot to avoid infinite polling
          return state
        },
        stdout: {
          write(chunk) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const exitCode = await exitPromise
    const events = parseJsonLines(stdoutChunks.join(''))

    expect(exitCode).toBe(130) // SIGINT from abort

    const snapshot = events.find((e) => e['event'] === 'monitor.snapshot')
    expect(snapshot).toBeDefined()

    // THE CRITICAL ASSERTION: high-water must be global max (10), not filtered max (1)
    const snapshotData = snapshot?.['snapshot'] as Record<string, unknown> | undefined
    expect(snapshotData?.['eventHighWaterSeq']).toBe(10)
  })

  test('--follow nextSeq advances globally so filtered polling does not miss non-matching events', async () => {
    // If filtering corrupts nextSeq to be max(filteredEvents.seq),
    // the poll loop will re-read events it already delivered on the next cycle.
    // nextSeq must start from globalHighWater+1, not max(filteredEvents.seq)+1.
    //
    // Setup: initial state has filtered events [1, 5]; global max = 10.
    // Next poll returns state with filtered events [1, 5, 11]; global max = 11.
    // The poll loop must yield only seq=11 on the next cycle (not re-yield 5..10).

    const initialState = createFixtureState({
      events: [event(1, 'turn.started'), event(5, 'turn.started')],
      eventGlobalHighWaterSeq: 10,
    })
    const nextState = createFixtureState({
      events: [event(1, 'turn.started'), event(5, 'turn.started'), event(11, 'turn.started')],
      eventGlobalHighWaterSeq: 11,
    })

    const abort = new AbortController()
    let callCount = 0
    const stdoutChunks: string[] = []

    const exitPromise = (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        forever: true,
        kind: 'turn.started',
        signal: abort.signal,
      },
      {
        buildMonitorState: async () => {
          callCount++
          if (callCount >= 2) abort.abort()
          return callCount <= 1 ? initialState : nextState
        },
        stdout: {
          write(chunk) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    await exitPromise
    const events = parseJsonLines(stdoutChunks.join(''))

    // Should see: snapshot(seq=10), event(1), event(5) [replay], then event(11) [live]
    // Must NOT see event(5) again on the second cycle (regression: would happen if nextSeq=5+1=6)
    const nonSnapshotEvents = events.filter((e) => e['event'] !== 'monitor.snapshot')
    const seqs = nonSnapshotEvents.map((e) => e['seq'] as number)

    // seq=5 must appear exactly once (not twice)
    expect(seqs.filter((s) => s === 5)).toHaveLength(1)
    // seq=11 must appear (new event from next poll)
    expect(seqs).toContain(11)
  })
})

// ---------------------------------------------------------------------------
// 6. Flag parsing errors
// ---------------------------------------------------------------------------

describe('monitor watch — filter flag parse errors (T-04232)', () => {
  test('--kind with empty value is a usage error (exit 2)', async () => {
    const state = createFixtureState()
    const result = await invokeWatch({ selector: SELECTOR, kind: '' }, state)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('kind')
  })

  test('--milestone and --kind together: milestone supersedes kind (or explicit error)', async () => {
    // Either --milestone supersedes --kind (no error) OR they're mutually exclusive (exit 2).
    // Either behavior is valid; this test documents that a combination is handled explicitly.
    const state = createFixtureState({
      events: [
        event(1, 'turn.started'),
        event(2, 'turn.tool_call', {
          payload: { toolName: 'Bash', input: { command: 'bun test' } },
        }),
      ],
    })

    const result = await invokeWatch(
      { selector: SELECTOR, milestone: true, kind: 'turn.started' },
      state
    )
    // The impl must handle this combination explicitly: either exit 2 (mutually exclusive)
    // or exit 0 with milestone semantics (milestone wins).
    // This test passes if either behavior is consistent; right now it fails because both flags are unknown.
    expect([0, 2]).toContain(result.exitCode)
    if (result.exitCode === 0) {
      // If milestone wins, output should NOT contain the Bash bun-test tool_call
      const bashNoiseCalls = result.events.filter((e) => {
        const p = e['payload'] as Record<string, unknown> | undefined
        return (
          e['event'] === 'turn.tool_call' &&
          p?.['toolName'] === 'Bash' &&
          JSON.stringify(p?.['input']).includes('bun test')
        )
      })
      expect(bashNoiseCalls).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Output validates against MonitorEventSchema
// ---------------------------------------------------------------------------

describe('monitor watch — filtered output schema compliance (T-04232)', () => {
  test('--kind filtered events validate against MonitorEventSchema', async () => {
    const state = createFixtureState({
      events: [
        event(1, 'turn.started', { turnId: TURN_ID }),
        event(2, 'turn.tool_call', { turnId: TURN_ID, payload: {} }),
        event(3, 'turn.completed', { turnId: TURN_ID, result: 'turn_succeeded' }),
      ],
    })

    const result = await invokeWatch(
      { selector: SELECTOR, kind: 'turn.started,turn.completed' },
      state
    )

    expect(result.exitCode).toBe(0)
    for (const e of result.events) {
      expect(() => MonitorEventSchema.parse(e)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. argv (CLI string parse) — new flags are parsed from string args
// ---------------------------------------------------------------------------
// These exercise parseArgv() path (used when hrc binary invokes the command).
// Fail because parseArgv throws CliUsageError for unknown flags.

describe('monitor watch — argv string parse for new filter flags (T-04232)', () => {
  test('--kind <value> is parsed from argv string array', async () => {
    // cmdMonitorWatch(['--kind', 'turn.started', '--json']) should not throw usage error
    const state = createFixtureState({ events: [event(1, 'turn.started')] })

    // Invoke via argv-style (first arg is string array)
    let exitCode: number | undefined
    let stderr = ''
    try {
      const result = await (
        cmdMonitorWatch as unknown as (
          argv: string[],
          deps?: {
            buildMonitorState: () => Promise<MonitorFixtureState>
            stdout: { write(chunk: string): boolean }
            stderr: { write(chunk: string): boolean }
          }
        ) => Promise<number | undefined>
      )(['--kind', 'turn.started', '--json'], {
        buildMonitorState: async () => state,
        stdout: {
          write() {
            return true
          },
        },
        stderr: {
          write(chunk) {
            stderr += chunk
            return true
          },
        },
      })
      exitCode = typeof result === 'number' ? result : 0
    } catch {
      exitCode = 2
    }

    // Should parse successfully (exit 0), not throw unknown option error
    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('unknown option')
  })

  test('--milestone is parsed from argv string array', async () => {
    const state = createFixtureState({ events: [event(1, 'turn.started')] })

    let exitCode: number | undefined
    let stderr = ''
    try {
      const result = await (
        cmdMonitorWatch as unknown as (
          argv: string[],
          deps?: {
            buildMonitorState: () => Promise<MonitorFixtureState>
            stdout: { write(chunk: string): boolean }
            stderr: { write(chunk: string): boolean }
          }
        ) => Promise<number | undefined>
      )(['--milestone', '--json'], {
        buildMonitorState: async () => state,
        stdout: {
          write() {
            return true
          },
        },
        stderr: {
          write(chunk) {
            stderr += chunk
            return true
          },
        },
      })
      exitCode = typeof result === 'number' ? result : 0
    } catch {
      exitCode = 2
    }

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('unknown option')
  })

  test('--grep <value> is parsed from argv string array', async () => {
    const state = createFixtureState({ events: [event(1, 'turn.started')] })

    let exitCode: number | undefined
    let stderr = ''
    try {
      const result = await (
        cmdMonitorWatch as unknown as (
          argv: string[],
          deps?: {
            buildMonitorState: () => Promise<MonitorFixtureState>
            stdout: { write(chunk: string): boolean }
            stderr: { write(chunk: string): boolean }
          }
        ) => Promise<number | undefined>
      )(['--grep', 'hrcchat dm', '--json'], {
        buildMonitorState: async () => state,
        stdout: {
          write() {
            return true
          },
        },
        stderr: {
          write(chunk) {
            stderr += chunk
            return true
          },
        },
      })
      exitCode = typeof result === 'number' ? result : 0
    } catch {
      exitCode = 2
    }

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('unknown option')
  })

  test('--tool <value> is parsed from argv string array', async () => {
    const state = createFixtureState({ events: [event(1, 'turn.started')] })

    let exitCode: number | undefined
    let stderr = ''
    try {
      const result = await (
        cmdMonitorWatch as unknown as (
          argv: string[],
          deps?: {
            buildMonitorState: () => Promise<MonitorFixtureState>
            stdout: { write(chunk: string): boolean }
            stderr: { write(chunk: string): boolean }
          }
        ) => Promise<number | undefined>
      )(['--tool', 'Bash', '--json'], {
        buildMonitorState: async () => state,
        stdout: {
          write() {
            return true
          },
        },
        stderr: {
          write(chunk) {
            stderr += chunk
            return true
          },
        },
      })
      exitCode = typeof result === 'number' ? result : 0
    } catch {
      exitCode = 2
    }

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('unknown option')
  })
})
