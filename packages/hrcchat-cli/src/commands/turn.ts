import { readFileSync } from 'node:fs'

import { resolveScopeInput } from 'agent-scope'
import { CliUsageError, parseDuration } from 'cli-kit'
import type { HrcLifecycleEvent } from 'hrc-core'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { type RenderFrame, SessionEventsManager, adaptHrcLifecycleEvent } from 'hrc-frame-render'
import type { HrcClient } from 'hrc-sdk'

import { resolveCallerAddress, resolveTargetToSessionRef } from '../normalize.js'
import {
  type RenderFrameFormatInput,
  createTerminalFrameRenderer,
  resolveRenderFrameSinkFormat,
  writeRenderFrameAsNdjson,
} from '../render-frame.js'
import { resolveRuntimeIntentForTarget } from '../resolve-intent.js'

export type TurnOptions = {
  new?: boolean | undefined
  format?: RenderFrameFormatInput | undefined
  pretty?: boolean | undefined
  stallAfter?: string | undefined
  file?: string | undefined
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

  const stallAfterMs = parseDuration(opts.stallAfter ?? '5m')

  // ── Resolve scope ──
  const resolved = resolveScopeInput(targetInput, 'main')
  const sessionRef = resolveTargetToSessionRef(targetInput)

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
  const runtimeIntent = resolveRuntimeIntentForTarget(targetInput)

  const handoff = await client.semanticTurnHandoff({
    from,
    to,
    body,
    runtimeIntent,
    createIfMissing: true,
  })

  // ── Resolve sink format ──
  // --pretty forces terminal/tree format regardless of TTY detection, so
  // headless invocations can render the same human-facing output.
  const effectiveFormat: RenderFrameFormatInput | undefined = opts.pretty ? 'tree' : opts.format
  const sinkFormat = resolveRenderFrameSinkFormat({
    format: effectiveFormat,
    isTTY: process.stdout.isTTY === true,
  })

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

  // SIGINT handler
  const sigintHandler = () => {
    abortController.abort()
  }
  process.on('SIGINT', sigintHandler)

  // Stall timer
  let stallFired = false
  const stallTimer = setTimeout(() => {
    stallFired = true
    abortController.abort()
  }, stallAfterMs)

  // For --pretty in headless mode we still want in-place redraw rather than
  // stamped scrollback. opts.pretty implies inPlace=true; otherwise honor TTY.
  const terminalRenderer =
    sinkFormat === 'terminal'
      ? createTerminalFrameRenderer({
          scopeHandle: targetInput,
          titleFallback: body,
          ...(opts.pretty ? { inPlace: true, color: true } : {}),
        })
      : undefined

  const manager = new SessionEventsManager(
    'hrcchat-turn',
    (_sessionRef, _projectId, _runId, frame) => {
      lastPhase = frame.phase
      if (terminalRenderer) {
        terminalRenderer.write(frame)
      } else {
        writeRenderFrameAsNdjson(frame)
      }
    }
  )

  manager.subscribe(handoff.sessionRef, resolved.parsed.projectId ?? '')

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
      const envelope = adaptHrcLifecycleEvent(event)
      if (envelope) {
        manager.receive(envelope)
      }

      // Check for terminal events
      if (isTurnEnd(event)) {
        turnCompleted = true
        abortController.abort()
        break
      }

      // Runtime died before turn completed
      if (isRuntimeDead(event)) {
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
    clearTimeout(stallTimer)
    process.removeListener('SIGINT', sigintHandler)
  }

  // ── Determine exit code from final state ──
  if (lastPhase === 'permission') {
    throw new TurnExitError(
      TURN_EXIT_PERMISSION_BLOCKED,
      'turn blocked on permission request (no interactive approval in MVP)'
    )
  }

  if (lastPhase === 'error') {
    throw new TurnExitError(TURN_EXIT_RUNTIME_DEAD, 'turn ended with error')
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
