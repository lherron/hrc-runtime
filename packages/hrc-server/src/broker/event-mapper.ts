/**
 * BrokerEventMapper (T-01690 Wave W3A / T-01696).
 *
 * The SOLE interpreter of broker `InvocationEventEnvelope` payloads. Given a
 * normalized broker event, it resolves projection context from the persisted
 * broker invocation and, in ONE SQLite transaction:
 *   1. appends the broker event by `(invocationId, seq)` via the W1B idempotent
 *      append repo (`BrokerInvocationEventRepository.appendEvent`);
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits HRC events with `source: 'broker'` via `EventRepository.append`;
 *   4. marks the broker event row `projection_status = 'applied'`.
 *
 * Contract invariants (pinned by broker-event-mapper.test.ts):
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     `BrokerInvocationEventConflictError`, NO projection;
 *   - `source:'broker'` on every emitted HRC event.
 *
 * W1A broker-path boundary: this module imports ONLY persistence
 * (`hrc-store-sqlite`), domain contracts (`hrc-core`), and broker protocol TYPES
 * (`spaces-harness-broker-protocol`). It MUST NOT import launch/exec.ts,
 * spaces-harness-codex, or spaces-harness-broker internals, and never
 * launches/execs anything. It is inert unless invoked by the W3B controller,
 * which is unreachable unless `HRC_HEADLESS_CODEX_BROKER_ENABLED` is set.
 */
import type {
  HrcContinuationRef,
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcProvider,
} from 'hrc-core'
import type {
  AgentMessageEvent,
  ContentBlock,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResult,
} from 'hrc-events'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  AssistantMessageCompletedPayload,
  AssistantMessageDeltaPayload,
  ContinuationUpdate,
  InvocationEventEnvelope,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  TerminalSurfaceReportedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
  TurnFailedPayload,
} from 'spaces-harness-broker-protocol'

import { appendHrcEvent } from '../hrc-event-helper'

/**
 * Broker event type -> canonical HRC lifecycle `event_kind`. The `events` table
 * mirror carries every broker event under a `broker.<type>` kind for provenance,
 * but the lifecycle stream (`hrc_events`, served by `/v1/events`) is what every
 * client consumes: hrcchat `turn` / `monitor wait` follow it and gate on these
 * canonical kinds, and `notifyEvent` only finalizes the semantic turn on a
 * `turn.completed` lifecycle event. A broker event with no mapping here is
 * provenance-only (no lifecycle row) (T-01711). Mapped kinds MUST exist in
 * `hrc-event-helper`'s KIND_CATEGORIES or `appendHrcEvent` throws.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coerce the broker `tool.call.completed.result` field (typed `unknown`) into
 * the canonical hrc-events `ToolResult` shape. Broker drivers emit
 * driver-specific result blobs (e.g. codex's `command` tool returns
 * `{output, exitCode}`); the lifecycle stream uses the hook-derived
 * `{content: ContentBlock[]}` shape consumers already know how to render.
 */
function toolResultFromBrokerResult(result: unknown): ToolResult {
  if (isRecord(result) && Array.isArray(result['content'])) {
    const content = result['content']
    if (content.every((item) => isRecord(item) && typeof item['type'] === 'string')) {
      return result as unknown as ToolResult
    }
  }
  const text =
    typeof result === 'string'
      ? result
      : isRecord(result) && typeof result['output'] === 'string'
        ? result['output']
        : result === undefined || result === null
          ? ''
          : safeStringify(result)
  const block: ContentBlock = { type: 'text', text }
  const details = isRecord(result) ? result : undefined
  return details === undefined ? { content: [block] } : { content: [block], details }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const BROKER_TO_HRC_KIND: Partial<Record<string, string>> = {
  'input.accepted': 'turn.accepted',
  'turn.started': 'turn.started',
  'assistant.message.completed': 'turn.message',
  'tool.call.started': 'turn.tool_call',
  'tool.call.completed': 'turn.tool_result',
  'tool.call.failed': 'turn.tool_result',
  'turn.completed': 'turn.completed',
  // Failed/interrupted have no registered lifecycle kind; surface them as a
  // terminal turn.completed (payload carries success:false) so client waiters
  // unblock — run state already records failed/cancelled via projectState.
  'turn.failed': 'turn.completed',
  'turn.interrupted': 'turn.completed',
}

export type BrokerEventMapperDeps = {
  db: HrcDatabase
  now?: () => string
}

export type BrokerProjectionResult = {
  /** True when the (invocationId, seq) was already applied with the same payload. */
  idempotent: boolean
  /** Raw `events`-table mirror appended this call (each `source:'broker'`); empty on idempotent re-apply. */
  events: HrcEventEnvelope[]
  /**
   * Canonical `hrc_events` lifecycle events appended this call (the ones the
   * server `notifyEvent`s to follow-stream subscribers and uses to finalize the
   * semantic turn). Empty on idempotent re-apply or for provenance-only events.
   */
  lifecycleEvents: HrcLifecycleEvent[]
}

/** Resolved projection context for a single invocation. */
type ProjectionContext = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  operationId: string
  runId: string | undefined
}

export class BrokerEventMapper {
  private readonly db: HrcDatabase
  private readonly now: () => string

  constructor(deps: BrokerEventMapperDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /**
   * Append + project a single broker event in one transaction. Synchronous: the
   * persistence layer is synchronous and the whole operation must commit (event
   * row + state) or roll back together.
   */
  apply(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    const run = this.db.sqlite.transaction(() => this.project(envelope))
    return run()
  }

  private project(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    const db = this.db
    const now = this.now()

    const invocation = db.brokerInvocations.getByInvocationId(envelope.invocationId)
    if (!invocation) {
      throw new Error(`broker invocation not found for event: ${envelope.invocationId}`)
    }
    const runtime = db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (!runtime) {
      throw new Error(`runtime not found for broker invocation: ${invocation.runtimeId}`)
    }

    // ── Broker FIFO queue correlation (order-robust resolution) ─────────────
    // Resolve runId by finding the most recent input.accepted at seq <=
    // envelope.seq and looking up the run HRC dispatched with that inputId.
    // The broker emits a strictly-monotonic seq, so for ANY event, the
    // "currently-being-applied input" is the highest-seq input.accepted that
    // precedes (or equals) it. This is robust to out-of-order arrival in
    // HRC's controller: even if turn.completed (seq N) arrives after a later
    // input.accepted (seq N+1) for the next queued input, the lookup filter
    // `seq <= N` still picks the correct prior input.accepted. Falls back to
    // invocation.runId when there's no preceding input.accepted (rare) or
    // when the run wasn't dispatched through the broker-input path (e.g. the
    // initial start-turn input on a fresh invocation, where the start path
    // pre-sets invocation.runId correctly).
    const resolvedRunId = this.resolveRunIdForEvent(envelope, invocation.runId)

    const ctx: ProjectionContext = {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      operationId: invocation.operationId,
      runId: resolvedRunId,
    }

    // (a) Idempotent append keyed by (invocationId, seq). A duplicate with the
    // same payload short-circuits with no projection; a divergent payload throws
    // BrokerInvocationEventConflictError, which propagates and rolls the tx back.
    const appended = db.brokerInvocationEvents.appendEvent({
      invocationId: envelope.invocationId,
      seq: envelope.seq,
      time: envelope.time,
      type: envelope.type,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      payload: envelope.payload,
    })

    if (appended.idempotent) {
      return { idempotent: true, events: [], lifecycleEvents: [] }
    }

    // (b) Project state into HRC, then emit the raw provenance mirror plus the
    // canonical lifecycle event (the latter is what clients/notifyEvent see).
    this.projectState(envelope, ctx, now)
    const emitted = this.emit(envelope, ctx, now)
    const lifecycleEvent = this.emitLifecycle(envelope, ctx, now)

    // (c) Record projection outcome on the broker event row.
    db.brokerInvocationEvents.updateProjection(envelope.invocationId, envelope.seq, {
      hrcEventSeq: emitted.seq,
      projectionStatus: 'applied',
    })

    return {
      idempotent: false,
      events: [emitted],
      lifecycleEvents: lifecycleEvent ? [lifecycleEvent] : [],
    }
  }

  /**
   * Resolve the runId this event belongs to, robust to out-of-order projection.
   *
   * Strategy: find the most-recent `input.accepted` at seq <= envelope.seq for
   * this invocation and resolve the run HRC dispatched with that inputId
   * (runs.dispatched_input_id). For the input.accepted event itself, the
   * envelope's own inputId is used (avoids a redundant DB hit AND covers the
   * case where appendEvent for the current envelope hasn't been written yet).
   *
   * Why per-event time-travel beats a stateful runId-flip: the controller's
   * `for await ... of` does pull envelopes sequentially, but envelopes
   * delivered by the broker client at the same millisecond can race past it
   * out of seq order (broker_invocation_events row evidence shows
   * input.accepted seq 53 projected before its preceding turn.completed seq
   * 52). A stateful flip would then misroute seq 52 onto run N+1. Time-travel
   * lookup uses the immutable seq order regardless of arrival order.
   *
   * Falls back to fallbackRunId (invocation.runId) when no input.accepted
   * precedes this event or when the matched input lacks a dispatched run
   * (e.g. the initial start-turn input on a fresh invocation — that path
   * pre-sets invocation.runId correctly).
   */
  private resolveRunIdForEvent(
    envelope: InvocationEventEnvelope,
    fallbackRunId: string | undefined
  ): string | undefined {
    // Prefer envelope.inputId when the broker sets it: input.accepted /
    // input.queued / input.rejected always carry it (contract), and
    // input.queued specifically refers to the QUEUED input — its seq-based
    // prior-input.accepted lookup would wrongly resolve to the currently-
    // running input. For events without envelope.inputId (turn.*, assistant.*,
    // diagnostics, etc.), find the most-recent input.accepted at seq <=
    // envelope.seq — that's the input currently being applied by the driver.
    const envelopeInputId =
      envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    const inputId =
      envelopeInputId ??
      this.findPriorInputAcceptedInputId(envelope.invocationId, envelope.seq)
    if (inputId !== undefined) {
      const run = this.db.runs.getByDispatchedInputId(inputId)
      if (run?.runId) return run.runId
    }
    return fallbackRunId
  }

  private extractInputIdFromPayload(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'inputId' in payload) {
      const v = (payload as { inputId?: unknown }).inputId
      return typeof v === 'string' ? v : undefined
    }
    return undefined
  }

  private findPriorInputAcceptedInputId(
    invocationId: string,
    seq: number
  ): string | undefined {
    // json_extract on broker_event_json (the payload, which carries inputId
    // on input.accepted per broker contract). Filtering on type='input.accepted'
    // before json_extract keeps this O(log n) via the (invocation_id, seq) index.
    const row = this.db.sqlite
      .query<{ inputId: string | null }, [string, number]>(
        `SELECT json_extract(broker_event_json, '$.inputId') AS inputId
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'input.accepted' AND seq <= ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId ?? undefined
  }

  /** Apply the type-specific state mutation. Emission is handled separately. */
  private projectState(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    const { runId } = ctx

    switch (envelope.type) {
      // ── Invocation lifecycle -> runtime linkage + invocation state ──────────
      case 'invocation.started': {
        db.runtimes.update(ctx.runtimeId, {
          activeInvocationId: invocationId,
          activeOperationId: ctx.operationId,
          lastActivityAt: now,
          updatedAt: now,
        })
        db.brokerInvocations.update(invocationId, { invocationState: 'starting', updatedAt: now })
        break
      }
      case 'invocation.ready': {
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'invocation.stopping': {
        db.brokerInvocations.update(invocationId, { invocationState: 'stopping', updatedAt: now })
        break
      }
      case 'invocation.exited': {
        db.brokerInvocations.update(invocationId, { invocationState: 'exited', updatedAt: now })
        break
      }
      case 'invocation.failed': {
        db.brokerInvocations.update(invocationId, { invocationState: 'failed', updatedAt: now })
        break
      }
      case 'invocation.disposed': {
        db.brokerInvocations.update(invocationId, { invocationState: 'disposed', updatedAt: now })
        break
      }

      // ── Input disposition -> run touch ──────────────────────────────────────
      case 'input.accepted':
      case 'input.rejected':
      case 'input.queued': {
        if (runId !== undefined) {
          db.runs.update(runId, { updatedAt: now })
        }
        break
      }

      // ── Turn lifecycle -> run state + invocation turn state ─────────────────
      case 'turn.started': {
        if (runId !== undefined) {
          db.runs.update(runId, { status: 'running', startedAt: now, updatedAt: now })
        }
        db.brokerInvocations.update(invocationId, {
          invocationState: 'turn_active',
          updatedAt: now,
        })
        break
      }
      case 'turn.completed': {
        if (runId !== undefined) {
          db.runs.markCompleted(runId, { status: 'completed', completedAt: now, updatedAt: now })
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.failed': {
        const payload = envelope.payload as TurnFailedPayload
        if (runId !== undefined) {
          db.runs.markCompleted(runId, {
            status: 'failed',
            completedAt: now,
            updatedAt: now,
            errorMessage: payload.message,
          })
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.interrupted': {
        if (runId !== undefined) {
          db.runs.markCompleted(runId, { status: 'cancelled', completedAt: now, updatedAt: now })
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }

      // ── Assistant output -> runtime buffer (text projection) ────────────────
      case 'assistant.message.completed': {
        const payload = envelope.payload as AssistantMessageCompletedPayload
        const text = payload.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
        this.appendBuffer(ctx, text, now)
        break
      }
      case 'assistant.message.delta': {
        const payload = envelope.payload as AssistantMessageDeltaPayload
        this.appendBuffer(ctx, payload.text, now)
        break
      }
      case 'assistant.message.started': {
        // No text yet; the emitted HRC event records the message start.
        break
      }

      // ── Tool activity -> emitted HRC event only (eventJson carries id+name) ──
      case 'tool.call.started':
      case 'tool.call.delta':
      case 'tool.call.completed':
      case 'tool.call.failed': {
        break
      }

      // ── Continuation -> DUAL write: runtime AND session (must-not-miss) ─────
      case 'continuation.updated': {
        const payload = envelope.payload as ContinuationUpdate
        const continuation: HrcContinuationRef = {
          provider: payload.provider as HrcProvider,
          key: payload.key,
        }
        db.runtimes.update(ctx.runtimeId, {
          continuation,
          lastActivityAt: now,
          updatedAt: now,
        })
        db.sessions.updateContinuation(ctx.hostSessionId, continuation, now)
        break
      }

      // ── Terminal surface binding ────────────────────────────────────────────
      case 'terminal.surface.reported': {
        const payload = envelope.payload as TerminalSurfaceReportedPayload
        // A `tmux-pane` lease is keyed by its pane id — the stable, unique lease
        // identifier (paneId is non-optional for tmux-pane). The legacy
        // `tmux-session` surface keeps the socket#session composite key, which a
        // pane lease must never use (it would emit `#undefined` when sessionName
        // is absent and would not be the pane id).
        const surfaceId =
          payload.kind === 'tmux-pane'
            ? payload.paneId
            : `${payload.socketPath}#${payload.sessionName}`
        db.surfaceBindings.bind({
          surfaceKind: payload.kind,
          surfaceId,
          hostSessionId: ctx.hostSessionId,
          runtimeId: ctx.runtimeId,
          generation: ctx.generation,
          ...(payload.paneId !== undefined ? { paneId: payload.paneId } : {}),
          boundAt: now,
        })
        break
      }

      // ── Permission audit ────────────────────────────────────────────────────
      case 'permission.requested': {
        // Audit/projection only: the request is recorded as a broker HRC event.
        // permission_decisions PK is permission_request_id and has no update API,
        // so the authoritative row is inserted on resolution below.
        break
      }
      case 'permission.resolved': {
        const payload = envelope.payload as PermissionResolvedPayload
        if (db.permissionDecisions.getByPermissionRequestId(payload.permissionRequestId)) {
          break
        }
        const requested = this.findRequestedPayload(invocationId, payload.permissionRequestId)
        db.permissionDecisions.insert({
          permissionRequestId: payload.permissionRequestId,
          invocationId,
          runtimeId: ctx.runtimeId,
          ...(runId !== undefined ? { runId } : {}),
          kind: requested?.payload.kind ?? 'unknown',
          subjectDisplayJson: JSON.stringify(requested?.payload.subjectDisplay ?? null),
          defaultDecision: requested?.payload.defaultDecision ?? 'deny',
          decision: payload.decision,
          decidedBy: payload.decidedBy,
          policyJson: JSON.stringify(
            payload.message !== undefined ? { message: payload.message } : {}
          ),
          requestedAt: requested?.time ?? now,
          decidedAt: now,
        })
        break
      }

      // ── Diagnostics / notices / usage -> emitted HRC event only ─────────────
      case 'diagnostic':
      case 'driver.notice':
      case 'usage.updated': {
        break
      }

      default: {
        // Unknown event types still get persisted + emitted; no state mutation.
        break
      }
    }
  }

  /** Emit a single broker-sourced HRC event mirroring the broker envelope. */
  private emit(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): HrcEventEnvelope {
    return this.db.events.append({
      ts: now,
      hostSessionId: ctx.hostSessionId,
      scopeRef: ctx.scopeRef,
      laneRef: ctx.laneRef,
      generation: ctx.generation,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      runtimeId: ctx.runtimeId,
      source: 'broker',
      eventKind: `broker.${envelope.type}`,
      eventJson: {
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        type: envelope.type,
        time: envelope.time,
        ...(envelope.turnId !== undefined ? { turnId: envelope.turnId } : {}),
        ...(envelope.inputId !== undefined ? { inputId: envelope.inputId } : {}),
        ...(envelope.itemId !== undefined ? { itemId: envelope.itemId } : {}),
        payload: envelope.payload,
      },
    })
  }

  /**
   * Project a broker event into the canonical `hrc_events` lifecycle stream that
   * every client follows via `/v1/events`. Returns the appended lifecycle event
   * (so the server can `notifyEvent` it) or undefined for provenance-only types.
   */
  private emitLifecycle(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): HrcLifecycleEvent | undefined {
    const eventKind = BROKER_TO_HRC_KIND[envelope.type]
    if (eventKind === undefined) {
      return undefined
    }
    return appendHrcEvent(this.db, eventKind, {
      ts: now,
      hostSessionId: ctx.hostSessionId,
      scopeRef: ctx.scopeRef,
      laneRef: ctx.laneRef,
      generation: ctx.generation,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      transport: 'headless',
      payload: this.lifecyclePayload(envelope),
    })
  }

  /** Build the legacy-shaped lifecycle payload for a mapped broker event. */
  private lifecyclePayload(envelope: InvocationEventEnvelope): Record<string, unknown> {
    switch (envelope.type) {
      case 'assistant.message.completed': {
        const payload = envelope.payload as AssistantMessageCompletedPayload
        const content = payload.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
        const event: AgentMessageEvent = {
          type: 'message_end',
          message: { role: 'assistant', content },
        }
        return event as unknown as Record<string, unknown>
      }
      case 'tool.call.started': {
        const payload = envelope.payload as ToolCallStartedPayload
        const event: ToolExecutionStartEvent = {
          type: 'tool_execution_start',
          toolUseId: payload.toolCallId,
          toolName: payload.name,
          input: isRecord(payload.input) ? payload.input : {},
        }
        return event as unknown as Record<string, unknown>
      }
      case 'tool.call.completed': {
        const payload = envelope.payload as ToolCallCompletedPayload
        const event: ToolExecutionEndEvent = {
          type: 'tool_execution_end',
          toolUseId: payload.toolCallId,
          toolName: payload.name,
          result: toolResultFromBrokerResult(payload.result),
          ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
        }
        return event as unknown as Record<string, unknown>
      }
      case 'tool.call.failed': {
        const payload = envelope.payload as ToolCallFailedPayload
        const event: ToolExecutionEndEvent = {
          type: 'tool_execution_end',
          toolUseId: payload.toolCallId,
          toolName: payload.name,
          result: { content: [{ type: 'text', text: payload.message }] },
          isError: true,
        }
        return event as unknown as Record<string, unknown>
      }
      case 'turn.completed':
        return { success: true, transport: 'headless', source: 'broker' }
      case 'turn.failed': {
        const payload = envelope.payload as TurnFailedPayload
        return { success: false, transport: 'headless', source: 'broker', message: payload.message }
      }
      case 'turn.interrupted':
        return { success: false, interrupted: true, transport: 'headless', source: 'broker' }
      default:
        return { transport: 'headless' }
    }
  }

  private appendBuffer(ctx: ProjectionContext, text: string, now: string): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const chunkSeq = this.db.runtimeBuffers.listByRunId(ctx.runId).length
    this.db.runtimeBuffers.append({
      runtimeId: ctx.runtimeId,
      runId: ctx.runId,
      chunkSeq,
      text,
      createdAt: now,
    })
  }

  /**
   * Recover the originating `permission.requested` payload (kind / subjectDisplay
   * / defaultDecision) persisted on a prior event so the authoritative decision
   * row carries the full request context.
   */
  private findRequestedPayload(
    invocationId: string,
    permissionRequestId: string
  ): { payload: PermissionRequestedPayload; time: string } | undefined {
    const rows = this.db.brokerInvocationEvents.listByInvocationId(invocationId)
    for (const row of rows) {
      if (row.type !== 'permission.requested') {
        continue
      }
      try {
        const payload = JSON.parse(row.brokerEventJson) as PermissionRequestedPayload
        if (payload.permissionRequestId === permissionRequestId) {
          return { payload, time: row.time }
        }
      } catch {
        // Ignore unparseable rows; fall through to the default-decision path.
      }
    }
    return undefined
  }
}
