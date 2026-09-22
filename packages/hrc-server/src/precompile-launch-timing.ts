import { createPhaseRecorder } from 'hrc-core'

import { recordLaunchSpan } from './request-metrics.js'
import { writeServerLog } from './server-log.js'

export type PrecompileLaunchTransport = 'headless' | 'interactive' | 'preview'

export type PrecompileLaunchTimingLogger = {
  info(message: string, fields: Record<string, unknown>): void
  warn(message: string, fields: Record<string, unknown>): void
}

export type PrecompileLaunchTimingContext = {
  transport: PrecompileLaunchTransport
  runtimeId: string
  stateRoot: string
  boundMs?: number | undefined
  logger: PrecompileLaunchTimingLogger
}

export const DEFAULT_PRECOMPILE_LAUNCH_BOUND_MS = 15_000

export function createPrecompileLaunchTimingContext(
  transport: PrecompileLaunchTransport,
  runtimeId: string,
  stateRoot: string
): PrecompileLaunchTimingContext {
  return {
    transport,
    runtimeId,
    stateRoot,
    boundMs: DEFAULT_PRECOMPILE_LAUNCH_BOUND_MS,
    logger: {
      info: (message, fields) => writeServerLog('INFO', message, fields),
      warn: (message, fields) => writeServerLog('WARN', message, fields),
    },
  }
}

export async function observePrecompileLaunchSpan<T>(
  phase: string,
  timing: PrecompileLaunchTimingContext,
  operation: () => Promise<T>
): Promise<T> {
  const recorder = createPhaseRecorder({
    sink: (record) => {
      if (record.status === 'warn') {
        emitTiming(timing.logger, 'warn', {
          phase,
          transport: timing.transport,
          runtimeId: timing.runtimeId,
          boundMs: record.limitMs,
          durMs: record.ms,
        })
      }
      if (record.ms !== undefined) emitSpan(timing, phase, record.ms)
    },
  })
  return recorder.step(
    phase,
    operation,
    timing.boundMs === undefined ? undefined : { limitMs: timing.boundMs }
  )
}

function emitTiming(
  logger: PrecompileLaunchTimingLogger,
  level: 'info' | 'warn',
  fields: Record<string, unknown>
): void {
  try {
    logger[level]('broker.timing', fields)
  } catch {
    // Timing diagnostics must never alter a launch outcome.
  }
}

/**
 * Emit one span to BOTH sinks: the log line (human breadcrumb, rotates) and the
 * metrics store (durable population behind `hrc admin metrics report`).
 */
function emitSpan(timing: PrecompileLaunchTimingContext, phase: string, durMs: number): void {
  emitTiming(timing.logger, 'info', {
    phase,
    transport: timing.transport,
    runtimeId: timing.runtimeId,
    durMs,
  })
  recordLaunchSpan(
    {
      phase,
      runtimeId: timing.runtimeId,
      ms: durMs,
      transport: timing.transport,
    },
    timing.stateRoot
  )
}
