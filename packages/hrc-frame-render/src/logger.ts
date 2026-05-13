type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogPayload = {
  message?: string | undefined
  trace?: Record<string, unknown> | undefined
  data?: Record<string, unknown> | undefined
  err?: Record<string, unknown> | undefined
}

function write(level: LogLevel, entry: Record<string, unknown>): void {
  if (level === 'debug' && process.env['LOG_LEVEL'] !== 'debug') {
    return
  }

  const line = JSON.stringify(entry)
  switch (level) {
    case 'debug':
    case 'info':
      console.log(line)
      return
    case 'warn':
      console.warn(line)
      return
    case 'error':
      console.error(line)
  }
}

export function createLogger(base: { component: string }) {
  const logAt = (level: LogLevel, event: string, payload: LogPayload = {}): void => {
    write(level, {
      level,
      component: base.component,
      event,
      ...payload,
      ts: new Date().toISOString(),
    })
  }

  return {
    debug: (event: string, payload?: LogPayload) => logAt('debug', event, payload),
    info: (event: string, payload?: LogPayload) => logAt('info', event, payload),
    warn: (event: string, payload?: LogPayload) => logAt('warn', event, payload),
    error: (event: string, payload?: LogPayload) => logAt('error', event, payload),
  }
}
