import { randomUUID } from 'node:crypto'
import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import type { JsonRepairRunCorrelation } from './broker-headless-types.js'
import { formatDmAddress } from './messages.js'
import { requireSession } from './require-helpers.js'
import { omitPersistedSelectionForReuse } from './selector-message-handlers/selection-request.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type CoalescedQueuedMember,
  type DispatchRunPersistenceOptions,
  dispatchOriginRunFields,
} from './server-types.js'
import { timestamp } from './server-util.js'

type DurableHeadlessTurnInput = {
  kind: string
  prompt: string
  source: string
  sourceMessageId?: string | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
}

function parseDurableHeadlessTurnInput(value: string | null): DurableHeadlessTurnInput | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<DurableHeadlessTurnInput>
    if (typeof parsed.kind !== 'string' || typeof parsed.prompt !== 'string') return undefined
    const source = typeof parsed.source === 'string' ? parsed.source : parsed.kind
    return { ...parsed, kind: parsed.kind, prompt: parsed.prompt, source }
  } catch {
    return undefined
  }
}

type DurableHeadlessQueueEntry = {
  run: HrcRunRecord
  delivery: DurableHeadlessTurnInput
}

/**
 * The caller prompt of a cold-birth accepted run, made durable (T-07944).
 *
 * A promptless cold boot accepts the run and then waits for the compiler
 * priming turn before submitting the caller's prompt through the invoke door.
 * That wait used to live only in an in-memory `.then` chain, so a daemon
 * restart in the window dropped the prompt with no record: the run stayed
 * `accepted` with no `dispatched_input_id` until the zombie sweep buried it 30
 * minutes later. Persisting the prompt and its dispatch options at acceptance
 * (in the SAME `runs.correlation_json` column the queued path already uses)
 * lets startup recovery re-arm the wait -> submit, or fail the run positively
 * and immediately when the invocation it was owed to is gone.
 */
const DURABLE_COLD_BOOT_INPUT_KIND = 'durable_cold_boot_turn_input'

type DurableColdBootTurnInput = DurableHeadlessTurnInput & {
  kind: typeof DURABLE_COLD_BOOT_INPUT_KIND
  source: 'cold_boot'
  /**
   * The shared dispatch-persistence options verbatim (all JSON scalars/objects),
   * so a re-armed submit rebuilds `executeHeadlessBrokerInputTurn`'s options
   * exactly instead of inventing a fresh, lossier set.
   */
  dispatch: DispatchRunPersistenceOptions
}

export function parseDurableColdBootTurnInput(
  value: string | null
): DurableColdBootTurnInput | undefined {
  const parsed = parseDurableHeadlessTurnInput(value)
  if (parsed === undefined || parsed.kind !== DURABLE_COLD_BOOT_INPUT_KIND) return undefined
  const dispatch = (parsed as { dispatch?: unknown }).dispatch
  return {
    ...parsed,
    kind: DURABLE_COLD_BOOT_INPUT_KIND,
    source: 'cold_boot',
    dispatch:
      dispatch !== null && typeof dispatch === 'object'
        ? (dispatch as DispatchRunPersistenceOptions)
        : { dispatchIdempotencyKey: undefined },
  }
}

function isDefaultPlainResponseFormat(responseFormat: HrcTurnResponseFormat | undefined): boolean {
  return responseFormat === undefined || responseFormat.kind === 'text'
}

function isCoalescibleSemanticDm(entry: DurableHeadlessQueueEntry): boolean {
  return (
    entry.delivery.source === 'semantic_dm' &&
    entry.delivery.sourceMessageId !== undefined &&
    isDefaultPlainResponseFormat(entry.delivery.responseFormat)
  )
}

export function formatQueuedDeliveryRemainderTrailer(
  entries: ReadonlyArray<{ seq?: number | undefined; senderScope: string }>
): string {
  return [
    `[queued delivery snapshot remainder count=${entries.length}]`,
    ...entries.map(
      (entry) => `- seq=${entry.seq === undefined ? 'n/a' : entry.seq} sender=${entry.senderScope}`
    ),
  ].join('\n')
}

export function formatQueuedSemanticDmDelivery(
  prompt: string,
  acceptedAt: string,
  deliveredAt: string
): string {
  const acceptedAtMs = Date.parse(acceptedAt)
  const deliveredAtMs = Date.parse(deliveredAt)
  const queueAgeMs =
    Number.isFinite(acceptedAtMs) && Number.isFinite(deliveredAtMs)
      ? Math.max(0, deliveredAtMs - acceptedAtMs)
      : 0
  return [
    `[queued DM delivery acceptedAt=${acceptedAt} deliveredAt=${deliveredAt} queueAgeMs=${queueAgeMs}]`,
    prompt,
  ].join('\n')
}

export function enqueueDurableHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    source: 'boot' | 'semantic_dm'
    runtimeId?: string | undefined
    sourceMessageId?: string | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): void {
  this.db.sqlite.transaction(() => {
    if (this.db.runs.getByRunId(runId)) return
    const nextQueueSeq =
      (this.db.sqlite
        .query<{ max_seq: number | null }, []>('SELECT MAX(queued_input_seq) AS max_seq FROM runs')
        .get()?.max_seq ?? 0) + 1
    const now = timestamp()
    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'queued',
      acceptedAt: now,
      updatedAt: now,
      queuedInputSeq: nextQueueSeq,
      dispatchedInputId: `input-${randomUUID()}`,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      ...dispatchOriginRunFields(options),
    })
    this.db.runs.setCorrelationJson(
      runId,
      JSON.stringify({
        kind: 'durable_headless_turn_input',
        prompt,
        source: options.source,
        ...(options.sourceMessageId !== undefined
          ? { sourceMessageId: options.sourceMessageId }
          : {}),
        ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
      } satisfies DurableHeadlessTurnInput)
    )
  })()
}

export async function dispatchQueuedHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn runtime has no broker invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  const queued = this.db.runs.getByRunId(runId)
  const inputId = queued?.dispatchedInputId
  if (queued?.status !== 'queued' || inputId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn input is no longer dispatchable', {
      runtimeId: runtime.runtimeId,
      runId,
      status: queued?.status,
      route: 'broker-queued-input',
    })
  }

  const claimedAt = timestamp()
  const claimed = this.db.sqlite.transaction(() => {
    const ownerClaimed = this.db.runs.claimQueued(runId, {
      runtimeId: runtime.runtimeId,
      invocationId,
      operationId: runtime.activeOperationId,
      dispatchedInputId: inputId,
      updatedAt: claimedAt,
    })
    if (!ownerClaimed) return false

    for (const member of options.coalescedMembers ?? []) {
      const message = this.db.messages.getById(member.sourceMessageId)
      if (
        message === undefined ||
        message.execution.state !== 'accepted' ||
        message.execution.runId !== member.runId
      ) {
        throw new Error(`queued DM ${member.sourceMessageId} is not coalescible`)
      }
      if (
        !this.db.runs.markQueuedCoalesced(member.runId, {
          ownerRunId: runId,
          position: member.position,
          completedAt: claimedAt,
          updatedAt: claimedAt,
        })
      ) {
        throw new Error(`queued run ${member.runId} is not coalescible`)
      }
      this.db.messages.updateExecution(member.sourceMessageId, {
        state: 'coalesced',
        coalescedIntoRunId: runId,
        coalescedPosition: member.position,
      })
    }
    return true
  })()
  if (!claimed) {
    throw new HrcRuntimeUnavailableError('queued turn input was already claimed', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  return await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, options)
}

export async function drainDurableHeadlessTurnInputs(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string
): Promise<void> {
  if (this.queuedTurnInputDrains.has(hostSessionId)) return
  this.queuedTurnInputDrains.add(hostSessionId)
  let queued: HrcRunRecord | undefined
  let delivery: DurableHeadlessTurnInput | undefined

  try {
    const snapshot = this.db.runs
      .snapshotQueuedByHostSessionId(hostSessionId, `queue-snapshot-${randomUUID()}`, timestamp())
      .map((run): DurableHeadlessQueueEntry | undefined => {
        const parsed = parseDurableHeadlessTurnInput(this.db.runs.getCorrelationJson(run.runId))
        return parsed === undefined ? undefined : { run, delivery: parsed }
      })
    if (snapshot.length === 0) return
    const first = snapshot[0]
    if (first === undefined) return

    const executing: DurableHeadlessQueueEntry[] = []
    if (isCoalescibleSemanticDm(first)) {
      for (const entry of snapshot) {
        if (entry === undefined || !isCoalescibleSemanticDm(entry)) break
        executing.push(entry)
      }
    } else {
      executing.push(first)
    }
    const owner = executing.at(-1)
    if (owner === undefined) return
    queued = owner.run
    delivery = owner.delivery
    const remainder = snapshot.slice(executing.length)

    const session = requireSession(this.db, hostSessionId)
    // T-07206: fresh starts commit this field only after controller.start succeeds,
    // so it is safe for an automatic drain to reuse as materialization authority.
    const persistedIntent = session.lastAppliedIntentJson
    const intent =
      persistedIntent === undefined ? undefined : omitPersistedSelectionForReuse(persistedIntent)
    if (!intent) {
      throw new HrcRuntimeUnavailableError('queued turn has no runtime intent', {
        hostSessionId,
        runId: queued.runId,
        route: 'broker-queued-input',
      })
    }

    const deliveredAt = timestamp()
    const content = executing
      .map((entry) =>
        entry.delivery.source === 'semantic_dm'
          ? formatQueuedSemanticDmDelivery(
              entry.delivery.prompt,
              entry.run.acceptedAt ?? entry.run.updatedAt,
              deliveredAt
            )
          : entry.delivery.prompt
      )
      .join('\n\n')
    const trailer = formatQueuedDeliveryRemainderTrailer(
      remainder.map((entry) => {
        if (entry === undefined) return { senderScope: 'unknown' }
        const message =
          entry.delivery.sourceMessageId === undefined
            ? undefined
            : this.db.messages.getById(entry.delivery.sourceMessageId)
        return {
          seq: entry.run.queuedInputSeq,
          senderScope:
            message === undefined ? entry.delivery.source : formatDmAddress(message.from),
        }
      })
    )
    const prompt = `${content}\n\n${trailer}`
    const coalescedMembers = executing.slice(0, -1).map((entry, position) => {
      const sourceMessageId = entry.delivery.sourceMessageId
      if (sourceMessageId === undefined) {
        throw new Error(`coalescible run ${entry.run.runId} has no source message`)
      }
      return { runId: entry.run.runId, sourceMessageId, position }
    })
    const response = await this.dispatchTurnForSession(session, intent, prompt, {
      runId: queued.runId,
      waitForCompletion: false,
      responseFormat: delivery.responseFormat,
      ...(coalescedMembers.length === 0 ? {} : { coalescedMembers }),
    })
    const result = (await response.json()) as DispatchTurnResponse
    if (delivery.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: result.status === 'completed' ? 'completed' : 'started',
        mode: 'headless',
        sessionRef: `${session.scopeRef}/lane:${session.laneRef}`,
        hostSessionId: result.hostSessionId,
        generation: result.generation,
        runtimeId: result.runtimeId,
        runId: result.runId,
        transport: 'headless',
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (queued) {
      const now = timestamp()
      this.db.runs.markCompleted(queued.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: message,
      })
    }
    if (delivery?.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: 'failed',
        errorCode: 'delivery_not_guaranteed',
        errorMessage: `input ${delivery.sourceMessageId} was not delivered: ${message}`,
      })
    }
    writeServerLog('WARN', 'turn_input_queue.drain_failed', {
      hostSessionId,
      runId: queued?.runId,
      error: message,
    })
  } finally {
    this.queuedTurnInputDrains.delete(hostSessionId)
  }
}
