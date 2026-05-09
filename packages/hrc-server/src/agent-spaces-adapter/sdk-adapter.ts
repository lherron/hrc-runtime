import { createHash } from 'node:crypto'

import {
  type AgentEvent,
  type AgentSpacesClient,
  type RunTurnNonInteractiveRequest,
  type RunTurnNonInteractiveResponse,
  createAgentSpacesClient,
} from 'agent-spaces'
import {
  type HrcContinuationRef,
  HrcErrorCode,
  type HrcEventEnvelope,
  type HrcHarness,
  type HrcProvider,
  type HrcRuntimeIntent,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import {
  getAspHome,
  resolveHarnessFrontendForProvider,
  resolveHarnessProvider,
} from 'spaces-config'
import { detectAgentLocalComponents, prepareAgentToolRuntime } from 'spaces-execution'

import { UnsupportedHarnessError, buildHrcCorrelationEnv, mergeEnv } from './cli-adapter.js'

export type SdkTurnRunner = (
  request: RunTurnNonInteractiveRequest
) => Promise<RunTurnNonInteractiveResponse>

export type SdkTurnOptions = {
  intent: HrcRuntimeIntent
  hostSessionId: string
  runId: string
  runtimeId: string
  prompt: string
  scopeRef: string
  laneRef: string
  generation: number
  existingProvider?: HrcProvider | undefined
  continuation?: HrcContinuationRef | undefined
  runner?: SdkTurnRunner | undefined
  onHrcEvent?:
    | ((event: Omit<HrcEventEnvelope, 'seq' | 'streamSeq'>) => void | Promise<void>)
    | undefined
  onBuffer?: ((text: string) => void | Promise<void>) | undefined
  signal?: AbortSignal | undefined
}

export type SdkTurnResult = {
  continuation?: HrcContinuationRef | undefined
  provider: HrcProvider
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  harnessSessionJson?: Record<string, unknown> | undefined
  result: RunTurnNonInteractiveResponse['result']
}

const sharedAgentSpacesClient = createAgentSpacesClient()

function getSharedAgentSpacesClient(): AgentSpacesClient {
  return sharedAgentSpacesClient
}

// ---------------------------------------------------------------------------
// Phase 3: In-flight input capability and delivery
// ---------------------------------------------------------------------------

export function getSdkInflightCapability(frontend: HrcHarness): boolean {
  // agent-sdk supports in-flight input via queueInFlightInput; pi-sdk does not.
  return frontend === 'agent-sdk'
}

export type SdkInflightInputClient = {
  queueInFlightInput(req: {
    hostSessionId: string
    runId: string
    inputApplicationId?: string | undefined
    idempotencyKey?: string | undefined
    semantics?: 'append_context' | 'interrupt_and_continue' | undefined
    prompt: string
  }): Promise<{ accepted: boolean; pendingTurns?: number }>
}

export type SdkInflightInputOptions = {
  hostSessionId: string
  runId: string
  runtimeId: string
  inputApplicationId?: string | undefined
  idempotencyKey?: string | undefined
  semantics?: 'append_context' | 'interrupt_and_continue' | undefined
  prompt: string
  scopeRef: string
  laneRef: string
  generation: number
  onHrcEvent?:
    | ((event: Omit<HrcEventEnvelope, 'seq' | 'streamSeq'>) => void | Promise<void>)
    | undefined
  client?: SdkInflightInputClient | undefined
  missingActiveRunRetryMs?: number | undefined
  retryDelayMs?: number | undefined
}

export type SdkInflightInputResult = {
  accepted: boolean
  pendingTurns?: number | undefined
}

export async function deliverSdkInflightInput(
  options: SdkInflightInputOptions
): Promise<SdkInflightInputResult> {
  const client = options.client ?? getSharedAgentSpacesClient()
  const onHrcEvent = options.onHrcEvent ?? (() => {})
  const retryUntil = Date.now() + (options.missingActiveRunRetryMs ?? 10_000)
  const retryDelayMs = options.retryDelayMs ?? 250

  let response: Awaited<ReturnType<SdkInflightInputClient['queueInFlightInput']>>
  for (;;) {
    try {
      response = await client.queueInFlightInput({
        hostSessionId: options.hostSessionId,
        runId: options.runId,
        ...(options.inputApplicationId !== undefined
          ? { inputApplicationId: options.inputApplicationId }
          : {}),
        ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options.semantics !== undefined ? { semantics: options.semantics } : {}),
        prompt: options.prompt,
      })
      break
    } catch (error) {
      if (!isMissingActiveRunError(error) || Date.now() >= retryUntil) {
        throw error
      }
      await delay(retryDelayMs)
    }
  }

  await onHrcEvent({
    ts: new Date().toISOString(),
    hostSessionId: options.hostSessionId,
    scopeRef: options.scopeRef,
    laneRef: options.laneRef,
    generation: options.generation,
    runId: options.runId,
    runtimeId: options.runtimeId,
    source: 'agent-spaces',
    eventKind: 'sdk.inflight_delivered',
    eventJson: {
      prompt: options.prompt,
      accepted: response.accepted,
      ...(options.semantics !== undefined ? { semantics: options.semantics } : {}),
    },
  })

  return {
    accepted: response.accepted,
    pendingTurns: response.pendingTurns,
  }
}

function isMissingActiveRunError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No active in-flight run')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Phase 1/2: SDK turn dispatch
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: readonly string[] = ['anthropic', 'openai'] satisfies readonly HrcProvider[]

function toFrontend(provider: HrcProvider): 'agent-sdk' | 'pi-sdk' {
  const frontend = resolveHarnessFrontendForProvider(provider, 'sdk')
  if (frontend === 'agent-sdk' || frontend === 'pi-sdk') {
    return frontend
  }
  return 'agent-sdk'
}

function toEventKind(event: AgentEvent): string {
  if (event.type === 'state') {
    return `sdk.${event.state}`
  }
  return `sdk.${event.type}`
}

/**
 * Extract the event payload for HRC eventJson.
 *
 * Strips envelope-level fields (ts, seq, hostSessionId, runId) that the HRC
 * event envelope already carries, then conditionally re-includes domain-relevant
 * optional fields (cpSessionId, continuation) only when present.
 */
function toEventJson(event: AgentEvent): Record<string, unknown> {
  const { ts, seq, hostSessionId, cpSessionId, runId, continuation, ...rest } = event
  return {
    ...rest,
    ...(cpSessionId ? { cpSessionId } : {}),
    ...(continuation ? { continuation } : {}),
  }
}

function inferHarnessSessionJson(
  provider: HrcProvider,
  frontend: 'agent-sdk' | 'pi-sdk',
  continuation?: HrcContinuationRef | undefined
): Record<string, unknown> {
  return {
    provider,
    frontend,
    ...(frontend === 'agent-sdk' && continuation?.key ? { sdkSessionId: continuation.key } : {}),
  }
}

async function buildSdkRequestEnv(intent: HrcRuntimeIntent): Promise<Record<string, string>> {
  let env = buildHrcCorrelationEnv(intent)
  const components = await detectAgentLocalComponents(intent.placement.agentRoot)

  if (components?.hasTools) {
    const toolRuntime = await prepareAgentToolRuntime(
      {
        agentRoot: intent.placement.agentRoot,
        projectRoot: intent.placement.projectRoot,
        components,
      },
      env
    )
    env = { ...env, ...toolRuntime.env }
  }

  return mergeEnv(env, intent.launch)
}

async function defaultRunner(
  request: RunTurnNonInteractiveRequest,
  intent: HrcRuntimeIntent
): Promise<RunTurnNonInteractiveResponse> {
  if (intent.placement.dryRun === true) {
    const provider = resolveHarnessProvider(request.frontend) ?? 'anthropic'
    const continuation =
      request.frontend === 'pi-sdk'
        ? undefined
        : ({
            provider,
            key: `sdk-${createHash('sha1')
              .update(request.hostSessionId ?? request.runId)
              .digest('hex')
              .slice(0, 12)}`,
          } satisfies HrcContinuationRef)

    const base = {
      hostSessionId: request.hostSessionId ?? 'unknown-host-session',
      runId: request.runId,
      ts: new Date().toISOString(),
      seq: 1,
      ...(continuation ? { continuation } : {}),
    }

    await request.callbacks.onEvent({
      ...base,
      type: 'state',
      state: 'running',
    } as AgentEvent)
    await request.callbacks.onEvent({
      ...base,
      seq: 2,
      type: 'message',
      role: 'assistant',
      content: `Dry run SDK response for: ${request.prompt}`,
    } as AgentEvent)
    await request.callbacks.onEvent({
      ...base,
      seq: 3,
      type: 'complete',
      result: { success: true, finalOutput: `Dry run SDK response for: ${request.prompt}` },
    } as AgentEvent)

    return {
      ...(continuation ? { continuation } : {}),
      provider,
      frontend: request.frontend,
      model: request.model,
      result: { success: true, finalOutput: `Dry run SDK response for: ${request.prompt}` },
    }
  }

  return getSharedAgentSpacesClient().runTurnNonInteractive(request)
}

export async function runSdkTurn(options: SdkTurnOptions): Promise<SdkTurnResult> {
  if (options.intent.harness.interactive !== false) {
    throw new UnsupportedHarnessError('interactive')
  }

  if (
    options.existingProvider !== undefined &&
    options.existingProvider !== options.intent.harness.provider
  ) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.PROVIDER_MISMATCH,
      `provider mismatch: existing runtime provider is "${options.existingProvider}" but request requires "${options.intent.harness.provider}"`,
      {
        existingProvider: options.existingProvider,
        requestedProvider: options.intent.harness.provider,
      }
    )
  }

  const frontend = toFrontend(options.intent.harness.provider)
  const runner =
    options.runner ??
    ((request: RunTurnNonInteractiveRequest) => defaultRunner(request, options.intent))

  const onHrcEvent = options.onHrcEvent ?? (() => {})
  const onBuffer = options.onBuffer ?? (() => {})
  const env = await buildSdkRequestEnv(options.intent)

  const runnerPromise = runner({
    aspHome: getAspHome(), // required by type but ignored when placement is set
    spec: { spaces: [] }, // required by type but ignored when placement is set
    cwd: '/', // required by type but ignored when placement is set
    placement: options.intent.placement,
    frontend,
    model: options.intent.harness.model,
    env,
    prompt: options.prompt,
    ...(options.intent.attachments !== undefined
      ? { attachments: options.intent.attachments }
      : {}),
    runId: options.runId,
    hostSessionId: options.hostSessionId,
    ...(options.continuation ? { continuation: options.continuation } : {}),
    callbacks: {
      onEvent: async (event) => {
        await onHrcEvent({
          ts: event.ts,
          hostSessionId: options.hostSessionId,
          scopeRef: options.scopeRef,
          laneRef: options.laneRef,
          generation: options.generation,
          runId: options.runId,
          runtimeId: options.runtimeId,
          source: 'agent-spaces',
          eventKind: toEventKind(event),
          eventJson: toEventJson(event),
        })

        if (event.type === 'message_delta' && event.role === 'assistant') {
          await onBuffer(event.delta)
        }

        if (event.type === 'message' && event.role === 'assistant') {
          await onBuffer(event.content)
        }
      },
    },
  })

  let response: RunTurnNonInteractiveResponse
  if (options.signal) {
    const signal = options.signal
    response = await Promise.race([
      runnerPromise,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          },
          { once: true }
        )
      }),
    ])
  } else {
    response = await runnerPromise
  }

  if (!VALID_PROVIDERS.includes(response.provider)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.PROVIDER_MISMATCH,
      `invalid provider returned by runner: "${response.provider}" (expected one of: ${VALID_PROVIDERS.join(', ')})`,
      { provider: response.provider }
    )
  }

  const continuation = response.continuation as HrcContinuationRef | undefined
  const harnessSessionJson = inferHarnessSessionJson(
    response.provider as HrcProvider,
    response.frontend,
    continuation
  )

  return {
    ...(continuation ? { continuation } : {}),
    provider: response.provider as HrcProvider,
    frontend: response.frontend,
    model: response.model,
    harnessSessionJson,
    result: response.result,
  }
}
