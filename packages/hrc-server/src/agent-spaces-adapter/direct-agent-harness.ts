import { randomUUID } from 'node:crypto'

import type { HrcRuntimeIntent, HrcSessionRecord, HrcTurnResponseFormat } from 'hrc-core'
import type {
  HarnessInvocationSpec,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import {
  type BrokerExecutionProfile,
  type CompiledRuntimePlan,
  type RuntimeIdentityAllocation,
  createCanonicalHasher,
  hashNeutralStartRequest,
  neutralSpecHash,
  neutralStartRequestHash,
  project,
  validateBrokerExecutionProfile,
} from 'spaces-runtime-contracts'

export type DirectAgentHarnessPlan = {
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  plan: CompiledRuntimePlan
  identity: RuntimeIdentityAllocation
}

export function buildDirectAgentHarnessPlan(input: {
  intent: HrcRuntimeIntent
  session: HrcSessionRecord
  runtimeId: string
  runId: string
  responseFormat?: HrcTurnResponseFormat | undefined
  dispatchEnv: Record<string, string>
  now: string
}): DirectAgentHarnessPlan {
  const bundle = input.intent.placement['bundle'] as
    | { kind?: string; agentName?: string; projectRoot?: string }
    | undefined
  const agentId = bundle?.agentName ?? input.dispatchEnv['AGENT_ID']
  if (agentId === undefined || agentId.length === 0) {
    throw new Error('Direct agent-harness requires an agent-project placement with agentName')
  }
  const invocationId = `inv-${randomUUID()}`
  const initialInputId = `input-${randomUUID()}`
  const identity = {
    requestId: `req-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    hostSessionId: input.session.hostSessionId,
    generation: input.session.generation,
    runtimeId: input.runtimeId,
    invocationId,
    initialInputId,
    runId: input.runId,
    traceId: `trace-${randomUUID()}`,
  } as RuntimeIdentityAllocation
  const provider = input.intent.harness.provider
  const requestedModel =
    input.intent.provision?.model ??
    input.intent.harness.model ??
    (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5.6-sol')
  const modelId = requestedModel.includes('/')
    ? requestedModel
    : provider === 'anthropic'
      ? `anthropic-max/${requestedModel}`
      : `openai-codex/${requestedModel}`
  const reasoningEffort = input.intent.provision?.reasoning
  const yolo = input.intent.provision?.yolo ?? input.intent.harness.yolo ?? false
  const projectRoot =
    bundle?.projectRoot ??
    (typeof input.intent.placement['projectRoot'] === 'string'
      ? input.intent.placement['projectRoot']
      : undefined)
  const cwd =
    (typeof input.intent.placement['cwd'] === 'string'
      ? input.intent.placement['cwd']
      : undefined) ??
    projectRoot ??
    process.cwd()
  const agentRoot =
    typeof input.intent.placement['agentRoot'] === 'string'
      ? input.intent.placement['agentRoot']
      : undefined
  const spec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: {
      frontend: 'agent-harness',
      provider,
      driver: 'agent-harness',
    },
    process: {
      command: 'in-process',
      args: [],
      cwd,
      lockedEnv: {},
      harnessTransport: { kind: 'in-process' },
    },
    interaction: { mode: 'service', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'agent-harness',
      permissionPolicy: { mode: yolo ? 'allow' : 'deny' },
    },
    sdk: {
      runtime: 'pi-sdk',
      provider: provider === 'anthropic' ? 'anthropic' : 'openai-codex',
      modelId,
      authMode: 'oauth',
      ...(reasoningEffort !== undefined ? { thinkingLevel: reasoningEffort } : {}),
    },
    agent: {
      agentId,
      ...(input.dispatchEnv['ASP_PROJECT'] !== undefined
        ? { projectId: input.dispatchEnv['ASP_PROJECT'] }
        : {}),
      ...(agentRoot !== undefined ? { agentRoot } : {}),
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      runMode: input.intent.taskContext === undefined ? 'query' : 'task',
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      runId: input.runId,
      hostSessionId: input.session.hostSessionId,
      generation: input.session.generation,
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
    },
  } as unknown as HarnessInvocationSpec
  const initialInput: InvocationInput = {
    inputId: initialInputId as InvocationInput['inputId'],
    kind: 'user',
    content: [{ type: 'text', text: input.intent.initialPrompt ?? '' }],
    ...(input.responseFormat?.kind === 'json_schema'
      ? { responseFormat: input.responseFormat }
      : {}),
  }
  const startRequest: InvocationStartRequest = { spec, initialInput }
  const specHash = neutralSpecHash(spec)
  const startRequestHash = neutralStartRequestHash(startRequest)
  const initialInputHash = hashValue(initialInput)
  const profileId = `profile_${hashValue({ driver: 'agent-harness', startRequest: hashNeutralStartRequest(startRequest) }).slice(0, 32)}`
  const compatibilityHash = hashValue({ driver: 'agent-harness', agentId, provider, modelId })
  const profileMaterial = {
    schemaVersion: 'agent-runtime-profile/v1' as const,
    profileId: profileId as BrokerExecutionProfile['profileId'],
    kind: 'harness-broker' as const,
    interactionMode: 'nonInteractive' as const,
    expectedCapabilities: {
      input: {
        user: 'required' as const,
        steer: 'optional' as const,
        appendContext: 'forbidden' as const,
        localImages: 'forbidden' as const,
        fileRefs: 'forbidden' as const,
        queue: 'required' as const,
      },
      turns: { concurrency: 'single' as const, interrupt: 'optional' as const },
      continuation: 'optional' as const,
      permissions: 'none' as const,
      events: {
        assistantDeltas: 'optional' as const,
        toolCalls: 'required' as const,
        usage: 'optional' as const,
        diagnostics: 'optional' as const,
      },
      control: {
        stop: 'optional' as const,
        dispose: 'optional' as const,
        reconcile: 'optional' as const,
        attachReplay: 'optional' as const,
      },
      lifecycle: {
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'forbidden' as const,
        permissionCancellation: 'forbidden' as const,
      },
    },
    brokerProtocol: 'harness-broker/0.2' as const,
    brokerDriver: 'agent-harness',
    brokerOwnership: 'hrc-owned-process' as const,
    harnessInvocation: { startRequest, specHash, startRequestHash, initialInputHash },
    policy: {
      permissionPolicy: yolo
        ? {
            mode: 'allow' as const,
            audit: true as const,
            provenance: {
              source: 'operator-config' as const,
              requestId: identity.requestId,
              createdAt: input.now,
            },
          }
        : { mode: 'deny' as const, audit: true as const },
      inputPolicy: {
        readyInput: 'start-turn' as const,
        busy: { whenBusy: 'queue' as const, maxDepth: 32 },
        supportedKinds: ['user', 'steer'] as const,
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' as const },
    },
    observability: {
      correlation: {
        requestId: identity.requestId,
        operationId: identity.operationId,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
        invocationId: invocationId as NonNullable<RuntimeIdentityAllocation['invocationId']>,
        traceId: identity.traceId,
      },
    },
  }
  const profileHash = (
    project(
      {
        ...profileMaterial,
        compatibilityHash,
        observability: { correlation: { generation: identity.generation } },
      },
      'profile'
    ) as { profileHash: string }
  ).profileHash
  const profile = {
    ...profileMaterial,
    profileHash,
    compatibilityHash,
  } as unknown as BrokerExecutionProfile
  const diagnostics = validateBrokerExecutionProfile(profile)
  if (diagnostics.length > 0) {
    throw new Error(`Invalid direct agent-harness profile: ${JSON.stringify(diagnostics)}`)
  }

  const planMaterial = {
    schemaVersion: 'agent-runtime-plan/v1' as const,
    compiler: { name: 'agent-spaces' as const, version: 'agent-harness-direct/1' },
    compileId: `compile_${hashValue({ agentId, provider, modelId }).slice(0, 32)}`,
    createdAt: input.now,
    identity,
    placement: input.intent.placement,
    resolvedBundle: { bundleIdentity: hashValue({ agentId, projectRoot, cwd }) },
    harness: { family: 'pi' as const, runtime: 'pi-sdk' as const, provider },
    model: {
      provider,
      modelId,
      requestedModel,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
    executionProfiles: [profile],
    artifacts: { bundleIdentity: hashValue({ agentId, projectRoot, cwd }) },
    lockedEnv: { lockedEnvKeys: [] },
    diagnostics: [],
  }
  const planHash = (project(planMaterial, 'plan') as { planHash: string }).planHash
  const plan = { ...planMaterial, planHash } as unknown as CompiledRuntimePlan
  return { profile, startRequest, specHash, startRequestHash, plan, identity }
}

function hashValue(value: unknown): string {
  return createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value
}
