import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { ParticipantAdapter, WriterEvidence, WriterRef } from 'spaces-runtime-contracts'
import { validateWriterEvidence } from 'spaces-runtime-contracts'

import type { ParticipantHostingIntent } from './participant-hosting-intent.js'
import type { ParticipantRealizedHosting } from './participant-realization.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'
import { createTmuxManager } from './tmux.js'

/**
 * The absorbing dispositions that record HRC projecting the producer's own
 * terminal event. `invocation.exited` is the last envelope of an ordered
 * per-invocation stream, so projecting it is simultaneously the primary fact
 * behind two independent questions: that exact writer can emit no further
 * native write, and nothing it committed remains unprojected. Neither answer is
 * derived from the other, and neither is derived from liveness.
 */
const PRODUCER_TERMINAL_DISPOSITION_PREFIX = 'producer-terminal:'

function parseJson<T>(json: string | undefined): T | null {
  if (json === undefined) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

/**
 * The exact writer a successor would replace: the broker instance HRC committed
 * at install acknowledgement.
 *
 * That instance is a bridge in both join directions. HRC hosting a broker
 * process conveys broker resource ownership only, so a broker instance id is
 * never relabeled as an application host incarnation id, and `subject` is never
 * inferred from the join. This phase declares only `key-scoped` classes, which
 * own no host incarnation identity at all; a `host` subject belongs to the
 * separately authored host-incarnation policy and is not minted here.
 */
export function participantWriterRef(
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): WriterRef | null {
  const identity = parseJson<{ brokerInstanceId?: unknown }>(attempt.brokerIdentityJson)
  const brokerInstanceId = identity?.brokerInstanceId
  if (
    subject === 'bridge' &&
    (typeof brokerInstanceId !== 'string' || brokerInstanceId.length === 0)
  ) {
    return null
  }
  // A `WriterRef` is identified by class and key. A direct protocol join may
  // have neither, and this evidence path is the key-scoped one, so an absent
  // pair means there is no ref to mint -- not a ref with placeholder parts.
  if (registration.classId === undefined || registration.participantKey === undefined) return null
  return {
    subject,
    classId: registration.classId,
    participantKey: registration.participantKey,
    attemptId: attempt.attemptId,
    invocationId: attempt.invocationId as WriterRef['invocationId'],
    attachEpoch: attempt.attachEpoch,
    ...(subject === 'bridge' ? { brokerInstanceId: brokerInstanceId as string } : {}),
    ...(subject === 'host' && registration.hostIncarnationId !== undefined
      ? { hostIncarnationId: registration.hostIncarnationId }
      : {}),
  }
}

function projectedProducerTerminal(attempt: ParticipantAttempt): string | null {
  if (attempt.state !== 'TERMINAL') return null
  const reason = attempt.dispositionReason?.trim() ?? ''
  return reason.startsWith(PRODUCER_TERMINAL_DISPOSITION_PREFIX) ? reason : null
}

type ObservedLiveness = { state: 'dead' | 'live' | 'unknown'; reason: string }

/**
 * Observes only the broker process HRC launched, against the launch identity
 * HRC itself committed. This is the HRC-owned process inspection the closure
 * permits; it reads no external host and no participant-owned bridge, and it
 * asserts nothing about any application beyond the child HRC owns.
 */
async function observeCommittedBrokerProcess(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt
): Promise<ObservedLiveness> {
  const realized = parseJson<ParticipantRealizedHosting>(attempt.realizedHostingJson)
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson)
  if (realized === null || intent?.hrcHosted === undefined) {
    return { state: 'unknown', reason: 'hrc-hosted broker has no committed launch identity yet' }
  }
  if (realized.substrate.kind !== 'leased-tmux') {
    return { state: 'unknown', reason: 'hrc-hosted broker has no committed process lease' }
  }
  const lease = realized.substrate
  const expectedCommandLine = `bun ${intent.hrcHosted.brokerArgv.join(' ')}`
  try {
    const tmux = (server.brokerTmuxManagerFactory ?? createTmuxManager)({
      socketPath: lease.brokerWindow.socketPath,
    })
    await tmux.initialize()
    const inspectPaneProcess = tmux.inspectPaneProcess?.bind(tmux)
    if (inspectPaneProcess === undefined) {
      return { state: 'unknown', reason: 'committed broker lease cannot be inspected here' }
    }
    const observed = await inspectPaneProcess(lease.brokerWindow.paneId)
    if (observed === null) {
      return { state: 'dead', reason: 'committed broker pane process is gone' }
    }
    if (observed.dead) {
      return { state: 'dead', reason: 'committed broker pane process exited' }
    }
    if (
      observed.pid !== lease.pid ||
      observed.command !== lease.command ||
      observed.commandLine !== expectedCommandLine
    ) {
      // A different process now occupies the committed lease. The writer HRC
      // launched is therefore gone; nothing is claimed about whatever replaced it.
      return {
        state: 'dead',
        reason: 'committed broker launch identity no longer occupies its lease',
      }
    }
    return { state: 'live', reason: 'committed broker process matches its launch identity' }
  } catch (error) {
    // A failed observation is an absence of knowledge, never death and never
    // retirement. It holds.
    return {
      state: 'unknown',
      reason: `committed broker observation failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * HRC's own evidence about the broker instance it launched and owns.
 *
 * `hrc-hosted` classes never ask their adapter about this writer, so a hosted
 * adapter that predates the writer-evidence seam — exposing neither
 * `retireWriter` nor `inspectWriter` — keeps working unchanged.
 */
export async function committedInstanceWriterEvidence(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt
): Promise<WriterEvidence | null> {
  const writerRef = participantWriterRef(registration, attempt)
  if (writerRef === null) return null
  const terminal = projectedProducerTerminal(attempt)
  const liveness = await observeCommittedBrokerProcess(server, attempt)
  return {
    schemaVersion: 'writer-evidence/v1',
    writerRef,
    observedAt: timestamp(),
    writePath:
      terminal === null
        ? {
            state: 'unknown',
            reason: 'no projected producer terminal for this committed broker invocation',
          }
        : { state: 'retired', reason: `projected ${terminal}` },
    liveness: { state: liveness.state, reason: liveness.reason },
    priorRecovery:
      terminal === null
        ? {
            state: 'unknown',
            reason: 'this committed broker invocation has no projected terminal envelope',
          }
        : {
            state: 'recovered',
            reason: `ordered producer stream projected through ${terminal}`,
          },
  }
}

const ABSORBING_ATTEMPT_STATES = new Set(['SUPERSEDED', 'ABANDONED', 'TERMINAL'])

export function isAbsorbingParticipantAttempt(attempt: ParticipantAttempt): boolean {
  return ABSORBING_ATTEMPT_STATES.has(attempt.state)
}

/**
 * Evidence about the exact writer a successor would replace, from that writer's
 * owner: HRC's committed instance facts for `hrc-hosted`, the adapter for
 * `participant-served`. A missing adapter method, a thrown call and a failed
 * validation are all read as no evidence, which holds; none is read as a state.
 */
export async function obtainParticipantWriterEvidence(
  server: HrcServerInstanceForHandlers,
  adapter: ParticipantAdapter,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): Promise<WriterEvidence | null> {
  const observed = await observeParticipantWriterEvidence(
    server,
    adapter,
    registration,
    attempt,
    subject
  )
  return observed.outcome === 'evidence' ? observed.evidence : null
}

export type ParticipantWriterEvidenceObservation =
  | { outcome: 'evidence'; evidence: WriterEvidence }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' }

/** Detailed form used when invalid producer evidence must be refused distinctly. */
export async function observeParticipantWriterEvidence(
  server: HrcServerInstanceForHandlers,
  adapter: ParticipantAdapter,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  subject: WriterRef['subject'] = 'bridge'
): Promise<ParticipantWriterEvidenceObservation> {
  if (registration.join === 'hrc-hosted') {
    const evidence = await committedInstanceWriterEvidence(server, registration, attempt)
    return evidence === null ? { outcome: 'unavailable' } : { outcome: 'evidence', evidence }
  }
  const exactWriter = participantWriterRef(registration, attempt, subject)
  if (exactWriter === null) return { outcome: 'unavailable' }
  // An already-absorbing prior writer is only inspected: asking its owner to
  // retire it again would be a fresh effect on someone else's writer rather
  // than an observation. Either method is read as evidence about the same
  // exact writer, and the request actually made is the one validated against.
  const preferInspection =
    isAbsorbingParticipantAttempt(attempt) || adapter.retireWriter === undefined
  const inspect = preferInspection && adapter.inspectWriter !== undefined
  const request = inspect
    ? { writerRef: exactWriter }
    : { writerRef: exactWriter, reason: 'successor-registration' }
  let raw: unknown
  try {
    raw = inspect
      ? await adapter.inspectWriter?.(request as { writerRef: WriterRef })
      : await adapter.retireWriter?.(request as { writerRef: WriterRef; reason: string })
  } catch {
    return { outcome: 'unavailable' }
  }
  if (raw === undefined) return { outcome: 'unavailable' }
  const validated = validateWriterEvidence(request, raw)
  return validated.ok ? { outcome: 'evidence', evidence: validated.value } : { outcome: 'invalid' }
}
