import type { HrcLifecycleEvent } from 'hrc-core'

/**
 * Shared helpers used by both the stacked aggregator and the stacked summarizer.
 *
 * These were previously duplicated verbatim across stacked-aggregator.ts and
 * stacked-summary.ts; centralizing them ensures a redaction-rule fix applies to
 * every code path that emits secrets.
 */

export function redactSecrets(value: string): string {
  return value
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/sk-ant-[^\s"'`\\]+/g, '[REDACTED]')
    .replace(/Bearer\s+eyJ[^\s"'`\\]+/g, 'Bearer [REDACTED]')
    .replace(/\b(password|api_key|apikey|token|secret)=([^\s"'`\\&]+)/gi, '$1=[REDACTED]')
}

export function mechanicalSummary(events: HrcLifecycleEvent[], phase: string): string {
  let lastTool: string | undefined
  for (const event of events) {
    const toolName = isRecord(event.payload) ? event.payload['toolName'] : undefined
    if (typeof toolName === 'string') {
      lastTool = toolName
    }
  }
  return `${events.length} events; last tool: ${lastTool ?? 'none'}; phase: ${phase}`
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const sharedTextEncoder = new TextEncoder()

/**
 * Truncate by character count, appending `marker` when the cap is exceeded.
 * The marker is load-bearing in the NDJSON contract, so callers pass it
 * explicitly and the emitted bytes must stay identical.
 */
export function truncateChars(value: string, cap: number, marker: string): string {
  if (value.length <= cap) {
    return value
  }
  return `${value.slice(0, Math.max(0, cap - marker.length))}${marker}`
}

/**
 * Truncate by encoded byte count, appending the newline-prefixed `[truncated]`
 * marker. The byte cap is intentionally distinct from the char-cap variant.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  const encoded = sharedTextEncoder.encode(value)
  if (encoded.byteLength <= maxBytes) {
    return value
  }
  const marker = '\n[truncated]'
  const room = Math.max(0, maxBytes - marker.length)
  let bounded = value.slice(0, room)
  while (sharedTextEncoder.encode(bounded).byteLength > room) {
    bounded = bounded.slice(0, -1)
  }
  return `${bounded}${marker}`
}
