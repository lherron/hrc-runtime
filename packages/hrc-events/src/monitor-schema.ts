/**
 * Monitor-domain event schema.
 *
 * Defines the shape of stdout lines emitted by `hrc monitor` (§10 of
 * MONITOR_PROPOSAL.md) and the result / failure-kind discriminators
 * mandated by FROZEN answers Q2 and Q5.
 *
 * These are the *monitor output* types, distinct from the hook-derived
 * session events in events.ts / schemas.ts. Hook-derived events flow
 * through normalizers; monitor events are what the operator sees.
 */

import { z } from 'zod'

// ============================================================================
// Result discriminator  (FROZEN Q2)
// ============================================================================

/**
 * All possible `result` values in a monitor final event.
 *
 * Operators match on this to decide next action. Scripts match on exit
 * code (0/1/2/3/4) for the coarse branch and inspect `result` for the
 * precise sub-case.
 */
export const MonitorResult = [
  'turn_succeeded',
  'turn_failed',
  'runtime_dead',
  'runtime_crashed',
  'response',
  'idle_no_response',
  'already_idle',
  'already_busy',
  'no_active_turn',
  'context_changed',
  'timeout',
  'stalled',
  'monitor_error',
] as const

export type MonitorResult = (typeof MonitorResult)[number]

export const MonitorResultSchema = z.enum(MonitorResult)

// ============================================================================
// Failure-kind discriminator  (FROZEN Q2)
// ============================================================================

/**
 * When `result` is `turn_failed`, `runtime_dead`, or `runtime_crashed`,
 * the monitor final event also carries a `failureKind` to classify the
 * root cause — when determinable.
 *
 * `unknown` is emitted when the harness does not provide enough signal
 * to classify. We never guess success.
 */
export const MonitorFailureKind = [
  'model',
  'tool',
  'process',
  'runtime',
  'cancelled',
  'unknown',
] as const

export type MonitorFailureKind = (typeof MonitorFailureKind)[number]

export const MonitorFailureKindSchema = z.enum(MonitorFailureKind)

// ============================================================================
// Context-changed reason discriminator  (FROZEN Q5)
// ============================================================================

/**
 * When `result` is `context_changed` (exit code 4), the `reason` field
 * tells the operator *why* the context is no longer valid.
 */
export const ContextChangedReason = ['session_rebound', 'generation_changed', 'cleared'] as const

export type ContextChangedReason = (typeof ContextChangedReason)[number]

export const ContextChangedReasonSchema = z.enum(ContextChangedReason)

// ============================================================================
// Monitor event names  (§10 stable set)
// ============================================================================

/**
 * Stable event names emitted on stdout, one per line.
 *
 * The list is intentionally extensible (new events may be added in
 * future phases) but existing names are frozen once shipped.
 */
export const MonitorEventName = [
  'monitor.snapshot',
  'turn.started',
  'turn.finished',
  'runtime.idle',
  'runtime.busy',
  'runtime.crashed',
  'runtime.dead',
  'message.response',
  'monitor.completed',
  'monitor.stalled',
] as const

export type MonitorEventName = (typeof MonitorEventName)[number]

export const MonitorEventNameSchema = z.enum(MonitorEventName)

// ============================================================================
// ISO-8601 timestamp refinement
// ============================================================================

const isoTimestampSchema = z.string().refine(
  (value) => {
    const d = new Date(value)
    return !Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(value)
  },
  { message: 'Expected an ISO-8601 timestamp' }
)

// ============================================================================
// Monitor event envelope  (§10 JSON line shape)
// ============================================================================

/**
 * The JSON shape of a single stdout line in `--output json` mode.
 *
 * Every event includes `event`, `selector`, `replayed`, and `ts`.
 * Optional fields are present only when relevant to the event kind.
 */
export const MonitorEventSchema = z.object({
  /** Stable event name. */
  event: MonitorEventNameSchema,

  /** Canonical selector string that scoped this monitor. */
  selector: z.string(),

  /** Runtime that emitted the underlying signal, if applicable. */
  runtimeId: z.string().optional(),

  /** Turn correlated with this event, if applicable. */
  turnId: z.string().optional(),

  /** Result discriminator — present on terminal / completion events. */
  result: MonitorResultSchema.optional(),

  /** Failure classification — present when result indicates failure. */
  failureKind: MonitorFailureKindSchema.optional(),

  /** Context-changed sub-reason — present when result is context_changed. */
  reason: ContextChangedReasonSchema.optional(),

  /** Whether this event was replayed from the event log (vs live). */
  replayed: z.boolean(),

  /** Process exit code that will accompany this event, if applicable. */
  exitCode: z.number().int().optional(),

  /** ISO-8601 timestamp of event emission. */
  ts: isoTimestampSchema,
})

export type MonitorEvent = z.infer<typeof MonitorEventSchema>
