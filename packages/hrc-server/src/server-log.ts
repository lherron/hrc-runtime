type ServerLogLevel = 'INFO' | 'WARN' | 'ERROR'

const SERVER_LOG_REDACT_KEY_PATTERN =
  /token|secret|password|passwd|pwd|auth|cookie|session|credential|api[_-]?key|access[_-]?key|refresh[_-]?token|bearer|oauth|client[_-]?secret/i

export function writeServerLog(
  level: ServerLogLevel,
  event: string,
  details?: Record<string, unknown> | undefined
): void {
  const ts = new Date().toISOString()
  const detailSuffix =
    details === undefined ? '' : ` ${safeStringifyForServerLog(redactForServerLog(details))}`
  process.stderr.write(`${ts} [hrc-server] ${level} ${event}${detailSuffix}\n`)
}

function safeStringifyForServerLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    const rendered = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ serializationError: rendered })
  }
}

function redactForServerLog(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    if (key && SERVER_LOG_REDACT_KEY_PATTERN.test(key)) {
      return '[REDACTED]'
    }
    return value.length > 500 ? `${value.slice(0, 497)}...` : value
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return value
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split('\n').slice(0, 5).join('\n') } : {}),
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForServerLog(entry))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactForServerLog(entryValue, entryKey),
      ])
    )
  }

  return String(value)
}
