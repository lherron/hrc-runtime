import type {
  DispatchTurnResponse,
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcMailDriveAttempt, HrcMailDriveWakeReason } from 'hrc-store-sqlite'

import { formatSessionRef } from './messages.js'
import { isRunActive } from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { findTargetSession } from './target-view.js'

const MAIL_DRIVE_TERMINAL_EVENTS = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.zombied',
  'turn.reaped',
])

type AttemptObservation = 'dispatch' | 'waiting' | 'finished'

function isDurablyActiveRun(run: HrcRunRecord): boolean {
  return run.status === 'queued' || isRunActive(run)
}

function targetHasRunningTurn(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord
): boolean {
  for (const runtime of server.db.runtimes.listByHostSessionId(session.hostSessionId)) {
    if (runtime.activeRunId !== undefined) {
      const run = server.db.runs.getByRunId(runtime.activeRunId)
      if (run === null || isDurablyActiveRun(run)) return true
    }
    if (
      runtime.status === 'busy' ||
      runtime.status === 'awaiting_input' ||
      runtime.status === 'starting' ||
      runtime.status === 'stopping'
    ) {
      return true
    }
  }
  return false
}

function terminalRunEvent(events: HrcLifecycleEvent[]): HrcLifecycleEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return event
  }
  return undefined
}

function observeAttempt(
  server: HrcServerInstanceForHandlers,
  attempt: HrcMailDriveAttempt
): AttemptObservation {
  const events = server.db.hrcEvents.listByRun(attempt.runId)
  const started = events.find((event) => event.eventKind === 'turn.started')
  let current = attempt
  if (started !== undefined) {
    current =
      server.db.mailDrives.recordStart({
        runId: attempt.runId,
        startHrcSeq: started.hrcSeq,
        startedAt: started.ts,
        hostSessionId: started.hostSessionId,
        generation: started.generation,
        runtimeId: started.runtimeId,
      }) ?? current
  }

  const terminal = terminalRunEvent(events)
  if (terminal !== undefined) {
    server.db.mailDrives.completeStartedAttempt(
      current.runId,
      terminal.eventKind,
      server.hrcMailMaxRounds
    )
    return 'finished'
  }

  const run = server.db.runs.getByRunId(current.runId)
  if (run === null) return 'dispatch'
  if (isDurablyActiveRun(run)) return 'waiting'

  if (run.completedAt !== undefined || run.status === 'completed' || run.status === 'failed') {
    server.db.mailDrives.completeStartedAttempt(
      current.runId,
      `run.${run.status}`,
      server.hrcMailMaxRounds
    )
    return 'finished'
  }
  return 'waiting'
}

async function driveMailTargetOnce(
  server: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): Promise<void> {
  let attempt = server.db.mailDrives.getActiveAttempt(targetSessionRef)
  if (attempt !== undefined) {
    const observation = observeAttempt(server, attempt)
    if (observation === 'waiting') return
    if (observation === 'finished') attempt = undefined
  }

  let session = findTargetSession(server.db, targetSessionRef) ?? undefined
  if (attempt === undefined) {
    if (session !== undefined && targetHasRunningTurn(server, session)) return
    const claim = server.db.mailDrives.claim(targetSessionRef, wakeReason)
    if (claim.outcome === 'clear') return
    attempt = claim.attempt
    if (claim.outcome === 'active') {
      const observation = observeAttempt(server, attempt)
      if (observation !== 'dispatch') return
    } else {
      try {
        await server.options.hrcMailKickerAfterClaim?.(attempt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        server.db.mailDrives.recordError(attempt.driveAttemptId, message)
        writeServerLog('WARN', 'hrcmail.kicker.after_claim_failed', {
          targetSessionRef,
          driveAttemptId: attempt.driveAttemptId,
          runId: attempt.runId,
          error: message,
        })
        return
      }
    }
  }

  try {
    const materializationIntent = session?.lastAppliedIntentJson ?? attempt.materializationIntent
    if (materializationIntent === undefined) {
      server.db.mailDrives.recordError(
        attempt.driveAttemptId,
        'target is unborn and the envelope has no materialization intent'
      )
      return
    }

    if (session === undefined) {
      // This is the only message-traffic provisioning path. ensureTargetSession
      // enters the normal summon/placement gate before it mints anything.
      session = await server.ensureTargetSession(targetSessionRef, materializationIntent)
    }
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: session.hostSessionId,
      generation: session.generation,
    })

    if (targetHasRunningTurn(server, session)) return

    const presented = server.db.mailDrives.presentForAttempt(attempt.driveAttemptId, (envelopeId) =>
      server.db.mailEnvelopes.require(envelopeId)
    )
    attempt = server.db.mailDrives.getAttempt(attempt.driveAttemptId) ?? attempt
    if (presented.length === 0) {
      server.db.mailDrives.completeNoOp(attempt.driveAttemptId)
      return
    }

    const response = await server.dispatchTurnForSession(
      session,
      session.lastAppliedIntentJson ?? materializationIntent,
      attempt.prompt,
      {
        runId: attempt.runId,
        waitForCompletion: false,
        whenBusy: 'reject',
      }
    )
    const body = (await response.json()) as DispatchTurnResponse
    server.db.mailDrives.recordSession(attempt.driveAttemptId, {
      hostSessionId: body.hostSessionId,
      generation: body.generation,
      runtimeId: body.runtimeId,
    })
    observeAttempt(server, attempt)
    writeServerLog('INFO', 'hrcmail.kicker.turn_dispatched', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      presentedCount: presented.length,
      wakeReason,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    server.db.mailDrives.recordError(attempt.driveAttemptId, message)
    writeServerLog('WARN', 'hrcmail.kicker.drive_failed', {
      targetSessionRef,
      driveAttemptId: attempt.driveAttemptId,
      runId: attempt.runId,
      wakeReason,
      error: message,
    })
  }
}

export function requestMailKickerWake(
  this: HrcServerInstanceForHandlers,
  targetSessionRef: string,
  wakeReason: HrcMailDriveWakeReason
): void {
  if (!this.hrcMailKickerEnabled || this.stopping) return
  this.mailKickerPendingTargets.set(targetSessionRef, wakeReason)
  queueMicrotask(() => {
    void this.drainMailKickerTarget(targetSessionRef).catch((error: unknown) => {
      writeServerLog('WARN', 'hrcmail.kicker.wake_failed', {
        targetSessionRef,
        wakeReason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}

export function drainMailKickerTarget(
  this: HrcServerInstanceForHandlers,
  targetSessionRef: string
): Promise<void> {
  const existing = this.mailKickerTargetOperations.get(targetSessionRef)
  if (existing !== undefined) return existing

  const operation = (async () => {
    while (!this.stopping && this.hrcMailKickerEnabled) {
      const reason = this.mailKickerPendingTargets.get(targetSessionRef)
      if (reason === undefined) return
      this.mailKickerPendingTargets.delete(targetSessionRef)
      await driveMailTargetOnce(this, targetSessionRef, reason)
    }
  })().finally(() => {
    this.mailKickerTargetOperations.delete(targetSessionRef)
    if (this.mailKickerPendingTargets.has(targetSessionRef) && !this.stopping) {
      queueMicrotask(() => void this.drainMailKickerTarget(targetSessionRef))
    }
  })
  this.mailKickerTargetOperations.set(targetSessionRef, operation)
  return operation
}

export function runMailKickerSweep(this: HrcServerInstanceForHandlers): Promise<void> {
  if (!this.hrcMailKickerEnabled || this.stopping) return Promise.resolve()
  if (this.mailKickerSweepInFlight !== undefined) return this.mailKickerSweepInFlight

  const sweep = (async () => {
    this.db.mailEnvelopes.requeueDeferredDue()
    const targets = this.db.mailDrives.listWakeTargets()
    for (const targetSessionRef of targets) {
      this.mailKickerPendingTargets.set(targetSessionRef, 'periodic')
    }
    await Promise.all(
      targets.map((targetSessionRef) => this.drainMailKickerTarget(targetSessionRef))
    )
  })().finally(() => {
    if (this.mailKickerSweepInFlight === sweep) this.mailKickerSweepInFlight = undefined
  })
  this.mailKickerSweepInFlight = sweep
  return sweep
}

export function startMailKicker(this: HrcServerInstanceForHandlers): void {
  if (!this.hrcMailKickerEnabled || this.mailKickerSweepTimer !== undefined) return
  this.mailKickerSweepTimer = setInterval(() => {
    void this.runMailKickerSweep().catch((error: unknown) => {
      writeServerLog('WARN', 'hrcmail.kicker.periodic_sweep_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, this.hrcMailKickerSweepIntervalMs)
  this.mailKickerSweepTimer.unref?.()
}

export function observeMailDriveLifecycleEvent(
  this: HrcServerInstanceForHandlers,
  event: HrcLifecycleEvent
): void {
  if (event.runId === undefined) return
  if (event.eventKind === 'turn.started') {
    this.db.mailDrives.recordStart({
      runId: event.runId,
      startHrcSeq: event.hrcSeq,
      startedAt: event.ts,
      hostSessionId: event.hostSessionId,
      generation: event.generation,
      runtimeId: event.runtimeId,
    })
    return
  }
  if (!MAIL_DRIVE_TERMINAL_EVENTS.has(event.eventKind)) return
  this.requestMailKickerWake(formatSessionRef(event.scopeRef, event.laneRef), 'turn_completion')
}

export const mailKickerHandlersMethods = {
  requestMailKickerWake,
  drainMailKickerTarget,
  runMailKickerSweep,
  startMailKicker,
  observeMailDriveLifecycleEvent,
}

export type MailKickerHandlersMethods = typeof mailKickerHandlersMethods
