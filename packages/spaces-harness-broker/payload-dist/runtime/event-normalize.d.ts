/**
 * Event normalization — the single central event-safety path applied by the
 * invocation manager before an event is sequenced and notified.
 *
 * This module is deliberately NOT a redaction subsystem. It performs two
 * non-secret safety transforms that the runtime contract requires of every
 * broker event:
 *
 *   (b) Well-known payload normalization — constrain `invocation.started` to
 *       its canonical safe shape and normalize the terminal `invocation.ready`
 *       / `invocation.disposed` payloads regardless of what the emitter passed.
 *   (c) Deterministic size bounding — truncate oversized payloads against
 *       `maxEventBytes`, emitting a broker diagnostic describing what was cut.
 *
 * Secret/token scrubbing was removed with the redaction subsystem: secrets
 * never enter event payloads in the first place (lockedEnv/dispatchEnv are not
 * echoed into events; credentials live on disk via CODEX_HOME).
 */
import type { DiagnosticPayload, InvocationEventType } from 'spaces-harness-broker-protocol';
/**
 * Constrain `invocation.started` payloads to only contain safe fields:
 * pid, command, args, cwd.
 */
export declare function safeStartedPayload(payload: unknown): unknown;
export interface NormalizeEventPayloadInput {
    type: InvocationEventType;
    payload: unknown;
    maxEventBytes?: number | undefined;
}
export interface NormalizeEventPayloadResult {
    payload: unknown;
    diagnostics?: DiagnosticPayload[] | undefined;
}
/**
 * Normalize and size-bound an event payload before it is sequenced and emitted.
 * There is exactly one place that decides the canonical shape and the byte
 * budget of what leaves the broker:
 *
 * 1. Constrain `invocation.started` to {pid, command, args, cwd}.
 * 2. Normalize final-contract terminal payloads (`invocation.ready`,
 *    `invocation.disposed`) to their canonical shape regardless of emitter.
 * 3. Truncate oversized payloads deterministically against `maxEventBytes`,
 *    emitting a broker diagnostic describing what was truncated.
 *
 * Returns the safe payload plus any diagnostics the manager should emit as
 * follow-on events. Truncation is preferred over failing the invocation.
 */
export declare function normalizeEventPayload(input: NormalizeEventPayloadInput): NormalizeEventPayloadResult;
//# sourceMappingURL=event-normalize.d.ts.map