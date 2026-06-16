/**
 * T-04733 characterization tests — pin the DIVERGENT isTurnEnd semantics
 * so the upcoming rename to two distinct names is provably behavior-preserving.
 *
 * Two predicates share the name `isTurnEnd` but have DIFFERENT semantics:
 *
 *   stacked-aggregator.ts:isTurnEnd = `turn.completed` ONLY
 *     Used inside `receive()` to trigger a terminal Final flush.
 *     A bare `turn_end` falls through as a progress event — aggregator stays open.
 *
 *   commands/turn.ts:isTurnEnd       = `turn_end || turn.completed`
 *     Used in the watch-loop to break on either event (and gate enrichFinalEvent).
 *
 * The key invariant: `[permission_request, turn_end]` on the stacked path MUST
 * end with phase:permission / exitCode:5. If the aggregator predicate were widened
 * to match `turn_end`, the turn_end would emit a premature phase:final frame,
 * overwriting the permission terminal and producing exit 0 — wrong.
 *
 * These tests pass GREEN on `refactor-work` (no source changes).
 * They will continue to pass GREEN after the rename (semantics unchanged).
 *
 * Run:
 *   cd ~/praesidium/hrc-runtime && bun test packages/hrcchat-cli/src/__tests__/t04733-char-isturnend.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent, SemanticTurnHandoffResponse } from 'hrc-core'
import type { HrcClient, WatchOptions } from 'hrc-sdk'

import { TurnExitError, type TurnOptions, cmdTurn } from '../commands/turn.js'

// ── Shared env save/restore ───────────────────────────────────────────────────

const savedEnv = {
  ASP_PROJECT: process.env['ASP_PROJECT'],
  HRC_SESSION_REF: process.env['HRC_SESSION_REF'],
}

function restoreEnv(): void {
  if (savedEnv.ASP_PROJECT === undefined) {
    Reflect.deleteProperty(process.env, 'ASP_PROJECT')
  } else {
    process.env['ASP_PROJECT'] = savedEnv.ASP_PROJECT
  }
  if (savedEnv.HRC_SESSION_REF === undefined) {
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
  } else {
    process.env['HRC_SESSION_REF'] = savedEnv.HRC_SESSION_REF
  }
}

afterEach(restoreEnv)

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1 — Aggregator-level harness
// ═══════════════════════════════════════════════════════════════════════════════

class FakeClock {
  nowMs = Date.parse('2026-05-13T18:00:00.000Z')
  private nextHandle = 1
  private timers = new Map<number, { at: number; callback: () => void }>()

  now = (): number => this.nowMs

  setTimeout = (callback: () => void, ms: number): number => {
    const handle = this.nextHandle++
    this.timers.set(handle, { at: this.nowMs + ms, callback })
    return handle
  }

  clearTimeout = (handle: number): void => {
    this.timers.delete(handle)
  }
}

function makeAggHandoff(
  overrides: Partial<SemanticTurnHandoffResponse> = {}
): SemanticTurnHandoffResponse {
  return {
    messageId: 'msg-t04733',
    sessionRef: 'agent:larry:project:agent-spaces:task:T-01449/lane:main',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01449',
    laneRef: 'main',
    hostSessionId: 'hsid-test',
    runtimeId: 'rt-test',
    runId: 'run-test',
    generation: 1,
    fromSeq: 10,
    ...overrides,
  }
}

function aggEvent(
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

async function makeAggregator() {
  const clock = new FakeClock()
  const lines: Array<Record<string, unknown>> = []
  const { createStackedAggregator } = await import('../stacked-aggregator.js')
  const aggregator = createStackedAggregator({
    windowMs: 1_000,
    stallAfterMs: 30_000,
    targetScope: 'larry@agent-spaces:T-01449',
    handoff: makeAggHandoff(),
    summarizer: { summarize: async () => 'test summary' },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    readTaskState: async () => null,
    writeLine(line: unknown) {
      lines.push(line as Record<string, unknown>)
    },
  })
  aggregator.start()
  return { aggregator, lines, clock }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2 — Watch-loop harness (integration via cmdTurn)
// ═══════════════════════════════════════════════════════════════════════════════

function makeWlHandoff(
  overrides: Partial<SemanticTurnHandoffResponse> = {}
): SemanticTurnHandoffResponse {
  return {
    messageId: 'msg-wl-t04733',
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

function wlEvent(
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

function makeWlClient(
  events: HrcLifecycleEvent[],
  handoff?: SemanticTurnHandoffResponse
): HrcClient {
  return {
    async getTarget() {
      return {
        sessionRef: 'agent:cody:project:agent-spaces/lane:main',
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
        state: 'active',
        activeHostSessionId: 'hsid-test',
        generation: 1,
      }
    },
    async clearContext(req: { hostSessionId: string }) {
      return {
        hostSessionId: req.hostSessionId,
        generation: 2,
        priorHostSessionId: req.hostSessionId,
      }
    },
    async semanticTurnHandoff() {
      return handoff ?? makeWlHandoff()
    },
    async *watch(_opts?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
      for (const event of events) {
        yield event
      }
    },
  } as HrcClient
}

async function runTurn(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  const origOut = process.stdout.write
  const origErr = process.stderr.write
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

  try {
    await cmdTurn(client, opts, positionals)
  } catch (err) {
    if (err instanceof TurnExitError) {
      exitCode = err.exitCode
    } else {
      exitCode = 1
    }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }

  return { exitCode, stdout, stderr }
}

function parseStackedLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['type'] === 'turn_stacked')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests — Group 1: stacked-aggregator isTurnEnd = turn.completed ONLY
// ═══════════════════════════════════════════════════════════════════════════════

describe('T-04733 char: stacked-aggregator isTurnEnd = turn.completed ONLY', () => {
  it('bare turn_end does NOT emit any line (aggregator ignores it; falls through as progress)', async () => {
    const { aggregator, lines } = await makeAggregator()

    await aggregator.receive(aggEvent(11, 'turn_end'))

    // The aggregator's isTurnEnd predicate is `turn.completed` ONLY.
    // turn_end hits none of the early-return branches and is absorbed as a
    // regular event (Queued → Progress phase transition).  No line is written.
    expect(lines).toHaveLength(0)

    await aggregator.close()
    // close() merely sets closed=true and clears timers — still no line
    expect(lines).toHaveLength(0)
  })

  it('turn.completed DOES emit a terminal final flush (contrast with turn_end)', async () => {
    const { aggregator, lines } = await makeAggregator()

    await aggregator.receive(aggEvent(11, 'turn.completed', { body: 'done' }))

    // turn.completed matches the aggregator's isTurnEnd → forceFlush(Final, terminal)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      flush: 'final',
      phase: 'final',
      exitCode: 0,
      result: 'success',
    })
  })

  it('permission_request + turn_end: permission flush emitted; turn_end does NOT add a second line', async () => {
    const { aggregator, lines } = await makeAggregator()

    await aggregator.receive(
      aggEvent(11, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/example' },
      })
    )
    // permission_request → forceFlush(Permission) — one non-terminal line
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ flush: 'permission', phase: 'permission' })

    await aggregator.receive(aggEvent(12, 'turn_end'))

    // turn_end does NOT match aggregator's isTurnEnd → no terminal Final flush emitted.
    // The aggregator is still open (closed === false).
    expect(lines).toHaveLength(1) // still exactly one line, the permission flush
  })

  it('[permission_request, turn_end] + finish(permission): correct two-frame output, no stray final', async () => {
    // Simulates the full finalizeTurn(aggregator, 'permission') path from commands/turn.ts.
    // The watch-loop breaks on turn_end, then the post-loop `lastPhase === permission` arm
    // calls finalizeTurn → aggregator.finish({ phase:'permission', flush:'permission', exitCode:5 }).
    const { aggregator, lines } = await makeAggregator()

    await aggregator.receive(
      aggEvent(11, 'permission_request', {
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/example' },
      })
    )
    await aggregator.receive(aggEvent(12, 'turn_end'))

    // Simulate the TERMINALS.permission finish call from finalizeTurn
    await aggregator.finish({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phase: 'permission' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flush: 'permission' as any,
      exitCode: 5,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: 'permission_blocked' as any,
    })

    // Exactly two frames: the force-flush from permission_request, then the
    // terminal frame from finish().  No 'final' phase frame anywhere.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ flush: 'permission', phase: 'permission' })
    expect(lines[1]).toMatchObject({
      flush: 'permission',
      phase: 'permission',
      result: 'permission_blocked',
      exitCode: 5,
    })
    // Critical: a widened aggregator predicate (turn_end || turn.completed) would
    // have emitted a phase:final/exitCode:0 frame AFTER turn_end above, leaving
    // the aggregator closed so finish() would be a no-op — breaking exit code.
    const hasFinalPhase = lines.some((l) => l['phase'] === 'final')
    expect(hasFinalPhase).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Tests — Group 2: watch-loop isTurnEnd = turn_end || turn.completed
// ═══════════════════════════════════════════════════════════════════════════════

describe('T-04733 char: watch-loop isTurnEnd = turn_end || turn.completed', () => {
  let savedAspAgentsRoot: string | undefined

  beforeEach(() => {
    savedAspAgentsRoot = process.env['ASP_AGENTS_ROOT']
  })

  afterEach(() => {
    if (savedAspAgentsRoot === undefined) {
      Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
    } else {
      process.env['ASP_AGENTS_ROOT'] = savedAspAgentsRoot
    }
  })

  it('bare turn_end terminates the watch loop with exitCode 0 (non-stacked)', async () => {
    // Non-stacked path: watch-loop's isTurnEnd matches turn_end → turnCompleted=true → exit 0
    const client = makeWlClient([wlEvent({ eventKind: 'turn_end', hrcSeq: 10 })])

    const result = await runTurn(client, {} as TurnOptions, ['cody@agent-spaces', 'hello'])

    expect(result.exitCode).toBe(0)
  })

  it('[turn_end] in stacked mode: watch-loop breaks → success arm → final stacked frame emitted', async () => {
    // The watch-loop's broad isTurnEnd (turn_end || turn.completed) breaks the loop on turn_end.
    // Post-loop: turnCompleted=true AND lastPhase≠permission/error → finalizeTurn('success')
    // → aggregator.finish({phase:final, flush:final, exitCode:0}) → final stacked frame.
    //
    // Note: the aggregator itself did NOT emit this frame from receive(turn_end) — it was
    // the watch-loop break + success arm that triggered it.
    const client = makeWlClient([wlEvent({ eventKind: 'turn_end', hrcSeq: 10 })])

    const result = await runTurn(
      client,
      { stacked: '1s' } as TurnOptions,
      ['cody@agent-spaces', 'hello']
    )

    expect(result.exitCode).toBe(0)
    const lines = parseStackedLines(result.stdout)
    expect(lines.at(-1)).toMatchObject({
      phase: 'final',
      flush: 'final',
      result: 'success',
      exitCode: 0,
    })
  })

  it('[permission_request, turn_end] stacked: permission exit wins (exitCode 5, phase:permission, no phase:final)', async () => {
    // This is the key cross-predicate interaction that proves both semantics together:
    //
    //   1. permission_request → aggregator.receive() force-flushes {flush:'permission'} (non-terminal)
    //   2. turn_end → watch-loop isTurnEnd=TRUE → loop breaks (turnCompleted=true)
    //                  aggregator.receive(turn_end) → isTurnEnd=FALSE → no terminal flush
    //   3. post-loop: lastPhase='permission' → finalizeTurn('permission')
    //                  → aggregator.finish({phase:'permission', flush:'permission', exitCode:5})
    //                  → terminal {flush:'permission', result:'permission_blocked', exitCode:5}
    //                  → throws TurnExitError(5)
    //
    // If the aggregator's predicate were widened to turn_end || turn.completed, step 2 would
    // emit a terminal {phase:'final', exitCode:0}, close the aggregator, and finish() would
    // be a no-op → wrong exit code, wrong terminal frame.
    const client = makeWlClient([
      wlEvent({
        eventKind: 'permission_request',
        hrcSeq: 10,
        payload: {
          requestId: 'perm-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          toolInput: { command: 'rm -rf /tmp/example' },
        },
      }),
      wlEvent({ eventKind: 'turn_end', hrcSeq: 11 }),
    ])

    const result = await runTurn(
      client,
      { stacked: '1s' } as TurnOptions,
      ['cody@agent-spaces', 'hello']
    )

    expect(result.exitCode).toBe(5)

    const lines = parseStackedLines(result.stdout)
    // Terminal frame is permission-flavoured, not final
    expect(lines.at(-1)).toMatchObject({
      phase: 'permission',
      flush: 'permission',
      result: 'permission_blocked',
      exitCode: 5,
    })

    // Critically: no phase:final frame exists in the output.
    // A widened aggregator predicate would have emitted one on turn_end receipt.
    const hasFinalPhase = lines.some((l) => l['phase'] === 'final')
    expect(hasFinalPhase).toBe(false)
  })
})
