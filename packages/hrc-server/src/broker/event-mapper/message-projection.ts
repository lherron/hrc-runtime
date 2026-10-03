import type { HrcContinuationRef } from 'hrc-core'
import type {
  AssistantMessageCompletedPayload,
  AssistantMessageDeltaPayload,
  ContinuationUpdate,
  InvocationEventEnvelope,
  TerminalSurfaceReportedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
  UsageUpdatedPayload,
} from 'spaces-harness-broker-protocol'
import { hasOpenAskBracket, isAskUserTool } from '../../ask-bracket'
import { disarmFirstTurnWatchOnContinuationCleared } from '../../first-turn-watch'
import {
  REPORTED_MODEL_STATE_KEY,
  isReportedModelIdentity,
  readReportedModelIdentity,
} from '../../reported-model'
import { runtimeActivityPatch } from '../../runtime-activity'
import type { DerivedTurnDescriptor, ProjectionContext } from './helpers'
import { auditPermissionCancelled, auditPermissionResolved } from './permission-audit'
import {
  isRuntimeAwaitingInput,
  markRuntimeAwaitingInput,
  markRuntimeInputResumed,
} from './runtime-state'

import type { BrokerEventMapper } from '../event-mapper'
import { isRecord } from '../json'

export const messageProjectionMethods = {
  /**
   * T-08583 — record the model the broker reports as actually serving the turn.
   * Latest wins; omission or a malformed identity stores nothing (and never
   * clears a prior identity or fails the projection). Raw token-usage payloads
   * stay in the broker ledger row only. Retained recovery never reaches here:
   * `projectRetainedState` is an allowlist without a `usage.updated` arm, so a
   * recovered usage event writes no runtime state by construction.
   */
  projectUsageReportedModel(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const model: unknown = (envelope.payload as Partial<UsageUpdatedPayload> | undefined)?.model
    if (!isReportedModelIdentity(model)) return
    const runtime = this.db.runtimes.getByRuntimeId(ctx.runtimeId)
    if (!runtime || runtime.generation !== ctx.generation) return
    const previous = readReportedModelIdentity(
      isRecord(runtime.runtimeStateJson) ? runtime.runtimeStateJson : undefined
    )
    if (previous?.id === model.id && previous.source === model.source) return
    this.db.runtimes.update(ctx.runtimeId, {
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        [REPORTED_MODEL_STATE_KEY]: { id: model.id, source: model.source, updatedAt: now },
      },
      updatedAt: now,
    })
  },

  // ── Assistant output -> runtime buffer (text projection) ────────────────
  projectMessage(
    this: BrokerEventMapper,
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
        this.appendCompletedMessageBuffer(ctx, text, now)
        break
      }
      case 'assistant.message.delta': {
        const payload = envelope.payload as AssistantMessageDeltaPayload
        this.appendBuffer(ctx, payload.text, now)
        break
      }
      case 'assistant.message.started': {
        // No text yet, but a new assistant message beginning after buffered
        // output needs a boundary: the buffer is later joined with '' as the
        // raw-stream turn body, and without a separator narrate→tool→answer
        // turns glue messages together (T-07824, buffered branch).
        this.appendMessageBoundaryBuffer(ctx, now)
        break
      }
    }
  },

  // ── Tool activity -> emitted HRC event only (eventJson carries id+name) ──
  // Ask-user tools (AskUserQuestion / request_user_input) additionally drive
  // the first-class awaiting-input state (T-01946): the open bracket parks the
  // runtime, the matching close resumes it. The durable bracket in
  // broker_invocation_events (appended above) is the authority; the runtime
  // status + derived events here are the fast path / observability.
  projectToolCall(
    this: BrokerEventMapper,
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
          markRuntimeAwaitingInput(db, ctx, invocationId, envelope.time ?? now, now)
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
          isRuntimeAwaitingInput(db, ctx.runtimeId) &&
          !hasOpenAskBracket(db, invocationId, runId)
        ) {
          markRuntimeInputResumed(db, ctx, invocationId, envelope.time ?? now, now)
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
  },

  // ── Continuation history + automatic-reuse intent (T-07899) ─────────────
  // Provider keys are durable history on the session row.
  // continuation.cleared records that ordinary run/start must be fresh by
  // disabling automatic reuse on the session; explicit `hrc resume` remains
  // able to select the retained key.
  projectContinuation(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    switch (envelope.type) {
      case 'continuation.updated': {
        const payload = envelope.payload as ContinuationUpdate
        // T-04836: preserve the broker continuation `kind` (e.g. Codex
        // 'session') so the interactive tmux recreate gate can distinguish a
        // resume-compatible session UUID from other continuation keys and
        // safely emit `codex resume <uuid>`. Claude rows omit kind and stay
        // compatible.
        const continuation: HrcContinuationRef = {
          provider: payload.provider,
          ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
          key: payload.key,
        }
        db.runtimes.update(ctx.runtimeId, {
          ...runtimeActivityPatch(db, ctx.runtimeId, {
            source: 'broker-event',
            occurredAt: envelope.time ?? now,
            updatedAt: now,
          }),
        })
        db.sessions.updateContinuation(ctx.hostSessionId, continuation, now)
        break
      }
      case 'continuation.cleared': {
        db.sessions.setContinuationReuseDisabled(ctx.hostSessionId, true, now)
        // T-07235: a clear that leaves the harness process RUNNING (reason=clear
        // — ordinary broker-controller behavior) must not disarm, or a wedged
        // TUI escapes the watchdog with a pre-first-turn clear.
        disarmFirstTurnWatchOnContinuationCleared(
          db,
          {
            runtimeId: ctx.runtimeId,
            generation: ctx.generation,
            invocationId: envelope.invocationId,
          },
          envelope.time ?? now
        )
        break
      }
    }
  },

  // ── Terminal surface binding ────────────────────────────────────────────
  projectTerminalSurface(
    this: BrokerEventMapper,
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
  },

  // ── Permission audit ────────────────────────────────────────────────────
  projectPermission(
    this: BrokerEventMapper,
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
        auditPermissionResolved(this.db, envelope, ctx, now, false)
        break
      }
      case 'permission.cancelled': {
        auditPermissionCancelled(this.db, envelope, ctx, now, false)
        break
      }
    }
  },

  updateLifecyclePosition(
    this: BrokerEventMapper,
    invocationId: string,
    runtimeId: string,
    occurredAt: string,
    updatedAt: string,
    patch: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): void {
    this.db.runtimes.update(runtimeId, {
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'broker-event',
        occurredAt,
        updatedAt,
      }),
    })
    this.db.brokerInvocations.update(invocationId, { ...patch, updatedAt })
  },

  isStaleLifecycleEnvelope(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    invocation: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): boolean {
    const currentHarnessGeneration = invocation.currentHarnessGeneration
    if (
      currentHarnessGeneration !== undefined &&
      envelope.harnessGeneration !== undefined &&
      envelope.harnessGeneration < currentHarnessGeneration
    ) {
      return true
    }

    const currentTurnAttempt = invocation.currentTurnAttempt
    if (
      currentTurnAttempt !== undefined &&
      envelope.turnAttempt !== undefined &&
      envelope.turnAttempt < currentTurnAttempt
    ) {
      return true
    }

    return false
  },

  appendBuffer(this: BrokerEventMapper, ctx: ProjectionContext, text: string, now: string): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const chunkSeq =
      this.nextBufferChunkSeqByRunId.get(ctx.runId) ??
      this.db.runtimeBuffers.nextChunkSeqByRunId(ctx.runId)
    this.db.runtimeBuffers.append({
      runtimeId: ctx.runtimeId,
      runId: ctx.runId,
      chunkSeq,
      text,
      createdAt: now,
    })
    this.nextBufferChunkSeqByRunId.set(ctx.runId, chunkSeq + 1)
  },

  /** Separate consecutive assistant messages inside the raw runtime buffer.
   *
   * Appends a blank-line chunk when the run already has buffered output, so
   * the buffered turn body (joined with '') keeps message boundaries. No-op
   * on an empty buffer (first message) or when the boundary already exists.
   */
  appendMessageBoundaryBuffer(this: BrokerEventMapper, ctx: ProjectionContext, now: string): void {
    if (ctx.runId === undefined) {
      return
    }
    const tail = this.db.runtimeBuffers.listTailByRunId(ctx.runId, 1).at(-1)?.text
    if (tail === undefined || tail === '\n\n') {
      return
    }
    this.appendBuffer(ctx, '\n\n', now)
  },

  appendCompletedMessageBuffer(
    this: BrokerEventMapper,
    ctx: ProjectionContext,
    text: string,
    now: string
  ): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const existing = this.db.runtimeBuffers
      .listTailByRunId(ctx.runId, text.length)
      .map((chunk) => chunk.text)
      .join('')
    if (existing.endsWith(text)) {
      return
    }
    this.appendBuffer(ctx, text, now)
  },
}

export type MessageProjectionMethods = typeof messageProjectionMethods
