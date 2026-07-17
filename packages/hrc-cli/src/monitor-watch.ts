/**
 * hrc monitor watch — event stream command (F2b).
 *
 * Consumes F1a event-source (createMonitorReader), F1b condition engine
 * (createMonitorConditionEngine), and F1c schema (MonitorEventSchema).
 *
 * Without --follow: replays matching monitor events up to current high-water;
 * exits 0 even if zero matched.
 *
 * With --follow: streams new events. If --until provided, exits when the
 * condition resolves via the F1b engine.
 *
 * Exit codes (cli-kit convention):
 *   0  condition satisfied OR finite replay completed
 *   1  timeout / stall reached without satisfying condition
 *   2  usage error / invalid selector
 *   3  monitor infrastructure failure
 *   4  condition impossible (terminal non-matching state)
 * 130  SIGINT
 */

import { CliUsageError, parseDuration } from 'cli-kit'
import {
  HrcDomainError,
  type HrcMonitorCondition,
  type HrcMonitorConditionEngineReader,
  type HrcMonitorConditionOutcome,
  type HrcMonitorEvent,
  type HrcMonitorState,
  type HrcMonitorWatchRequest,
  type HrcSelector,
  createMonitorConditionEngine,
  createMonitorReader,
  formatSelector,
  resolveDatabasePath,
} from 'hrc-core'
import { MonitorResult } from 'hrc-events'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { type HrcLifecycleMonitorFilters, openHrcDatabase } from 'hrc-store-sqlite'
import { splitCsv } from './cli/argv.js'
import { matchStringFlag, parseNonNegativeInteger, parsePositiveInteger } from './monitor-args.js'
import {
  MSG_REQUIRED_CONDITIONS,
  POLL_MS,
  assertValidUntilCondition,
} from './monitor-conditions.js'
import { numberField, stringField } from './monitor-fields.js'
import {
  type MonitorOutputFormat,
  createMonitorRenderer,
  parseMonitorOutputFormat,
  resolveMonitorOutputFormat,
  toMonitorJsonEvent,
} from './monitor-render.js'
import {
  type MonitorSelectorSpec,
  eventMatchesSelectorSet,
  isFanInSelectorSet,
  parseMonitorSelectors,
  scopeMatchesSelectorSpec,
  selectorSetLabel,
} from './monitor-selectors.js'

// -- Types -------------------------------------------------------------------

type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

type FilterSpec =
  | { milestone: true }
  | {
      milestone?: false | undefined
      kinds?: string[] | undefined
      tools?: string[] | undefined
      grep?: string | undefined
    }

/** Structured args accepted when invoked directly (e.g. from tests). */
export type MonitorWatchArgs = {
  selector?: string | undefined
  selectors?: string[] | undefined
  json?: boolean | undefined
  pretty?: boolean | undefined
  format?: MonitorOutputFormat | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  last?: number | undefined
  until?: string | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
  signal?: AbortSignal | undefined
  // -- Event filtering (T-04232) --
  kind?: string | undefined // comma-separated event_kind list
  tool?: string | undefined // comma-separated toolName list (turn.tool_call only)
  grep?: string | undefined // payload substring match
  milestone?: boolean | undefined // curated preset (supersedes kind/tool/grep)
  allEvents?: boolean | undefined // opt out of the fan-in milestone default
  forever?: boolean | undefined // opt out of single-runtime implicit terminal exit
  /** Internal marker: preserve normal follow/replay behavior while stopping at terminal. */
  implicitTerminal?: boolean | undefined
}

/** Injectable dependencies for testing. */
export type MonitorWatchDeps = {
  buildMonitorState: () => Promise<HrcMonitorState>
  stdout: { write(chunk: string): boolean; drain?: () => Promise<void> }
  stderr: { write(chunk: string): boolean }
}

export class MonitorWatchExit extends Error {
  constructor(readonly code: number) {
    super(`monitor watch exit ${code}`)
    this.name = 'MonitorWatchExit'
  }
}

const VALID_RESULTS = new Set<string>(MonitorResult)
const DEFAULT_REPLAY_LIMIT = 100

// -- Public entry point -------------------------------------------------------

/**
 * Dual-signature entry:
 * - `cmdMonitorWatch(argv: string[])` — from CLI (commander toLegacyArgv)
 * - `cmdMonitorWatch(args: MonitorWatchArgs, deps: MonitorWatchDeps)` — from tests
 */
export async function cmdMonitorWatch(
  argsOrArgv: string[] | MonitorWatchArgs,
  deps?: MonitorWatchDeps
): Promise<number | undefined> {
  const parsedArgs = Array.isArray(argsOrArgv) ? parseArgv(argsOrArgv) : argsOrArgv
  const args = applyFanInDefaults(parsedArgs)
  const io = deps ?? defaultDeps(args)

  try {
    const exitCode = await runWatch(args, io)
    if (!deps) {
      // CLI mode: exit the process
      await drainStdout(io.stdout)
      process.exit(exitCode)
    }
    return exitCode
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) {
        await drainStdout(io.stdout)
        process.exit(2)
      }
      return 2
    }
    if (error instanceof HrcDomainError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) {
        await drainStdout(io.stdout)
        process.exit(2)
      }
      return 2
    }
    throw error
  }
}

// -- Core logic ---------------------------------------------------------------

async function runWatch(args: MonitorWatchArgs, io: MonitorWatchDeps): Promise<number> {
  const follow = args.follow ?? false
  const until = args.until
  const signal = args.signal
  const format = resolveMonitorOutputFormat({
    format: args.format,
    pretty: args.pretty,
    json: args.json,
  })

  // Validate condition
  assertValidUntilCondition(until)

  // Validate event-filter flags (T-04232)
  if (args.kind !== undefined && args.kind.trim() === '') {
    throw new CliUsageError('--kind requires a non-empty value')
  }
  if (args.tool !== undefined && args.tool.trim() === '') {
    throw new CliUsageError('--tool requires a non-empty value')
  }

  if (args.last !== undefined) {
    if (!Number.isInteger(args.last) || args.last < 1) {
      throw new CliUsageError('--last must be a positive integer')
    }
    if (args.fromSeq !== undefined) {
      throw new CliUsageError('--last cannot be used with --from-seq')
    }
    if (until !== undefined) {
      throw new CliUsageError('--last cannot be used with --until')
    }
  }

  const rawSelectors = selectorArgs(args)
  let selectorSpecs: MonitorSelectorSpec[]
  try {
    selectorSpecs = parseMonitorSelectors(rawSelectors)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid selector: ${message}`)
  }
  const selector =
    selectorSpecs.length === 1 && selectorSpecs[0]?.kind === 'exact'
      ? selectorSpecs[0].selector
      : undefined

  // Q4 FROZEN: response/response-or-idle REQUIRE msg: selector
  if (until && MSG_REQUIRED_CONDITIONS.has(until)) {
    if (
      selectorSpecs.length !== 1 ||
      !selector ||
      (selector.kind !== 'message' && selector.kind !== 'message-seq')
    ) {
      throw new CliUsageError(`${until} requires a msg: selector`)
    }
  }

  // Handle SIGINT
  if (signal?.aborted) {
    return 130
  }

  // Apply server-side-equivalent event filtering (T-04232). In live mode the
  // SQL layer already narrowed the firehose; this wrapper enforces the same
  // predicate for injected/test state and preserves the global high-water.
  const filteredIo = wrapWithMonitorFilters(io, args, selectorSpecs)

  // Build state
  const state = await filteredIo.buildMonitorState()

  const implicitTerminal =
    follow &&
    until === undefined &&
    args.forever !== true &&
    selector !== undefined &&
    resolvesToConcreteRuntime(state, selector)
  if (implicitTerminal) {
    return runReplayOrFollow(
      state,
      { ...args, implicitTerminal: true },
      selector,
      filteredIo,
      format
    )
  }

  if (args.until && follow) {
    if (isFanInSelectorSet(selectorSpecs)) {
      return runSelectorSetConditionWatch(state, args, selectorSpecs, filteredIo, format)
    }
    return runConditionWatch(state, args, selector, filteredIo, format)
  }
  return runReplayOrFollow(state, args, selector, filteredIo, format)
}

function selectorArgs(args: MonitorWatchArgs): string[] {
  if (args.selectors && args.selectors.length > 0) return args.selectors
  return args.selector ? [args.selector] : []
}

function resolvesToConcreteRuntime(state: HrcMonitorState, selector: HrcSelector): boolean {
  if (selector.kind === 'runtime') {
    return state.runtimes.some((runtime) => runtime.runtimeId === selector.runtimeId)
  }
  if (selector.kind === 'host' || selector.kind === 'concrete') {
    return state.sessions.some(
      (session) =>
        session.hostSessionId === selector.hostSessionId && session.runtimeId !== undefined
    )
  }
  if (selector.kind === 'scope' || selector.kind === 'target' || selector.kind === 'session') {
    return state.sessions.some((session) => {
      if (session.runtimeId === undefined) return false
      if (selector.kind === 'session') return session.sessionRef === selector.sessionRef
      return session.scopeRef === selector.scopeRef
    })
  }
  return false
}

// -- Condition-based watch (--follow --until) ---------------------------------

async function runConditionWatch(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  if (!selector) {
    throw new CliUsageError('--until requires a selector')
  }

  const condition = args.until as HrcMonitorCondition
  const selectorStr = formatSelector(selector)
  const selectedScopeRef = scopeRefForSelector(state, selector)

  // Use polling reader only when a timeout or stall-after is set, so new events
  // arriving after the initial snapshot can be observed. Without any deadline the
  // static reader drains and lets the condition engine return monitor_error (exit 3).
  const hasDeadline = args.timeoutMs !== undefined || args.stallAfterMs !== undefined
  const reader = hasDeadline ? createPollingConditionReader(state, io) : createMonitorReader(state)
  const engine = createMonitorConditionEngine(reader)

  let outcome: HrcMonitorConditionOutcome
  try {
    outcome = await engine.wait({
      selector,
      condition,
      timeoutMs: args.timeoutMs,
      stallAfterMs: args.stallAfterMs,
    })
  } catch (error) {
    if (error instanceof HrcDomainError) {
      throw new CliUsageError(error.message)
    }
    throw error
  }

  // Emit accumulated event stream (includes monitor.snapshot at start
  // and monitor.completed/monitor.stalled at the end, appended by engine).
  // In follow+condition mode:
  //   - Override replayed to false (all events are "live" from the CLI perspective)
  //   - Enrich the final completed/stalled event with runtimeId/turnId from context.
  if (outcome.eventStream) {
    const writer = createEventWriter(io.stdout, selectorStr, args, format)
    // Extract runtimeId/turnId from the last non-terminal event
    let lastRuntimeId: string | undefined
    let lastTurnId: string | undefined
    for (const event of outcome.eventStream) {
      const evName = stringField(event, 'event')
      if (
        evName !== 'monitor.completed' &&
        evName !== 'monitor.stalled' &&
        evName !== 'monitor.snapshot'
      ) {
        const rid = stringField(event, 'runtimeId')
        const tid = stringField(event, 'turnId')
        if (rid) lastRuntimeId = rid
        if (tid) lastTurnId = tid
      }
    }

    for (const event of outcome.eventStream) {
      const evName = stringField(event, 'event')
      // All events in follow+condition mode are non-replayed from CLI perspective
      const enriched: Record<string, unknown> = { ...event, replayed: false }

      if (evName === 'monitor.completed' || evName === 'monitor.stalled') {
        // Enrich with runtimeId/turnId if not already present
        if (lastRuntimeId && !stringField(event, 'runtimeId')) enriched['runtimeId'] = lastRuntimeId
        if (lastTurnId && !stringField(event, 'turnId')) enriched['turnId'] = lastTurnId
        if (selectedScopeRef && !stringField(event, 'scopeRef')) {
          enriched['scopeRef'] = selectedScopeRef
        }
      }
      writer.write(enriched)
    }
    writer.flush()
  }

  return outcome.exitCode
}

type SelectorConditionCandidate = {
  key: string
  selector: HrcSelector
  scopeRef: string
}

export type AnyMonitorConditionResult = {
  outcome: HrcMonitorConditionOutcome
  selector: HrcSelector
  scopeRef: string
}

function runtimeSelector(runtimeId: string): HrcSelector {
  return { kind: 'runtime', raw: `runtime:${runtimeId}`, runtimeId }
}

function hostSelector(hostSessionId: string): HrcSelector {
  return { kind: 'host', raw: `host:${hostSessionId}`, hostSessionId }
}

function scopeRefForSelector(state: HrcMonitorState, selector: HrcSelector): string | undefined {
  if (selector.kind === 'scope' || selector.kind === 'target' || selector.kind === 'session') {
    return selector.scopeRef
  }
  if (selector.kind === 'runtime') {
    const runtime = state.runtimes.find((candidate) => candidate.runtimeId === selector.runtimeId)
    return state.sessions.find((session) => session.hostSessionId === runtime?.hostSessionId)
      ?.scopeRef
  }
  if (selector.kind === 'host' || selector.kind === 'concrete') {
    return state.sessions.find((session) => session.hostSessionId === selector.hostSessionId)
      ?.scopeRef
  }
  if (selector.kind === 'stable') {
    return state.sessions.find((session) => session.sessionRef === selector.sessionRef)?.scopeRef
  }
  return undefined
}

function selectorConditionCandidates(
  state: HrcMonitorState,
  specs: readonly MonitorSelectorSpec[]
): SelectorConditionCandidate[] {
  const candidates = new Map<string, SelectorConditionCandidate>()
  for (const spec of specs) {
    if (spec.kind === 'exact') {
      const scopeRef = scopeRefForSelector(state, spec.selector)
      candidates.set(spec.raw, {
        key: spec.raw,
        selector: spec.selector,
        scopeRef: scopeRef ?? '',
      })
      continue
    }
    for (const session of state.sessions) {
      if (!scopeMatchesSelectorSpec(session.scopeRef, spec)) continue
      const selector = session.runtimeId
        ? runtimeSelector(session.runtimeId)
        : hostSelector(session.hostSessionId)
      candidates.set(session.hostSessionId, {
        key: session.hostSessionId,
        selector,
        scopeRef: session.scopeRef,
      })
    }
  }
  return [...candidates.values()]
}

function isDecisiveConditionOutcome(outcome: HrcMonitorConditionOutcome): boolean {
  return (
    outcome.result !== 'timeout' &&
    outcome.result !== 'stalled' &&
    outcome.result !== 'monitor_error'
  )
}

export async function waitForAnyMonitorCondition(
  initialState: HrcMonitorState,
  args: Pick<MonitorWatchArgs, 'until' | 'timeoutMs' | 'stallAfterMs' | 'signal'>,
  specs: readonly MonitorSelectorSpec[],
  io: Pick<MonitorWatchDeps, 'buildMonitorState'>
): Promise<AnyMonitorConditionResult> {
  const condition = args.until as HrcMonitorCondition
  const startedAt = Date.now()
  const deadline = args.timeoutMs === undefined ? undefined : startedAt + args.timeoutMs
  const controller = new AbortController()
  const seen = new Set<string>()
  let fallback: AnyMonitorConditionResult | undefined

  return await new Promise<AnyMonitorConditionResult>((resolve) => {
    let settled = false
    const finish = (result: AnyMonitorConditionResult): void => {
      if (settled) return
      settled = true
      controller.abort()
      resolve(result)
    }
    const startCandidate = (
      candidate: SelectorConditionCandidate,
      state: HrcMonitorState
    ): void => {
      if (seen.has(candidate.key)) return
      seen.add(candidate.key)
      const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now())
      const engine = createMonitorConditionEngine(
        createPollingConditionReader(state, io, controller.signal)
      )
      void engine
        .wait({
          selector: candidate.selector,
          condition,
          timeoutMs: remaining,
          stallAfterMs: args.stallAfterMs,
        })
        .then((outcome) => {
          const result = { outcome, selector: candidate.selector, scopeRef: candidate.scopeRef }
          fallback ??= result
          if (isDecisiveConditionOutcome(outcome)) finish(result)
        })
    }

    void (async () => {
      let state = initialState
      while (!settled && !controller.signal.aborted) {
        for (const candidate of selectorConditionCandidates(state, specs)) {
          startCandidate(candidate, state)
        }
        if (args.signal?.aborted) {
          finish({
            outcome: { result: 'monitor_error', exitCode: 130 },
            selector: runtimeSelector('aborted'),
            scopeRef: '',
          })
          return
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          finish(
            fallback ?? {
              outcome: { result: 'timeout', exitCode: 1 },
              selector: runtimeSelector('unresolved'),
              scopeRef: '',
            }
          )
          return
        }
        await sleep(POLL_MS)
        state = await io.buildMonitorState()
      }
    })()
  })
}

async function runSelectorSetConditionWatch(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  specs: readonly MonitorSelectorSpec[],
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  const winner = await waitForAnyMonitorCondition(state, args, specs, io)
  const writer = createEventWriter(io.stdout, selectorSetLabel(specs), args, format)
  for (const event of winner.outcome.eventStream ?? []) {
    const name = stringField(event, 'event')
    const enriched: Record<string, unknown> = { ...event, replayed: false }
    if (name === 'monitor.completed' || name === 'monitor.stalled') {
      enriched['scopeRef'] = winner.scopeRef
      enriched['condition'] = args.until
      enriched['exitCode'] = winner.outcome.exitCode
    }
    writer.write(enriched)
  }
  if (!winner.outcome.eventStream || winner.outcome.eventStream.length === 0) {
    writer.write({
      event: winner.outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
      condition: args.until,
      scopeRef: winner.scopeRef,
      result: winner.outcome.result,
      exitCode: winner.outcome.exitCode,
      replayed: false,
      ts: new Date().toISOString(),
    })
  }
  writer.flush()
  return winner.outcome.exitCode
}

// -- Replay / follow without condition ----------------------------------------

async function runReplayOrFollow(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  const follow = args.follow ?? false
  const selectorStr = selector ? formatSelector(selector) : ''
  const writer = createEventWriter(io.stdout, selectorStr, args, format)

  const reader = createMonitorReader(state)

  if (follow) {
    return runPollingFollow(state, args, selector, io, writer)
  }

  const request: HrcMonitorWatchRequest = {
    selector,
    follow,
    fromSeq: args.fromSeq,
  }

  const events: MonitorOutputEvent[] = []
  for await (const event of reader.watch(request)) {
    events.push(event)
  }

  // Non-follow replay caps (T-01740 Fix B): an explicit --from-seq window is
  // UNCAPPED so a full event dump is possible (the reader's fromSeq branch is
  // likewise uncapped — see hrc-core watchEvents). Without --from-seq the default
  // last-N cap still applies; --last overrides the count. NB: the bare-selector
  // default cap also lives in the reader (matching.slice(-100)), so widening it
  // beyond --from-seq would need the reader to surface the matched total — left as
  // a follow-up; --from-seq is the documented full-dump path.
  const explicitWindow = args.fromSeq !== undefined
  const replayLimit = args.last ?? (explicitWindow ? undefined : DEFAULT_REPLAY_LIMIT)
  const output =
    replayLimit !== undefined && events.length > replayLimit ? events.slice(-replayLimit) : events

  for (const event of output) {
    // Mark all non-follow events as replayed
    const enriched: Record<string, unknown> = { ...event, replayed: !follow }
    writer.write(enriched)
  }
  writer.flush()

  return 0
}

async function runPollingFollow(
  initialState: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  writer: EventWriter
): Promise<number> {
  const initialReader = createMonitorReader(initialState)
  const snapshot = initialReader.snapshot(selector)
  writer.write({
    seq: snapshot.eventHighWaterSeq,
    event: 'monitor.snapshot',
    replayed: false,
    snapshot,
  })
  const initialTerminalResult = args.implicitTerminal
    ? terminalSnapshotResult(initialState, selector)
    : undefined
  if (initialTerminalResult !== undefined) {
    writeImplicitTerminalCompletion(writer, args, selector, initialState, initialTerminalResult)
    writer.flush()
    return 0
  }

  // When a filter is active, replay the curated set already matched on attach so
  // the grader sees recent milestones — but keep the poll cursor global so we do
  // not re-scan non-matching events (T-04232 daedalus high-water invariant).
  const filterActive = isFilterActive(args)
  let nextSeq = Math.max(1, snapshot.eventHighWaterSeq + 1)
  if (args.fromSeq !== undefined || args.last !== undefined || filterActive) {
    let replayHighWater = snapshot.eventHighWaterSeq
    const replayEvents: MonitorOutputEvent[] = []
    for await (const event of initialReader.watch({
      selector,
      follow: false,
      fromSeq: args.fromSeq,
    })) {
      replayEvents.push(event)
    }
    const output =
      args.last !== undefined && replayEvents.length > args.last
        ? replayEvents.slice(-args.last)
        : replayEvents
    for (const event of output) {
      const enriched: Record<string, unknown> = { ...event, replayed: true }
      writer.write(enriched)
      const seq = numberField(enriched, 'seq')
      if (seq !== undefined) replayHighWater = Math.max(replayHighWater, seq)
    }
    // Filtered follow keeps the global cursor (snapshot high-water); explicit
    // --from-seq/--last windows advance past the replayed tail as before.
    if (!filterActive) {
      nextSeq = replayHighWater + 1
    }
  }

  if (args.signal?.aborted) {
    writer.flush()
    return 130
  }

  while (!args.signal?.aborted) {
    const state = await io.buildMonitorState()
    const reader = createMonitorReader(state)
    let yielded = false
    for await (const event of reader.watch({
      selector,
      follow: false,
      fromSeq: nextSeq,
    })) {
      yielded = true
      const enriched: Record<string, unknown> = { ...event, replayed: false }
      writer.write(enriched)
      const seq = numberField(enriched, 'seq')
      if (seq !== undefined) {
        nextSeq = Math.max(nextSeq, seq + 1)
      }
      if (args.implicitTerminal && isTerminalMonitorEvent(enriched)) {
        writeImplicitTerminalCompletion(
          writer,
          args,
          selector,
          state,
          stringField(enriched, 'result') ?? 'turn_succeeded',
          stringField(enriched, 'scopeRef')
        )
        writer.flush()
        return 0
      }
    }
    if (!yielded) {
      await sleep(POLL_MS)
    }
  }

  writer.flush()
  return 130
}

function terminalSnapshotResult(
  state: HrcMonitorState,
  selector: HrcSelector | undefined
): string | undefined {
  if (!selector) return undefined
  const scopeRef = scopeRefForSelector(state, selector)
  const session = state.sessions.find((candidate) => {
    if (scopeRef !== undefined) return candidate.scopeRef === scopeRef
    if (selector.kind === 'runtime') return candidate.runtimeId === selector.runtimeId
    if (selector.kind === 'host' || selector.kind === 'concrete') {
      return candidate.hostSessionId === selector.hostSessionId
    }
    return false
  })
  const runtime = state.runtimes.find((candidate) =>
    selector.kind === 'runtime'
      ? candidate.runtimeId === selector.runtimeId
      : candidate.hostSessionId === session?.hostSessionId
  )
  if (
    runtime?.status === 'dead' ||
    runtime?.status === 'crashed' ||
    runtime?.status === 'terminated'
  ) {
    return 'already_dead'
  }
  return runtime?.activeTurnId === null ? 'no_active_turn' : undefined
}

function isTerminalMonitorEvent(event: MonitorOutputEvent): boolean {
  const name = eventKindOf(event)
  return (
    name === 'turn.finished' ||
    name === 'turn.completed' ||
    name === 'turn.failed' ||
    name === 'runtime.dead' ||
    name === 'runtime.crashed'
  )
}

function writeImplicitTerminalCompletion(
  writer: EventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  state: HrcMonitorState,
  result: string,
  eventScopeRef?: string
): void {
  writer.write({
    event: 'monitor.completed',
    selector: selector ? formatSelector(selector) : '',
    condition: 'terminal',
    scopeRef: eventScopeRef ?? (selector ? scopeRefForSelector(state, selector) : undefined),
    result,
    exitCode: 0,
    replayed: false,
    ts: new Date().toISOString(),
    ...(args.format ? { format: args.format } : {}),
  })
}

// -- Event output -------------------------------------------------------------

type EventWriter = {
  write(event: MonitorOutputEvent): void
  flush(): void
}

function createEventWriter(
  stdout: { write(chunk: string): boolean },
  selectorStr: string,
  args: MonitorWatchArgs,
  format: MonitorOutputFormat
): EventWriter {
  if (format === 'json' || format === 'ndjson') {
    return {
      write(event) {
        const replayed = event['replayed'] === true
        const output = toMonitorJsonEvent(event, selectorStr, replayed)
        const eventName = stringField(output, 'event') ?? 'unknown'
        const result = stringField(output, 'result')
        if (result && eventName !== 'monitor.completed' && eventName !== 'monitor.stalled') {
          if (!VALID_RESULTS.has(result)) {
            output['result'] = undefined
          }
        }
        stdout.write(`${JSON.stringify(output)}\n`)
      },
      flush() {},
    }
  }

  const renderer = createMonitorRenderer(format, {
    maxLines: args.maxLines,
    scopeWidth: args.scopeWidth,
  })
  return {
    write(event) {
      if (stringField(event, 'event') === 'monitor.snapshot') {
        return
      }
      stdout.write(renderer.push(event))
    },
    flush() {
      stdout.write(renderer.flush())
    },
  }
}

async function drainStdout(stdout: MonitorWatchDeps['stdout']): Promise<void> {
  await stdout.drain?.()
}

// -- Polling condition reader (follow + until) --------------------------------

/**
 * Creates a condition engine reader that polls for new events by re-building
 * monitor state on each cycle. This is necessary for --follow --until mode
 * against live systems where new events (runtime.idle, turn.finished) arrive
 * after the initial state snapshot.
 *
 * The initial snapshot and capture use the pre-built state for consistency.
 * The watch() generator polls by re-reading state every POLL_MS when no new
 * events are available.
 */
function createPollingConditionReader(
  initialState: HrcMonitorState,
  io: Pick<MonitorWatchDeps, 'buildMonitorState'>,
  signal?: AbortSignal
): HrcMonitorConditionEngineReader {
  return {
    snapshot(selector) {
      return createMonitorReader(initialState).snapshot(selector)
    },
    captureStart(selector, options) {
      return createMonitorReader(initialState).captureStart(selector, options)
    },
    watch(request) {
      return pollingWatch(request, io, signal)
    },
  }
}

async function* pollingWatch(
  request: HrcMonitorWatchRequest,
  io: Pick<MonitorWatchDeps, 'buildMonitorState'>,
  signal?: AbortSignal
): AsyncIterable<HrcMonitorEvent | Record<string, unknown>> {
  // Yield the initial snapshot from the first state read
  const firstState = await io.buildMonitorState()
  const firstReader = createMonitorReader(firstState)
  const snapshotRequest: HrcMonitorWatchRequest = {
    selector: request.selector,
    follow: true,
    fromSeq: request.fromSeq,
  }
  // The first reader.watch() with follow=true yields the snapshot event first
  let nextSeq = request.fromSeq ?? 1
  for await (const event of firstReader.watch(snapshotRequest)) {
    yield event
    const seq = numberField(event, 'seq')
    if (seq !== undefined) {
      nextSeq = Math.max(nextSeq, seq + 1)
    }
  }

  // Poll for new events
  if (!request.follow) return
  while (!signal?.aborted) {
    const state = await io.buildMonitorState()
    const reader = createMonitorReader(state)
    let yielded = false
    for await (const event of reader.watch({
      selector: request.selector,
      follow: false,
      fromSeq: nextSeq,
      includeCorrelatedMessageResponses: request.includeCorrelatedMessageResponses,
    })) {
      yielded = true
      const seq = numberField(event, 'seq')
      if (seq !== undefined) {
        nextSeq = Math.max(nextSeq, seq + 1)
      }
      yield event
    }
    if (!yielded) {
      await sleep(POLL_MS)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// -- Default deps (live mode) -------------------------------------------------

function defaultDeps(args: MonitorWatchArgs): MonitorWatchDeps {
  const storeFilters = deriveStoreFilters(args)
  return {
    buildMonitorState: () => buildLiveMonitorState(storeFilters),
    stdout: createDrainableStdout(process.stdout),
    stderr: process.stderr,
  }
}

function createDrainableStdout(stream: {
  write(chunk: string, callback?: () => void): boolean
}): MonitorWatchDeps['stdout'] {
  const pendingWrites = new Set<Promise<void>>()

  return {
    write(chunk: string): boolean {
      let resolveWrite!: () => void
      const writeFinished = new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
      pendingWrites.add(writeFinished)

      const result = stream.write(chunk, () => {
        pendingWrites.delete(writeFinished)
        resolveWrite()
      })

      return result
    },
    async drain(): Promise<void> {
      while (pendingWrites.size > 0) {
        await Promise.all(Array.from(pendingWrites))
      }
    },
  }
}

async function buildLiveMonitorState(
  storeFilters?: HrcLifecycleMonitorFilters | undefined
): Promise<HrcMonitorState> {
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)

  const status = await client.getStatus()

  // Build sessions from status
  const sessions = status.sessions.map((view) => ({
    sessionRef: `${view.session.scopeRef}/lane:${view.session.laneRef}`,
    scopeRef: view.session.scopeRef,
    laneRef: view.session.laneRef,
    hostSessionId: view.session.hostSessionId,
    generation: view.session.generation,
    runtimeId: view.activeRuntime?.runtime.runtimeId,
    status: view.session.status,
    activeTurnId: view.activeRuntime?.runtime.activeRunId ?? null,
  }))

  // Build runtimes from status
  const runtimes = status.sessions.flatMap((view) => {
    const rt = view.activeRuntime?.runtime
    if (!rt) return []
    return [
      {
        runtimeId: rt.runtimeId,
        hostSessionId: rt.hostSessionId,
        status: rt.status,
        transport: rt.transport,
        activeTurnId: rt.activeRunId ?? null,
      },
    ]
  })

  // Load events from database. When filters are active (T-04232) the query layer
  // narrows the firehose server-side so the CLI never materializes it; the global
  // high-water is captured separately so the follow cursor stays global.
  const db = openHrcDatabase(resolveDatabasePath())
  let events: HrcMonitorEvent[]
  let eventGlobalHighWaterSeq: number | undefined
  try {
    const rawEvents = storeFilters
      ? db.hrcEvents.listFromHrcSeqFiltered(1, storeFilters)
      : db.hrcEvents.listFromHrcSeq(1)
    if (storeFilters) {
      eventGlobalHighWaterSeq = db.hrcEvents.maxHrcSeq()
    }
    events = rawEvents.map((e) => {
      const payload = e.payload as Record<string, unknown> | null | undefined
      return {
        seq: e.hrcSeq,
        hrcSeq: e.hrcSeq,
        streamSeq: e.streamSeq,
        ts: e.ts,
        event: e.eventKind,
        eventKind: e.eventKind,
        sessionRef: `${e.scopeRef}/lane:${e.laneRef ?? 'main'}`,
        scopeRef: e.scopeRef,
        laneRef: e.laneRef,
        hostSessionId: e.hostSessionId,
        generation: e.generation,
        category: e.category,
        runtimeId: e.runtimeId,
        turnId: e.runId,
        runId: e.runId,
        launchId: e.launchId,
        transport: e.transport,
        errorCode: e.errorCode,
        payload: e.payload,
        ...(payload && typeof payload === 'object' && 'messageId' in payload
          ? { messageId: String(payload['messageId']) }
          : {}),
        ...(payload && typeof payload === 'object' && 'messageSeq' in payload
          ? { messageSeq: Number(payload['messageSeq']) }
          : {}),
      }
    })
  } finally {
    db.close()
  }

  // Load messages from database if available
  const messages = await loadMessages(client)

  return {
    daemon: {
      pid: process.pid,
      status: 'healthy',
    },
    socket: {
      path: socketPath,
      responsive: true,
    },
    sessions,
    runtimes,
    messages,
    events,
    ...(eventGlobalHighWaterSeq !== undefined ? { eventGlobalHighWaterSeq } : {}),
  }
}

async function loadMessages(client: HrcClient): Promise<HrcMonitorState['messages']> {
  try {
    const response = await client.listMessages()
    if (!response?.messages) return []
    return response.messages.map((m) => ({
      messageId: m.messageId,
      messageSeq: m.messageSeq,
      sessionRef: m.execution?.sessionRef,
      hostSessionId: m.execution?.hostSessionId,
      runtimeId: m.execution?.runtimeId,
      runId: m.execution?.runId,
    }))
  } catch {
    return []
  }
}

// -- Arg parsing (CLI argv mode) -----------------------------------------------

type SimpleBooleanFlag = 'follow' | 'json' | 'pretty' | 'milestone' | 'forever' | 'allEvents'

function simpleBooleanFlag(arg: string): SimpleBooleanFlag | undefined {
  switch (arg) {
    case '--follow':
      return 'follow'
    case '--json':
      return 'json'
    case '--pretty':
      return 'pretty'
    case '--milestone':
      return 'milestone'
    case '--forever':
      return 'forever'
    case '--all-events':
      return 'allEvents'
    default:
      return undefined
  }
}

function parseArgv(args: string[]): MonitorWatchArgs {
  const selectors: string[] = []
  let fromSeq: number | undefined
  let last: number | undefined
  let until: string | undefined
  let timeout: string | undefined
  let stallAfter: string | undefined
  let format: MonitorOutputFormat | undefined
  let maxLines: number | undefined
  let scopeWidth: number | undefined
  let kind: string | undefined
  let tool: string | undefined
  let grep: string | undefined
  const booleanFlags: Partial<Record<SimpleBooleanFlag, true>> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    const booleanFlag = simpleBooleanFlag(arg)
    if (booleanFlag !== undefined) {
      booleanFlags[booleanFlag] = true
      continue
    }

    const fromSeqMatch = matchStringFlag(arg, '--from-seq', args, i)
    if (fromSeqMatch) {
      fromSeq = parsePositiveInteger('--from-seq', fromSeqMatch.value)
      i = fromSeqMatch.next
      continue
    }
    const lastMatch = matchStringFlag(arg, '--last', args, i)
    if (lastMatch) {
      last = parsePositiveInteger('--last', lastMatch.value)
      i = lastMatch.next
      continue
    }
    const untilMatch = matchStringFlag(arg, '--until', args, i)
    if (untilMatch) {
      until = untilMatch.value
      i = untilMatch.next
      continue
    }
    const timeoutMatch = matchStringFlag(arg, '--timeout', args, i)
    if (timeoutMatch) {
      timeout = timeoutMatch.value
      i = timeoutMatch.next
      continue
    }
    const stallMatch = matchStringFlag(arg, '--stall-after', args, i)
    if (stallMatch) {
      stallAfter = stallMatch.value
      i = stallMatch.next
      continue
    }
    if (arg === '--format') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--format requires a value')
      try {
        format = parseMonitorOutputFormat(val)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CliUsageError(message)
      }
      i += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      try {
        format = parseMonitorOutputFormat(arg.slice('--format='.length))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CliUsageError(message)
      }
      continue
    }
    const maxLinesMatch = matchStringFlag(arg, '--max-lines', args, i)
    if (maxLinesMatch) {
      maxLines = parseNonNegativeInteger('--max-lines', maxLinesMatch.value)
      i = maxLinesMatch.next
      continue
    }
    const scopeWidthMatch = matchStringFlag(arg, '--scope-width', args, i)
    if (scopeWidthMatch) {
      scopeWidth = parseNonNegativeInteger('--scope-width', scopeWidthMatch.value)
      i = scopeWidthMatch.next
      continue
    }
    const kindMatch = matchStringFlag(arg, '--kind', args, i)
    if (kindMatch) {
      kind = kindMatch.value
      i = kindMatch.next
      continue
    }
    const toolMatch = matchStringFlag(arg, '--tool', args, i)
    if (toolMatch) {
      tool = toolMatch.value
      i = toolMatch.next
      continue
    }
    const grepMatch = matchStringFlag(arg, '--grep', args, i)
    if (grepMatch) {
      grep = grepMatch.value
      i = grepMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    selectors.push(arg)
  }

  return {
    selector: selectors[0],
    selectors,
    fromSeq,
    last,
    follow: booleanFlags.follow ?? false,
    until,
    json: booleanFlags.json ?? false,
    pretty: booleanFlags.pretty ?? false,
    format,
    maxLines,
    scopeWidth,
    kind,
    tool,
    grep,
    ...(booleanFlags.milestone ? { milestone: true } : {}),
    ...(booleanFlags.forever ? { forever: true } : {}),
    ...(booleanFlags.allEvents ? { allEvents: true } : {}),
    // Convert duration strings to ms for the internal API
    ...(timeout ? { timeoutMs: parseDuration(timeout) } : {}),
    ...(stallAfter ? { stallAfterMs: parseDuration(stallAfter) } : {}),
  }
}

// -- Event filtering (T-04232) ------------------------------------------------

const MILESTONE_EVENT_KINDS = new Set<string>([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'session.started',
  'session.cleared',
  'runtime.idle',
  'runtime.dead',
])
const MILESTONE_BASH_NEEDLES = [
  'hrcchat dm',
  'wrkq touch',
  'wrkq set',
  'wrkq comment',
  'git commit',
]

function normalizeEventFilterSpec(args: MonitorWatchArgs): FilterSpec | undefined {
  if (args.allEvents === true) return undefined
  if (args.milestone === true) return { milestone: true }

  const spec: FilterSpec = {}
  let any = false
  if (args.kind !== undefined && args.kind.trim() !== '') {
    spec.kinds = splitCsv(args.kind)
    any = true
  }
  if (args.tool !== undefined && args.tool.trim() !== '') {
    spec.tools = splitCsv(args.tool)
    any = true
  }
  if (args.grep !== undefined && args.grep !== '') {
    spec.grep = args.grep
    any = true
  }
  return any ? spec : undefined
}

/** True when any of the --kind/--tool/--grep/--milestone filters is requested. */
function isFilterActive(args: MonitorWatchArgs): boolean {
  return normalizeEventFilterSpec(args) !== undefined
}

function eventKindOf(event: MonitorOutputEvent): string {
  return stringField(event, 'eventKind') ?? stringField(event, 'event') ?? ''
}

function payloadOf(event: MonitorOutputEvent): Record<string, unknown> {
  const payload = (event as Record<string, unknown>)['payload']
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function payloadToolName(event: MonitorOutputEvent): string | undefined {
  const tool = payloadOf(event)['toolName']
  return typeof tool === 'string' ? tool : undefined
}

function isMilestoneEvent(event: MonitorOutputEvent): boolean {
  const kind = eventKindOf(event)
  if (MILESTONE_EVENT_KINDS.has(kind)) return true
  if (kind === 'turn.tool_call') {
    const tool = payloadToolName(event)
    if (tool === 'Agent' || tool === 'Skill') return true
    if (tool === 'Bash') {
      const serialized = JSON.stringify(payloadOf(event))
      return MILESTONE_BASH_NEEDLES.some((needle) => serialized.includes(needle))
    }
  }
  return false
}

/**
 * Build an in-memory predicate mirroring the SQL filter (T-04232). Used for
 * injected/test state and as a redundant guard over already-filtered live state.
 * `milestone` supersedes kind/tool/grep. Returns null when no filter is active.
 */
function buildEventFilter(args: MonitorWatchArgs): ((event: MonitorOutputEvent) => boolean) | null {
  const spec = normalizeEventFilterSpec(args)
  if (spec === undefined) return null
  if (spec.milestone === true) {
    return (event) => isMilestoneEvent(event)
  }
  const predicates: Array<(event: MonitorOutputEvent) => boolean> = []
  if (spec.kinds !== undefined) {
    const kinds = new Set(spec.kinds)
    predicates.push((event) => kinds.has(eventKindOf(event)))
  }
  if (spec.tools !== undefined) {
    const tools = new Set(spec.tools)
    predicates.push(
      (event) => eventKindOf(event) === 'turn.tool_call' && tools.has(payloadToolName(event) ?? '')
    )
  }
  if (spec.grep !== undefined) {
    const needle = spec.grep
    predicates.push((event) => JSON.stringify(payloadOf(event)).includes(needle))
  }
  return (event) => predicates.every((predicate) => predicate(event))
}

/**
 * Derive the store-layer filter (server-side SQL narrowing) from CLI args.
 * Returns undefined when no filter is active so the unfiltered fast path is kept.
 */
function deriveStoreFilters(args: MonitorWatchArgs): HrcLifecycleMonitorFilters | undefined {
  const spec = normalizeEventFilterSpec(args)
  const selectorSpecs = parseMonitorSelectors(selectorArgs(args))
  const canNarrowByScope = selectorSpecs.every(
    (selector) => selector.kind !== 'exact' || selector.selector.kind === 'scope'
  )
  const scopeFilters: HrcLifecycleMonitorFilters = canNarrowByScope
    ? {
        scopeRefs: selectorSpecs.flatMap((selector) =>
          selector.kind === 'exact' && selector.selector.kind === 'scope'
            ? [selector.selector.scopeRef]
            : []
        ),
        scopeRefPrefixes: selectorSpecs.flatMap((selector) =>
          selector.kind === 'scope-prefix' ? [selector.prefix] : []
        ),
        taskIds: selectorSpecs.flatMap((selector) =>
          selector.kind === 'task' ? [selector.taskId] : []
        ),
      }
    : {}
  const eventFilters: HrcLifecycleMonitorFilters =
    spec?.milestone === true
      ? { milestone: true }
      : {
          ...(spec?.kinds !== undefined ? { eventKinds: spec.kinds } : {}),
          ...(spec?.tools !== undefined ? { toolNames: spec.tools } : {}),
          ...(spec?.grep !== undefined ? { payloadContains: spec.grep } : {}),
        }
  const filters = {
    ...scopeFilters,
    ...eventFilters,
  }
  const hasFilter = Object.values(filters).some(
    (value) => value !== undefined && (!Array.isArray(value) || value.length > 0)
  )
  return hasFilter ? filters : undefined
}

function eventsHighWater(events: HrcMonitorEvent[]): number {
  return events.reduce((max, event) => {
    const seq = numberField(event, 'seq')
    return seq !== undefined ? Math.max(max, seq) : max
  }, 0)
}

/**
 * Wrap deps so every `buildMonitorState()` applies the active event filter and
 * preserves the global event high-water (so the follow cursor stays global).
 * Returns the deps unchanged when no filter is active.
 */
function wrapWithMonitorFilters(
  io: MonitorWatchDeps,
  args: MonitorWatchArgs,
  specs: readonly MonitorSelectorSpec[]
): MonitorWatchDeps {
  const eventPredicate = buildEventFilter(args)
  if (!eventPredicate && specs.length === 0) return io
  return {
    ...io,
    buildMonitorState: async () => {
      const state = await io.buildMonitorState()
      const globalHighWater = state.eventGlobalHighWaterSeq ?? eventsHighWater(state.events)
      return {
        ...state,
        events: state.events.filter(
          (event) =>
            eventMatchesSelectorSet(state, event, specs) &&
            (eventPredicate === null || eventPredicate(event))
        ),
        eventGlobalHighWaterSeq: globalHighWater,
      }
    },
  }
}

function applyFanInDefaults(args: MonitorWatchArgs): MonitorWatchArgs {
  const rawSelectors = selectorArgs(args)
  const fanIn =
    rawSelectors.length > 1 ||
    rawSelectors.some((selector) => /^T-\d+$/.test(selector) || selector.endsWith(':*'))
  const explicitFilter =
    args.kind !== undefined ||
    args.tool !== undefined ||
    args.grep !== undefined ||
    args.milestone === true ||
    args.allEvents === true
  if (!fanIn || explicitFilter) return args
  return { ...args, milestone: true }
}

// -- Helpers ------------------------------------------------------------------
