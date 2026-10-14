export type ServerLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

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

/**
 * The Praesidium logging standard's line shape (L2, `var/agents/references/logging.md`):
 * one JSON object per line, `{ts, level, component, event, data}`, with `data`
 * omitted when empty. `component` defaults to the event's first dotted segment.
 * Server lines go to stdout, so launchd's `hrc-server.log` is the server log and
 * `hrc-server.err.log` keeps only crash and runtime noise.
 */
export function formatServerLogLine(
  level: ServerLogLevel,
  event: string,
  data?: Record<string, unknown> | undefined,
  component?: string | undefined
): string {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: level.toLowerCase(),
    component: component ?? event.split('.', 1)[0],
    event,
  }
  if (data !== undefined && Object.keys(data).length > 0) line['data'] = data
  try {
    return `${JSON.stringify(line)}\n`
  } catch (error) {
    line['data'] = { serializationError: error instanceof Error ? error.message : String(error) }
    return `${JSON.stringify(line)}\n`
  }
}

// Bound once at load: code that swaps `process.stdout.write` for its own output
// (in-process CLI capture, cli-metrics byte counting) must not absorb daemon
// log lines. Tests read the log through `setServerLogWriter` instead.
const stdoutWrite = process.stdout.write.bind(process.stdout)
let serverLogWriter: (line: string) => void = (line) => {
  stdoutWrite(line)
}

/** Redirects server log lines (tests only); returns a restore function. */
export function setServerLogWriter(writer: (line: string) => void): () => void {
  const previous = serverLogWriter
  serverLogWriter = writer
  return () => {
    serverLogWriter = previous
  }
}

/** Writes a formatted line to the real stdout, bypassing any `setServerLogWriter`. */
export function writeServerLogPassthrough(line: string): void {
  stdoutWrite(line)
}

export function writeServerLog(
  level: ServerLogLevel,
  event: string,
  details?: Record<string, unknown> | undefined,
  options?: { component?: string | undefined } | undefined
): void {
  const data =
    details === undefined ? undefined : (redactForServerLog(details) as Record<string, unknown>)
  serverLogWriter(formatServerLogLine(level, event, data, options?.component))
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
