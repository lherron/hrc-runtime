import { randomUUID } from 'node:crypto'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  RestartStyle,
} from 'hrc-core'
import { waitForLaunchCarriedSubmissionIdentity } from '../launch-carried-submission.js'
import type { InitialPromptDeliveryReceipt } from '../runtime-start-handlers.js'
import { localizeIntentToSession } from '../scope-claim-core.js'
import { json } from '../server-util.js'
import { submissionResponse, submitThroughAdmission } from './submit.js'
import type { AdmissionContext, SubmissionRequest } from './types.js'

/** Admit D10's delivery, then expose only its ordinary receipt and completion observation. */
export async function admitRuntimeStartPrompt(
  ctx: AdmissionContext,
  target: SubmissionRequest['target'],
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle,
  options: { allowStaleGeneration?: boolean | undefined; signal?: AbortSignal | undefined } = {}
): Promise<{ runtime: HrcRuntimeSnapshot; waitForCompletion(): Promise<HrcRuntimeSnapshot> }> {
  const delivery: InitialPromptDeliveryReceipt = {}
  let positiveRejection = false
  const runId = `run-${randomUUID()}`
  const response = submissionResponse(
    await submitThroughAdmission(
      ctx,
      {
        door: 'runtime-start-prompt',
        intent: 'enqueue',
        target,
        body: intent.initialPrompt ?? '',
        principal: 'system',
        runtimeIntent: intent,
        executionFormat: 'format1',
        ...options,
        options: { runId },
        replay: async () => {
          throw new Error('START claim keys are not input idempotency keys')
        },
      },
      async (plan) => {
        if (plan.launchCarry === undefined) throw new Error('START plan has no prompt carry')
        const carriedIntent = localizeIntentToSession(
          {
            ...intent,
            initialPrompt: plan.launchCarry.carriesBody ? plan.request.body : undefined,
          },
          plan.session
        )
        const runtime = await ctx.startRuntimeForSession(
          plan.session,
          carriedIntent,
          restartStyle,
          { initialPromptPlan: plan, initialPromptReceipt: delivery }
        )
        if (delivery.response === undefined && ctx.db.runs.getByRunId(runId) !== null)
          await waitForLaunchCarriedSubmissionIdentity(ctx, runId, runtime.runtimeId)
        const receipt =
          delivery.response === undefined
            ? undefined
            : ((await delivery.response.clone().json()) as DispatchTurnResponse)
        if (receipt?.admission === 'rejected') {
          positiveRejection = true
          return {
            kind: 'rejected_unlanded',
            rejection: { source: 'positive-rejection', value: json(runtime) },
          }
        }
        return { kind: 'accepted', value: json(runtime) }
      }
    )
  )
  const runtime = (await response.json()) as HrcRuntimeSnapshot
  return {
    runtime,
    async waitForCompletion() {
      // Some legacy START reuse paths carry no input; retain their existing receipt.
      const run = ctx.db.runs.getByRunId(runId)
      if (run !== null && !positiveRejection) {
        if (delivery.completionKind === 'interactive')
          await ctx.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
        else await ctx.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
      }
      return ctx.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    },
  }
}
