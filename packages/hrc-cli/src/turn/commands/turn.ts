import { readFileSync } from 'node:fs'

import { CliUsageError, parseDuration } from 'cli-kit'
import type {
  HrcLifecycleEvent,
  HrcSubmissionResponse,
  HrcTurnResponseFormat,
  SemanticTurnHandoffPendingResponse,
  SemanticTurnHandoffResponse,
} from 'hrc-core'
import { type RenderFrame, SessionEventsManager, adaptHrcLifecycleEvent } from 'hrc-frame-render'
import type { HrcClient } from 'hrc-sdk'

import type { ProfileAwareResolvedScopeInput as ScopeInput } from 'hrc-sdk'
import { printJson, printJsonLine } from '../../print.js'
import { writeDeliveryOutcome, writeDeliveryWarnings } from '../delivery-warning.js'
import { resolveMessagingScope, resolveSenderAddress } from '../normalize.js'
import {
  type RenderFrameFormatInput,
  createTerminalFrameRenderer,
  resolveRenderFrameSinkFormat,
  writeRenderFrameAsNdjson,
} from '../render-frame.js'
import { resolveLaunchTarget } from '../resolve-intent.js'
import { type StackedAggregator, createStackedAggregator } from '../stacked-aggregator.js'
import { isCanonicalTurnCompletionFailure, isRecord } from '../stacked-shared.js'
import { type StackedSeatSummarizer, createStackedSummarizer } from '../stacked-summary.js'
import { FlushReason, Phase, Result, type StackedHandoff } from '../stacked-types.js'

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
 *   6 — no admitted run to attach to
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
export const TURN_EXIT_NOTHING_TO_ATTACH = 6
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

/**
 * `--timeout` is a hard bound on `--wait` whatever the server does (T-08865):
 * print the timeout as the command's JSON result and exit non-zero.
 */
function waitTimeoutExit(
  timeoutMs: number,
  fields: { runId?: string | undefined; door?: string | undefined } = {}
): TurnExitError {
  printJsonLine({
    result: 'wait_timeout',
    timeoutMs,
    ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
    ...(fields.door !== undefined ? { door: fields.door } : {}),
  })
  return new TurnExitError(TURN_EXIT_STALL, `--wait timeout reached after ${timeoutMs}ms`)
}

/** Call `onDeadline` when (or if already) the wait deadline fires; returns the unbind. */
function bindWaitDeadline(deadline: AbortSignal | undefined, onDeadline: () => void): () => void {
  if (deadline === undefined) return () => {}
  if (deadline.aborted) {
    onDeadline()
    return () => {}
  }
  deadline.addEventListener('abort', onDeadline, { once: true })
  return () => deadline.removeEventListener('abort', onDeadline)
}

/**
 * A waited door whose turn ended failed (e.g. its broker never started) exits
 * like a watched failed turn, after its response line is printed (T-08865).
 */
function exitIfWaitedTurnFailed(response: HrcSubmissionResponse): void {
  const body = response as Record<string, unknown>
  const terminal = isRecord(body['terminal']) ? body['terminal'] : {}
  if (body['status'] !== 'failed' && terminal['status'] !== 'failed') return
  const error = isRecord(body['error']) ? body['error'] : {}
  const code = typeof error['code'] === 'string' ? error['code'] : 'failed'
  const message = typeof error['message'] === 'string' ? `: ${error['message']}` : ''
  throw new TurnExitError(TERMINALS.error.exitCode, `turn failed: ${code}${message}`)
}

/** Run a server-side waiting door; the client deadline ends it if the server does not. */
async function withWaitDeadline<T>(
  output: TurnOutputOptions,
  door: string,
  call: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  try {
    return await call(output.waitDeadline)
  } catch (error) {
    if (output.waitDeadline?.aborted === true && output.waitTimeoutMs !== undefined) {
      throw waitTimeoutExit(output.waitTimeoutMs, { door })
    }
    throw error
  }
}

function assertProjectResolved(targetInput: string, resolved: ScopeInput): void {
  if (resolved.parsed.projectId) {
    return
  }

  throw new CliUsageError(
    [
      `cannot resolve a project for target "${targetInput}".`,
      'A turn must target an agent within a project, but none was found: the',
      'target has no @<project> qualifier, ASP_PROJECT is unset, and the current',
      'directory maps to no known project. Fix one of:',
      `  • qualify the target:  hrc turn ${targetInput}@<project> "…"`,
      `  • set the env:         ASP_PROJECT=<project> hrc turn ${targetInput} "…"`,
      `  • run from a project:  cd ~/praesidium/<project> && hrc turn ${targetInput} "…"`,
    ].join('\n')
  )
}

type PreparedTurnObservation = {
  resolved: ScopeInput
  handoff: StackedHandoff
  catchUpThroughSeq?: number | undefined
  /**
   * Follow the seat rather than one run. A steer that joins a running turn is
   * settled into the run that owns that turn, so its own run carries none of
   * the turn's events; the first turn terminal on the seat after admission is
   * the turn it joined or started.
   */
  followSeat?: boolean | undefined
}

/**
 * A steer the server downgraded (T-08536) was asked for "now" and delivered
 * "after". Say so on stderr for every output mode; the JSON response line carries the fields.
 */
export function writeDoorDowngrade(
  response: Pick<HrcSubmissionResponse, 'effectiveDoor' | 'requestedDoor' | 'downgradeReason'>,
  write: (text: string) => void = (text) => process.stderr.write(text)
): void {
  if (response.requestedDoor === undefined || response.effectiveDoor === undefined) return
  write(
    `notice: ${response.requestedDoor} downgraded to ${response.effectiveDoor} (${response.downgradeReason ?? 'unknown'}): the message runs after the current turn\n`
  )
}

async function prepareDispatchedTurn(
  client: HrcClient,
  opts: TurnOptions,
  input: TurnBodyInput,
  output: TurnOutputOptions,
  stallAfterMs: number,
  responseFormat: HrcTurnResponseFormat | undefined,
  dependencies: TurnCommandDependencies
): Promise<PreparedTurnObservation | undefined> {
  const { targetInput, body, bodyFromFile, bodyFromStdin } = input
  const { waitMode, stackedWindowMs } = output
  const resolveLaunch = dependencies.resolveLaunchTarget ?? resolveLaunchTarget
  const { resolved, sessionRef, runtimeIntent } = await resolveLaunch(targetInput)

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
    return undefined
  }

  assertProjectResolved(targetInput, resolved)
  const sender = await resolveSenderAddress(opts.as)
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
  const queue = opts.queue === true
  if (opts.preempt === true) {
    const preempted = await withWaitDeadline(output, 'preempt', (signal) =>
      client.preempt(
        {
          ...submissionRequest,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
        },
        { signal: waitMode === 'final' ? signal : undefined }
      )
    )
    printJsonLine(preempted)
    exitIfWaitedTurnFailed(preempted)
    return undefined
  }
  if (!queue) {
    // Steer = send now (T-08533): join the running turn, or start one. A target
    // with no session row has no seat to steer yet; its birth turn is the turn
    // the steer would start, and the handoff below is the door that births it.
    const existing = await client.resolveSession({ sessionRef, create: false })
    if (existing.found) {
      if (waitMode === 'final') {
        const waited = await withWaitDeadline(output, 'steer', (signal) =>
          client.steer({ ...submissionRequest, wait: true }, { signal })
        )
        writeDoorDowngrade(waited)
        printJsonLine(waited)
        exitIfWaitedTurnFailed(waited)
        return undefined
      }
      const steered = await client.steer(submissionRequest)
      writeDoorDowngrade(steered)
      if (steered.admission !== 'admitted' || !('runId' in steered)) {
        printJsonLine(steered)
        return undefined
      }
      return {
        resolved,
        // A steer downgraded to enqueue (T-08536) waits BEHIND the running turn,
        // so the seat's next terminal may not be its turn: follow its own run.
        followSeat: steered.effectiveDoor !== 'enqueue',
        handoff: {
          sessionRef,
          scopeRef: resolved.scopeRef,
          laneRef: resolved.laneRef,
          hostSessionId: steered.hostSessionId,
          runtimeId: steered.runtimeId ?? '',
          runId: steered.runId,
          generation: steered.generation,
          fromSeq: steered.observation?.lifecycle.fromSeq ?? 0,
        },
      }
    }
  }
  if (queue && (waitMode === 'final' || ttlMs !== undefined)) {
    const enqueued = await withWaitDeadline(output, 'enqueue', (signal) =>
      client.enqueue(
        {
          ...submissionRequest,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(waitMode === 'final' ? { wait: true, turnPolicy: 'guarded' as const } : {}),
        },
        { signal: waitMode === 'final' ? signal : undefined }
      )
    )
    printJsonLine(enqueued)
    exitIfWaitedTurnFailed(enqueued)
    return undefined
  }
  const dispatch = await client.semanticTurnHandoff({
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
  if (isPendingSemanticTurnHandoff(dispatch)) {
    printJsonLine(dispatch)
    return undefined
  }
  const quiet = waitMode !== undefined ? opts.quiet !== false : opts.quiet === true
  if (!quiet) {
    writeDeliveryWarnings(dispatch.warnings)
    writeDeliveryOutcome(dispatch.delivery)
  }
  return { resolved, handoff: dispatch }
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

type TurnFailure = {
  result: 'turn_failed'
  runId: string | undefined
  eventKind: string
  hrcSeq: number
  errorCode: string | undefined
  code: string
  message: string | undefined
  diagnosticsSeq?: number | undefined
  retrieval?: string | undefined
}

/**
 * Events after which the watched run can never complete: `turn.failed` (e.g.
 * broker_start_failed) and a `first_turn_missing` trip, which makes the run
 * terminal server-side (a late turn.started never resurrects it).
 */
function turnFailureOf(event: HrcLifecycleEvent): TurnFailure | undefined {
  if (event.eventKind !== 'turn.failed' && event.eventKind !== 'first_turn_missing') {
    return undefined
  }
  const payload = isRecord(event.payload) ? event.payload : {}
  const payloadCode = typeof payload['code'] === 'string' ? payload['code'] : undefined
  const message = typeof payload['message'] === 'string' ? payload['message'] : undefined
  const firstTurnMissing = event.eventKind === 'first_turn_missing'
  return {
    result: 'turn_failed',
    runId: event.runId,
    eventKind: event.eventKind,
    hrcSeq: event.hrcSeq,
    errorCode: event.errorCode,
    code: payloadCode ?? event.errorCode ?? event.eventKind,
    message,
    ...(firstTurnMissing
      ? { diagnosticsSeq: event.hrcSeq, retrieval: `hrc runtime diagnostics ${event.hrcSeq}` }
      : {}),
  }
}

/** Report a failed turn on the active sink and exit with the error terminal's code. */
async function failTurn(
  failure: TurnFailure,
  aggregator: StackedAggregator | undefined,
  printFailureLine: boolean
): Promise<never> {
  const detail = `${failure.code}${failure.message !== undefined ? `: ${failure.message}` : ''}`
  const outcome = TERMINALS.error
  if (aggregator) {
    await aggregator.finish({
      phase: outcome.phase,
      flush: outcome.flush,
      exitCode: outcome.exitCode,
      result: outcome.result,
      error: { message: detail },
    })
  } else if (printFailureLine) {
    printJsonLine(failure)
  }
  throw new TurnExitError(outcome.exitCode, `turn failed: ${detail}`)
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
    return isCanonicalTurnCompletionFailure(event) ? 'error' : 'final'
  }
  if (event.eventKind === 'run_failed' || event.eventKind === 'turn.error') {
    return 'error'
  }
  if (event.eventKind === 'run_queued') {
    return prior ?? 'queued'
  }
  return prior === 'permission' || prior === 'error' ? prior : 'progress'
}

async function enrichFinalEvent(event: HrcLifecycleEvent): Promise<HrcLifecycleEvent> {
  return event
}
