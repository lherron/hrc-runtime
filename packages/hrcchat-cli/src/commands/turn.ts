import { readFileSync } from 'node:fs'

import { CliUsageError, parseDuration } from 'cli-kit'
import type {
  HrcLifecycleEvent,
  HrcMessageAddress,
  HrcTurnResponseFormat,
  SemanticTurnHandoffPendingResponse,
  SemanticTurnHandoffResponse,
  SemanticTurnHandoffStartedResponse,
} from 'hrc-core'
import { type RenderFrame, SessionEventsManager, adaptHrcLifecycleEvent } from 'hrc-frame-render'
import type { HrcClient } from 'hrc-sdk'

import { writeDeliveryOutcome, writeDeliveryWarnings } from '../delivery-warning.js'
import { type resolveScope, resolveSenderAddress } from '../normalize.js'
import { printJson, printJsonLine } from '../print.js'
import {
  type RenderFrameFormatInput,
  createTerminalFrameRenderer,
  resolveRenderFrameSinkFormat,
  writeRenderFrameAsNdjson,
} from '../render-frame.js'
import { resolveLaunchTarget } from '../resolve-intent.js'
import { type StackedAggregator, createStackedAggregator } from '../stacked-aggregator.js'
import { isRecord } from '../stacked-shared.js'
import { createStackedSummarizer } from '../stacked-summary.js'
import { FlushReason, Phase, Result } from '../stacked-types.js'

export type TurnOptions = {
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
  /** T-07155 — preempt the target's active turn instead of queueing behind it. */
  steer?: boolean | undefined
  preempt?: boolean | undefined
  /** Admission lifetime for enqueue/preempt. */
  ttl?: string | undefined
  /** Wait budget for `--wait final`. Default 45m. */
  timeout?: string | undefined
  /** Suppress all progress output while `--wait` blocks (default in wait mode). */
  quiet?: boolean | undefined
}

const TURN_WAIT_DEFAULT_TIMEOUT = '45m'

function isPendingSemanticTurnHandoff(
  response: SemanticTurnHandoffResponse
): response is SemanticTurnHandoffPendingResponse {
  return 'status' in response && response.status === 'pending'
}

type TurnBodyInput = {
  targetInput: string
  body: string
  bodyFromFile: boolean
  bodyFromStdin: boolean
}

type TurnOutputOptions = {
  waitMode: string | undefined
  waitTimeoutMs: number | undefined
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

/**
 * Typed exit error for the turn command.
 * Thrown instead of calling process.exit() directly so that main.ts
 * can map it to the correct exit code, and tests can assert on it.
 *
 * Exit codes:
 *   0 — turn completed (success, no error thrown)
 *   1 — stall-after fired
 *   2 — usage error (handled by CliUsageError)
 *   3 — infra failure (socket, daemon)
 *   4 — runtime dead before turn completed
 *   5 — permission-blocked
 * 130 — SIGINT
 */
export class TurnExitError extends Error {
  readonly exitCode: number
  constructor(exitCode: number, message: string) {
    super(message)
    this.name = 'TurnExitError'
    this.exitCode = exitCode
  }
}

export const TURN_EXIT_STALL = 1
export const TURN_EXIT_INFRA = 3
export const TURN_EXIT_RUNTIME_DEAD = 4
export const TURN_EXIT_PERMISSION_BLOCKED = 5
export const TURN_EXIT_SIGINT = 130

/**
 * The four terminal outcomes of the turn watch loop, reified as a table so the
 * (phase, flush, exitCode, result, message) tuple for each is declared in one
 * place rather than hand-aligned across four `aggregator.finish(...) ; throw`
 * blocks. Every triple is preserved byte-for-byte from the original blocks —
 * exit codes (0/4/5) are the user-facing CLI contract and must not shift.
 *
 *   runtimeDead — runtime exited before the turn completed (exit 4)
 *   permission  — turn blocked on a permission request (exit 5)
 *   error       — turn ended with an error (exit 4, reusing RUNTIME_DEAD)
 *   success     — turn completed normally (exit 0, no throw)
 *
 * Note `runtimeDead` and `error` share TURN_EXIT_RUNTIME_DEAD but carry
 * different Result values (RuntimeDead vs TurnError) and messages.
 */
type TerminalKind = 'runtimeDead' | 'permission' | 'error' | 'success'

type TerminalOutcome = {
  phase: Phase
  flush: FlushReason
  exitCode: number
  result: Result
  /** aggregator-finish error payload; omitted when the arm carries no error */
  errorMessage?: string
  /** TurnExitError message; omitted for the non-throwing success arm */
  throwMessage?: string
}

const TERMINALS: Record<TerminalKind, TerminalOutcome> = {
  runtimeDead: {
    phase: Phase.Error,
    flush: FlushReason.Error,
    exitCode: TURN_EXIT_RUNTIME_DEAD,
    result: Result.RuntimeDead,
    errorMessage: 'runtime exited before turn completed',
    throwMessage: 'runtime exited before turn completed',
  },
  permission: {
    phase: Phase.Permission,
    flush: FlushReason.Permission,
    exitCode: TURN_EXIT_PERMISSION_BLOCKED,
    result: Result.PermissionBlocked,
    throwMessage: 'turn blocked on permission request (no interactive approval in MVP)',
  },
  error: {
    phase: Phase.Error,
    flush: FlushReason.Error,
    exitCode: TURN_EXIT_RUNTIME_DEAD,
    result: Result.TurnError,
    errorMessage: 'turn ended with error',
    throwMessage: 'turn ended with error',
  },
  success: {
    phase: Phase.Final,
    flush: FlushReason.Final,
    exitCode: 0,
    result: Result.Success,
  },
}

/**
 * Finalize the stacked aggregator for a terminal outcome, then (for every arm
 * except success) throw the matching TurnExitError. Preserves the exact
 * finish(...) payload and exit-code/message of the original inline blocks.
 */
async function finalizeTurn(
  aggregator: StackedAggregator | undefined,
  kind: TerminalKind
): Promise<void> {
  const outcome = TERMINALS[kind]
  await aggregator?.finish({
    phase: outcome.phase,
    flush: outcome.flush,
    exitCode: outcome.exitCode,
    result: outcome.result,
    ...(outcome.errorMessage !== undefined ? { error: { message: outcome.errorMessage } } : {}),
  })
  if (outcome.throwMessage !== undefined) {
    throw new TurnExitError(outcome.exitCode, outcome.throwMessage)
  }
}

function readTurnBodyInput(opts: TurnOptions, positionals: string[]): TurnBodyInput {
  const targetInput = positionals[0]
  if (!targetInput) {
    throw new CliUsageError('missing required argument: <target>')
  }

  const bodyPositional = positionals[1]
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

function resolveTurnOutputOptions(opts: TurnOptions): TurnOutputOptions {
  if (opts.steer === true && opts.wait !== undefined) {
    throw new CliUsageError('--steer cannot be combined with --wait; steer has no turn of its own')
  }
  if (opts.steer === true && opts.preempt === true) {
    throw new CliUsageError('--steer and --preempt select different submission doors')
  }
  if (opts.steer === true && opts.ttl !== undefined) {
    throw new CliUsageError('--ttl is available only for enqueue and preempt')
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

  return { waitMode, waitTimeoutMs, stackedWindowMs }
}

function assertProjectResolved(
  targetInput: string,
  resolved: ReturnType<typeof resolveScope>
): void {
  if (resolved.parsed.projectId) {
    return
  }

  throw new CliUsageError(
    [
      `cannot resolve a project for target "${targetInput}".`,
      'A turn must target an agent within a project, but none was found: the',
      'target has no @<project> qualifier, ASP_PROJECT is unset, and the current',
      'directory maps to no known project. Fix one of:',
      `  • qualify the target:  hrcchat turn ${targetInput}@<project> "…"`,
      `  • set the env:         ASP_PROJECT=<project> hrcchat turn ${targetInput} "…"`,
      `  • run from a project:  cd ~/praesidium/<project> && hrcchat turn ${targetInput} "…"`,
    ].join('\n')
  )
}

export async function cmdTurn(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[]
): Promise<void> {
  const { targetInput, body, bodyFromFile, bodyFromStdin } = readTurnBodyInput(opts, positionals)
  const responseFormat = parseResponseFormatOption(opts)

  const stallAfterMs = parseDuration(opts.stallAfter ?? '1h')

  // ── Final-only Codex wait mode (mutex with all streaming options) ──
  const { waitMode, stackedWindowMs } = resolveTurnOutputOptions(opts)

  // ── Resolve scope ──
  const target = resolveLaunchTarget(targetInput)
  const { resolved, sessionRef, runtimeIntent } = target

  // ── --dry-run: print the resolved dispatch plan and exit ──
  // Purely local resolution — consults no server state, mutates nothing
  // (no clearContext), and dispatches no turn.
  if (opts.dryRun) {
    printJson({
      command: 'turn',
      dryRun: true,
      note: 'local plan preview — no server state consulted, nothing dispatched',
      target: targetInput,
      sessionRef,
      scopeRef: resolved.scopeRef,
      laneRef: resolved.laneRef,
      projectId: resolved.parsed.projectId ?? null,
      placementResolution: resolved.placement.resolution,
      bodySource: bodyFromFile ? 'file' : bodyFromStdin ? 'stdin' : 'positional',
      bodyLength: body.length,
      clearContextFirst: opts.new === true,
      replyToMessageId: opts.replyTo ?? null,
      responseFormat: responseFormat ?? null,
      output: {
        format: opts.format ?? null,
        pretty: opts.pretty === true,
        stackedWindowMs: stackedWindowMs ?? null,
        stallAfterMs,
      },
      runtimeIntent,
    })
    return
  }

  // ── Require a resolvable project before dispatching ──
  // A turn places an agent within a project. When the target carries no
  // @<project> qualifier, ASP_PROJECT is unset, and the cwd maps to no known
  // project, resolution yields a degenerate project-less scope (agent:<name>).
  // Dispatching there produces no runnable turn and no rendered frames, so the
  // operator is left with no reply, no confirmation, and — worst of all — no
  // error. Fail loud with actionable guidance instead. (--dry-run is exempt
  // above: it intentionally prints the degenerate plan so the gap is visible.)
  assertProjectResolved(targetInput, resolved)

  // ── Dispatch turn via semanticTurnHandoff ──
  // Freshness is part of this atomic destination-side handoff. A separate
  // origin-side clear cannot enforce context rotation for federated targets.
  const sender = resolveSenderAddress(opts.as)
  if (sender.source === 'human-fallback') {
    if (!process.stdout.isTTY) {
      throw new CliUsageError(
        'no session envelope and no interactive terminal: name the sender with --as <principal> ("human" or an agent handle) — scripted sends must not default to the human seat'
      )
    }
    process.stderr.write('notice: dispatching as human (no session envelope)\n')
  }
  const from = sender.address
  const to = { kind: 'session' as const, sessionRef }

  const principalRef =
    from.kind === 'session'
      ? (from.sessionRef.split('/lane:')[0] ?? from.sessionRef)
      : from.entity === 'human'
        ? 'human:lance'
        : `system:${from.entity}`
  const ttlMs = opts.ttl === undefined ? undefined : parseDuration(opts.ttl)
  if (ttlMs !== undefined && ttlMs <= 0) {
    throw new CliUsageError(`invalid duration: ${opts.ttl} (must be > 0)`)
  }
  const submissionRequest = {
    target: sessionRef,
    body,
    origin: { principalRef, ...(from.kind === 'session' ? { scopeRef: principalRef } : {}) },
    ...(opts.new === true ? { freshContext: true } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  }
  if (opts.steer === true) {
    printJsonLine(await client.steer(submissionRequest))
    return
  }
  if (opts.preempt === true) {
    printJsonLine(
      await client.preempt({
        ...submissionRequest,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
      })
    )
    return
  }
  if (waitMode === 'final' || ttlMs !== undefined) {
    printJsonLine(
      await client.enqueue({
        ...submissionRequest,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
      })
    )
    return
  }
  const handoff = await client.semanticTurnHandoff({
    from,
    to,
    body,
    runtimeIntent,
    createIfMissing: true,
    ...(opts.new === true ? { freshContext: true } : {}),
    replyToMessageId: opts.replyTo,
    allowCrossScopeReply: opts.crossScopeReply,
    responseFormat,
  })
  if (isPendingSemanticTurnHandoff(handoff)) {
    printJsonLine(handoff)
    return
  }
  const quiet = waitMode !== undefined ? opts.quiet !== false : opts.quiet === true
  if (!quiet) {
    writeDeliveryWarnings(handoff.warnings)
    writeDeliveryOutcome(handoff.delivery)
  }
  const expectedResponder = { kind: 'session' as const, sessionRef: handoff.sessionRef }

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

  // SIGINT handler
  const sigintHandler = () => {
    abortController.abort()
  }
  process.on('SIGINT', sigintHandler)

  // Stall timer
  let stallFired = false
  const stallTimer =
    stackedWindowMs === undefined
      ? setTimeout(() => {
          stallFired = true
          abortController.abort()
        }, stallAfterMs)
      : undefined

  // For --pretty in headless mode we still want in-place redraw rather than
  // stamped scrollback. opts.pretty implies inPlace=true; otherwise honor TTY.
  const terminalRenderer =
    stackedWindowMs === undefined && sinkFormat === 'terminal'
      ? createTerminalFrameRenderer({
          scopeHandle: targetInput,
          titleFallback: body,
          ...(opts.pretty ? { inPlace: true, color: true } : {}),
        })
      : undefined

  const manager =
    stackedWindowMs === undefined
      ? new SessionEventsManager('hrcchat-turn', (_sessionRef, _projectId, _runId, frame) => {
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
    stackedAggregator = createStackedAggregator({
      windowMs: stackedWindowMs,
      stallAfterMs,
      targetScope: targetInput,
      handoff,
      summarizer: createStackedSummarizer(),
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

  try {
    for await (const event of client.watch({
      scopeRef: handoff.scopeRef,
      laneRef: handoff.laneRef,
      runId: handoff.runId,
      generation: handoff.generation,
      fromSeq: handoff.fromSeq,
      follow: true,
      signal: abortController.signal,
    })) {
      const stackedEvent =
        stackedAggregator && isWatchLoopTurnTerminal(event)
          ? await enrichFinalEvent(client, handoff, event, {
              expectedResponder,
              expectedRecipient: from,
            })
          : event
      if (stackedAggregator) {
        lastPhase = deriveStackedPhase(stackedEvent, lastPhase)
        await stackedAggregator.receive(stackedEvent)
      } else {
        const envelope = adaptHrcLifecycleEvent(event)
        if (envelope) {
          manager?.receive(envelope)
        }
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
        // AbortError from stall timer or SIGINT
        if (stallFired) {
          throw new TurnExitError(TURN_EXIT_STALL, 'stall-after timeout reached')
        }
        // SIGINT
        throw new TurnExitError(TURN_EXIT_SIGINT, 'interrupted')
      }
      throw err
    }
  } finally {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer)
    }
    process.removeListener('SIGINT', sigintHandler)
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

  // exit 0 — success (implicit return)
}

/**
 * Watch-loop terminal predicate: which events end the turn for the watch loop
 * (both the stacked and non-stacked paths). Deliberately BROADER than the
 * stacked aggregator's own `isStackedAggregatorFinal` (turn.completed only) —
 * the two are intentionally distinct, NOT a duplicate. Do not unify the bodies;
 * see T-04733 (daedalus-gated) for why widening/narrowing either is a behavior
 * change.
 */
function isWatchLoopTurnTerminal(event: HrcLifecycleEvent): boolean {
  return event.eventKind === 'turn_end' || event.eventKind === 'turn.completed'
}

function isRuntimeDead(event: HrcLifecycleEvent): boolean {
  return (
    event.eventKind === 'runtime_exited' ||
    event.eventKind === 'runtime_crashed' ||
    event.eventKind === 'runtime_killed'
  )
}

function deriveStackedPhase(
  event: HrcLifecycleEvent,
  prior: RenderFrame['phase'] | undefined
): RenderFrame['phase'] | undefined {
  if (event.eventKind === 'permission_request') {
    return 'permission'
  }
  if (event.eventKind === 'turn.completed') {
    return 'final'
  }
  if (event.eventKind === 'run_failed' || event.eventKind === 'turn.error') {
    return 'error'
  }
  if (event.eventKind === 'run_queued') {
    return prior ?? 'queued'
  }
  return prior === 'permission' || prior === 'error' ? prior : 'progress'
}

async function enrichFinalEvent(
  _client: HrcClient,
  _handoff: SemanticTurnHandoffStartedResponse,
  event: HrcLifecycleEvent,
  _correlation: {
    expectedResponder: HrcMessageAddress
    expectedRecipient: HrcMessageAddress
  }
): Promise<HrcLifecycleEvent> {
  return event
}
