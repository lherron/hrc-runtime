/**
 * Reads the daemon's server log in the logging standard's L2 shape (T-10854):
 * one JSON object per line on stdout, `{ts, level, component, event, data}`.
 * Tests capture or read the log through these helpers instead of slicing text.
 */

import { setServerLogWriter, writeServerLogPassthrough } from '../../server-log.js'

export type ServerLogLine = {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  component: string
  event: string
  data?: Record<string, unknown>
}

/** Parses log text; lines that are not a server-log object (test noise) are skipped. */
export function parseServerLog(text: string): ServerLogLine[] {
  const lines: ServerLogLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('{')) continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>)['event'] === 'string' &&
      typeof (value as Record<string, unknown>)['level'] === 'string'
    ) {
      lines.push(value as ServerLogLine)
    }
  }
  return lines
}

export type ServerLogCapture = {
  /** Everything parsed so far. */
  readonly lines: ServerLogLine[]
  /** Parsed lines for one event name. */
  events(event: string): ServerLogLine[]
  /** Each server-log line as its raw JSON text, for substring assertions. */
  rawLines(): string[]
  /** The raw captured text. */
  text(): string
  restore(): void
}

/**
 * Captures the server log through `setServerLogWriter`. With `passthrough`
 * the lines still reach the real stdout.
 */
export function captureServerLog(options: { passthrough?: boolean } = {}): ServerLogCapture {
  let text = ''
  const restore = setServerLogWriter((line) => {
    text += line
    if (options.passthrough === true) writeServerLogPassthrough(line)
  })
  return {
    get lines() {
      return parseServerLog(text)
    },
    events(event) {
      return parseServerLog(text).filter((line) => line.event === event)
    },
    rawLines: () => parseServerLog(text).map((line) => JSON.stringify(line)),
    text: () => text,
    restore,
  }
}

/** Runs `operation` with the server log captured, restoring stdout afterwards. */
export async function withServerLog<T>(
  operation: () => Promise<T>
): Promise<{ value: T; log: ServerLogCapture }> {
  const log = captureServerLog()
  try {
    return { value: await operation(), log }
  } finally {
    log.restore()
  }
}
