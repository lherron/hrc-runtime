/**
 * The trigger that turns a registration into a live observer (T-08294 §3, §5).
 *
 * Registration and observation are deliberately separate facts — a desktop
 * conversation keeps its permanent address whether or not HRC is watching it —
 * but they are not independent ACTIONS. Without this module `attachDesktopObserver`
 * is unreachable: registrations accumulate addresses and every one of them
 * reports `unattached` forever.
 *
 * Two properties matter more than the mechanism:
 *
 *  - **Attachment never blocks registration.** The hook is in front of a turn
 *    Lance is waiting on, and the permanent mapping is already committed by the
 *    time we get here. So this is scheduled, not awaited, and a failure is
 *    DEGRADED OBSERVATION recorded on the registration — never an unregistered
 *    conversation and never a statement about desktop.
 *  - **HRC may reattach its own observer freely.** That is the one lifecycle
 *    power §3 grants it. Re-registration of a conversation whose observer died
 *    starts a new one on the SAME permanent address; it does not mint a name, it
 *    does not touch desktop, and it does not birth a CLI.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { DesktopThreadRegistration } from 'hrc-store-sqlite'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

import { writeServerLog } from '../server-log.js'
import { timestamp } from '../server-util.js'
import { CODEX_DESKTOP_BROKER_DRIVER, type CodexDesktopDriverSpec } from './observer-attachment.js'

/**
 * Conventional location of the desktop-bundled Codex on macOS. This is a
 * CANDIDATE that must exist on disk, never a hardcoded production path: the
 * compatibility readback is explicit that the observed values are observations
 * of one installation. An absent bundle leaves observation pending with a
 * diagnostic rather than handing the driver a path to nothing.
 */
const CONVENTIONAL_DESKTOP_BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/codex'

/** Operator override, for a desktop installed somewhere else. */
export const DESKTOP_BUNDLE_ENV = 'HRC_CODEX_DESKTOP_BUNDLE'

/**
 * Resolve the bundled executable the driver should use.
 *
 * Order is evidence-first: what the helper observed inside desktop's own process
 * beats an operator override, which beats a convention. Every candidate must
 * exist, so a stale recorded path falls through to one that does not.
 */
export function resolveDesktopBundleExecutable(input: {
  readonly reported?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}): string | undefined {
  const env = input.env ?? process.env
  const candidates = [input.reported, env[DESKTOP_BUNDLE_ENV], CONVENTIONAL_DESKTOP_BUNDLE]
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)
  )
}

/**
 * The CURRENT-GENERATION observer runtime row for a registration, if any.
 *
 * Two filters, and neither is sufficient alone.
 *
 * **Generation.** `listByHostSessionId` returns every row the session has ever
 * had. The precedent is T-07650: a gen-27 `ready` row took a message meant for
 * gen 50, because the lookup never compared generations. Newest-first with an
 * exact generation match is the same shape `presentationRuntimeIdFor` settled on.
 *
 * **Status.** An observer that terminated or was disposed is not an observer.
 *
 * What this deliberately does NOT decide is whether the row is ATTACHED. A
 * crashed or replay-stale external observer keeps `status: 'ready'` — the
 * lifecycle handlers return early for external ownership precisely so they do
 * not assert a terminal fact about something HRC does not own. So this answers
 * "which row", and {@link desktopObserverAttachmentHealth} answers "is it
 * connected". Blacklisting more statuses would not have helped: the real failure
 * leaves `ready` untouched.
 */
/**
 * Stable location for ASP's private native-attempt store.
 *
 * Keyed on the REGISTRATION, not the invocation or the capture directory, which
 * is the whole point: an uncertain native queue write must stay fenced when the
 * observer is replaced, and a replacement gets a fresh captureDir. Derived
 * deterministically so HRC hands back the same path after a restart without
 * storing an extra column. HRC never opens it — ASP owns the schema.
 */
export function desktopNativeAttemptStorePath(
  registration: DesktopThreadRegistration,
  stateRoot?: string | undefined
): string {
  const root = stateRoot ?? join(homedir(), '.hrc')
  return join(root, 'codex-desktop', registration.registrationKey, 'native-attempts.db')
}

export function currentDesktopObserverRuntime(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration
): HrcRuntimeSnapshot | undefined {
  const session = server.db.sessions.getByHostSessionId(registration.hostSessionId)
  if (session === undefined || session === null) return undefined
  const runtimes = server.db.runtimes.listByHostSessionId(registration.hostSessionId)
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    const runtime = runtimes[index]
    if (runtime === undefined) continue
    if (runtime.generation !== session.generation) continue
    if (runtime.status === 'terminated' || runtime.status === 'disposed') continue
    return runtime
  }
  return undefined
}

export type DesktopObserverHealth =
  | { readonly state: 'attached'; readonly runtime: HrcRuntimeSnapshot }
  | {
      readonly state: 'detached' | 'absent'
      readonly runtime?: HrcRuntimeSnapshot | undefined
      readonly reason: string
    }

/**
 * Is HRC actually observing this conversation right now?
 *
 * Answered from the durable attachment projection rather than from row status,
 * because row status is exactly what stays stale here. The two real loss
 * mechanisms both now record `control.brokerAttached: false` plus an
 * `observerAttachment` block at the moment HRC loses the connection
 * (`markBrokerCrashTerminal` and `failReplayStale`, external branches) WITHOUT
 * touching status — a detachment is a fact about HRC's observer, a status change
 * would be a claim about desktop.
 *
 * A live control probe is deliberately NOT run here. This sits on the hook's
 * bounded path, an unreachable broker would cost a timeout per registration, and
 * the recovery below re-probes for real by attempting the reattach anyway. The
 * cost of being wrong in the optimistic direction is one reattach attempt that
 * finds the broker healthy; the cost of the old predicate was never recovering.
 *
 * The durable projection alone is NOT sufficient, and T-08296 is the specimen.
 * An HRC restart is not a crash: nothing writes a detachment, so
 * `observerAttachment` stays null and `control.brokerAttached` keeps the `true`
 * the PREVIOUS daemon wrote. Every field this function used to read therefore
 * said "attached" while the new daemon held no socket at all — the conversation
 * went unobserved with its row reading `ready`, and every re-registration
 * answered `already_attached`. So the projection is now joined with the one fact
 * only the live process has: whether the REQUEST-SERVING controller holds a
 * client for this runtime's CURRENT invocation. That is an in-memory lookup, not
 * the RPC this comment rules out.
 */
export function desktopObserverAttachmentHealth(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration
): DesktopObserverHealth {
  const runtime = currentDesktopObserverRuntime(server, registration)
  if (runtime === undefined) {
    return { state: 'absent', reason: 'no current-generation observer runtime' }
  }
  const state = runtime.runtimeStateJson ?? {}
  const attachment = state['observerAttachment']
  if (
    attachment !== null &&
    typeof attachment === 'object' &&
    !Array.isArray(attachment) &&
    (attachment as Record<string, unknown>)['state'] === 'detached'
  ) {
    const reason = (attachment as Record<string, unknown>)['reason']
    return {
      state: 'detached',
      runtime,
      reason: typeof reason === 'string' ? reason : 'observer_detached',
    }
  }
  const control = state['control']
  if (
    control !== null &&
    typeof control === 'object' &&
    !Array.isArray(control) &&
    (control as Record<string, unknown>)['brokerAttached'] === false
  ) {
    return { state: 'detached', runtime, reason: 'broker_not_attached' }
  }
  // The live half. A runtime whose invocation this daemon is not holding a
  // client for needs a REATTACH — it says nothing about whether the broker is
  // alive, which is why the recovery below dials the persisted endpoint before
  // it ever considers a replacement.
  if (runtime.activeInvocationId !== undefined) {
    const held = server.getHarnessBrokerController().activeClientInvocationId(runtime.runtimeId)
    if (held !== runtime.activeInvocationId) {
      return {
        state: 'detached',
        runtime,
        reason:
          held === undefined
            ? 'serving_controller_client_absent'
            : 'serving_controller_client_stale',
      }
    }
  }
  // A runtime that never reached a started invocation has nothing to reattach.
  if (runtime.status === 'failed' || runtime.status === 'crashed' || runtime.status === 'stale') {
    return { state: 'detached', runtime, reason: `runtime_${runtime.status}` }
  }
  return { state: 'attached', runtime }
}

/** Back-compat alias; prefer {@link currentDesktopObserverRuntime}. */
export const liveDesktopObserverRuntime = currentDesktopObserverRuntime

/** In-flight attachments, per server instance. One attempt per registration. */
const attachmentOperations = new WeakMap<HrcServerInstanceForHandlers, Map<string, Promise<void>>>()

function operationsFor(server: HrcServerInstanceForHandlers): Map<string, Promise<void>> {
  let operations = attachmentOperations.get(server)
  if (operations === undefined) {
    operations = new Map<string, Promise<void>>()
    attachmentOperations.set(server, operations)
  }
  return operations
}

export type DesktopAttachmentDisposition =
  | { readonly scheduled: true }
  | { readonly scheduled: false; readonly reason: string; readonly detail: string }

/**
 * Build the private driver spec for a registration, or say why it cannot be built.
 *
 * The rollout path is required and must EXIST. The compatibility readback records
 * that a freshly started thread may not have persisted a rollout yet, so an
 * absent one is a retryable pending — the next hook attaches — not a failure of
 * the registration and not a claim about desktop.
 */
export function buildDesktopDriverSpec(
  registration: DesktopThreadRegistration,
  env?: Record<string, string | undefined> | undefined,
  recoveryBoundary?: DesktopRecoveryBoundary | undefined,
  stateRoot?: string | undefined
):
  | { readonly driver: CodexDesktopDriverSpec }
  | { readonly reason: string; readonly detail: string } {
  const rolloutPath = registration.rolloutPath
  if (rolloutPath === undefined || !existsSync(rolloutPath)) {
    return {
      reason: 'rollout_unavailable',
      detail:
        rolloutPath === undefined
          ? 'registration has no recorded rollout path yet'
          : `rollout ${rolloutPath} is not readable`,
    }
  }
  const bundleExecutable = resolveDesktopBundleExecutable({
    ...(registration.bundlePath === undefined ? {} : { reported: registration.bundlePath }),
    ...(env === undefined ? {} : { env }),
  })
  if (bundleExecutable === undefined) {
    return {
      reason: 'bundle_unresolved',
      detail: `no desktop-bundled Codex executable found; set ${DESKTOP_BUNDLE_ENV}`,
    }
  }
  return {
    driver: {
      kind: CODEX_DESKTOP_BROKER_DRIVER,
      bundleExecutable,
      codexHome: registration.homeIdentity,
      sqliteHome: registration.sqliteHome,
      threadId: registration.nativeThreadId,
      rolloutPath,
      // Present ONLY on a replacement observer, and deliberately NOT a byte
      // offset. See {@link desktopRecoveryBoundary}: HRC has no source position
      // to give, and the filesystem length it CAN measure is the producer's EOF,
      // which would silently discard everything written-but-unread and
      // read-but-uncommitted when the driver honours it.
      ...(recoveryBoundary === undefined ? {} : { recoveryBoundary }),
      // ASP's own attempt store, so an uncertain native queue write stays fenced
      // across observer replacement. HRC derives it once per registration,
      // persists it, and re-passes it verbatim — it is an OPAQUE path here.
      // ASP owns the schema and is the only reader/writer; HRC never opens it.
      // Deliberately NOT under the per-invocation captureDir, which is exactly
      // what a replacement observer does not inherit.
      nativeAttemptStorePath: desktopNativeAttemptStorePath(registration, stateRoot),
    },
  }
}

/**
 * What HRC has DURABLY COMMITTED for a previous observer's invocation.
 *
 * This replaces an earlier `adoptionWatermark: { byteOffset }` taken from
 * `statSync(rolloutPath).size`. That was wrong and Astra caught it: the file
 * length is the PRODUCER's current EOF, not how far the observer read nor how
 * far HRC committed. A broker can die behind the producer, with unread lines,
 * captured-but-unprojected events and a partial trailing line all below that
 * offset — so resuming there would have silently dropped them the moment the
 * driver honoured the field. Filesystem length is not delivery evidence.
 *
 * The real evidence was already on disk and I had not looked in the right
 * column. `broker_invocation_events.broker_envelope_json` carries, per event:
 *
 *   provenance.rawRecordId    the source RECORD, so several normalized events
 *                             from one JSONL line are groupable (observed: 372
 *                             records producing 400+ events)
 *   provenance.sourceCursor   { byteOffset, line } — the record's START offset
 *   provenance.sourceEpoch    file identity, so a replaced/rotated rollout is
 *                             not mistaken for the same source
 *   provenance.rawSha256      the raw record hash
 *   provenance.nativeType/nativeId, plus envelope turnId/itemId
 *
 * Filtering on `projectionStatus === 'applied'` turns that into a COMMITTED
 * boundary rather than a captured one: an event the broker delivered but HRC
 * never projected is exactly the event recovery must re-deliver.
 *
 * The boundary says what was committed and where that record STARTS. It does
 * not tell the driver where to resume reading — deciding that belongs to the
 * side that owns the file cursor, which is why the boundary record is named
 * rather than skipped: re-emitting it whole and letting HRC drop the
 * projections it already has is what makes a partially-projected record safe.
 */
export type DesktopRecoveryBoundary = {
  readonly sourceKind?: string | undefined
  /** Identity of the observed file. A different epoch invalidates the offsets. */
  readonly sourceEpoch?: string | undefined
  /**
   * The furthest source record HRC has COMMITTED anything from.
   *
   * ADVISORY. It does NOT certify that every earlier record was published, and
   * a replacement must not use it as a skip-to position. HRC scans its own
   * `broker_invocation_events`, so it can only speak about records that reached
   * it: normalization still BUFFERED inside the driver — an AgentMessage held
   * until `task_complete` flushes — has no row here at all, and is invisible to
   * this scan even when its raw record precedes this one. Choosing the restart
   * position belongs to the side that knows what it is still holding.
   */
  readonly furthestCommittedRecord?:
    | {
        readonly rawRecordId: string
        readonly byteOffset: number
        readonly line?: number | undefined
        readonly rawSha256?: string | undefined
        readonly nativeType?: string | undefined
      }
    | undefined
  /**
   * The earliest record HRC holds an UNPROJECTED row for, when it has one.
   *
   * A LOWER BOUND on how far back replay must reach, never an upper bound, for
   * the same reason: a record the driver never emitted leaves no row to find.
   */
  readonly earliestPendingRecord?:
    | { readonly rawRecordId: string; readonly byteOffset: number }
    | undefined
  /**
   * EVERY projection HRC has committed for this invocation — not a suffix.
   *
   * The whole set, because the replacement may legitimately restart EARLIER
   * than anything in this boundary (it retains buffered normalization HRC never
   * saw). A suffix-scoped dedupe set would then re-admit every applied record
   * before that point as new. This is the load-bearing half of the contract:
   * HRC says what it already has, the driver decides where to resume, and
   * duplicates are resolved by identity rather than by position.
   */
  readonly committedProjections: readonly {
    readonly seq: number
    readonly type: string
    readonly turnId?: string | undefined
    readonly itemId?: string | undefined
    readonly nativeId?: string | undefined
    readonly rawRecordId?: string | undefined
  }[]
  /** Highest broker seq HRC applied. Per-invocation space; diagnostics only. */
  readonly appliedThroughSeq: number
  /** Nothing committed — the replacement must adopt from the start. */
  readonly empty: boolean
}

type AppliedEnvelope = {
  readonly seq: number
  readonly type: string
  readonly turnId?: string | undefined
  readonly itemId?: string | undefined
  readonly provenance: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseAppliedEnvelope(json: string | undefined): AppliedEnvelope | undefined {
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const seq = parsed['seq']
  const type = parsed['type']
  if (typeof seq !== 'number' || typeof type !== 'string') return undefined
  const provenance = parsed['provenance']
  return {
    seq,
    type,
    ...(typeof parsed['turnId'] === 'string' ? { turnId: parsed['turnId'] } : {}),
    ...(typeof parsed['itemId'] === 'string' ? { itemId: parsed['itemId'] } : {}),
    provenance: isRecord(provenance) ? provenance : {},
  }
}

/**
 * Derive the recovery boundary from a previous observer's durable events.
 *
 * HRC reports what it committed and what it knows is outstanding. It does not
 * compute a restart position, because it cannot: its evidence is limited to
 * events that actually reached it, and the driver may still be holding
 * normalization that never did.
 */
export function desktopRecoveryBoundary(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot | undefined
): DesktopRecoveryBoundary | undefined {
  const invocationId = runtime?.activeInvocationId
  if (runtime === undefined || invocationId === undefined) return undefined

  const applied: AppliedEnvelope[] = []
  let appliedThroughSeq = 0
  let sourceKind: string | undefined
  let sourceEpoch: string | undefined
  let furthestApplied: AppliedEnvelope | undefined
  let furthestAppliedOffset = -1
  let earliestPending: AppliedEnvelope | undefined
  let earliestPendingOffset = Number.POSITIVE_INFINITY

  for (const event of server.db.brokerInvocationEvents.listByInvocationId(invocationId)) {
    const envelope = parseAppliedEnvelope(event.brokerEnvelopeJson)
    if (envelope === undefined) continue
    if (typeof envelope.provenance['sourceKind'] === 'string') {
      sourceKind = envelope.provenance['sourceKind']
    }
    if (typeof envelope.provenance['sourceEpoch'] === 'string') {
      sourceEpoch = envelope.provenance['sourceEpoch']
    }
    const cursor = envelope.provenance['sourceCursor']
    const byteOffset =
      isRecord(cursor) && typeof cursor['byteOffset'] === 'number'
        ? cursor['byteOffset']
        : undefined

    if (event.projectionStatus === 'applied') {
      appliedThroughSeq = Math.max(appliedThroughSeq, event.seq)
      applied.push(envelope)
      if (byteOffset !== undefined && byteOffset > furthestAppliedOffset) {
        furthestAppliedOffset = byteOffset
        furthestApplied = envelope
      }
      continue
    }
    if (byteOffset !== undefined && byteOffset < earliestPendingOffset) {
      earliestPendingOffset = byteOffset
      earliestPending = envelope
    }
  }

  const recordOf = (
    envelope: AppliedEnvelope,
    byteOffset: number
  ): { rawRecordId: string; byteOffset: number } => {
    const rawRecordId = envelope.provenance['rawRecordId']
    return {
      rawRecordId: typeof rawRecordId === 'string' ? rawRecordId : `offset:${byteOffset}`,
      byteOffset,
    }
  }

  const committedProjections = applied.map((envelope) => {
    const rawRecordId = envelope.provenance['rawRecordId']
    return {
      seq: envelope.seq,
      type: envelope.type,
      ...(envelope.turnId === undefined ? {} : { turnId: envelope.turnId }),
      ...(envelope.itemId === undefined ? {} : { itemId: envelope.itemId }),
      ...(typeof envelope.provenance['nativeId'] === 'string'
        ? { nativeId: envelope.provenance['nativeId'] }
        : {}),
      ...(typeof rawRecordId === 'string' ? { rawRecordId } : {}),
    }
  })

  const base = {
    ...(sourceKind === undefined ? {} : { sourceKind }),
    ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
    ...(earliestPending === undefined
      ? {}
      : { earliestPendingRecord: recordOf(earliestPending, earliestPendingOffset) }),
    committedProjections,
    appliedThroughSeq,
  }

  if (furthestApplied === undefined) {
    return { ...base, empty: committedProjections.length === 0 }
  }
  const cursor = furthestApplied.provenance['sourceCursor']
  return {
    ...base,
    furthestCommittedRecord: {
      ...recordOf(furthestApplied, furthestAppliedOffset),
      ...(isRecord(cursor) && typeof cursor['line'] === 'number' ? { line: cursor['line'] } : {}),
      ...(typeof furthestApplied.provenance['rawSha256'] === 'string'
        ? { rawSha256: furthestApplied.provenance['rawSha256'] }
        : {}),
      ...(typeof furthestApplied.provenance['nativeType'] === 'string'
        ? { nativeType: furthestApplied.provenance['nativeType'] }
        : {}),
    },
    empty: false,
  }
}

/**
 * Schedule (never await) an observer attachment for a registration.
 *
 * Idempotent three ways: a live observer short-circuits, an in-flight attempt is
 * joined rather than duplicated, and the broker controller itself is the final
 * fence. Returning a disposition rather than a promise is deliberate — callers
 * report what was scheduled; they must not be able to wait on it.
 */
export function scheduleDesktopObserverAttachment(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration
): DesktopAttachmentDisposition {
  const health = desktopObserverAttachmentHealth(server, registration)
  if (health.state === 'attached') {
    return {
      scheduled: false,
      reason: 'already_attached',
      detail: `runtime ${health.runtime.runtimeId} is already observing this conversation`,
    }
  }
  const operations = operationsFor(server)
  if (operations.has(registration.registrationKey)) {
    return {
      scheduled: false,
      reason: 'attachment_in_flight',
      detail: 'an attachment attempt for this conversation is already running',
    }
  }
  const stateRoot = server.options.stateRoot
  const built = buildDesktopDriverSpec(registration, undefined, undefined, stateRoot)
  if (!('driver' in built)) {
    writeServerLog('INFO', 'desktop_observer.attach_deferred', {
      scopeRef: registration.scopeRef,
      nativeThreadId: registration.nativeThreadId,
      reason: built.reason,
      detail: built.detail,
    })
    return { scheduled: false, reason: built.reason, detail: built.detail }
  }

  const detached = health.state === 'detached' ? health.runtime : undefined
  const resumed =
    detached === undefined
      ? built
      : buildDesktopDriverSpec(
          registration,
          undefined,
          desktopRecoveryBoundary(server, detached),
          stateRoot
        )
  if (!('driver' in resumed)) {
    return { scheduled: false, reason: resumed.reason, detail: resumed.detail }
  }
  const operation = recoverDesktopObserver(server, registration, resumed.driver, detached)
    .then((outcome) => {
      if (!outcome.attached) {
        // Degraded observation, recorded and left recoverable. The permanent
        // address, the mapping and the desktop conversation are all untouched.
        writeServerLog('WARN', 'desktop_observer.attach_degraded', {
          scopeRef: registration.scopeRef,
          nativeThreadId: registration.nativeThreadId,
          reason: outcome.reason,
          detail: outcome.detail,
        })
      }
    })
    .catch((error: unknown) => {
      writeServerLog('WARN', 'desktop_observer.attach_error', {
        scopeRef: registration.scopeRef,
        nativeThreadId: registration.nativeThreadId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      operations.delete(registration.registrationKey)
    })
  operations.set(registration.registrationKey, operation)
  return { scheduled: true }
}

/**
 * Recover observation for a registration whose observer is absent or detached.
 *
 * Order is the point. A DETACHED runtime may still have a live broker holding a
 * durable invocation — a daemon restart, a lost controller, a replay hiccup — and
 * reattaching to it is strictly better than starting over: the existing
 * invocation, its event cursor and its capture pipeline are preserved, so nothing
 * duplicates and no historical turn is re-presented as new. Only when the broker
 * is genuinely unreachable does a fresh observer start, and even then the old row
 * is left alone: HRC records that it superseded its own observer, and never
 * asserts a terminal fact about a conversation it does not own.
 *
 * `reattachDurableBrokerSessionForOpen` is the SAME lazy-reattach the dispatch
 * path uses (T-01801) — dial the persisted endpoint, read the attach token,
 * `attachAndReplay`, single-flight per runtime. Reusing it is what keeps desktop
 * recovery on the ordinary durable-broker semantics instead of a private one.
 */
async function recoverDesktopObserver(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration,
  driver: CodexDesktopDriverSpec,
  detached: HrcRuntimeSnapshot | undefined
): Promise<{ readonly attached: boolean; readonly reason?: string; readonly detail?: string }> {
  if (detached !== undefined) {
    const reattach = await server
      .reattachDurableBrokerSessionForOpen(detached)
      .catch((error: unknown) => ({
        state: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error),
      }))
    if (reattach.state === 'reattached') {
      const now = timestamp()
      // Re-read AFTER the await. `attachAndReplay` persists refreshed broker,
      // invocation and replay state onto this row while we were suspended, and
      // spreading the pre-await snapshot over it silently reverted all of it —
      // including the very cursor that stops replay re-presenting history. The
      // stale-snapshot overwrite is only invisible because the fields it clobbers
      // are the ones nothing reads until the next restart.
      const fresh = server.db.runtimes.getByRuntimeId(detached.runtimeId) ?? detached
      const priorState = fresh.runtimeStateJson ?? {}
      const priorControl =
        priorState['control'] !== null &&
        typeof priorState['control'] === 'object' &&
        !Array.isArray(priorState['control'])
          ? (priorState['control'] as Record<string, unknown>)
          : {}
      server.db.runtimes.update(detached.runtimeId, {
        updatedAt: now,
        runtimeStateJson: {
          ...priorState,
          updatedAt: now,
          // `attachAndReplay` sets this itself on the real path; restoring it
          // here too keeps the projection coherent rather than leaving a
          // reattached observer reading `brokerAttached: false` forever.
          control: { ...priorControl, mode: 'broker-ipc', brokerAttached: true },
          observerAttachment: { state: 'attached', reattachedAt: now, via: 'durable-replay' },
        },
      })
      writeServerLog('INFO', 'desktop_observer.reattached', {
        scopeRef: registration.scopeRef,
        nativeThreadId: registration.nativeThreadId,
        runtimeId: detached.runtimeId,
      })
      return { attached: true }
    }
    // The broker is gone, so a fresh observer is the only way back. Record that
    // HRC superseded ITS OWN observer — no status change, no terminal reason,
    // and nothing said about the desktop thread.
    const now = timestamp()
    const priorState =
      (server.db.runtimes.getByRuntimeId(detached.runtimeId) ?? detached).runtimeStateJson ?? {}
    server.db.runtimes.update(detached.runtimeId, {
      updatedAt: now,
      runtimeStateJson: {
        ...priorState,
        updatedAt: now,
        observerAttachment: {
          state: 'superseded',
          supersededAt: now,
          reason: 'durable reattach unavailable; a fresh observer was started',
        },
      },
    })
    writeServerLog('INFO', 'desktop_observer.superseded', {
      scopeRef: registration.scopeRef,
      nativeThreadId: registration.nativeThreadId,
      runtimeId: detached.runtimeId,
      reattachState: reattach.state,
    })
  }
  return await server.attachDesktopObserver({ registration, driver })
}
