import { randomUUID } from 'node:crypto'
import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcExecutionFormat,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { hasInitialUserTurn } from './agent-spaces-adapter/compile-adapter.js'
import { bindAppHarnessBirthIntent } from './app-session-identity.js'
import { aspdHeadlessBrokerEndpoint } from './aspd-headless-start.js'
import { createBirthTimeline } from './birth-timeline.js'
import { waitForInteractiveBrokerRunCompletion } from './broker-headless-completion.js'
import { waitForHeadlessBrokerRunCompletion } from './broker-headless-completion.js'
import { recordDetachedHeadlessTurnFailure } from './broker-headless-completion.js'
import { executeHeadlessBrokerFormat2DispatchTurn } from './broker-headless-format2.js'
import { executeHeadlessBrokerInputTurn } from './broker-headless-input-turn.js'
import { enqueueDurableHeadlessTurnInput } from './broker-headless-queue.js'
import { dispatchQueuedHeadlessTurnInput } from './broker-headless-queue.js'
import { drainDurableHeadlessTurnInputs } from './broker-headless-queue.js'
import { startAspdHeadlessBrokerRuntime } from './broker-headless-start.js'
import { executeHeadlessBrokerStartTurn } from './broker-headless-start.js'
import { assertParticipantAddressNotSubstituted } from './participant-delivery.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import type {
  AttachBeforeInvocationStartOption,
  DispatchRunPersistenceOptions,
} from './server-types.js'
import { aspdUnconfiguredError } from './server-util.js'

export {
  disposeColdBootInputContinuationFailure,
  failColdBootInputContinuation,
  settleFailedHeadlessBrokerStart,
  executeHeadlessBrokerStartTurn,
} from './broker-headless-start.js'
export { executeHeadlessBrokerFormat2DispatchTurn } from './broker-headless-format2.js'
export { executeHeadlessBrokerInputTurn } from './broker-headless-input-turn.js'
export {
  dispatchQueuedHeadlessTurnInput,
  drainDurableHeadlessTurnInputs,
  enqueueDurableHeadlessTurnInput,
  formatQueuedDeliveryRemainderTrailer,
  formatQueuedSemanticDmDelivery,
  parseDurableColdBootTurnInput,
} from './broker-headless-queue.js'
export {
  recordDetachedHeadlessTurnFailure,
  waitForCompilerPrimingTerminal,
  waitForHeadlessBrokerRunCompletion,
  waitForInteractiveBrokerRunCompletion,
} from './broker-headless-completion.js'

export async function startHeadlessBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string | undefined,
  options: DispatchRunPersistenceOptions & {
    /** Frozen before compile; public ingress remains responsible for selecting it. */
    executionFormat?: HrcExecutionFormat | undefined
    allowCompilerInitialInputWithoutIdentity?: boolean | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
    coldBirthPromptMode?: 'replace-priming' | 'append-to-priming' | undefined
    /** The attached door pauses only after a producer-declared surface is leased. */
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  const executionFormat = options.executionFormat ?? 'format1'
  if (executionFormat === 'format2' && runId !== undefined) {
    throw new HrcRuntimeUnavailableError(
      'format 2 broker birth cannot carry an admission-time run identity',
      { code: 'execution_format_mismatch', runId, route: 'broker' }
    )
  }
  // R-4.3.2: never born a substitute runtime at a reserved participant
  // address. Delivery routes into the participant's own runtime before this
  // point; this is the backstop at the place a runtime is actually born.
  assertParticipantAddressNotSubstituted(this, session)
  // T-08576 D5: an app birth carries only HRC-owned identity; it consumes its
  // run grant exactly when its compile identity allocates the run id.
  const boundIntent =
    runId === undefined
      ? intent
      : bindAppHarnessBirthIntent(
          this.db,
          session,
          intent,
          runId,
          hasInitialUserTurn(prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent)
        )
  const requestedTurnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...boundIntent, initialPrompt: prompt } : boundIntent
  // Presentation is producer-resolved at compilation. Before that boundary we
  // record only an opaque/default timeline marker; no intent-to-driver choice.
  const presentation = requestedTurnIntent.presentation?.operator ?? 'default'
  const birthTimeline =
    options.birthTimeline ??
    createBirthTimeline({
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      birthId: runId ?? `format2-${randomUUID()}`,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runId,
      presentation,
    })
  birthTimeline.enrich({
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runId,
    presentation,
  })
  birthTimeline.mark(
    options.birthTimeline === undefined ? 'request-received' : 'runtime-start-entered'
  )
  // T-08542: a node that declares an aspd endpoint prepares ordinary headless
  // codex-app-server there, with no facade/toolchain fallback. Headless
  // muse-serve prepares on its own route the same way.
  const aspdEndpoint = aspdHeadlessBrokerEndpoint(requestedTurnIntent)
  if (aspdEndpoint !== undefined) {
    return await startAspdHeadlessBrokerRuntime(
      this,
      session,
      requestedTurnIntent,
      runId,
      aspdEndpoint,
      options,
      birthTimeline
    )
  }
  // T-08596 (T-08569A closure): the bundled ASP execution closure is removed.
  // The facade/toolchain fallback below is deleted; a node that declares no
  // aspd endpoint for this birth refuses loudly with a typed refusal, never an
  // ENOENT from a missing bin.
  throw aspdUnconfiguredError('headless-broker-birth', {
    hostSessionId: session.hostSessionId,
    runId,
    harnessId: requestedTurnIntent.harness.id ?? null,
    provider: requestedTurnIntent.harness.provider,
  })
}

export const brokerHeadlessHandlersMethods = {
  startHeadlessBrokerRuntime,
  executeHeadlessBrokerFormat2DispatchTurn,
  executeHeadlessBrokerStartTurn,
  executeHeadlessBrokerInputTurn,
  enqueueDurableHeadlessTurnInput,
  dispatchQueuedHeadlessTurnInput,
  drainDurableHeadlessTurnInputs,
  waitForInteractiveBrokerRunCompletion,
  waitForHeadlessBrokerRunCompletion,
  recordDetachedHeadlessTurnFailure,
}

export type BrokerHeadlessHandlersMethods = typeof brokerHeadlessHandlersMethods
