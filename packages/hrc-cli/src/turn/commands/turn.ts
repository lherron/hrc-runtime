import { readFileSync } from 'node:fs'

import { CliUsageError, parseDuration } from 'cli-kit'
import type { HrcLifecycleEvent, HrcTurnResponseFormat } from 'hrc-core'
import { type RenderFrame, SessionEventsManager, adaptHrcLifecycleEvent } from 'hrc-frame-render'
import type { HrcClient } from 'hrc-sdk'
import { resolveMessagingScope } from '../normalize.js'
import {
  type RenderFrameFormatInput,
  createTerminalFrameRenderer,
  resolveRenderFrameSinkFormat,
  writeRenderFrameAsNdjson,
} from '../render-frame.js'
import type { resolveLaunchTarget } from '../resolve-intent.js'
import { type StackedAggregator, createStackedAggregator } from '../stacked-aggregator.js'
import { isRecord } from '../stacked-shared.js'
import { type StackedSeatSummarizer, createStackedSummarizer } from '../stacked-summary.js'
import type { StackedHandoff } from '../stacked-types.js'
import {
  type PreparedTurnObservation,
  assertProjectResolved,
  bindWaitDeadline,
  prepareDispatchedTurn,
  waitTimeoutExit,
} from './turn-dispatch.js'
import {
  TURN_EXIT_INFRA,
  TURN_EXIT_NOTHING_TO_ATTACH,
  TURN_EXIT_SIGINT,
  TURN_EXIT_STALL,
  TurnExitError,
  deriveStackedPhase,
  enrichFinalEvent,
  failTurn,
  finalizeTurn,
  isRuntimeDead,
  isWatchLoopTurnTerminal,
  turnFailureOf,
} from './turn-terminals.js'

export { writeDoorDowngrade } from './turn-dispatch.js'
export {
  TURN_EXIT_INFRA,
  TURN_EXIT_NOTHING_TO_ATTACH,
  TURN_EXIT_PERMISSION_BLOCKED,
  TURN_EXIT_RUNTIME_DEAD,
  TURN_EXIT_SIGINT,
  TURN_EXIT_STALL,
  TurnExitError,
} from './turn-terminals.js'

export type TurnOptions = {
  /** Observe an admitted run without dispatching input. */
  attach?: boolean | undefined
  /** Explicit sender principal ("human" or an agent handle); wins over the envelope. */
  as?: string | undefined
  new?: boolean | undefined
  dryRun?: boolean | undefined
  format?: RenderFrameFormatInput | undefined
  pretty?: boolean | undefined
  stallAfter?: string | undefined
  file?: string | undefined
  stacked?: string | undefined
  follow?: string | undefined
  replyTo?: string | undefined
  crossScopeReply?: boolean | undefined
  responseFormatJsonSchema?: string | undefined
  /**
   * Final-only Codex wait mode. `final` blocks quietly until the turn reaches a
   * terminal state, then emits one compact JSON object. Mutually exclusive with
   * the streaming options (`--follow`/`--stacked`/`--format tree|compact`/
   * `--pretty`), whose progress-stream semantics are unchanged.
   */
  wait?: string | undefined
  /**
   * Accepted for compatibility and changes nothing: steer is the default door
   * (T-08533). Steer = send now: the body joins the running turn, or starts one.
   */
  steer?: boolean | undefined
  /** Queue = send after: the body is its own turn, ordered behind the running one. */
  queue?: boolean | undefined
  /** T-07155 — preempt the target's active turn instead of queueing behind it. */
  preempt?: boolean | undefined
  /** Admission lifetime for enqueue/preempt. */
  ttl?: string | undefined
  /** Wait budget for `--wait final`. Default 45m. */
  timeout?: string | undefined
  /** Suppress all progress output while `--wait` blocks (default in wait mode). */
  quiet?: boolean | undefined
}

export type TurnCommandDependencies = {
  createStackedSummarizer?: typeof createStackedSummarizer
  resolveMessagingScope?: typeof resolveMessagingScope
  resolveLaunchTarget?: typeof resolveLaunchTarget
  /** Test-only clock compression; production always uses the exported constant. */
  attachCatchUpDeadlineMs?: number | undefined
}

const TURN_WAIT_DEFAULT_TIMEOUT = '45m'
export const ATTACH_CATCH_UP_DEADLINE_MS = 30_000

export type TurnBodyInput = {
  targetInput: string
  body: string
  bodyFromFile: boolean
  bodyFromStdin: boolean
}

export type TurnOutputOptions = {
  waitMode: string | undefined
  waitTimeoutMs: number | undefined
  /** Fires at --timeout, measured from command start; bounds every --wait door. */
  waitDeadline: AbortSignal | undefined
  stackedWindowMs: number | undefined
}

function parseResponseFormatOption(opts: TurnOptions): HrcTurnResponseFormat | undefined {
  const raw = opts.responseFormatJsonSchema
  if (raw === undefined) {
    return undefined
  }
  const jsonText = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid --response-format-json-schema JSON: ${message}`)
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError('--response-format-json-schema must be a JSON object')
  }
  return { kind: 'json_schema', schema: parsed }
}

function readTurnBodyInput(opts: TurnOptions, positionals: string[]): TurnBodyInput {
  const targetInput = positionals[0]
  if (!targetInput) {
    throw new CliUsageError('missing required argument: <target>')
  }

  const bodyPositional = positionals[1]
  if (opts.attach === true) {
    if (bodyPositional !== undefined || opts.file !== undefined) {
      throw new CliUsageError('--attach cannot be combined with a prompt, -, or --file')
    }
    return { targetInput, body: '', bodyFromFile: false, bodyFromStdin: false }
  }

  const bodyFromStdin = bodyPositional === '-'
  const bodyFromFile = opts.file !== undefined

  const sourceCount =
    (bodyPositional !== undefined && !bodyFromStdin ? 1 : 0) +
    (bodyFromStdin ? 1 : 0) +
    (bodyFromFile ? 1 : 0)

  if (sourceCount > 1) {
    throw new CliUsageError('only one body source allowed: positional prompt, - (stdin), or --file')
  }

  let body: string | undefined
  if (bodyFromFile && opts.file) {
    body = readFileSync(opts.file, 'utf8')
  } else if (bodyFromStdin) {
    body = readFileSync('/dev/stdin', 'utf8')
  } else {
    body = bodyPositional
  }

  if (!body) {
    throw new CliUsageError('turn requires a prompt (positional, -, or --file)')
  }

  return { targetInput, body, bodyFromFile, bodyFromStdin }
}

function assertAttachOptionCompatibility(opts: TurnOptions): void {
  if (opts.attach !== true) {
    return
  }
  const incompatible: Array<[boolean, string]> = [
    [opts.new === true, '--new'],
    [opts.dryRun === true, '--dry-run'],
    [opts.steer === true, '--steer'],
    [opts.queue === true, '--queue'],
    [opts.preempt === true, '--preempt'],
    [opts.wait !== undefined, '--wait'],
    [opts.ttl !== undefined, '--ttl'],
    [opts.replyTo !== undefined, '--reply-to'],
    [opts.crossScopeReply === true, '--cross-scope-reply'],
    [opts.responseFormatJsonSchema !== undefined, '--response-format-json-schema'],
    [opts.as !== undefined, '--as'],
    [opts.quiet === true, '--quiet'],
  ]
  const conflict = incompatible.find(([present]) => present)
  if (conflict !== undefined) {
    throw new CliUsageError(`--attach cannot be combined with ${conflict[1]}`)
  }
}

function nothingToAttach(targetInput: string, reason: string): never {
  throw new TurnExitError(
    TURN_EXIT_NOTHING_TO_ATTACH,
    `turn: no active turn on ${targetInput} (${reason})`
  )
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function originatingMessageId(
  events: HrcLifecycleEvent[],
  dispatchedInputId: string | undefined
): string | undefined {
  for (const event of events) {
    if (event.eventKind !== 'turn.started' && event.eventKind !== 'turn.attributed') continue
    const inputId = stringField(event.payload, 'inputId')
    if (inputId !== undefined) return inputId
  }
  return dispatchedInputId
}

const ATTACHABLE_RUN_STATUSES = new Set(['accepted', 'started', 'running'])

async function resolveAttachObservation(
  client: HrcClient,
  targetInput: string,
  sessionRef: string
): Promise<{
  handoff: StackedHandoff
  firstSeq: number
  catchUpThroughSeq: number
}> {
  const session = await client.resolveSession({ sessionRef })
  if (!session.found) {
    nothingToAttach(targetInput, 'session not found')
  }

  const runtimes = await client.listRuntimes({ hostSessionId: session.hostSessionId })
  if (runtimes.length === 0) {
    nothingToAttach(targetInput, 'session has no runtime')
  }
  const inspected = await Promise.all(
    runtimes.map((runtime) => client.inspectRuntime({ runtimeId: runtime.runtimeId }))
  )
  const candidates = inspected.filter((runtime) => runtime.activeRunId !== null)
  if (candidates.length === 0) {
    nothingToAttach(targetInput, 'no runtime has an active run')
  }
  if (candidates.length > 1) {
    nothingToAttach(targetInput, `${candidates.length} runtimes have active runs`)
  }

  const runtime = candidates[0]
  if (runtime === undefined || runtime.activeRunId === null) {
    nothingToAttach(targetInput, 'no runtime has an active run')
  }
  const runId = runtime.activeRunId
  const run = await client.getRun(runId)
  if (run === null) {
    nothingToAttach(targetInput, `active run ${runId} was not found`)
  }
  if (!ATTACHABLE_RUN_STATUSES.has(run.status)) {
    nothingToAttach(targetInput, `active run ${runId} has status ${run.status}`)
  }

  const replay: HrcLifecycleEvent[] = []
  for await (const event of client.watch({
    runId,
    generation: runtime.generation,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    fromSeq: 1,
    follow: false,
  })) {
    replay.push(event)
  }
  if (replay.length === 0) {
    nothingToAttach(targetInput, 'run has no ledger events')
  }

  const firstEvent = replay[0]
  const lastEvent = replay.at(-1)
  if (firstEvent === undefined || lastEvent === undefined) {
    nothingToAttach(targetInput, 'run has no ledger events')
  }
  const firstSeq = firstEvent.hrcSeq
  const catchUpThroughSeq = lastEvent.hrcSeq
  const messageId = originatingMessageId(replay, run.dispatchedInputId)
  return {
    handoff: {
      ...(messageId !== undefined ? { messageId } : {}),
      sessionRef,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      runId,
      generation: runtime.generation,
      fromSeq: firstSeq,
    },
    firstSeq,
    catchUpThroughSeq,
  }
}

function resolveTurnOutputOptions(opts: TurnOptions): TurnOutputOptions {
  const doorFlags = [
    [opts.steer === true, '--steer'],
    [opts.queue === true, '--queue'],
    [opts.preempt === true, '--preempt'],
  ] as const
  const selected = doorFlags.filter(([present]) => present).map(([, flag]) => flag)
  if (selected.length > 1) {
    throw new CliUsageError(`${selected.join(' and ')} select different submission doors`)
  }
  if (opts.queue !== true && opts.preempt !== true && opts.ttl !== undefined) {
    throw new CliUsageError('--ttl is available only with --queue or --preempt')
  }
  if (opts.queue !== true && (opts.replyTo !== undefined || opts.crossScopeReply === true)) {
    throw new CliUsageError(
      `${opts.replyTo !== undefined ? '--reply-to' : '--cross-scope-reply'} threads a queued message; pass --queue`
    )
  }
  const waitMode = opts.wait
  if (waitMode !== undefined && waitMode !== 'final') {
    throw new CliUsageError(`unsupported --wait mode for turn: "${waitMode}" (expected: final)`)
  }
  if (waitMode !== undefined) {
    if (opts.follow !== undefined || opts.stacked !== undefined) {
      throw new CliUsageError(
        '--wait (final-only) and --follow/--stacked (streaming) are mutually exclusive; pass one'
      )
    }
    if (opts.pretty) {
      throw new CliUsageError('--wait cannot be combined with --pretty')
    }
    if (opts.format === 'tree' || opts.format === 'compact') {
      throw new CliUsageError('--wait cannot be combined with --format tree or compact')
    }
  }

  const waitTimeoutMs =
    waitMode !== undefined ? parseDuration(opts.timeout ?? TURN_WAIT_DEFAULT_TIMEOUT) : undefined
  if (waitTimeoutMs !== undefined && waitTimeoutMs <= 0) {
    throw new CliUsageError(`invalid duration: ${opts.timeout} (must be > 0)`)
  }

  if (opts.stacked !== undefined && opts.follow !== undefined) {
    throw new CliUsageError('--follow is an alias for --stacked; pass one, not both')
  }
  const stackedRaw = opts.stacked ?? opts.follow
  const stackedWindowMs = stackedRaw !== undefined ? parseDuration(stackedRaw) : undefined
  if (stackedWindowMs !== undefined && stackedWindowMs <= 0) {
    throw new CliUsageError(`invalid duration: ${stackedRaw} (must be > 0)`)
  }
  if (stackedWindowMs !== undefined) {
    if (opts.pretty) {
      throw new CliUsageError('--follow/--stacked cannot be combined with --pretty')
    }
    if (opts.format === 'tree' || opts.format === 'compact') {
      throw new CliUsageError('--follow/--stacked cannot be combined with --format tree or compact')
    }
  }

  const waitDeadline = waitTimeoutMs !== undefined ? AbortSignal.timeout(waitTimeoutMs) : undefined
  return { waitMode, waitTimeoutMs, waitDeadline, stackedWindowMs }
}

export async function cmdTurn(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[],
  dependencies: TurnCommandDependencies = {}
): Promise<void> {
  assertAttachOptionCompatibility(opts)
  const { targetInput, body, bodyFromFile, bodyFromStdin } = readTurnBodyInput(opts, positionals)
  const responseFormat = opts.attach === true ? undefined : parseResponseFormatOption(opts)

  const stallAfterMs = parseDuration(opts.stallAfter ?? '1h')
  const output = resolveTurnOutputOptions(opts)
  const { stackedWindowMs, waitDeadline, waitTimeoutMs } = output

  let prepared: PreparedTurnObservation | undefined
  if (opts.attach === true) {
    // Observe-only resolution intentionally uses the messaging seam: task
    // worktree drift warns, but never becomes a launch-eligibility check.
    const resolveMessaging = dependencies.resolveMessagingScope ?? resolveMessagingScope
    const resolved = await resolveMessaging(targetInput, { withCallerTaskId: true })
    const sessionRef = `${resolved.scopeRef}/lane:${resolved.laneId}`
    assertProjectResolved(targetInput, resolved)
    const observation = await resolveAttachObservation(client, targetInput, sessionRef)
    prepared = {
      resolved,
      handoff: observation.handoff,
      catchUpThroughSeq: observation.catchUpThroughSeq,
    }
  } else {
    prepared = await prepareDispatchedTurn(
      client,
      opts,
      { targetInput, body, bodyFromFile, bodyFromStdin },
      output,
      stallAfterMs,
      responseFormat,
      dependencies
    )
  }
  if (prepared === undefined) {
    return
  }
  const { resolved, handoff, catchUpThroughSeq, followSeat } = prepared

  // ── Resolve sink format ──
  // --pretty forces terminal/tree format regardless of TTY detection, so
  // headless invocations can render the same human-facing output.
  const effectiveFormat: RenderFrameFormatInput | undefined = opts.pretty ? 'tree' : opts.format
  const sinkFormat =
    stackedWindowMs === undefined
      ? resolveRenderFrameSinkFormat({
          format: effectiveFormat,
          isTTY: process.stdout.isTTY === true,
        })
      : 'ndjson'

  // Quiet the projection's per-event logger unless the operator explicitly
  // asked for it. The frame stream IS the user-facing output here; info logs
  // interleaved with frames make the CLI unreadable.
  if (process.env['LOG_LEVEL'] === undefined) {
    process.env['LOG_LEVEL'] = 'warn'
  }

  // ── Watch loop: stream events, adapt → frame → render ──
  const abortController = new AbortController()
  let turnCompleted = false
  let lastPhase: RenderFrame['phase'] | undefined
  let stackedAggregator: StackedAggregator | undefined
  let stackedSummarizer: StackedSeatSummarizer | undefined

  // SIGINT handler
  const sigintHandler = () => {
    abortController.abort()
  }
  process.on('SIGINT', sigintHandler)

  // Dispatch mode arms stall immediately. Attach mode arms it only after the
  // fixed replay boundary has been consumed, so --stall-after measures live
  // silence rather than local ledger catch-up.
  let stallFired = false
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armNonStackedStall = () => {
    if (stackedWindowMs !== undefined || stallTimer !== undefined) return
    stallTimer = setTimeout(() => {
      stallFired = true
      abortController.abort()
    }, stallAfterMs)
  }
  if (opts.attach !== true) {
    armNonStackedStall()
  }

  let waitTimedOut = false
  const unbindWaitDeadline = bindWaitDeadline(waitDeadline, () => {
    waitTimedOut = true
    abortController.abort()
  })

  // For --pretty in headless mode we still want in-place redraw rather than
  // stamped scrollback. opts.pretty implies inPlace=true; otherwise honor TTY.
  const terminalRenderer =
    stackedWindowMs === undefined && sinkFormat === 'terminal'
      ? createTerminalFrameRenderer({
          scopeHandle: targetInput,
          titleFallback: body || 'Attached turn',
          ...(opts.pretty ? { inPlace: true, color: true } : {}),
        })
      : undefined

  const manager =
    stackedWindowMs === undefined
      ? new SessionEventsManager('hrc-turn', (_sessionRef, _projectId, _runId, frame) => {
          lastPhase = frame.phase
          if (terminalRenderer) {
            terminalRenderer.write(frame)
          } else {
            writeRenderFrameAsNdjson(frame)
          }
        })
      : undefined

  manager?.subscribe(handoff.sessionRef, resolved.parsed.projectId ?? '')

  if (stackedWindowMs !== undefined) {
    const createSummarizer = dependencies.createStackedSummarizer ?? createStackedSummarizer
    stackedSummarizer = createSummarizer({
      client,
      targetProjectId: resolved.parsed.projectId as string,
      observedAgentId: resolved.parsed.agentId,
      runId: handoff.runId,
    })
    stackedAggregator = createStackedAggregator({
      windowMs: stackedWindowMs,
      stallAfterMs,
      targetScope: targetInput,
      handoff,
      summarizer: stackedSummarizer,
      ...(catchUpThroughSeq !== undefined ? { catchUpThroughSeq } : {}),
      writeLine(line) {
        process.stdout.write(`${JSON.stringify(line)}\n`)
      },
      onStall() {
        stallFired = true
        abortController.abort()
      },
    })
    stackedAggregator.start()
  }

  let attachCatchUpComplete = catchUpThroughSeq === undefined
  let attachCatchUpDeadlineFired = false
  let lastAttachSeq = handoff.fromSeq - 1
  const pendingNonStackedCatchUp: HrcLifecycleEvent[] = []
  let attachCatchUpDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  if (!attachCatchUpComplete) {
    attachCatchUpDeadlineTimer = setTimeout(() => {
      attachCatchUpDeadlineFired = true
      abortController.abort()
    }, dependencies.attachCatchUpDeadlineMs ?? ATTACH_CATCH_UP_DEADLINE_MS)
  }

  try {
    try {
      for await (const event of client.watch({
        scopeRef: handoff.scopeRef,
        laneRef: handoff.laneRef,
        ...(followSeat === true ? {} : { runId: handoff.runId }),
        generation: handoff.generation,
        fromSeq: handoff.fromSeq,
        follow: true,
        signal: abortController.signal,
      })) {
        lastAttachSeq = event.hrcSeq
        const stackedEvent =
          stackedAggregator && isWatchLoopTurnTerminal(event)
            ? await enrichFinalEvent(event)
            : event
        if (stackedAggregator) {
          lastPhase = deriveStackedPhase(stackedEvent, lastPhase)
          await stackedAggregator.receive(stackedEvent)
        } else {
          let eventsToRender = [event]
          if (!attachCatchUpComplete) {
            pendingNonStackedCatchUp.push(event)
            eventsToRender =
              catchUpThroughSeq !== undefined && event.hrcSeq >= catchUpThroughSeq
                ? pendingNonStackedCatchUp.splice(0)
                : []
          }
          for (const eventToRender of eventsToRender) {
            const envelope = adaptHrcLifecycleEvent(eventToRender)
            if (envelope) {
              manager?.receive(envelope)
            }
          }
        }

        if (
          !attachCatchUpComplete &&
          catchUpThroughSeq !== undefined &&
          event.hrcSeq >= catchUpThroughSeq
        ) {
          attachCatchUpComplete = true
          if (attachCatchUpDeadlineTimer !== undefined) {
            clearTimeout(attachCatchUpDeadlineTimer)
            attachCatchUpDeadlineTimer = undefined
          }
          armNonStackedStall()
        }

        // A failed turn is terminal: HRC will open no turn for this run (T-08865).
        const failure = turnFailureOf(event)
        if (failure !== undefined) {
          abortController.abort()
          await failTurn(
            failure,
            stackedAggregator,
            sinkFormat !== 'terminal' || output.waitMode !== undefined
          )
        }

        // Check for terminal events
        if (isWatchLoopTurnTerminal(event)) {
          turnCompleted = true
          abortController.abort()
          break
        }

        // Runtime died before turn completed
        if (isRuntimeDead(event)) {
          await finalizeTurn(stackedAggregator, 'runtimeDead')
        }
      }
    } catch (err) {
      if (err instanceof TurnExitError) {
        throw err
      }
      // Turn completed — abort was intentional to close the follow stream, so
      // fall through to exit-code determination below.
      if (!turnCompleted) {
        if (abortController.signal.aborted) {
          if (attachCatchUpDeadlineFired) {
            throw new TurnExitError(
              TURN_EXIT_INFRA,
              `turn: attach did not complete catch-up (received through seq ${lastAttachSeq} of ${catchUpThroughSeq})`
            )
          }
          if (waitTimedOut && waitTimeoutMs !== undefined) {
            throw waitTimeoutExit(waitTimeoutMs, { runId: handoff.runId })
          }
          // AbortError from stall timer or SIGINT
          if (stallFired) {
            throw new TurnExitError(TURN_EXIT_STALL, 'stall-after timeout reached')
          }
          // SIGINT
          throw new TurnExitError(TURN_EXIT_SIGINT, 'interrupted')
        }
        throw err
      }
    }

    if (!attachCatchUpComplete) {
      throw new TurnExitError(
        TURN_EXIT_INFRA,
        `turn: attach did not complete catch-up (received through seq ${lastAttachSeq} of ${catchUpThroughSeq})`
      )
    }

    // ── Determine exit code from final state ──
    if (lastPhase === 'permission') {
      await finalizeTurn(stackedAggregator, 'permission')
    }

    if (lastPhase === 'error') {
      await finalizeTurn(stackedAggregator, 'error')
    }

    if (stackedAggregator && turnCompleted) {
      await finalizeTurn(stackedAggregator, 'success')
    }
  } finally {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer)
    }
    if (attachCatchUpDeadlineTimer !== undefined) {
      clearTimeout(attachCatchUpDeadlineTimer)
    }
    process.removeListener('SIGINT', sigintHandler)
    unbindWaitDeadline()
    try {
      await stackedAggregator?.close()
    } finally {
      await stackedSummarizer?.cleanup()
    }
  }

  // exit 0 — success (implicit return)
}
