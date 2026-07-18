import { writeServerLog } from './server-log.js'

export type PrecompileLaunchTransport = 'headless' | 'interactive' | 'preview'

export type PrecompileLaunchTimingLogger = {
  info(message: string, fields: Record<string, unknown>): void
  warn(message: string, fields: Record<string, unknown>): void
}

export type PrecompileLaunchTimingContext = {
  transport: PrecompileLaunchTransport
  runtimeId: string
  boundMs?: number | undefined
  logger: PrecompileLaunchTimingLogger
}

export const DEFAULT_PRECOMPILE_LAUNCH_BOUND_MS = 15_000

export function createPrecompileLaunchTimingContext(
  transport: PrecompileLaunchTransport,
  runtimeId: string
): PrecompileLaunchTimingContext {
  return {
    transport,
    runtimeId,
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
  const startedAt = performance.now()
  let boundWarningEmitted = false
  let boundTimer: ReturnType<typeof setTimeout> | undefined

  if (timing.boundMs !== undefined) {
    boundTimer = setTimeout(() => {
      boundWarningEmitted = true
      emitTiming(timing.logger, 'warn', {
        phase,
        transport: timing.transport,
        runtimeId: timing.runtimeId,
        boundMs: timing.boundMs,
        durMs: performance.now() - startedAt,
      })
    }, timing.boundMs)
  }

  try {
    return await operation()
  } finally {
    if (boundTimer !== undefined) clearTimeout(boundTimer)
    const durMs = performance.now() - startedAt
    if (!boundWarningEmitted && timing.boundMs !== undefined && durMs >= timing.boundMs) {
      emitTiming(timing.logger, 'warn', {
        phase,
        transport: timing.transport,
        runtimeId: timing.runtimeId,
        boundMs: timing.boundMs,
        durMs,
      })
    }
    emitTiming(timing.logger, 'info', {
      phase,
      transport: timing.transport,
      runtimeId: timing.runtimeId,
      durMs,
    })
  }
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
