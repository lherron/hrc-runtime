import type {
  DispatchTurnResponse,
  HrcMessageRecord,
  HrcRuntimeSnapshot,
  HrcTurnResponseFormat,
  SemanticTurnHandoffStartedResponse,
} from 'hrc-core'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context.js'
import { writeServerLog } from '../../server-log.js'
import { assertDispatchRunId, requireDispatchRuntimeId } from '../../server-util.js'
import type { AdmittedPlan } from '../types.js'
export async function tryDeliverSemanticTurnToInteractiveRuntime(
  this: HrcServerInstanceForHandlers,
  plan: AdmittedPlan,
  input: {
    runtime: HrcRuntimeSnapshot
    request: HrcMessageRecord
    payload: string
    runId: string
    sessionRef: string
    fromSeq: number
    responseFormat?: HrcTurnResponseFormat | undefined
    observeReceipt?: ((receipt: DispatchTurnResponse) => void) | undefined
  }
): Promise<SemanticTurnHandoffStartedResponse | undefined> {
  const session = plan.session
  const { runtime, request, payload, runId, sessionRef, fromSeq, responseFormat } = input
  if (runtime.transport !== 'tmux') {
    return undefined
  }

  if (runtime.controllerKind === 'harness-broker' && runtime.activeInvocationId !== undefined) {
    // Async reply-bridge delivery: do NOT block here. The Claude reply is
    // bridged back as a separate DM via maybeCompleteInteractiveSemanticTurn
    // (8a0979b), so the semantic-turn handoff returns 'started' immediately.
    const turnResponse = await this.executeInteractiveBrokerInputTurn(
      plan,
      runtime,
      payload,
      runId,
      { waitForCompletion: false, submissionDoor: 'enqueue', responseFormat }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    input.observeReceipt?.(turnBody)
    assertDispatchRunId(turnBody)
    const brokerTransport = turnBody.transport as 'tmux'

    const finalizer = this.turnResponseFinalizers.get(runId)
    if (finalizer) {
      this.turnResponseFinalizers.set(runId, {
        ...finalizer,
        mode: 'interactive',
      })
    }

    this.db.messages.updateExecution(request.messageId, {
      state: turnBody.status === 'completed' ? 'completed' : 'started',
      mode: 'interactive',
      sessionRef,
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      transport: brokerTransport,
    })

    writeServerLog('INFO', 'semantic_turn.interactive_broker_selected', {
      messageId: request.messageId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      runId,
    })

    return {
      messageId: request.messageId,
      sessionRef,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: turnBody.hostSessionId,
      runtimeId: requireDispatchRuntimeId(turnBody),
      runId: turnBody.runId,
      generation: turnBody.generation,
      fromSeq,
      ...(turnBody.warnings !== undefined ? { warnings: turnBody.warnings } : {}),
      ...(turnBody.delivery !== undefined ? { delivery: turnBody.delivery } : {}),
    }
  }

  return undefined
}
