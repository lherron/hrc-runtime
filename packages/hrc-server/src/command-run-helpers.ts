import { createHash } from 'node:crypto'
import {
  HrcBadRequestError,
  type HrcCommandLaunchSpec,
  HrcErrorCode,
  HrcInternalError,
  type HrcSessionRecord,
  type LaunchCommandScopedRunResponse,
} from 'hrc-core'
import { runBoundedSubprocess } from './bounded-subprocess.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstance } from './index.js'
import { writeServerLog } from './server-log.js'
import { parseSessionRef } from './server-parsers.js'
import { timestamp } from './server-util.js'

/**
 * A configured command-run is a whole job, not a probe, so the bound is an
 * hour: long enough for any healthy build or script, and still an end for one
 * that wedged and would otherwise hold its run open forever.
 */
const COMMAND_RUN_TIMEOUT_MS = 60 * 60 * 1000

export type CommandRunProcessResult = {
  exitCode: number | null
  signal: string | null
  errorMessage?: string | undefined
}

export function commandRunOperationId(idempotencyKey: string): string {
  return `command-run:${idempotencyKey}`
}

export function commandRunId(idempotencyKey: string): string {
  return `run-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

export function commandRunResponseFromRun(
  run: {
    runId: string
    hostSessionId: string
    runtimeId?: string | undefined
    generation: number
    transport: string
  },
  replayed: boolean
): LaunchCommandScopedRunResponse {
  if (!run.runtimeId) {
    throw new HrcInternalError('command-run dispatch is missing runtime identity', {
      runId: run.runId,
    })
  }
  if (run.transport !== 'tmux' && run.transport !== 'headless' && run.transport !== 'sdk') {
    throw new HrcInternalError('command-run dispatch has unsupported transport', {
      runId: run.runId,
      transport: run.transport,
    })
  }
  return {
    runId: run.runId,
    hostSessionId: run.hostSessionId,
    runtimeId: run.runtimeId,
    generation: run.generation,
    transport: run.transport,
    replayed,
  }
}

export function parseCommandRunSessionRef(sessionRef: string): {
  scopeRef: string
  laneRef: string
} {
  const normalized = sessionRef.trim()
  const laneMarker = '/lane:'
  const laneIndex = normalized.lastIndexOf(laneMarker)
  if (laneIndex < 0) {
    return parseSessionRef(normalized)
  }

  const scopeRef = normalized.slice(0, laneIndex).replaceAll('/', ':').trim()
  const laneRef = normalized.slice(laneIndex + laneMarker.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must include scopeRef and laneRef',
      { sessionRef }
    )
  }
  return { scopeRef, laneRef }
}

export async function runConfiguredCommand(
  command: HrcCommandLaunchSpec,
  binding: Record<string, string>,
  stdinJson: unknown
): Promise<CommandRunProcessResult> {
  const argv = command.argv
  if (!argv || argv.length === 0) {
    throw new HrcInternalError('configured command-run target has no argv')
  }

  const env = { ...process.env } as Record<string, string | undefined>
  for (const key of command.unsetEnv ?? []) {
    delete env[key]
  }
  if (command.pathPrepend && command.pathPrepend.length > 0) {
    env['PATH'] = `${command.pathPrepend.join(':')}:${env['PATH'] ?? ''}`
  }
  Object.assign(env, command.env ?? {}, binding)

  const executable = argv[0]
  if (!executable) {
    throw new HrcInternalError('configured command-run target has no executable')
  }

  // A timeout rejects with SubprocessTimeoutError, which the caller records as
  // a failed run.
  const result = await runBoundedSubprocess(argv, {
    cwd: command.cwd,
    env,
    timeoutMs: COMMAND_RUN_TIMEOUT_MS,
    stdin: stdinJson === undefined ? '' : `${JSON.stringify(stdinJson)}\n`,
    stdout: 'ignore',
    stderrTailChars: 4096,
  })
  const stderr = result.stderr.trim()
  return {
    exitCode: result.signalCode === null ? result.exitCode : null,
    signal: result.signalCode,
    ...(stderr.length > 0 ? { errorMessage: stderr } : {}),
  }
}

export async function finalizeConfiguredCommandRun(
  server: HrcServerInstance,
  input: {
    command: HrcCommandLaunchSpec
    binding: Record<string, string>
    stdinJson: unknown
    configuredTargetId: string
    session: HrcSessionRecord
    runtimeId: string
    runId: string
    transport: 'tmux'
  }
): Promise<void> {
  let result: CommandRunProcessResult
  try {
    result = await runConfiguredCommand(input.command, input.binding, input.stdinJson)
  } catch (error) {
    result = {
      exitCode: 1,
      signal: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }

  const completedAt = timestamp()
  const exitCode = result.exitCode ?? (result.signal ? 128 : 1)
  const status = exitCode === 0 ? 'completed' : 'failed'
  const errorMessage =
    result.errorMessage ?? `command-run exited with status ${String(result.exitCode)}`
  server.db.runs.markCompleted(input.runId, {
    status,
    completedAt,
    updatedAt: completedAt,
    ...(status === 'failed'
      ? {
          errorCode: HrcErrorCode.INTERNAL_ERROR,
          errorMessage,
        }
      : {}),
  })
  server.db.runtimes.updateRunId(input.runtimeId, undefined, completedAt)
  server.db.runtimes.updateStatus(input.runtimeId, 'terminated', completedAt)

  if (status === 'failed') {
    writeServerLog('ERROR', 'command_run.failed', {
      runId: input.runId,
      runtimeId: input.runtimeId,
      configuredTargetId: input.configuredTargetId,
      hostSessionId: input.session.hostSessionId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      sessionRef: `${input.session.scopeRef}/lane:${input.session.laneRef}`,
      errorMessage,
      exitCode,
      signal: result.signal,
    })
  }

  server.notifyEvent(
    appendHrcEvent(server.db, 'command_run.exited', {
      ts: completedAt,
      hostSessionId: input.session.hostSessionId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      generation: input.session.generation,
      runtimeId: input.runtimeId,
      runId: input.runId,
      transport: input.transport,
      payload: {
        configuredTargetId: input.configuredTargetId,
        binding: input.binding,
        status,
        exitCode,
        signal: result.signal,
      },
    })
  )
}
