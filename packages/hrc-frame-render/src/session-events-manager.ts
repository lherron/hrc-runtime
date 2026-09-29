import { createLogger } from './logger.js'
import { processEvent } from './session-events-reducer.js'
import { runStateToFrame } from './session-events-render.js'
import type { ProjectState, RunState } from './session-events-types.js'
import type { GatewaySessionEvent, RenderFrame, SessionEventEnvelope } from './types.js'

export { runStateToFrame } from './session-events-render.js'
export type { AssistantSegment, RunState } from './session-events-types.js'

const log = createLogger({ component: 'hrc-frame-render' })

export type RenderFrameCallback = (
  sessionRef: string,
  projectId: string,
  runId: string,
  frame: RenderFrame
) => void

/**
 * @deprecated Use RenderFrameCallback for new render sinks. The legacy callback
 * receives the mutable RunState as its fifth argument for compatibility.
 */
export type OnRenderCallback = (
  sessionRef: string,
  projectId: string,
  runId: string,
  frame: RenderFrame,
  run: RunState
) => void

export type OnRunQueuedCallback = (projectId: string, runId: string, inputContent: string) => void

export class SessionEventsManager {
  private readonly gatewayId: string
  private readonly onRender: OnRenderCallback
  private readonly sessions = new Map<string, ProjectState>()

  constructor(gatewayId: string, onRender: RenderFrameCallback)
  constructor(gatewayId: string, onRender: OnRenderCallback)
  constructor(gatewayId: string, onRender: RenderFrameCallback | OnRenderCallback) {
    this.gatewayId = gatewayId
    this.onRender = onRender
  }

  subscribe(sessionRef: string, projectId: string): void {
    if (!this.sessions.has(sessionRef)) {
      this.sessions.set(sessionRef, {
        projectId,
        runs: new Map(),
      })
    }
  }

  unsubscribe(sessionRef: string): void {
    this.sessions.delete(sessionRef)
  }

  receive(envelope: SessionEventEnvelope): void {
    if (!envelope.sessionRef) {
      log.warn('session.event.dropped', {
        message: 'Dropping session event without canonical session identity',
        trace: { gatewayId: this.gatewayId, projectId: envelope.projectId, runId: envelope.runId },
        data: { eventType: envelope.event.type },
      })
      return
    }

    const state = this.ensureSession(envelope.sessionRef, envelope.projectId)
    const affectedRunId = this.getAffectedRunId(envelope.event, envelope.runId)
    const existingRun = affectedRunId ? state.runs.get(affectedRunId) : undefined
    const seq = envelope.seq ?? (existingRun?.lastSeq ?? 0) + 1
    const isInternal = envelope.run?.visibility === 'internal'

    if (existingRun && seq <= existingRun.lastSeq) {
      log.debug('session.event.dedupe', {
        message: `Ignoring duplicate event: ${envelope.event.type}`,
        trace: {
          gatewayId: this.gatewayId,
          projectId: envelope.projectId,
          sessionRef: envelope.sessionRef,
          runId: envelope.runId,
        },
        data: { eventType: envelope.event.type, seq, lastSeq: existingRun.lastSeq },
      })
      return
    }

    if (isInternal) {
      return
    }

    log.info('session.event.received', {
      message: `Received event: ${envelope.event.type}`,
      trace: {
        gatewayId: this.gatewayId,
        projectId: envelope.projectId,
        sessionRef: envelope.sessionRef,
        runId: envelope.runId,
      },
      data: { eventType: envelope.event.type, seq },
    })

    this.processAndEmit(
      envelope.sessionRef,
      envelope.projectId,
      envelope.event,
      envelope.runId,
      seq
    )
  }

  getRunState(sessionRef: string, runId: string): RunState | undefined {
    return this.sessions.get(sessionRef)?.runs.get(runId)
  }

  private ensureSession(sessionRef: string, projectId: string): ProjectState {
    const existing = this.sessions.get(sessionRef)
    if (existing) {
      return existing
    }

    const created: ProjectState = {
      projectId,
      runs: new Map(),
    }
    this.sessions.set(sessionRef, created)
    return created
  }

  private processAndEmit(
    sessionRef: string,
    projectId: string,
    event: GatewaySessionEvent,
    runId: string | undefined,
    seq: number
  ): void {
    const state = this.ensureSession(sessionRef, projectId)
    const newState = processEvent(state, event, runId, seq)
    this.sessions.set(sessionRef, newState)

    const affectedRunId = this.getAffectedRunId(event, runId)
    if (!affectedRunId) {
      return
    }

    const run = newState.runs.get(affectedRunId)
    if (!run) {
      return
    }

    this.onRender(sessionRef, projectId, affectedRunId, runStateToFrame(run), run)
  }

  private getAffectedRunId(
    event: GatewaySessionEvent,
    contextRunId?: string | undefined
  ): string | undefined {
    switch (event.type) {
      case 'run_queued':
      case 'run_started':
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled':
      case 'permission_request':
      case 'permission_decision':
        return event.runId
      default:
        return contextRunId
    }
  }
}
