import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BrokerDispatchInspectView } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope, SeatProbeResponse } from 'spaces-harness-broker-protocol'

import { appendHrcEvent } from '../hrc-event-helper'
import type { BrokerControllerLogger } from './controller/types'
import { canOperatorAttach } from './runtime-hosting'

export const DEFAULT_BROKER_SEAT_PROBE_INTERVAL_MS = 5_000
export const DEFAULT_BROKER_DISPATCH_STALL_THRESHOLD_MS = 60_000
export const BROKER_CLOSE_OUTPUT_TAIL_BYTES = 8 * 1024
const RECENT_DIAGNOSTIC_LIMIT = 32

export type BrokerSeatStateName =
  | 'idle'
  | 'turn-active'
  | 'turn-observed'
  | 'starting'
  | 'stopping'
  | 'terminal'

export type BrokerSeatObservation = {
  availability: 'current' | 'stale' | 'unavailable'
  state: BrokerSeatStateName | null
  observedAt: string
  attemptedAt?: string | undefined
  invocationId: string | null
  brokerHeldDepth: number | null
  turnId?: string | undefined
  cause: string
  error?: string | undefined
}

export type BrokerSeatTransition = {
  runtimeId: string
  invocationId: string
  previousState: BrokerSeatStateName | null
  nextState: BrokerSeatStateName
  transitionedAt: string
  cause: string
  brokerHeldDepth: number
  turnId?: string | undefined
  stalledWarnedAt?: string | undefined
}

export type BrokerSubmissionMilestone = {
  submissionId: string
  runId: string | null
  door: string | null
  admissionClass: string | null
  acceptedAt: string | null
  handedToHarnessAt: string | null
  turnStartedAt: string | null
  turnId: string | null
  /**
   * T-08333. Absorption is LANDED evidence, not a turn start: the body merged
   * into a turn that was already running, so the submission originates no turn
   * of its own and never advances past `handed_to_harness`. Kept separate from
   * `turnStartedAt`/`turnId` so the record itself preserves the distinction —
   * `absorbedTurnId` is the turn this submission JOINED, never one it started.
   * Absent on records written before T-08333, so read them with `!= null`.
   */
  absorbedAt: string | null
  absorbedTurnId: string | null
  lastMilestone: 'accepted' | 'handed_to_harness' | 'turn_started'
  stalledWarnedAt?: string | undefined
}

type SubmissionMilestonePatch = Partial<BrokerSubmissionMilestone> & {
  lastMilestone: BrokerSubmissionMilestone['lastMilestone']
}

export type BrokerTurnOriginDiagnostic = {
  turnId: string | null
  inputId: string | null
  runId: string | null
  origin: 'hrc-dispatched' | 'local-interactive' | 'unknown'
  observedAt: string
}

export type BrokerCloseOutput = {
  availability: 'available' | 'unavailable'
  source: 'broker-stderr-file' | 'broker-transport-error' | 'unavailable'
  tail: string | null
  bytes: number
  truncated: boolean
  path: string | null
  reason?: string | undefined
}

export type BrokerCloseDiagnostic = {
  runtimeId: string
  invocationId: string | null
  observedAt: string
  invocationPhaseAtClose: string
  brokerPid: number | null
  childPid: number | null
  exitCode: number | null
  signal: string | null
  error: string
  output: BrokerCloseOutput
}

export type BrokerDispatchDiagnostics = {
  liveSeatProbe?: BrokerSeatObservation | undefined
  seatTransitions?: BrokerSeatTransition[] | undefined
  submissions?: BrokerSubmissionMilestone[] | undefined
  turns?: BrokerTurnOriginDiagnostic[] | undefined
  lastUnexpectedClose?: BrokerCloseDiagnostic | undefined
  lastAuthorityDisagreementKey?: string | undefined
}

function diagnosticsFor(
  runtimeState: Record<string, unknown> | undefined
): BrokerDispatchDiagnostics {
  const value = runtimeState?.['brokerDispatchDiagnostics']
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as BrokerDispatchDiagnostics)
    : {}
}

function bounded<T>(items: readonly T[]): T[] {
  return items.slice(-RECENT_DIAGNOSTIC_LIMIT)
}

function appendDurableDiagnostic(
  db: HrcDatabase,
  runtimeId: string,
  eventKind: string,
  eventJson: Record<string, unknown>,
  ts: string,
  runId?: string | undefined
): void {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) return
  appendHrcEvent(db, eventKind, {
    ts,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    runtimeId,
    ...(runId !== undefined ? { runId } : {}),
    payload: eventJson,
  })
}

function updateDiagnostics(
  db: HrcDatabase,
  runtimeId: string,
  now: string,
  update: (current: BrokerDispatchDiagnostics) => BrokerDispatchDiagnostics
): BrokerDispatchDiagnostics | undefined {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) return undefined
  const next = update(diagnosticsFor(runtime.runtimeStateJson))
  db.runtimes.update(runtimeId, {
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      brokerDispatchDiagnostics: next,
    },
    updatedAt: now,
  })
  return next
}

export function recordSeatProbe(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  runtimeId: string
  invocationId: string
  response: SeatProbeResponse
  observedAt: string
  cause: string
  stallThresholdMs: number
}): BrokerSeatObservation {
  const state = input.response.seat.state
  const currentRuntime = input.db.runtimes.getByRuntimeId(input.runtimeId)
  const current = diagnosticsFor(currentRuntime?.runtimeStateJson)
  const previous = current.liveSeatProbe
  const previousTransition = current.seatTransitions?.at(-1)
  const transitioned = previous?.state !== state || previous.invocationId !== input.invocationId
  const observation: BrokerSeatObservation = {
    availability: 'current',
    state,
    observedAt: input.observedAt,
    invocationId: input.invocationId,
    brokerHeldDepth: input.response.brokerHeldDepth,
    ...(input.response.seat.state === 'turn-active' || input.response.seat.state === 'turn-observed'
      ? { turnId: String(input.response.seat.turnId) }
      : {}),
    cause: input.cause,
  }
  let transition = previousTransition
  if (transitioned) {
    transition = {
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
      previousState: previous?.state ?? null,
      nextState: state,
      transitionedAt: input.observedAt,
      cause: input.cause,
      brokerHeldDepth: input.response.brokerHeldDepth,
      ...(input.response.seat.state === 'turn-active' ||
      input.response.seat.state === 'turn-observed'
        ? { turnId: String(input.response.seat.turnId) }
        : {}),
    }
    appendDurableDiagnostic(
      input.db,
      input.runtimeId,
      'broker.seat.transition',
      transition,
      input.observedAt
    )
    input.logger.info?.('broker.seat.transition', transition)
  }

  const transitionAgeMs = transition
    ? Date.parse(input.observedAt) - Date.parse(transition.transitionedAt)
    : 0
  const shouldWarn =
    state !== 'idle' &&
    state !== 'turn-active' &&
    transition !== undefined &&
    transition.invocationId === input.invocationId &&
    transition.nextState === state &&
    transition.stalledWarnedAt === undefined &&
    transitionAgeMs >= input.stallThresholdMs
  const warnedAt = shouldWarn ? input.observedAt : undefined
  const nextTransition: BrokerSeatTransition | undefined =
    warnedAt && transition ? { ...transition, stalledWarnedAt: warnedAt } : transition
  updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => {
    const priorTransitions = latest.seatTransitions ?? []
    const seatTransitions =
      nextTransition === undefined
        ? priorTransitions
        : transitioned
          ? bounded([...priorTransitions, nextTransition])
          : bounded([...priorTransitions.slice(0, -1), nextTransition])
    return { ...latest, liveSeatProbe: observation, seatTransitions }
  })

  if (warnedAt && nextTransition) {
    const fields = {
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
      seatState: state,
      nonDispatchableSince: nextTransition.transitionedAt,
      durationMs: transitionAgeMs,
      thresholdMs: input.stallThresholdMs,
      cause: input.cause,
      dispatchGate: 'live-seat',
    }
    appendDurableDiagnostic(input.db, input.runtimeId, 'broker.seat.stalled', fields, warnedAt)
    input.logger.warn?.('broker.seat.stalled', fields)
  }
  return observation
}

export function recordUnavailableSeatProbe(input: {
  db: HrcDatabase
  runtimeId: string
  invocationId?: string | undefined
  observedAt: string
  cause: string
  error: string
}): BrokerSeatObservation {
  const runtime = input.db.runtimes.getByRuntimeId(input.runtimeId)
  const previous = diagnosticsFor(runtime?.runtimeStateJson).liveSeatProbe
  const observation: BrokerSeatObservation = {
    availability:
      previous?.state !== undefined && previous.state !== null ? 'stale' : 'unavailable',
    state: previous?.state ?? null,
    observedAt: previous?.observedAt ?? input.observedAt,
    attemptedAt: input.observedAt,
    invocationId: input.invocationId ?? previous?.invocationId ?? null,
    brokerHeldDepth: previous?.brokerHeldDepth ?? null,
    ...(previous?.turnId !== undefined ? { turnId: previous.turnId } : {}),
    cause: input.cause,
    error: input.error,
  }
  updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => ({
    ...latest,
    liveSeatProbe: observation,
  }))
  return observation
}

export function recordSubmissionAccepted(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  runtimeId: string
  invocationId: string
  submissionId: string
  runId?: string | undefined
  door: string
  admissionClass: string
  observedAt: string
}): void {
  updateSubmission(input, {
    admissionClass: input.admissionClass,
    acceptedAt: input.observedAt,
    lastMilestone: 'accepted',
  })
}

/**
 * The correlation carried by `submission.executed` / `submission.absorbed`:
 * `{submissionId, turnId}`. The submissionId is the submission's OWN identity,
 * so evidence read here can only ever settle the submission it names.
 */
function submissionDispositionEvidence(
  envelope: InvocationEventEnvelope
): { submissionId: string; turnId: string | null } | undefined {
  const payload =
    envelope.payload !== null && typeof envelope.payload === 'object'
      ? (envelope.payload as { submissionId?: unknown; turnId?: unknown })
      : undefined
  if (typeof payload?.submissionId !== 'string') return undefined
  const turnId =
    typeof envelope.turnId === 'string'
      ? envelope.turnId
      : typeof payload.turnId === 'string'
        ? payload.turnId
        : null
  return { submissionId: payload.submissionId, turnId }
}

export function recordBrokerEventMilestones(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  runtimeId: string
  envelope: InvocationEventEnvelope
  runId?: string | undefined
  observedAt: string
}): void {
  const inputId =
    input.envelope.inputId ??
    (input.envelope.payload && typeof input.envelope.payload === 'object'
      ? ((input.envelope.payload as { inputId?: unknown }).inputId as string | undefined)
      : undefined)
  if (input.envelope.type === 'input.accepted' && inputId !== undefined) {
    updateSubmission(
      {
        ...input,
        invocationId: String(input.envelope.invocationId),
        submissionId: inputId,
        door: 'unknown',
      },
      { handedToHarnessAt: input.observedAt, lastMilestone: 'handed_to_harness' }
    )
  }
  // T-08333: `submission.executed` IS the correlated start evidence for a
  // submission whose driver reports an inputId-less `turn.started`. Its payload
  // names the submission AND the turn it originated, so it settles exactly that
  // submission and can never settle another input. It records the moment HRC
  // OBSERVED the execution — the envelope's own `time` is deliberately NOT
  // read, so nothing is backdated to an asserted original start — and it never
  // overwrites a start already observed, so a replayed or duplicated execution
  // leaves the recorded start alone. Frozen evidence in
  // var/wrkq-artifacts/T-08296/quasar-audit (C-21096/C-21097): four queued
  // submissions across both drivers executed and were then reported stalled 60 s
  // after acceptance, because nothing here consumed this event.
  if (input.envelope.type === 'submission.executed') {
    const evidence = submissionDispositionEvidence(input.envelope)
    if (evidence !== undefined) {
      updateSubmission(
        {
          ...input,
          invocationId: String(input.envelope.invocationId),
          submissionId: evidence.submissionId,
          door: 'unknown',
        },
        (previous) =>
          previous?.turnStartedAt != null
            ? { lastMilestone: 'turn_started' }
            : {
                turnStartedAt: input.observedAt,
                turnId: evidence.turnId ?? previous?.turnId ?? null,
                lastMilestone: 'turn_started',
              }
      )
    }
    return
  }
  // T-08333: `submission.absorbed` is landed evidence of the SAME class —
  // `hrc-mail-kicker/src/drive/landing.ts` has always treated executed and
  // absorbed alike as landed. Absorption is NOT a turn start: the body merged
  // into a turn already running, so it originates no turn, emits no
  // `turn.started` of its own, and must not stamp a start time or a turn
  // origin. It settles the DELIVERY-stall condition only, and the milestone
  // stays `handed_to_harness` — which absorption does prove, since a body
  // cannot merge into a live turn without having reached the harness.
  if (input.envelope.type === 'submission.absorbed') {
    const evidence = submissionDispositionEvidence(input.envelope)
    if (evidence !== undefined) {
      updateSubmission(
        {
          ...input,
          invocationId: String(input.envelope.invocationId),
          submissionId: evidence.submissionId,
          door: 'unknown',
        },
        (previous) =>
          previous?.absorbedAt != null
            ? { lastMilestone: 'handed_to_harness' }
            : {
                absorbedAt: input.observedAt,
                absorbedTurnId: evidence.turnId ?? previous?.absorbedTurnId ?? null,
                lastMilestone: 'handed_to_harness',
              }
      )
    }
    return
  }
  if (input.envelope.type !== 'turn.started') return

  const turnId =
    input.envelope.turnId ??
    (input.envelope.payload && typeof input.envelope.payload === 'object'
      ? ((input.envelope.payload as { turnId?: unknown }).turnId as string | undefined)
      : undefined)
  if (inputId !== undefined) {
    updateSubmission(
      {
        ...input,
        invocationId: String(input.envelope.invocationId),
        submissionId: inputId,
        door: 'unknown',
      },
      {
        turnStartedAt: input.observedAt,
        turnId: turnId ?? null,
        lastMilestone: 'turn_started',
      }
    )
  }
  const runtime = input.db.runtimes.getByRuntimeId(input.runtimeId)
  const origin: BrokerTurnOriginDiagnostic['origin'] =
    input.runId !== undefined
      ? 'hrc-dispatched'
      : runtime !== null && canOperatorAttach(runtime)
        ? 'local-interactive'
        : 'unknown'
  const turn: BrokerTurnOriginDiagnostic = {
    turnId: turnId ?? null,
    inputId: inputId ?? null,
    runId: input.runId ?? null,
    origin,
    observedAt: input.observedAt,
  }
  updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => ({
    ...latest,
    turns: bounded([...(latest.turns ?? []), turn]),
  }))
  appendDurableDiagnostic(
    input.db,
    input.runtimeId,
    'broker.turn.origin',
    turn,
    input.observedAt,
    input.runId
  )
  input.logger.info?.('broker.turn.origin', { runtimeId: input.runtimeId, ...turn })
}

function updateSubmission(
  input: {
    db: HrcDatabase
    logger: BrokerControllerLogger
    runtimeId: string
    invocationId: string
    submissionId: string
    runId?: string | undefined
    door: string
    admissionClass?: string | undefined
    observedAt: string
  },
  patch:
    | SubmissionMilestonePatch
    | ((previous?: BrokerSubmissionMilestone) => SubmissionMilestonePatch)
): void {
  let milestone!: BrokerSubmissionMilestone
  let appliedMilestone!: BrokerSubmissionMilestone['lastMilestone']
  updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => {
    const submissions = [...(latest.submissions ?? [])]
    const index = submissions.findIndex((entry) => entry.submissionId === input.submissionId)
    const previous = index >= 0 ? submissions[index] : undefined
    const resolved = typeof patch === 'function' ? patch(previous) : patch
    appliedMilestone = resolved.lastMilestone
    const milestoneRank = { accepted: 0, handed_to_harness: 1, turn_started: 2 } as const
    const lastMilestone =
      previous !== undefined &&
      milestoneRank[previous.lastMilestone] > milestoneRank[resolved.lastMilestone]
        ? previous.lastMilestone
        : resolved.lastMilestone
    milestone = {
      submissionId: input.submissionId,
      runId: input.runId ?? previous?.runId ?? null,
      door: input.door === 'unknown' ? (previous?.door ?? null) : input.door,
      admissionClass: input.admissionClass ?? previous?.admissionClass ?? null,
      acceptedAt: previous?.acceptedAt ?? null,
      handedToHarnessAt: previous?.handedToHarnessAt ?? null,
      turnStartedAt: previous?.turnStartedAt ?? null,
      turnId: previous?.turnId ?? null,
      absorbedAt: previous?.absorbedAt ?? null,
      absorbedTurnId: previous?.absorbedTurnId ?? null,
      ...previous,
      ...resolved,
      lastMilestone,
    }
    if (index >= 0) submissions[index] = milestone
    else submissions.push(milestone)
    return { ...latest, submissions: bounded(submissions) }
  })
  const fields = {
    runtimeId: input.runtimeId,
    invocationId: input.invocationId,
    submissionId: input.submissionId,
    runId: milestone.runId,
    door: milestone.door,
    admissionClass: milestone.admissionClass,
    milestone: appliedMilestone,
    observedAt: input.observedAt,
  }
  appendDurableDiagnostic(
    input.db,
    input.runtimeId,
    'broker.submission.milestone',
    fields,
    input.observedAt,
    milestone.runId ?? undefined
  )
  input.logger.info?.('broker.submission.milestone', fields)
}

export function warnStalledSubmissions(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  runtimeId: string
  invocationId: string
  observedAt: string
  thresholdMs: number
  seatState: string
  invocationPhase: string
}): void {
  const runtime = input.db.runtimes.getByRuntimeId(input.runtimeId)
  const diagnostics = diagnosticsFor(runtime?.runtimeStateJson)
  const nowMs = Date.parse(input.observedAt)
  for (const submission of diagnostics.submissions ?? []) {
    if (
      submission.acceptedAt === null ||
      submission.turnStartedAt !== null ||
      submission.stalledWarnedAt !== undefined
    ) {
      continue
    }
    // T-08333: absorption is landed evidence. A QUEUE-door submission that
    // merges into a live turn originates no turn of its own, so it never
    // reports a `turn.started` and never advances past `handed_to_harness` —
    // the exact exposure the door-scoped carve-out below does NOT cover. It is
    // the delivery-stall condition that is settled here; no start is asserted.
    if (submission.absorbedAt != null) continue
    // A STEER's last milestone IS `handed_to_harness` (T-08108). It joins a turn
    // that is already running and originates none of its own, so it will never
    // report a `turn.started` of its own and this detector would warn about
    // every healthy steer at the threshold — as it did on max3, 60 s after a
    // delivery that had already reached the pane. Only a steer that never
    // reached the harness is actually stalled.
    if (submission.door === 'steer' && submission.handedToHarnessAt !== null) continue
    const durationMs = nowMs - Date.parse(submission.acceptedAt)
    if (!Number.isFinite(durationMs) || durationMs < input.thresholdMs) continue
    updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => ({
      ...latest,
      submissions: (latest.submissions ?? []).map((entry) =>
        entry.submissionId === submission.submissionId
          ? { ...entry, stalledWarnedAt: input.observedAt }
          : entry
      ),
    }))
    const fields = {
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
      submissionId: submission.submissionId,
      runId: submission.runId,
      acceptedAt: submission.acceptedAt,
      durationMs,
      thresholdMs: input.thresholdMs,
      lastCompletedMilestone: submission.lastMilestone,
      seatState: input.seatState,
      invocationPhase: input.invocationPhase,
    }
    appendDurableDiagnostic(
      input.db,
      input.runtimeId,
      'broker.submission.stalled',
      fields,
      input.observedAt,
      submission.runId ?? undefined
    )
    input.logger.warn?.('broker.submission.stalled', fields)
  }
}

function redactDiagnosticOutput(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(
      /((?:token|secret|password|passwd|pwd|authorization|cookie|api[_-]?key|oauth)["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
      '$1[REDACTED]'
    )
}

function boundRedactedText(text: string, limit: number): string {
  const redacted = Buffer.from(redactDiagnosticOutput(text), 'utf8')
  return redacted.byteLength <= limit
    ? redacted.toString('utf8')
    : redacted.subarray(redacted.byteLength - limit).toString('utf8')
}

function tailUtf8(
  text: string,
  limit: number
): { tail: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= limit) {
    return { tail: boundRedactedText(text, limit), bytes: bytes.byteLength, truncated: false }
  }
  return {
    tail: boundRedactedText(bytes.subarray(bytes.byteLength - limit).toString('utf8'), limit),
    bytes: limit,
    truncated: true,
  }
}

function readBoundedFileTail(path: string, limit: number): ReturnType<typeof tailUtf8> | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, limit)
    if (length === 0) return undefined
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
    return {
      tail: boundRedactedText(buffer.toString('utf8'), limit),
      bytes: length,
      truncated: size > limit,
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function parseProcessTermination(message: string): {
  exitCode: number | null
  signal: string | null
} {
  const signal = message.match(/\bsignal\s+(SIG[A-Z0-9]+)/i)?.[1]?.toUpperCase() ?? null
  const exit = message.match(/\bexit code\s+(-?\d+)/i)?.[1]
  return { exitCode: exit !== undefined ? Number(exit) : null, signal }
}

export function buildBrokerCloseDiagnostic(input: {
  db: HrcDatabase
  runtimeId: string
  error: Error
  observedAt: string
}): BrokerCloseDiagnostic {
  const runtime = input.db.runtimes.getByRuntimeId(input.runtimeId)
  const invocation = runtime?.activeInvocationId
    ? input.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
    : input.db.brokerInvocations.listByRuntimeId(input.runtimeId).at(-1)
  const broker = runtime?.runtimeStateJson?.['broker']
  const brokerRecord =
    broker !== null && typeof broker === 'object' ? (broker as Record<string, unknown>) : undefined
  const attachTokenRef = brokerRecord?.['endpoint']
  const endpoint =
    attachTokenRef !== null && typeof attachTokenRef === 'object'
      ? (attachTokenRef as Record<string, unknown>)
      : undefined
  const tokenRefValue = endpoint?.['attachTokenRef']
  const tokenRef =
    tokenRefValue !== null && typeof tokenRefValue === 'object'
      ? (tokenRefValue as Record<string, unknown>)
      : undefined
  const stderrPath =
    typeof tokenRef?.['path'] === 'string'
      ? join(dirname(tokenRef['path']), 'broker.err')
      : undefined
  const fileTail = stderrPath
    ? readBoundedFileTail(stderrPath, BROKER_CLOSE_OUTPUT_TAIL_BYTES)
    : undefined
  const embeddedStderr = input.error.message.match(/\nBroker stderr:\n([\s\S]*)$/)?.[1]
  const embeddedTail = embeddedStderr
    ? tailUtf8(embeddedStderr, BROKER_CLOSE_OUTPUT_TAIL_BYTES)
    : undefined
  const captured = fileTail ?? embeddedTail
  const termination = parseProcessTermination(input.error.message)
  return {
    runtimeId: input.runtimeId,
    invocationId: invocation?.invocationId ?? null,
    observedAt: input.observedAt,
    invocationPhaseAtClose: invocation?.invocationState ?? 'unknown',
    brokerPid:
      invocation?.brokerPid ??
      (typeof brokerRecord?.['brokerPid'] === 'number' ? brokerRecord['brokerPid'] : null),
    childPid: invocation?.childPid ?? runtime?.childPid ?? null,
    exitCode: termination.exitCode,
    signal: termination.signal,
    error: input.error.message.split('\n')[0] ?? input.error.message,
    output: captured
      ? {
          availability: 'available',
          source: fileTail ? 'broker-stderr-file' : 'broker-transport-error',
          tail: captured.tail,
          bytes: captured.bytes,
          truncated: captured.truncated,
          path: fileTail && stderrPath ? stderrPath : null,
        }
      : {
          availability: 'unavailable',
          source: 'unavailable',
          tail: null,
          bytes: 0,
          truncated: false,
          path: stderrPath ?? null,
          reason: stderrPath
            ? 'broker stderr file absent or unreadable'
            : 'no retained output source',
        },
  }
}

export function persistBrokerCloseDiagnostic(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  diagnostic: BrokerCloseDiagnostic
}): void {
  const { diagnostic } = input
  updateDiagnostics(input.db, diagnostic.runtimeId, diagnostic.observedAt, (latest) => ({
    ...latest,
    lastUnexpectedClose: diagnostic,
  }))
  appendDurableDiagnostic(
    input.db,
    diagnostic.runtimeId,
    'broker.socket.closed_unexpectedly',
    diagnostic,
    diagnostic.observedAt
  )
  input.logger.error?.('broker.socket.closed_unexpectedly', diagnostic)
}

export function getBrokerDispatchDiagnostics(
  db: HrcDatabase,
  runtimeId: string
): BrokerDispatchDiagnostics | undefined {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  const diagnostics = diagnosticsFor(runtime?.runtimeStateJson)
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined
}

export function projectBrokerDispatchInspectView(input: {
  runtimeProjection: string
  invocationProjection: string | null
  liveSeatProbe: BrokerSeatObservation
  diagnostics?: BrokerDispatchDiagnostics | undefined
}): BrokerDispatchInspectView {
  const { liveSeatProbe } = input
  const projectionDispatchable =
    input.runtimeProjection === 'ready' && input.invocationProjection === 'ready'
  const seatDispatchable = liveSeatProbe.state === 'idle'
  return {
    dispatchGate: 'live-seat',
    agreement:
      liveSeatProbe.availability === 'stale'
        ? 'stale'
        : liveSeatProbe.availability === 'unavailable'
          ? 'unavailable'
          : projectionDispatchable === seatDispatchable
            ? 'agree'
            : 'disagree',
    runtimeProjection: input.runtimeProjection,
    invocationProjection: input.invocationProjection,
    liveSeatProbe,
    seatTransitions: input.diagnostics?.seatTransitions ?? [],
    submissions: input.diagnostics?.submissions ?? [],
    turns: input.diagnostics?.turns ?? [],
    lastUnexpectedClose: input.diagnostics?.lastUnexpectedClose ?? null,
  }
}

export function recordAuthorityDisagreement(input: {
  db: HrcDatabase
  logger: BrokerControllerLogger
  runtimeId: string
  invocationId: string | null
  runtimeState: string
  invocationState: string | null
  seat: BrokerSeatObservation
  observedAt: string
}): boolean {
  if (input.seat.availability !== 'current' || input.seat.state === null) return false
  const expectedDispatchable = input.runtimeState === 'ready' && input.invocationState === 'ready'
  const seatDispatchable = input.seat.state === 'idle'
  const disagreement = expectedDispatchable !== seatDispatchable
  if (!disagreement) return false
  const key = JSON.stringify([
    input.runtimeState,
    input.invocationState,
    input.seat.state,
    input.seat.invocationId,
  ])
  const current = getBrokerDispatchDiagnostics(input.db, input.runtimeId)
  if (current?.lastAuthorityDisagreementKey === key) return true
  updateDiagnostics(input.db, input.runtimeId, input.observedAt, (latest) => ({
    ...latest,
    lastAuthorityDisagreementKey: key,
  }))
  const fields = {
    runtimeId: input.runtimeId,
    invocationId: input.invocationId,
    runtimeProjection: input.runtimeState,
    invocationProjection: input.invocationState,
    liveSeatState: input.seat.state,
    liveSeatObservedAt: input.seat.observedAt,
    dispatchGate: 'live-seat',
    disagreement: true,
  }
  appendDurableDiagnostic(
    input.db,
    input.runtimeId,
    'broker.dispatch_authority.disagreement',
    fields,
    input.observedAt
  )
  input.logger.warn?.('broker.dispatch_authority.disagreement', fields)
  return true
}
