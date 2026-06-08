import { readFileSync } from 'node:fs'

import { CliUsageError, parseDuration } from 'cli-kit'
import type { HrcLifecycleEvent, HrcMessageRecord, SemanticTurnHandoffResponse } from 'hrc-core'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { type RenderFrame, SessionEventsManager, adaptHrcLifecycleEvent } from 'hrc-frame-render'
import type { HrcClient } from 'hrc-sdk'

import { resolveCallerAddress, resolveScope, resolveTargetToSessionRef } from '../normalize.js'
import { printJson } from '../print.js'
import {
  type RenderFrameFormatInput,
  createTerminalFrameRenderer,
  resolveRenderFrameSinkFormat,
  writeRenderFrameAsNdjson,
} from '../render-frame.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'
import { type StackedAggregator, createStackedAggregator } from '../stacked-aggregator.js'
import { createStackedSummarizer } from '../stacked-summary.js'
import { FlushReason, Phase, Result } from '../stacked-types.js'

export type TurnOptions = {
  new?: boolean | undefined
  dryRun?: boolean | undefined
  format?: RenderFrameFormatInput | undefined
  pretty?: boolean | undefined
  stallAfter?: string | undefined
  file?: string | undefined
  stacked?: string | undefined
  follow?: string | undefined
  replyTo?: string | undefined
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

export async function cmdTurn(
  client: HrcClient,
  opts: TurnOptions,
  positionals: string[]
): Promise<void> {
  const targetInput = positionals[0]
  if (!targetInput) {
    throw new CliUsageError('missing required argument: <target>')
  }

  // ── Body mutex: exactly one source allowed ──
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

  const stallAfterMs = parseDuration(opts.stallAfter ?? '1h')
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

  // ── Resolve scope ──
  const resolved = resolveScope(targetInput)
  const sessionRef = resolveTargetToSessionRef(targetInput)
  const runtimeIntent = resolveRuntimeIntentForTarget(targetInput)

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
      bodySource: bodyFromFile ? 'file' : bodyFromStdin ? 'stdin' : 'positional',
      bodyLength: body.length,
      clearContextFirst: opts.new === true,
      replyToMessageId: opts.replyTo ?? null,
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
  if (!resolved.parsed.projectId) {
    throw new CliUsageError(
      [
        `cannot resolve a project for target "${targetInput}".`,
        `A turn must target an agent within a project, but none was found: the`,
        `target has no @<project> qualifier, ASP_PROJECT is unset, and the current`,
        `directory maps to no known project. Fix one of:`,
        `  • qualify the target:  hrcchat turn ${targetInput}@<project> "…"`,
        `  • set the env:         ASP_PROJECT=<project> hrcchat turn ${targetInput} "…"`,
        `  • run from a project:  cd ~/praesidium/<project> && hrcchat turn ${targetInput} "…"`,
      ].join('\n')
    )
  }

  // ── --new: clearContext if host exists ──
  if (opts.new) {
    try {
      const target = await client.getTarget(sessionRef)
      if (target.activeHostSessionId) {
        await client.clearContext({
          hostSessionId: target.activeHostSessionId,
          dropContinuation: true,
        })
      }
    } catch (err) {
      // Target doesn't exist yet — skip clearContext, let handoff create it
      if (!(err instanceof HrcDomainError && err.code === HrcErrorCode.UNKNOWN_SESSION)) {
        throw err
      }
    }
  }

  // ── Dispatch turn via semanticTurnHandoff ──
  // CRITICAL: watch filters come from handoff result (post-clearContext),
  // not from anything resolved before clearContext.
  const from = resolveCallerAddress()
  const to = { kind: 'session' as const, sessionRef }

  const handoff = await client.semanticTurnHandoff({
    from,
    to,
    body,
    runtimeIntent,
    createIfMissing: true,
    replyToMessageId: opts.replyTo,
  })

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
        stackedAggregator && isTurnEnd(event)
          ? await enrichFinalEvent(client, handoff, event)
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
      if (isTurnEnd(event)) {
        turnCompleted = true
        abortController.abort()
        break
      }

      // Runtime died before turn completed
      if (isRuntimeDead(event)) {
        await stackedAggregator?.finish({
          phase: Phase.Error,
          flush: FlushReason.Error,
          exitCode: TURN_EXIT_RUNTIME_DEAD,
          result: Result.RuntimeDead,
          error: { message: 'runtime exited before turn completed' },
        })
        throw new TurnExitError(TURN_EXIT_RUNTIME_DEAD, 'runtime exited before turn completed')
      }
    }
  } catch (err) {
    if (err instanceof TurnExitError) {
      throw err
    }
    // Turn completed — abort was intentional to close the follow stream
    if (turnCompleted) {
      // fall through to exit code determination below
    } else if (abortController.signal.aborted) {
      // AbortError from stall timer or SIGINT
      if (stallFired) {
        throw new TurnExitError(TURN_EXIT_STALL, 'stall-after timeout reached')
      }
      // SIGINT
      throw new TurnExitError(TURN_EXIT_SIGINT, 'interrupted')
    } else {
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
    await stackedAggregator?.finish({
      phase: Phase.Permission,
      flush: FlushReason.Permission,
      exitCode: TURN_EXIT_PERMISSION_BLOCKED,
      result: Result.PermissionBlocked,
    })
    throw new TurnExitError(
      TURN_EXIT_PERMISSION_BLOCKED,
      'turn blocked on permission request (no interactive approval in MVP)'
    )
  }

  if (lastPhase === 'error') {
    await stackedAggregator?.finish({
      phase: Phase.Error,
      flush: FlushReason.Error,
      exitCode: TURN_EXIT_RUNTIME_DEAD,
      result: Result.TurnError,
      error: { message: 'turn ended with error' },
    })
    throw new TurnExitError(TURN_EXIT_RUNTIME_DEAD, 'turn ended with error')
  }

  if (stackedAggregator && turnCompleted) {
    await stackedAggregator.finish({
      phase: Phase.Final,
      flush: FlushReason.Final,
      exitCode: 0,
      result: Result.Success,
    })
  }

  // exit 0 — success (implicit return)
}

function isTurnEnd(event: HrcLifecycleEvent): boolean {
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
  client: HrcClient,
  handoff: SemanticTurnHandoffResponse,
  event: HrcLifecycleEvent
): Promise<HrcLifecycleEvent> {
  const payload = isRecord(event.payload) ? event.payload : {}
  const payloadBody = typeof payload['body'] === 'string' ? payload['body'] : undefined
  const payloadReplyId =
    typeof payload['replyMessageId'] === 'string' ? payload['replyMessageId'] : undefined
  if (payloadBody !== undefined && payloadReplyId !== undefined) {
    return event
  }

  const reply = await findDurableReply(client, handoff.messageId)
  if (reply === undefined) {
    return event
  }

  return {
    ...event,
    payload: {
      ...payload,
      body: payloadBody ?? reply.body,
      replyMessageId: payloadReplyId ?? reply.messageId,
    },
  }
}

async function findDurableReply(
  client: HrcClient,
  requestMessageId: string
): Promise<HrcMessageRecord | undefined> {
  const maybeClient = client as HrcClient & {
    listMessages?: HrcClient['listMessages'] | undefined
  }
  if (typeof maybeClient.listMessages !== 'function') {
    return undefined
  }

  try {
    const result = await maybeClient.listMessages({
      thread: { rootMessageId: requestMessageId },
      phases: ['response'],
      limit: 1,
      order: 'desc',
    })
    return result.messages[0]
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
