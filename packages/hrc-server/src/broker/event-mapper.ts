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
  HrcLifecycleTransport,
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
  HarnessExitedPayload,
  HarnessRecoveryCompletedPayload,
  HarnessRecoveryFailedPayload,
  HarnessStartedPayload,
  InvocationEventEnvelope,
  InvocationExitedPayload,
  InvocationFailedPayload,
  LifecycleEscalationPayload,
  LifecyclePolicyAcceptedPayload,
  PermissionCancelledPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  TerminalSurfaceReportedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
  TurnFailedPayload,
  TurnRetryPayload,
  UserMessagePayload,
} from 'spaces-harness-broker-protocol'

import { hasOpenAskBracket, isAskUserTool, runtimeHasAnyOpenAskBracket } from '../ask-bracket'
import { appendHrcEvent, createUserPromptPayload } from '../hrc-event-helper'
import { writeServerLog } from '../server-log.js'

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

function omitRuntimeStateActiveRun(value: Record<string, unknown>): Record<string, unknown> {
  const { activeRunId: _activeRunId, ...rest } = value
  return rest
}

function lifecycleTransportFromRuntime(value: string): HrcLifecycleTransport {
  if (value === 'sdk' || value === 'tmux' || value === 'headless' || value === 'ghostty') {
    return value
  }
  return 'headless'
}

function permissionIdentityKey(input: {
  invocationId: string
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  permissionRequestId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.permissionRequestId,
  ])
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
  // Interactive TUI prompts (claude-code-tmux / codex-cli-tmux) surface the
  // operator's typed text as a broker user.message, emitted right after
  // turn.started. Map it to the canonical turn.user_prompt so the prompt rides
  // the same lifecycle stream as agent messages and tool calls (T-02026).
  'user.message': 'turn.user_prompt',
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

const TERMINAL_TURN_EVENT_TYPES = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const
const TERMINAL_TURN_EVENT_TYPE_SQL = TERMINAL_TURN_EVENT_TYPES.map((type) => `'${type}'`).join(', ')

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

/**
 * A pending HRC-derived turn lifecycle event (T-01946). projectState records the
 * descriptor while it mutates state; project() emits it AFTER the canonical event
 * so the hrcSeq order matches the returned lifecycleEvents order.
 */
type DerivedTurnDescriptor = {
  eventKind: 'turn.awaiting_input' | 'turn.input_resumed'
  toolUseId: string
  toolName: string
}

/** Resolved projection context for a single invocation. */
type ProjectionContext = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: HrcLifecycleTransport
  operationId: string
  runId: string | undefined
}

type RuntimeRecord = NonNullable<ReturnType<HrcDatabase['runtimes']['getByRuntimeId']>>

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
      transport: lifecycleTransportFromRuntime(runtime.transport),
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
      // Persist the envelope-level identity (T-01946): the durable ask-bracket
      // identity is (invocationId, runId, harnessGeneration, turnAttempt,
      // toolCallId), but broker_event_json holds only envelope.payload, so these
      // two envelope fields must be persisted explicitly to survive restart.
      ...(envelope.harnessGeneration !== undefined
        ? { harnessGeneration: envelope.harnessGeneration }
        : {}),
      ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
      payload: envelope.payload,
    })

    if (appended.idempotent) {
      return { idempotent: true, events: [], lifecycleEvents: [] }
    }

    // (b) Project state into HRC, then emit the raw provenance mirror plus the
    // canonical lifecycle event (the latter is what clients/notifyEvent see).
    // `derivedDescriptors` records HRC-side lifecycle events the mapper synthesizes
    // beyond the 1:1 broker mapping (T-01946 turn.awaiting_input / turn.input_resumed).
    // They are EMITTED after the canonical event so their hrcSeq is strictly greater
    // — keeping the returned `lifecycleEvents` order identical to replay-by-hrcSeq
    // (and semantically the tool_call precedes the awaiting_input it triggers).
    const derivedDescriptors: DerivedTurnDescriptor[] = []
    const stale = this.isStaleLifecycleEnvelope(envelope, invocation, runtime)
    this.projectState(envelope, ctx, now, stale, derivedDescriptors)
    const emitted = this.emit(envelope, ctx, now)
    const lifecycleEvent = stale ? undefined : this.emitLifecycle(envelope, ctx, now)
    const derived = derivedDescriptors.map((descriptor) =>
      this.emitDerivedTurnEvent(descriptor.eventKind, envelope, ctx, now, {
        toolUseId: descriptor.toolUseId,
        toolName: descriptor.toolName,
      })
    )

    // (c) Record projection outcome on the broker event row.
    db.brokerInvocationEvents.updateProjection(envelope.invocationId, envelope.seq, {
      hrcEventSeq: emitted.seq,
      projectionStatus: 'applied',
    })

    return {
      idempotent: false,
      events: [emitted],
      lifecycleEvents: [...(lifecycleEvent ? [lifecycleEvent] : []), ...derived],
    }
  }

  /**
   * Resolve the runId this event belongs to, robust to out-of-order projection.
   *
   * Events with explicit inputId are authoritative. Events without inputId are
   * attributed through the open turn bracket: find the most recent turn.started
   * at seq <= event.seq that has not been closed by a terminal turn before the
   * event, then resolve the input.accepted that started that bracket.
   *
   * This is seq-based rather than arrival-order-based, so a later queued
   * input.accepted row cannot steal ownership from the turn whose started
   * bracket is still open.
   */
  private resolveRunIdForEvent(
    envelope: InvocationEventEnvelope,
    fallbackRunId: string | undefined
  ): string | undefined {
    // Prefer envelope.inputId when the broker sets it: input.accepted /
    // input.queued / input.rejected always carry it (contract), and
    // input.queued specifically refers to the QUEUED input.
    const envelopeInputId = envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    if (envelopeInputId !== undefined) {
      const run = this.db.runs.getByDispatchedInputId(envelopeInputId)
      if (run?.runId) return run.runId
      return fallbackRunId
    }

    const openTurnStartedSeq = this.findOpenTurnStartedSeqForAttribution(envelope)
    if (openTurnStartedSeq !== undefined) {
      const bracketInput = this.findPriorInputAccepted(envelope.invocationId, openTurnStartedSeq)
      if (bracketInput) {
        const run = this.db.runs.getByDispatchedInputId(bracketInput.inputId)
        if (run?.runId) return run.runId
      }
      return fallbackRunId
    }

    if (this.findPriorInputAccepted(envelope.invocationId, envelope.seq)) return undefined
    return fallbackRunId
  }

  private extractInputIdFromPayload(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'inputId' in payload) {
      const v = (payload as { inputId?: unknown }).inputId
      return typeof v === 'string' ? v : undefined
    }
    return undefined
  }

  private findPriorInputAccepted(
    invocationId: string,
    seq: number
  ): { inputId: string; seq: number } | undefined {
    // json_extract on broker_event_json (the payload, which carries inputId
    // on input.accepted per broker contract). Filtering on type='input.accepted'
    // before json_extract keeps this O(log n) via the (invocation_id, seq) index.
    const row = this.db.sqlite
      .query<{ inputId: string | null; seq: number }, [string, number]>(
        `SELECT seq, json_extract(broker_event_json, '$.inputId') AS inputId
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'input.accepted' AND seq <= ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId ? { inputId: row.inputId, seq: row.seq } : undefined
  }

  private findOpenTurnStartedSeqForAttribution(
    envelope: InvocationEventEnvelope
  ): number | undefined {
    if (envelope.type === 'turn.started') {
      return envelope.seq
    }
    const row = this.db.sqlite
      .query<{ seq: number }, [string, number, number]>(
        `SELECT started.seq AS seq
           FROM broker_invocation_events AS started
          WHERE started.invocation_id = ?
            AND started.type = 'turn.started'
            AND started.seq <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM broker_invocation_events AS terminal
               WHERE terminal.invocation_id = started.invocation_id
                 AND terminal.type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
                 AND terminal.seq > started.seq
                 AND terminal.seq < ?
            )
          ORDER BY started.seq DESC
          LIMIT 1`
      )
      .get(envelope.invocationId, envelope.seq, envelope.seq)
    return row?.seq
  }

  private hasOpenTurnBracketAtSeq(invocationId: string, seq: number): boolean {
    const row = this.db.sqlite
      .query<{ count: number }, [string, number, number]>(
        `SELECT COUNT(*) AS count
           FROM broker_invocation_events AS started
          WHERE started.invocation_id = ?
            AND started.type = 'turn.started'
            AND started.seq <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM broker_invocation_events AS terminal
               WHERE terminal.invocation_id = started.invocation_id
                 AND terminal.type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
                 AND terminal.seq > started.seq
                 AND terminal.seq <= ?
            )`
      )
      .get(invocationId, seq, seq)
    return (row?.count ?? 0) > 0
  }

  /** Apply the type-specific state mutation. Emission is handled separately. */
  private projectState(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean,
    derived: DerivedTurnDescriptor[]
  ): void {
    if (stale) {
      if (envelope.type === 'permission.resolved') {
        this.auditPermissionResolved(envelope, ctx, now, true)
      } else if (envelope.type === 'permission.cancelled') {
        this.auditPermissionCancelled(envelope, ctx, now, true)
      }
      return
    }

    // Per-family projectors keep behavior byte-identical to the prior single
    // switch; each handles its slice of `envelope.type` and is a no-op for
    // unrelated/unknown types (which are still persisted + emitted upstream).
    switch (envelope.type) {
      case 'invocation.started':
      case 'invocation.ready':
      case 'invocation.stopping':
      case 'invocation.exited':
      case 'invocation.failed':
      case 'invocation.disposed':
        this.projectInvocationLifecycle(envelope, ctx, now)
        return

      case 'lifecycle.policy.accepted':
      case 'lifecycle.escalation':
      case 'harness.started':
      case 'harness.exited':
      case 'harness.recovery.started':
      case 'harness.recovery.completed':
      case 'harness.recovery.failed':
        this.projectLifecyclePolicy(envelope, ctx, now)
        return

      case 'input.accepted':
      case 'input.rejected':
      case 'input.queued':
      case 'turn.started':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
      case 'turn.stalled':
      case 'turn.retry':
        this.projectTurn(envelope, ctx, now)
        return

      case 'assistant.message.completed':
      case 'assistant.message.delta':
      case 'assistant.message.started':
        this.projectMessage(envelope, ctx, now)
        return

      case 'tool.call.started':
      case 'tool.call.completed':
      case 'tool.call.failed':
      case 'tool.call.delta':
        this.projectToolCall(envelope, ctx, now, derived)
        return

      case 'continuation.updated':
      case 'continuation.cleared':
        this.projectContinuation(envelope, ctx, now)
        return

      case 'terminal.surface.reported':
        this.projectTerminalSurface(envelope, ctx, now)
        return

      case 'permission.requested':
      case 'permission.resolved':
      case 'permission.cancelled':
        this.projectPermission(envelope, ctx, now)
        return

      default: {
        // Diagnostics / notices / usage and unknown event types still get
        // persisted + emitted upstream; no state mutation here.
        return
      }
    }
  }

  // ── Invocation lifecycle -> runtime linkage + invocation state ──────────
  private projectInvocationLifecycle(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    switch (envelope.type) {
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
        const payload = envelope.payload as InvocationExitedPayload
        db.brokerInvocations.update(invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
        break
      }
      case 'invocation.failed': {
        const payload = envelope.payload as InvocationFailedPayload
        db.brokerInvocations.update(invocationId, {
          invocationState: 'failed',
          lifecycleTerminalReason: payload.reason ?? payload.code ?? 'failed',
          updatedAt: now,
        })
        break
      }
      case 'invocation.disposed': {
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'disposed',
          ...(invocation?.lifecycleTerminalReason === undefined
            ? { lifecycleTerminalReason: 'disposed' }
            : {}),
          updatedAt: now,
        })
        break
      }
    }
  }

  // ── Lifecycle policy / recovery vocabulary ────────────────────────────
  private projectLifecyclePolicy(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    switch (envelope.type) {
      case 'lifecycle.policy.accepted': {
        const payload = envelope.payload as LifecyclePolicyAcceptedPayload
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
        if (
          invocation?.lifecyclePolicyHash !== undefined &&
          invocation.lifecyclePolicyHash !== payload.policyHash
        ) {
          throw new Error(
            `accepted lifecycle policy hash mismatch for ${invocationId}: expected ${invocation.lifecyclePolicyHash}, got ${payload.policyHash}`
          )
        }
        db.runtimes.update(ctx.runtimeId, {
          lifecyclePolicyHash: payload.policyHash,
          lastActivityAt: now,
          updatedAt: now,
        })
        db.brokerInvocations.update(invocationId, {
          lifecyclePolicyHash: payload.policyHash,
          updatedAt: now,
        })
        break
      }
      case 'lifecycle.escalation': {
        const payload = envelope.payload as LifecycleEscalationPayload
        db.brokerInvocations.update(invocationId, {
          lastLifecycleEscalationJson: JSON.stringify({
            reason: payload.reason,
            requestedAction: payload.requestedAction,
            ...(payload.harnessGeneration !== undefined
              ? { harnessGeneration: payload.harnessGeneration }
              : {}),
            ...(payload.inputId !== undefined ? { inputId: payload.inputId } : {}),
            ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
            ...(payload.turnAttempt !== undefined ? { turnAttempt: payload.turnAttempt } : {}),
            ...(payload.policyHash !== undefined ? { policyHash: payload.policyHash } : {}),
          }),
          updatedAt: now,
        })
        break
      }
      case 'harness.started': {
        const payload = envelope.payload as HarnessStartedPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
          currentHarnessGeneration: payload.generation,
        })
        break
      }
      case 'harness.exited': {
        const payload = envelope.payload as HarnessExitedPayload
        db.brokerInvocations.update(invocationId, {
          lifecycleTerminalReason: payload.reason,
          updatedAt: now,
        })
        break
      }
      case 'harness.recovery.started': {
        // Evidence-only; appendEvent/emit retain the broker record.
        break
      }
      case 'harness.recovery.completed': {
        const payload = envelope.payload as HarnessRecoveryCompletedPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
          currentHarnessGeneration: payload.toGeneration,
        })
        break
      }
      case 'harness.recovery.failed': {
        const payload = envelope.payload as HarnessRecoveryFailedPayload
        db.brokerInvocations.update(invocationId, {
          lastLifecycleEscalationJson: JSON.stringify({
            reason: payload.reason,
            ...(payload.requestedAction !== undefined
              ? { requestedAction: payload.requestedAction }
              : {}),
            fromGeneration: payload.fromGeneration,
          }),
          updatedAt: now,
        })
        break
      }
    }
  }

  // ── Input disposition + turn lifecycle -> run state + invocation turn state ─
  private projectTurn(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    const { runId } = ctx
    switch (envelope.type) {
      // ── Input disposition -> run touch ──────────────────────────────────────
      case 'input.accepted':
      case 'input.rejected':
      case 'input.queued': {
        if (runId !== undefined) {
          db.runs.update(runId, { updatedAt: now })
        }
        break
      }
      case 'turn.started': {
        if (runId !== undefined) {
          db.runs.update(runId, { status: 'running', startedAt: now, updatedAt: now })
          this.claimRuntimeTurnOwnership(ctx, runId, now)
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
          this.markRuntimeTurnTerminal(ctx, envelope, runId, now)
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
          this.markRuntimeTurnTerminal(ctx, envelope, runId, now)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.interrupted': {
        if (runId !== undefined) {
          db.runs.markCompleted(runId, { status: 'cancelled', completedAt: now, updatedAt: now })
          this.markRuntimeTurnTerminal(ctx, envelope, runId, now)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.stalled': {
        // Evidence-only; appendEvent/emit retain the broker record.
        break
      }
      case 'turn.retry': {
        const payload = envelope.payload as TurnRetryPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
          currentHarnessGeneration: payload.toHarnessGeneration,
          currentTurnAttempt: payload.toAttempt,
        })
        break
      }
    }
  }

  // ── Assistant output -> runtime buffer (text projection) ────────────────
  private projectMessage(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    switch (envelope.type) {
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
    }
  }

  // ── Tool activity -> emitted HRC event only (eventJson carries id+name) ──
  // Ask-user tools (AskUserQuestion / request_user_input) additionally drive
  // the first-class awaiting-input state (T-01946): the open bracket parks the
  // runtime, the matching close resumes it. The durable bracket in
  // broker_invocation_events (appended above) is the authority; the runtime
  // status + derived events here are the fast path / observability.
  private projectToolCall(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    derived: DerivedTurnDescriptor[]
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    const { runId } = ctx
    switch (envelope.type) {
      case 'tool.call.started': {
        const payload = envelope.payload as ToolCallStartedPayload
        if (runId !== undefined && isAskUserTool(payload.name)) {
          this.markRuntimeAwaitingInput(ctx, invocationId, now)
          derived.push({
            eventKind: 'turn.awaiting_input',
            toolUseId: payload.toolCallId,
            toolName: payload.name,
          })
        }
        break
      }
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const payload = envelope.payload as ToolCallCompletedPayload | ToolCallFailedPayload
        // Only an ask-tool close that resolves the LAST open ask bracket for this
        // run resumes the turn. The current envelope is already appended, so
        // hasOpenAskBracket reflects this close. Guarded on the runtime actually
        // being parked to avoid a spurious resume for a non-awaiting close.
        if (
          runId !== undefined &&
          isAskUserTool(payload.name) &&
          this.isRuntimeAwaitingInput(ctx.runtimeId) &&
          !hasOpenAskBracket(db, invocationId, runId)
        ) {
          this.markRuntimeInputResumed(ctx, invocationId, now)
          derived.push({
            eventKind: 'turn.input_resumed',
            toolUseId: payload.toolCallId,
            toolName: payload.name,
          })
        }
        break
      }
      case 'tool.call.delta': {
        break
      }
    }
  }

  // ── Continuation -> DUAL write/clear: runtime AND session (must-not-miss) ─
  // A user-initiated end (Claude `/quit`) drops the captured continuation so
  // the next `hrc run` starts fresh instead of `--resume`-ing the quit
  // session. Must clear BOTH sides: the next-launch resolution reads
  // `runtime.continuation ?? session.continuation` (index.ts ~2728/3120), so
  // clearing only one leaves the other as a fallback that re-resumes.
  // External pane-kill / crash reports reason `other` and never reaches here,
  // so resume durability survives pane recreation (T-01761 ariadne case).
  private projectContinuation(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    switch (envelope.type) {
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
      case 'continuation.cleared': {
        db.runtimes.clearContinuation(ctx.runtimeId, now)
        db.sessions.updateContinuation(ctx.hostSessionId, undefined, now)
        break
      }
    }
  }

  // ── Terminal surface binding ────────────────────────────────────────────
  private projectTerminalSurface(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const payload = envelope.payload as TerminalSurfaceReportedPayload
    // A `tmux-pane` lease is keyed by its pane id — the stable, unique lease
    // identifier (paneId is non-optional for tmux-pane). The legacy
    // `tmux-session` surface keeps the socket#session composite key, which a
    // pane lease must never use (it would emit `#undefined` when sessionName
    // is absent and would not be the pane id).
    const surfaceId =
      payload.kind === 'tmux-pane' ? payload.paneId : `${payload.socketPath}#${payload.sessionName}`
    this.db.surfaceBindings.bind({
      surfaceKind: payload.kind,
      surfaceId,
      hostSessionId: ctx.hostSessionId,
      runtimeId: ctx.runtimeId,
      generation: ctx.generation,
      ...(payload.paneId !== undefined ? { paneId: payload.paneId } : {}),
      boundAt: now,
    })
  }

  // ── Permission audit ────────────────────────────────────────────────────
  private projectPermission(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    switch (envelope.type) {
      case 'permission.requested': {
        // Audit/projection only: the request is recorded as a broker HRC event.
        // permission_decisions PK is permission_request_id and has no update API,
        // so the authoritative row is inserted on resolution below.
        break
      }
      case 'permission.resolved': {
        this.auditPermissionResolved(envelope, ctx, now, false)
        break
      }
      case 'permission.cancelled': {
        this.auditPermissionCancelled(envelope, ctx, now, false)
        break
      }
    }
  }

  private updateLifecyclePosition(
    invocationId: string,
    runtimeId: string,
    now: string,
    patch: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): void {
    this.db.runtimes.update(runtimeId, { ...patch, lastActivityAt: now, updatedAt: now })
    this.db.brokerInvocations.update(invocationId, { ...patch, updatedAt: now })
  }

  private isStaleLifecycleEnvelope(
    envelope: InvocationEventEnvelope,
    invocation: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    },
    runtime: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): boolean {
    const currentHarnessGeneration =
      invocation.currentHarnessGeneration ?? runtime.currentHarnessGeneration
    if (
      currentHarnessGeneration !== undefined &&
      envelope.harnessGeneration !== undefined &&
      envelope.harnessGeneration < currentHarnessGeneration
    ) {
      return true
    }

    const currentTurnAttempt = invocation.currentTurnAttempt ?? runtime.currentTurnAttempt
    if (
      currentTurnAttempt !== undefined &&
      envelope.turnAttempt !== undefined &&
      envelope.turnAttempt < currentTurnAttempt
    ) {
      return true
    }

    return false
  }

  private auditPermissionResolved(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean
  ): void {
    const payload = envelope.payload as PermissionResolvedPayload
    const identityKey = permissionIdentityKey({
      invocationId: envelope.invocationId,
      harnessGeneration: envelope.harnessGeneration,
      turnAttempt: envelope.turnAttempt,
      permissionRequestId: payload.permissionRequestId,
    })
    if (this.db.permissionDecisions.getByPermissionIdentityKey(identityKey)) {
      return
    }
    const requested = this.findRequestedPayload(envelope.invocationId, payload.permissionRequestId)
    this.db.permissionDecisions.insert({
      permissionIdentityKey: identityKey,
      permissionRequestId: payload.permissionRequestId,
      invocationId: envelope.invocationId,
      ...(envelope.harnessGeneration !== undefined
        ? { harnessGeneration: envelope.harnessGeneration }
        : {}),
      ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      kind: requested?.payload.kind ?? 'unknown',
      subjectDisplayJson: JSON.stringify(requested?.payload.subjectDisplay ?? null),
      defaultDecision: requested?.payload.defaultDecision ?? 'deny',
      decision: payload.decision,
      decidedBy: payload.decidedBy,
      policyJson: JSON.stringify({
        ...(payload.message !== undefined ? { message: payload.message } : {}),
        ...(stale ? { stale: true } : {}),
      }),
      requestedAt: requested?.time ?? now,
      decidedAt: now,
    })
  }

  private auditPermissionCancelled(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean
  ): void {
    const payload = envelope.payload as PermissionCancelledPayload
    const identityKey = permissionIdentityKey({
      invocationId: envelope.invocationId,
      harnessGeneration: envelope.harnessGeneration ?? payload.harnessGeneration,
      turnAttempt: envelope.turnAttempt ?? payload.turnAttempt,
      permissionRequestId: payload.permissionRequestId,
    })
    if (this.db.permissionDecisions.getByPermissionIdentityKey(identityKey)) {
      return
    }
    const requested = this.findRequestedPayload(envelope.invocationId, payload.permissionRequestId)
    const harnessGeneration = envelope.harnessGeneration ?? payload.harnessGeneration
    const turnAttempt = envelope.turnAttempt ?? payload.turnAttempt
    const defaultDecision = requested?.payload.defaultDecision ?? 'deny'
    this.db.permissionDecisions.insert({
      permissionIdentityKey: identityKey,
      permissionRequestId: payload.permissionRequestId,
      invocationId: envelope.invocationId,
      ...(harnessGeneration !== undefined ? { harnessGeneration } : {}),
      ...(turnAttempt !== undefined ? { turnAttempt } : {}),
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      kind: requested?.payload.kind ?? 'unknown',
      subjectDisplayJson: JSON.stringify(requested?.payload.subjectDisplay ?? null),
      defaultDecision,
      decision: defaultDecision,
      decidedBy: 'policy',
      policyJson: JSON.stringify({
        cancelled: true,
        reason: payload.reason,
        ...(stale ? { stale: true } : {}),
      }),
      requestedAt: requested?.time ?? now,
      decidedAt: now,
    })
  }

  /** True iff the runtime is currently projected as parked on a user prompt. */
  private isRuntimeAwaitingInput(runtimeId: string): boolean {
    return this.db.runtimes.getByRuntimeId(runtimeId)?.status === 'awaiting_input'
  }

  private claimRuntimeTurnOwnership(ctx: ProjectionContext, runId: string, now: string): void {
    const runtime = this.db.runtimes.getByRuntimeId(ctx.runtimeId)
    if (!runtime) return
    if (runtime.activeRunId !== undefined && runtime.activeRunId !== runId) {
      const activeRun = this.db.runs.getByRunId(runtime.activeRunId)
      if (activeRun && activeRun.completedAt === undefined) return
    }

    const runtimeStateJson = isRecord(runtime.runtimeStateJson)
      ? runtime.runtimeStateJson
      : undefined
    this.db.runtimes.update(ctx.runtimeId, {
      status: 'busy',
      activeRunId: runId,
      lastActivityAt: now,
      updatedAt: now,
      ...(runtimeStateJson !== undefined
        ? {
            runtimeStateJson: {
              ...runtimeStateJson,
              status: 'busy',
              activeRunId: runId,
              updatedAt: now,
            },
          }
        : {}),
    })
  }

  /** Park the runtime on an open ask bracket (T-01946): turn is active but blocked. */
  private markRuntimeAwaitingInput(
    ctx: ProjectionContext,
    invocationId: string,
    now: string
  ): void {
    this.db.brokerInvocations.update(invocationId, {
      invocationState: 'awaiting_input',
      updatedAt: now,
    })
    this.setRuntimeStatus(ctx.runtimeId, 'awaiting_input', now)
  }

  /**
   * Resume after the operator answers: the SAME turn continues (busy), it does
   * NOT complete — `turn.completed` later flips ready via markRuntimeTurnTerminal.
   */
  private markRuntimeInputResumed(ctx: ProjectionContext, invocationId: string, now: string): void {
    this.db.brokerInvocations.update(invocationId, {
      invocationState: 'turn_active',
      updatedAt: now,
    })
    this.setRuntimeStatus(ctx.runtimeId, 'busy', now)
  }

  /** Update runtime.status (and the mirrored runtimeStateJson.status) in lockstep. */
  private setRuntimeStatus(runtimeId: string, status: string, now: string): void {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) return
    const runtimeStateJson = isRecord(runtime.runtimeStateJson)
      ? runtime.runtimeStateJson
      : undefined
    this.db.runtimes.update(runtimeId, {
      status,
      lastActivityAt: now,
      updatedAt: now,
      ...(runtimeStateJson !== undefined
        ? { runtimeStateJson: { ...runtimeStateJson, status, updatedAt: now } }
        : {}),
    })
  }

  /**
   * Emit an HRC-derived turn lifecycle event (turn.awaiting_input /
   * turn.input_resumed). These have no broker event type — the mapper synthesizes
   * them from the ask bracket as the observability / fast-path surface. The
   * authority remains the durable bracket in broker_invocation_events.
   */
  private emitDerivedTurnEvent(
    eventKind: 'turn.awaiting_input' | 'turn.input_resumed',
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    extra: { toolUseId: string; toolName: string }
  ): HrcLifecycleEvent {
    return appendHrcEvent(this.db, eventKind, {
      ts: now,
      hostSessionId: ctx.hostSessionId,
      scopeRef: ctx.scopeRef,
      laneRef: ctx.laneRef,
      generation: ctx.generation,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      transport: ctx.transport,
      payload: {
        toolUseId: extra.toolUseId,
        toolName: extra.toolName,
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        ...(envelope.harnessGeneration !== undefined
          ? { harnessGeneration: envelope.harnessGeneration }
          : {}),
        ...(envelope.turnAttempt !== undefined ? { turnAttempt: envelope.turnAttempt } : {}),
      },
    })
  }

  private clearRuntimeTurnOwnership(runtime: RuntimeRecord, now: string): void {
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    const runtimeStateJson = isRecord(runtime.runtimeStateJson)
      ? omitRuntimeStateActiveRun(runtime.runtimeStateJson)
      : runtime.runtimeStateJson
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: now,
      updatedAt: now,
      ...(runtimeStateJson !== undefined
        ? {
            runtimeStateJson: {
              ...runtimeStateJson,
              status: 'ready',
              updatedAt: now,
            },
          }
        : {}),
    })
  }

  private terminalBelongsToActiveInvocation(
    runtime: RuntimeRecord,
    ctx: ProjectionContext,
    invocationId: string
  ): boolean {
    if (runtime.activeInvocationId !== undefined && runtime.activeInvocationId !== invocationId) {
      return false
    }
    if (runtime.activeOperationId !== undefined && runtime.activeOperationId !== ctx.operationId) {
      return false
    }
    return true
  }

  private markRuntimeTurnTerminal(
    ctx: ProjectionContext,
    envelope: InvocationEventEnvelope,
    runId: string,
    now: string
  ): void {
    const runtime = this.db.runtimes.getByRuntimeId(ctx.runtimeId)
    if (!runtime) return
    if (runtime.activeRunId !== undefined && runtime.activeRunId !== runId) {
      const canUnwedge =
        this.terminalBelongsToActiveInvocation(runtime, ctx, envelope.invocationId) &&
        !this.hasOpenTurnBracketAtSeq(envelope.invocationId, envelope.seq) &&
        !runtimeHasAnyOpenAskBracket(this.db, runtime)
      if (canUnwedge) {
        writeServerLog('WARN', 'broker.event_mapper.runtime_unwedged_on_run_mismatch', {
          runtimeId: ctx.runtimeId,
          invocationId: envelope.invocationId,
          seq: envelope.seq,
          activeRunId: runtime.activeRunId,
          terminalRunId: runId,
        })
        this.clearRuntimeTurnOwnership(runtime, now)
      }
      return
    }

    // Gate 3 / invariant (T-01946): never project `ready` while an ask bracket is
    // still open on this runtime. A genuine same-run terminal closes this run's
    // brackets (the authority requires no later same-run terminal), so this is
    // normally false — it only holds if another run on the runtime is still
    // parked, in which case the still-open bracket governs the runtime and we
    // leave ownership/awaiting untouched rather than projecting a false `ready`.
    if (runtimeHasAnyOpenAskBracket(this.db, runtime)) {
      return
    }

    this.clearRuntimeTurnOwnership(runtime, now)
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
    if (eventKind === 'turn.user_prompt' && this.isEchoedUserPrompt(envelope, ctx)) {
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
      transport: ctx.transport,
      payload: this.lifecyclePayload(envelope, ctx.transport),
    })
  }

  private isEchoedUserPrompt(envelope: InvocationEventEnvelope, ctx: ProjectionContext): boolean {
    if (envelope.type !== 'user.message') {
      return false
    }
    const payload = envelope.payload as Partial<UserMessagePayload>
    if (typeof payload.content !== 'string') {
      return false
    }

    const canonicalContent = createUserPromptPayload(payload.content).message.content
    const fromHrcSeq = this.currentTurnPromptWindowStart(ctx)
    const priorPrompts = this.db.hrcEvents.listByKind('turn.user_prompt', {
      hostSessionId: ctx.hostSessionId,
      generation: ctx.generation,
      runtimeId: ctx.runtimeId,
      fromHrcSeq,
    })

    return priorPrompts.some(
      (event) => this.userPromptPayloadContent(event.payload) === canonicalContent
    )
  }

  private currentTurnPromptWindowStart(ctx: ProjectionContext): number {
    const events = this.db.hrcEvents.listFromHrcSeq(1, {
      hostSessionId: ctx.hostSessionId,
      generation: ctx.generation,
      runtimeId: ctx.runtimeId,
    })
    const lastTerminal = events.filter((event) => event.eventKind === 'turn.completed').at(-1)
    return lastTerminal === undefined ? 1 : lastTerminal.hrcSeq + 1
  }

  private userPromptPayloadContent(payload: unknown): string | undefined {
    if (!isRecord(payload)) {
      return undefined
    }
    const message = payload['message']
    if (!isRecord(message) || message['role'] !== 'user') {
      return undefined
    }
    const content = message['content']
    return typeof content === 'string' ? content : undefined
  }

  /** Build the legacy-shaped lifecycle payload for a mapped broker event. */
  private lifecyclePayload(
    envelope: InvocationEventEnvelope,
    transport: HrcLifecycleTransport
  ): Record<string, unknown> {
    switch (envelope.type) {
      case 'user.message': {
        const payload = envelope.payload as UserMessagePayload
        // createUserPromptPayload builds the {type:'message_end', role:'user'}
        // shape (with turn-text truncation) consumers already render.
        return createUserPromptPayload(payload.content) as unknown as Record<string, unknown>
      }
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
        return { success: true, transport, source: 'broker' }
      case 'turn.failed': {
        const payload = envelope.payload as TurnFailedPayload
        return { success: false, transport, source: 'broker', message: payload.message }
      }
      case 'turn.interrupted':
        return { success: false, interrupted: true, transport, source: 'broker' }
      default:
        return { transport }
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
