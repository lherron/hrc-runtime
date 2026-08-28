type ServerLogLevel = 'INFO' | 'WARN' | 'ERROR'

const SERVER_LOG_REDACT_KEY_PATTERN =
  /token|secret|password|passwd|pwd|auth|cookie|session|credential|api[_-]?key|access[_-]?key|refresh[_-]?token|bearer|oauth|client[_-]?secret/i

/**
 * Keys the pattern matches by accident, and that never carry a secret.
 *
 * `targetSessionRef` is an ADDRESS — the scope handle a message is going to —
 * and it matches only because the pattern covers `session`. Redacting it turned
 * every `wrkq.kicker.*` line into a log about nobody, which is how a delivery
 * gap on two nodes stayed unreadable while it was happening (T-07643). An
 * allowlist keeps the pattern's default-deny posture; nothing here may name a
 * value, only a key whose contents are already public vocabulary.
 *
 * `hostSessionId` is the same accident and the same cost. It is an opaque
 * identifier the CLI prints, the collaboration ledger stamps on every
 * presentation receipt, and the T-07650 audits settled on as their canonical
 * join key — precisely because a runtime id churns mid-session and a host
 * session does not. A daemon log that redacts the one column the audit joins on
 * cannot be reconciled against the ledger at all, which is what made the shadow
 * teardown's own line unreadable when it was first written.
 */
const SERVER_LOG_NEVER_REDACTED_KEYS = new Set(['targetSessionRef', 'hostSessionId'])

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
    if (
      key &&
      !SERVER_LOG_NEVER_REDACTED_KEYS.has(key) &&
      SERVER_LOG_REDACT_KEY_PATTERN.test(key)
    ) {
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
