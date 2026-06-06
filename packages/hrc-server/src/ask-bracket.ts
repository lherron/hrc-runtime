/**
 * Ask-user bracket authority (T-01946).
 *
 * A turn parked on a user prompt (claude-code `AskUserQuestion`; codex
 * `request_user_input`) emits NO closing event while it waits for the human, so
 * the event-silence staleness clock would reap a perfectly live, parked TUI. The
 * fix models "awaiting user input" as a first-class state whose AUTHORITY is the
 * durable, broker-seq-ordered ask bracket recorded in `broker_invocation_events`
 * — NOT the `awaiting_input` runtime status (a projection / fast path) and NEVER
 * tmux pane liveness (which can't distinguish awaiting-input from mid-compute).
 *
 * A "bracket" is the matched pair of broker events that share one `toolCallId`:
 * a `tool.call.started` opens it and the matching `tool.call.completed` /
 * `tool.call.failed` closes it. An ask bracket is OPEN for a run when, in broker
 * seq order, there is a `tool.call.started` for an ask tool with no later
 * matching close AND no later same-run terminal turn event. This module is the
 * single place that predicate lives, consulted by both the broker event mapper
 * (live open/close detection + restart re-derivation) and the HRC reaper / zombie
 * sweep (non-reapable guard).
 */
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

/**
 * The harness tool names that block a turn on operator input. Both ride the
 * generic broker tool-call bracket (there is no dedicated broker event type, and
 * no `permission.*` event); the broker mapper projects them as ordinary
 * `turn.tool_call` / `turn.tool_result` and this module layers awaiting-input on
 * top of the same bracket.
 */
export const ASK_USER_TOOL_NAMES = ['AskUserQuestion', 'request_user_input'] as const

const ASK_TOOL_SET: ReadonlySet<string> = new Set(ASK_USER_TOOL_NAMES)

export function isAskUserTool(toolName: string | undefined): boolean {
  return toolName !== undefined && ASK_TOOL_SET.has(toolName)
}

/**
 * Stable composite identity for an ask bracket. Bare `toolCallId` is not enough:
 * a re-ask gets a fresh `toolCallId`, and a harness retry re-runs a turn under a
 * new `(harnessGeneration, turnAttempt)`. Mirrors `permissionIdentityKey` in the
 * event mapper.
 */
export function askBracketIdentityKey(input: {
  invocationId: string
  runId?: string | undefined
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  toolCallId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.runId ?? null,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.toolCallId,
  ])
}

/** SQL `IN (...)` placeholders + params for the ask-tool name filter. */
function askToolInClause(): { sql: string; params: string[] } {
  return {
    sql: ASK_USER_TOOL_NAMES.map(() => '?').join(', '),
    params: [...ASK_USER_TOOL_NAMES],
  }
}

/**
 * A `tool.call.completed` / `tool.call.failed` only CLOSES an opening
 * `tool.call.started` (aliased `st`) when it shares the SAME composite identity:
 * run, harness generation, turn attempt AND toolCallId (T-01946). A toolCallId
 * reused under a different run / generation / attempt must NOT close this bracket.
 * SQLite `IS` is null-safe equality (`NULL IS NULL` => true), so brackets whose
 * identity fields are all null still pair correctly, while a populated-vs-null
 * mismatch does not. `harness_generation` / `turn_attempt` are the envelope-level
 * identity columns persisted by migration 0022.
 */
const ASK_BRACKET_CLOSE_NOT_EXISTS = `
  NOT EXISTS (
    SELECT 1 FROM broker_invocation_events cl
     WHERE cl.invocation_id = st.invocation_id
       AND cl.seq > st.seq
       AND cl.type IN ('tool.call.completed', 'tool.call.failed')
       AND cl.run_id IS st.run_id
       AND cl.harness_generation IS st.harness_generation
       AND cl.turn_attempt IS st.turn_attempt
       AND json_extract(cl.broker_event_json, '$.toolCallId')
           IS json_extract(st.broker_event_json, '$.toolCallId')
  )`

/**
 * A same-run terminal turn event clears every open ask bracket for that run. This
 * clause is INTENTIONALLY run-scoped (`run_id`, null-safe `IS`), NOT composite:
 * a terminal ENDS turn ownership regardless of generation/attempt, so a later
 * `turn.completed|failed|interrupted` for the run must close brackets even if it
 * carried a different generation/attempt than the opening `tool.call.started`. Do
 * NOT "fix" this to composite identity — that would leave stale brackets open
 * forever after such a terminal, making the run look permanently awaiting
 * (daedalus ruling, T-01946).
 */
const ASK_BRACKET_TERMINAL_NOT_EXISTS = `
  NOT EXISTS (
    SELECT 1 FROM broker_invocation_events tm
     WHERE tm.invocation_id = st.invocation_id
       AND tm.run_id IS st.run_id
       AND tm.seq > st.seq
       AND tm.type IN ('turn.completed', 'turn.failed', 'turn.interrupted')
  )`

/**
 * AUTHORITY predicate: does `runId` have an open ask bracket within `invocationId`,
 * judged purely from the durable broker event ledger ordered by broker seq?
 *
 * An ask bracket is open when there exists a `tool.call.started` for an ask tool
 * (this run) with:
 *  - no later `tool.call.completed` / `tool.call.failed` sharing its FULL composite
 *    identity (run, harnessGeneration, turnAttempt, toolCallId), and
 *  - no later same-run terminal turn event (`turn.completed|failed|interrupted`).
 *
 * Seq comparisons (not arrival order, not wall-clock) define "later", so this is
 * robust to out-of-seq projection and survives daemon restart for free (the rows
 * are persisted). Filtering on `invocation_id` (indexed) before the `json_extract`
 * keeps the scan bounded to one invocation's events.
 */
export function hasOpenAskBracket(db: HrcDatabase, invocationId: string, runId: string): boolean {
  const asks = askToolInClause()
  const row = db.sqlite
    .query<{ one: number }, [string, string, ...string[]]>(
      `
        SELECT 1 AS one
          FROM broker_invocation_events st
         WHERE st.invocation_id = ?
           AND st.run_id = ?
           AND st.type = 'tool.call.started'
           AND json_extract(st.broker_event_json, '$.name') IN (${asks.sql})
           AND ${ASK_BRACKET_CLOSE_NOT_EXISTS}
           AND ${ASK_BRACKET_TERMINAL_NOT_EXISTS}
         LIMIT 1
      `
    )
    .get(invocationId, runId, ...asks.params)
  return row !== null && row !== undefined
}

/** True if the runtime's current invocation has an open ask bracket for `runId`. */
export function runtimeHasOpenAskBracket(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  runId: string
): boolean {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) return false
  return hasOpenAskBracket(db, invocationId, runId)
}

export type OpenAskBracket = {
  invocationId: string
  runId: string | null
  toolCallId: string | null
  toolName: string | null
  harnessGeneration: number | null
  turnAttempt: number | null
  seq: number
}

/**
 * Identity of every currently-open ask bracket on the runtime's active
 * invocation, regardless of run. Used to surface a corrupt `awaiting_input`
 * runtime (status set but no `activeRunId`) with enough detail to act on it, and
 * to decide in `markRuntimeTurnTerminal` whether ANY bracket still bars `ready`.
 */
export function listOpenAskBrackets(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): OpenAskBracket[] {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) return []
  const asks = askToolInClause()
  const rows = db.sqlite
    .query<
      {
        runId: string | null
        toolCallId: string | null
        toolName: string | null
        harnessGeneration: number | null
        turnAttempt: number | null
        seq: number
      },
      [string, ...string[]]
    >(
      `
        SELECT st.run_id AS runId,
               json_extract(st.broker_event_json, '$.toolCallId') AS toolCallId,
               json_extract(st.broker_event_json, '$.name') AS toolName,
               st.harness_generation AS harnessGeneration,
               st.turn_attempt AS turnAttempt,
               st.seq AS seq
          FROM broker_invocation_events st
         WHERE st.invocation_id = ?
           AND st.type = 'tool.call.started'
           AND json_extract(st.broker_event_json, '$.name') IN (${asks.sql})
           AND ${ASK_BRACKET_CLOSE_NOT_EXISTS}
           AND ${ASK_BRACKET_TERMINAL_NOT_EXISTS}
         ORDER BY st.seq ASC
      `
    )
    .all(invocationId, ...asks.params)
  return rows.map((row) => ({
    invocationId,
    runId: row.runId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    harnessGeneration: row.harnessGeneration,
    turnAttempt: row.turnAttempt,
    seq: row.seq,
  }))
}

/** True if the runtime's active invocation has any open ask bracket (any run). */
export function runtimeHasAnyOpenAskBracket(db: HrcDatabase, runtime: HrcRuntimeSnapshot): boolean {
  return listOpenAskBrackets(db, runtime).length > 0
}

/** Highest broker seq recorded for the invocation (for corrupt-state reporting). */
export function latestBrokerSeq(db: HrcDatabase, invocationId: string): number | undefined {
  const row = db.sqlite
    .query<{ maxSeq: number | null }, [string]>(
      'SELECT MAX(seq) AS maxSeq FROM broker_invocation_events WHERE invocation_id = ?'
    )
    .get(invocationId)
  return row?.maxSeq ?? undefined
}

/**
 * A runtime is corrupt-awaiting when it carries the `awaiting_input` status with
 * no `activeRunId` — an impossible-by-construction combination that must be
 * surfaced as suspect, never silently normalized to ready/busy or treated as
 * reusable readiness (T-01946 gate 6).
 */
export function isCorruptAwaitingRuntime(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.status === 'awaiting_input' && runtime.activeRunId === undefined
}

/**
 * Restart / reattach re-derivation: given a status freshly derived from the
 * broker's reported invocation state (which has no `awaiting_input` member, so a
 * parked turn reports `turn_active` => `busy`), promote it back to `awaiting_input`
 * when the durable bracket says the active run is parked on an ask. Keeps the
 * runtime-status projection honest across daemon restarts without making the
 * status the authority.
 */
export function deriveRuntimeStatusWithAwaiting(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  baseStatus: string
): string {
  // Use any-open-bracket rather than scoping to activeRunId: at reattach the
  // runtime row may not yet carry activeRunId, and a parked TUI shows a question
  // regardless of which run owns it. The reaper guard, separately, scopes to the
  // candidate run — this is only the status projection.
  return runtimeHasAnyOpenAskBracket(db, runtime) ? 'awaiting_input' : baseStatus
}
