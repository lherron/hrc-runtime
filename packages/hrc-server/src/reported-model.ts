/**
 * Codex-reported model identity (T-08583).
 *
 * The harness broker attaches the model Codex actually ran to every
 * `usage.updated` event (`payload.model = { id, source }`, T-08430). HRC
 * stores the latest reported identity on the runtime's opaque
 * `runtimeStateJson` under `reportedModel` and surfaces it in
 * `hrc runtime inspect` as the *reported* model — never as a fallback for,
 * or merge with, the planned model or the `provider` harness-family label.
 *
 * Omission carries no claim: when the driver has no truthful source it omits
 * `model`, and HRC stores nothing (and never clears a prior identity).
 */
import type { HrcReportedModelIdentity } from 'hrc-core'

export const REPORTED_MODEL_STATE_KEY = 'reportedModel'

const REPORTED_MODEL_SOURCES = new Set(['provider-response', 'harness-config'])

/** True iff the value is a well-formed broker-reported model identity. */
export function isReportedModelIdentity(value: unknown): value is HrcReportedModelIdentity {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['source'] === 'string' &&
    REPORTED_MODEL_SOURCES.has(record['source'])
  )
}

/**
 * Read the reported identity off a runtime's opaque state blob. Returns null
 * when nothing well-formed was reported — never a fallback.
 */
export function readReportedModelIdentity(
  runtimeStateJson: Record<string, unknown> | undefined
): HrcReportedModelIdentity | null {
  const raw = runtimeStateJson?.[REPORTED_MODEL_STATE_KEY]
  if (!isReportedModelIdentity(raw)) return null
  return { id: raw.id, source: raw.source }
}
