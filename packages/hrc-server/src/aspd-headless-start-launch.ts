import type { HrcRuntimeIntent, HrcRuntimeSnapshot } from 'hrc-core'
import {
  ExecutionReleaseRefusal,
  validateFrozenExecutionRelease,
} from './agent-spaces-adapter/aspd-execution-release.js'
import {
  aspdStartError,
  aspdWorkerArgv,
  describeAspdHostingPaths,
  presentationForExecution,
  readAspdPreparation,
} from './aspd-headless-start-record.js'
import type { BirthTimeline } from './birth-timeline.js'
import type { BrokerControllerStartInput } from './broker/controller/types.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { type DispatchRunPersistenceOptions, dispatchRunPersistence } from './server-types.js'
import { timestamp } from './server-util.js'
import { dropUnconfirmedResumeContinuation } from './session-continuation-reuse.js'

function recordPrelaunchRefusal(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  operationId: string,
  code: string,
  message: string
): void {
  const current = server.db.runtimeOperations.getByOperationId(operationId)
  if (current?.status !== 'prepared') return
  server.db.runtimeOperations.update(operationId, {
    errorCode: code,
    errorMessage: message,
    updatedAt: timestamp(),
  })
}

export type AspdLaunchOptions = DispatchRunPersistenceOptions & {
  onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
  /**
   * T-08556: the attached-run door's live attach handshake. Not frozen: it names
   * this process's pending attach, which a preparation cannot outlive.
   */
  attachBeforeInvocationStart?: BrokerControllerStartInput['attachBeforeInvocationStart']
  birthTimeline?: BirthTimeline | undefined
  settleFailure: (error: {
    code: string
    message: string
    detail: Record<string, unknown>
  }) => never
}

/**
 * Launch a frozen aspd preparation. Input is only the operation id: every fact
 * is reread from the database. Pre-start refusals leave the row `prepared`
 * with the refusal recorded; nothing is re-prepared or rebound.
 */
export async function launchAspdPreparedAttempt(
  server: HrcServerInstanceForHandlers,
  operationId: string,
  options: AspdLaunchOptions
): Promise<{ runtime: HrcRuntimeSnapshot; intent: HrcRuntimeIntent }> {
  const { status, record } = readAspdPreparation(server, operationId)
  // Records written before rev11 are durable format-1 preparations. New records
  // always carry this field, but the fallback preserves a safe rollback path.
  const executionFormat = record.admission.executionFormat ?? 'format1'
  options.birthTimeline?.enrich({
    runtimeId: record.runtimeId,
    operationId,
    invocationId: String(record.admission.identity.invocationId),
    compileId: String(record.admission.plan.compileId),
    releaseId: record.aspd.release.releaseId,
    executionReleaseId: record.executionRelease.releaseId,
    presentation: record.hosting.presentation,
  })
  options.birthTimeline?.mark('aspd-prepared-attempt-read', { operationId })
  const detail = {
    operationId,
    runtimeId: record.runtimeId,
    runId: record.runId,
    hostSessionId: record.hostSessionId,
    executionReleaseId: record.executionRelease.releaseId,
  }
  if (status !== 'prepared') {
    throw aspdStartError(
      'aspd_preparation_not_prepared',
      `aspd preparation ${operationId} is ${status}, not a never-submitted prepared attempt`,
      { ...detail, status }
    )
  }
  const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
    recordPrelaunchRefusal(server, operationId, code, message)
    writeServerLog('WARN', 'aspd.launch.refused', { code, ...detail, ...extra })
    throw aspdStartError(code, message, { ...detail, ...extra })
  }

  const session = server.db.sessions.getByHostSessionId(record.hostSessionId)
  if (session === null || session.generation !== record.generation) {
    refuse(
      'preparation_generation_superseded',
      'the host session generation moved past this frozen preparation',
      { frozenGeneration: record.generation, currentGeneration: session?.generation }
    )
  }

  if (
    executionFormat === 'format2' &&
    (record.runId !== undefined || record.admission.identity.runId !== undefined)
  ) {
    refuse(
      'execution_format_mismatch',
      'format-2 preparation carries an admission-time run identity',
      {
        executionFormat,
        recordRunId: record.runId,
        identityRunId: record.admission.identity.runId,
      }
    )
  }

  let executable: string
  try {
    executable = validateFrozenExecutionRelease(record.executionRelease).executable
  } catch (error) {
    if (error instanceof ExecutionReleaseRefusal) {
      return refuse(error.code, error.message, error.detail)
    }
    throw error
  }
  const currentPaths = describeAspdHostingPaths(
    server.options,
    record.hosting.driverKind,
    record.runtimeId,
    record.hosting.presentation
  )
  const expectedArgv = aspdWorkerArgv(record.executionRelease, record, currentPaths)
  const launchMatchesAdmission =
    record.route === 'producer-selected-execution' &&
    record.hosting.driverKind === record.admission.execution.driver &&
    record.hosting.presentation === presentationForExecution(record.admission.execution)
  if (
    JSON.stringify(expectedArgv) !== JSON.stringify(record.hosting.argv) ||
    JSON.stringify(currentPaths) !== JSON.stringify(record.hosting.paths) ||
    !launchMatchesAdmission
  ) {
    refuse('launch_description_mismatch', 'frozen worker launch description no longer matches', {
      frozenArgv: record.hosting.argv,
    })
  }

  writeServerLog('INFO', 'aspd.launch.begin', { ...detail, executable })
  options.birthTimeline?.mark('aspd-launch-authority-validated', detail)
  const controller = server.getHarnessBrokerController()
  const admission = record.admission
  const result = await controller.start({
    execution: admission.execution,
    plan: admission.plan,
    ...((record.response as unknown as { sessionMetadata?: Record<string, unknown> })
      .sessionMetadata !== undefined
      ? {
          sessionMetadata: (
            record.response as unknown as { sessionMetadata: Record<string, unknown> }
          ).sessionMetadata,
        }
      : {}),
    hrcPolicy: admission.hrcPolicy,
    executionFormat,
    identity: admission.identity,
    ...(options.birthTimeline !== undefined ? { birthTimeline: options.birthTimeline } : {}),
    ...(record.dispatch.runtimeAuthority !== undefined
      ? { runtimeAuthority: record.dispatch.runtimeAuthority }
      : {}),
    ...(record.dispatch.requestedResponseFormat !== undefined
      ? { requestedResponseFormat: record.dispatch.requestedResponseFormat }
      : {}),
    ...dispatchRunPersistence(options),
    ...(record.dispatch.format2RequestHash !== undefined
      ? { format2RequestHash: record.dispatch.format2RequestHash }
      : {}),
    dispatchEnv: record.dispatch.dispatchEnv,
    routeDecision: record.dispatch.routeDecision,
    ...(record.dispatch.lifecyclePolicy !== undefined
      ? { lifecyclePolicy: record.dispatch.lifecyclePolicy }
      : {}),
    ...(options.attachBeforeInvocationStart !== undefined
      ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
      : {}),
    aspdExecution: {
      operationId,
      release: record.executionRelease,
      executable,
      argv: record.hosting.argv,
    },
    ...(options.onAccepted
      ? {
          onAccepted: async (graph) => {
            await options.onAccepted?.(graph.runtime)
          },
        }
      : {}),
  })
  if (!result.ok) {
    recordPrelaunchRefusal(server, operationId, result.error.code, result.error.message)
    writeServerLog('WARN', 'aspd.launch.failed', { code: result.error.code, ...detail })
    const resumeFailure = dropUnconfirmedResumeContinuation(server.db, {
      invocationId: String(record.admission.identity.invocationId),
      stage: 'start',
      failure: result.error.message,
    })
    if (resumeFailure?.event !== undefined) server.notifyEvent(resumeFailure.event)
    options.settleFailure(
      resumeFailure === undefined
        ? result.error
        : {
            ...result.error,
            message: `${resumeFailure.message} (${result.error.message})`,
            detail: {
              ...result.error.detail,
              resumeFailedAtLaunch: {
                provider: resumeFailure.provider,
                continuationKey: resumeFailure.key,
                dropped: resumeFailure.dropped,
              },
            },
          }
    )
  }
  writeServerLog('INFO', 'aspd.launch.started', {
    ...detail,
    invocationId: result.invocation.invocationId,
    workerRelease: result.hello.release?.releaseId,
  })
  return { runtime: result.runtime, intent: record.intent }
}
