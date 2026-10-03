import { randomUUID } from 'node:crypto'
import { HrcRuntimeUnavailableError, createPhaseRecorder } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeSnapshot,
  PhaseRecord,
  PrepareAttachedRunResponse,
  ResumeAttachedRunResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import { isAttachedRunAspdCodexIntent } from './presentation-operator.js'
import { projectHrcReleaseIdentity } from './release-provenance.js'
import { requireKnownRuntime, requireSession } from './require-helpers.js'
import {
  DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS,
  DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  type parseDispatchTurnRequest,
  parseJsonBody,
  parsePrepareAttachedRunRequest,
  parseResumeAttachedRunRequest,
} from './server-parsers.js'
import type { AttachedRunObservation, PendingAttachedRunOperation } from './server-types.js'
import { assertDispatchRunId, json, requireDispatchRuntimeId } from './server-util.js'
import { toStartRuntimeResponse } from './status-views.js'

type AttachedRunResult = StartRuntimeResponse | DispatchTurnResponse

async function dispatchTurnResponseJson(response: Response) {
  return (await response.json()) as DispatchTurnResponse
}

function runtimeIdFromAttachedRunResult(result: AttachedRunResult): string {
  if ('runId' in result) {
    const dispatched = result as DispatchTurnResponse
    assertDispatchRunId(dispatched)
    return requireDispatchRuntimeId(dispatched)
  }
  if (result.runtimeId === undefined) {
    throw new Error('attached start completed without runtime identity')
  }
  return result.runtimeId
}

async function attachDescriptorBody(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
) {
  return (await server.attachRuntime(runtime).json()) as PrepareAttachedRunResponse['attach']
}

export type DispatchTurnObservationContext = {
  lifecycleFromSeq: number
  brokerAfterSeqByInvocation: Map<string, number>
}

export type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}

export function normalizeJsonRepairCorrelation(
  repair: NonNullable<ReturnType<typeof parseDispatchTurnRequest>['repair']>,
  repairRunId: string
): JsonRepairRunCorrelation {
  return {
    kind: 'json_repair',
    sourceRunId: repair.sourceRunId,
    failedValidationRunId: repair.failedValidationRunId ?? repair.sourceRunId,
    repairRunId,
  }
}

export function captureBrokerAfterSeqByInvocation(
  server: HrcServerInstanceForHandlers,
  hostSessionId: string
): Map<string, number> {
  const cursors = new Map<string, number>()
  for (const runtime of server.db.runtimes.listByHostSessionId(hostSessionId)) {
    if (runtime.controllerKind !== 'harness-broker' || runtime.activeInvocationId === undefined) {
      continue
    }
    cursors.set(
      runtime.activeInvocationId,
      server.db.brokerInvocationEvents.maxBrokerSeq(runtime.activeInvocationId)
    )
  }
  return cursors
}

export async function enrichDispatchTurnResponse(
  server: HrcServerInstanceForHandlers,
  response: Response,
  context: DispatchTurnObservationContext
): Promise<Response> {
  const body = (await response.json()) as Omit<
    DispatchTurnResponse,
    'startIdentity' | 'observation'
  > &
    Partial<Pick<DispatchTurnResponse, 'startIdentity' | 'observation'>>
  // Format2 returns an input receipt whose broker observation was persisted at
  // admission. It intentionally has no lifecycle/run selector to enrich.
  if (body.runId === undefined) {
    return json(body, response.status)
  }
  const runId = body.runId
  const run = server.db.runs.getByRunId(runId)
  const invocationId = run?.invocationId
  const runtimeId = requireDispatchRuntimeId(body)

  const enriched = {
    ...body,
    startIdentity:
      invocationId !== undefined
        ? ({ kind: 'broker', invocationId } as const)
        : ({ kind: 'sdk' } as const),
    observation: {
      lifecycle: {
        selector: {
          runId,
          runtimeId,
          generation: body.generation,
        },
        fromSeq: context.lifecycleFromSeq,
      },
      ...(invocationId !== undefined
        ? {
            broker: {
              selector: {
                invocationId,
                runId,
                runtimeId,
                generation: body.generation,
              },
              afterSeq: context.brokerAfterSeqByInvocation.get(invocationId) ?? 0,
            },
          }
        : {}),
    },
  } satisfies DispatchTurnResponse

  return json(enriched, response.status)
}

export async function handlePrepareAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parsePrepareAttachedRunRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'prepare-attached-run',
  })
  const pendingStartId = `attached-${randomUUID()}`
  const controller = this.getHarnessBrokerController()
  const phases: PhaseRecord[] = []
  const startedAt = performance.now()
  const elapsed = (since: number): number =>
    Math.max(0, Number((performance.now() - since).toFixed(1)))
  // T-08708: the preparation records its real compile + admission here and
  // names the execution and releases it admitted. They are their own rows ahead
  // of broker-start, whose existing measurement still spans them.
  const observation: AttachedRunObservation = { phases: createPhaseRecorder() }
  const attach = { pendingStartId, observation }
  const hrcRelease = projectHrcReleaseIdentity(this.capturedRelease)
  const diagnostics = (runtimeId?: string) => ({
    releases: {
      ...(hrcRelease === undefined ? {} : { hrc: hrcRelease }),
      ...observation.releases,
    },
    ids: {
      pendingStartId,
      hostSessionId: session.hostSessionId,
      ...(runtimeId === undefined ? {} : { runtimeId }),
    },
    ...(observation.execution === undefined ? {} : { execution: observation.execution }),
    phases: structuredClone(phases),
  })

  const brokerStartAt = performance.now()
  const pushBrokerStart = (
    status: 'ok' | 'error',
    extra: Pick<PhaseRecord, 'reason'> = {}
  ): void => {
    const clientPhases = phases.splice(0)
    phases.push(...observation.phases.records(), ...clientPhases, {
      id: 'broker-start',
      status,
      ms: elapsed(brokerStartAt),
      ...extra,
    })
  }
  const operation = (async (): Promise<AttachedRunResult> => {
    // T-08556 (§1.4): on a node that declares an aspd endpoint, a Codex attached
    // run selects its runtime only through the start singleflight (join first,
    // registered before its first await), with or without a prompt, and the
    // prompt is delivered once after that start settles into the runtime it chose.
    if (isAttachedRunAspdCodexIntent(body.intent)) {
      const { initialPrompt: _initialPrompt, ...startIntent } = body.intent
      let delivered: Response | undefined
      const runtime = await this.startRuntimeForSession(
        session,
        startIntent,
        body.restartStyle ?? 'reuse_pty',
        {
          attachBeforeInvocationStart: attach,
          attachedRunDoor: true,
          ...(body.prompt && body.prompt.length > 0
            ? {
                attachedRunPrompt: {
                  prompt: body.prompt,
                  runId: `run-${randomUUID()}`,
                  onDelivered: (response: Response) => {
                    delivered = response
                  },
                },
              }
            : {}),
        }
      )
      return delivered !== undefined
        ? await dispatchTurnResponseJson(delivered)
        : toStartRuntimeResponse(runtime)
    }
    if (body.prompt && body.prompt.length > 0) {
      const response = await this.dispatchTurnForSession(session, body.intent, body.prompt, {
        runId: `run-${randomUUID()}`,
        waitForCompletion: false,
        attachBeforeInvocationStart: attach,
      })
      return await dispatchTurnResponseJson(response)
    }

    const runtime = await this.startRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty',
      { attachBeforeInvocationStart: attach }
    )
    return toStartRuntimeResponse(runtime)
  })()

  const pendingOperation: PendingAttachedRunOperation = { result: operation }
  const savePreparationAt = performance.now()
  this.attachedRunOperations.set(pendingStartId, pendingOperation)
  phases.push({ id: 'save-preparation', status: 'ok', ms: elapsed(savePreparationAt) })
  void operation.catch(() => undefined)

  try {
    const brokerReadyAt = performance.now()
    const winner = await Promise.race([
      controller
        .waitForAttachedStartReady(pendingStartId, DEFAULT_ATTACHED_START_READY_TIMEOUT_MS)
        .then(
          (ready: { pendingStartId: string; runtime: HrcRuntimeSnapshot }) => ({
            kind: 'prepared' as const,
            ready,
          }),
          (error: unknown) => ({ kind: 'ready_timeout' as const, error })
        ),
      operation.then((result) => ({ kind: 'started' as const, result })),
    ])

    if (winner.kind === 'ready_timeout') {
      phases.push({
        id: 'broker-ready',
        status: 'error',
        ms: elapsed(brokerReadyAt),
        limitMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
        reason: winner.error instanceof Error ? winner.error.message : String(winner.error),
      })
      throw new HrcRuntimeUnavailableError(
        `attached broker start did not become ready within ${DEFAULT_ATTACHED_START_READY_TIMEOUT_MS}ms`,
        { pendingStartId, timeoutMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS }
      )
    }

    if (winner.kind === 'prepared') {
      pushBrokerStart('ok')
      phases.push({
        id: 'broker-ready',
        status: 'ok',
        ms: elapsed(brokerReadyAt),
        limitMs: DEFAULT_ATTACHED_START_READY_TIMEOUT_MS,
      })
      pendingOperation.resumeDeadlineTimer = setTimeout(() => {
        if (this.attachedRunOperations.get(pendingStartId) !== pendingOperation) return
        this.attachedRunOperations.delete(pendingStartId)
        controller.cancelAttachedStart(
          pendingStartId,
          `attached run resume deadline expired: ${pendingStartId}`
        )
      }, DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS)
      pendingOperation.resumeDeadlineTimer.unref?.()
      return json({
        status: 'prepared',
        pendingStartId,
        hostSessionId: winner.ready.runtime.hostSessionId,
        runtimeId: winner.ready.runtime.runtimeId,
        attach: await attachDescriptorBody(this, winner.ready.runtime),
        diagnostics: diagnostics(winner.ready.runtime.runtimeId),
      } satisfies PrepareAttachedRunResponse)
    }

    pushBrokerStart('ok')
    phases.push({
      id: 'broker-ready',
      status: 'skipped',
      reason: 'start completed without an attach gate',
    })
    this.attachedRunOperations.delete(pendingStartId)
    controller.cancelAttachedStart(pendingStartId, 'attached run completed without a pending start')
    const runtime = requireKnownRuntime(this.db, runtimeIdFromAttachedRunResult(winner.result))
    return json({
      status: 'started',
      result: winner.result,
      attach: await attachDescriptorBody(this, runtime),
      diagnostics: diagnostics(runtime.runtimeId),
    } satisfies PrepareAttachedRunResponse)
  } catch (error) {
    if (!phases.some((phase) => phase.id === 'broker-start')) {
      pushBrokerStart('error', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    if (!phases.some((phase) => phase.id === 'broker-ready')) {
      phases.push({ id: 'broker-ready', status: 'not-reached', reason: 'broker start failed' })
    }
    this.attachedRunOperations.delete(pendingStartId)
    if (pendingOperation.resumeDeadlineTimer) {
      clearTimeout(pendingOperation.resumeDeadlineTimer)
    }
    controller.cancelAttachedStart(
      pendingStartId,
      error instanceof Error ? error.message : String(error)
    )
    if (error instanceof HrcRuntimeUnavailableError) {
      error.detail['phases'] = structuredClone(phases)
      error.detail['ids'] = diagnostics().ids
      error.detail['failingPhase'] ??= innermostFailingPhase(phases)
      error.detail['elapsedMs'] = elapsed(startedAt)
    }
    throw error
  }
}

/** The deepest failed phase along the first failing branch. */
function innermostFailingPhase(phases: readonly PhaseRecord[]): string | undefined {
  const failed = phases.find((phase) => phase.status === 'error')
  if (failed === undefined) return undefined
  return innermostFailingPhase(failed.children ?? []) ?? failed.id
}

export async function handleResumeAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseResumeAttachedRunRequest(await parseJsonBody(request))
  const pendingOperation = this.attachedRunOperations.get(body.pendingStartId)
  if (!pendingOperation) {
    throw new HrcRuntimeUnavailableError('attached run is not pending', {
      pendingStartId: body.pendingStartId,
      route: 'attached-run',
    })
  }
  this.attachedRunOperations.delete(body.pendingStartId)
  if (pendingOperation.resumeDeadlineTimer) {
    clearTimeout(pendingOperation.resumeDeadlineTimer)
  }

  const resumed = this.getHarnessBrokerController().resumeAttachedStart(body.pendingStartId)
  if (!resumed.ok) {
    throw new HrcRuntimeUnavailableError(resumed.error.message, {
      pendingStartId: body.pendingStartId,
      code: resumed.error.code,
      route: 'attached-run',
    })
  }

  const result = (await pendingOperation.result) as AttachedRunResult
  return json({
    status: 'started',
    result,
  } satisfies ResumeAttachedRunResponse)
}
