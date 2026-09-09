import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import {
  type HrcRuntimeIntent,
  type HrcSessionRecord,
  type RestartStyle,
  resolveStateRoot,
} from 'hrc-core'
import { inspectAgentSystemPrompt } from 'spaces-runtime'

import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { buildDirectAgentHarnessPlan } from './agent-spaces-adapter/direct-agent-harness.js'
import {
  isInteractiveTmuxBrokerIntent,
  normalizeClaudeInteractiveBrokerIntent,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import { createPrecompileLaunchTimingContext } from './precompile-launch-timing.js'

export type BrokerRunPreview = {
  controllerKind: 'harness-broker'
  brokerDriver: string
  interactionMode: string
  profileId: string
  profileHash: string
  specHash: string
  startRequestHash: string
  process: {
    command: string
    args: string[]
    cwd: string
  }
  initialInput: boolean
  launchInitialPromptLength?: number | undefined
  inputQueue: string
  interrupt: string
  resource?: string | undefined
  warnings: string[]
  /**
   * Prompt + environment material so `--dry-run` shows at least what
   * `asp run --dry-run` shows.
   *
   * `systemPromptFile` and the argv prompt flag only exist on the claude
   * route; codex passes neither, which is why reading prompts off the spec
   * alone rendered NOTHING for a codex agent. The prompt zones therefore come
   * from `inspectAgentSystemPrompt` — the same resolver `asp run` uses —
   * driven by the compiled `lockedEnv`, so the inputs are still read off the
   * frozen compile result rather than re-derived from placement.
   */
  systemPromptFile?: string | undefined
  systemPromptMode?: 'append' | 'replace' | undefined
  primingPrompt?: string | undefined
  /** Resolved prompt zones, at parity with `asp run --dry-run`. */
  systemPrompt?: string | undefined
  reminderContent?: string | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
  /** Compiled launch environment (`spec.process.lockedEnv`), values included. */
  env: Record<string, string>
  planHash: string
  compileId: string
  bundleIdentity: string
  model: {
    provider: string
    modelId: string
    requestedModel?: string | undefined
  }
}

/**
 * Resolve the agent's prompt zones for the preview.
 *
 * Inputs come from the compiled `lockedEnv` — the exact environment the launch
 * will run under — so this asks the resolver the same question the launch will
 * answer, rather than re-deriving one from placement. Returns nothing when the
 * agent has no context template (a bare SOUL.md-less agent), which is a real
 * "no prompt" answer, not a failure.
 */
async function resolvePromptZones(
  env: Record<string, string>,
  sessionRef: string
): Promise<
  | {
      systemPrompt: string
      systemPromptMode: 'append' | 'replace'
      reminderContent?: string | undefined
      promptSectionSizes: string[]
      reminderSectionSizes: string[]
      totalContextChars: number
      maxChars?: number | undefined
      nearMaxChars?: boolean | undefined
    }
  | undefined
> {
  const agentRoot = env['ASP_AGENT_ROOT']
  if (agentRoot === undefined || agentRoot.length === 0) return undefined
  const [scopePart, lanePart] = sessionRef.split('/lane:')
  const taskId = (scopePart ?? '').split(':task:')[1]

  const inspected = await inspectAgentSystemPrompt({
    agentRoot,
    agentsRoot: dirname(agentRoot),
    ...(env['ASP_HOME'] !== undefined ? { aspHome: env['ASP_HOME'] } : {}),
    ...(env['ASP_PROJECT_ROOT'] !== undefined ? { projectRoot: env['ASP_PROJECT_ROOT'] } : {}),
    ...(env['ASP_PROJECT'] !== undefined ? { projectId: env['ASP_PROJECT'] } : {}),
    ...(env['ASP_AGENT_NAME'] !== undefined ? { agentId: env['ASP_AGENT_NAME'] } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    lane: lanePart ?? 'main',
    runMode: 'task',
  })
  if (inspected === undefined) return undefined

  const reminder = inspected.reminder.content
  return {
    systemPrompt: inspected.prompt.content,
    systemPromptMode: inspected.prompt.mode,
    ...(reminder !== undefined && reminder.length > 0 ? { reminderContent: reminder } : {}),
    promptSectionSizes: inspected.diagnostics.prompt.sectionSizes,
    reminderSectionSizes: inspected.diagnostics.reminder.sectionSizes,
    totalContextChars: inspected.diagnostics.totalChars,
    ...(inspected.template.maxChars !== undefined ? { maxChars: inspected.template.maxChars } : {}),
    ...(inspected.diagnostics.nearMaxChars !== undefined
      ? { nearMaxChars: inspected.diagnostics.nearMaxChars }
      : {}),
  }
}

/**
 * The priming prompt, wherever the selected route puts it. Claude carries it in
 * `launch.initialPrompt`; codex sends it as the invocation's initial user turn.
 */
function resolvePrimingPrompt(
  launchInitialPrompt: string | undefined,
  initialInput: { content?: readonly unknown[] | undefined } | undefined
): string | undefined {
  if (typeof launchInitialPrompt === 'string' && launchInitialPrompt.length > 0) {
    return launchInitialPrompt
  }
  const text = (initialInput?.content ?? [])
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .filter((s) => s.length > 0)
    .join('\n')
  return text.length > 0 ? text : undefined
}

export async function buildBrokerRunPreview(
  intent: HrcRuntimeIntent,
  options: {
    sessionRef: string
    restartStyle: RestartStyle
    promptLength?: number | undefined
  }
): Promise<BrokerRunPreview | undefined> {
  const previewIntent = shouldRedirectClaudeToInteractiveBroker(intent)
    ? normalizeClaudeInteractiveBrokerIntent(intent)
    : intent
  if (!isInteractiveTmuxBrokerIntent(previewIntent) && !shouldUseHeadlessTransport(previewIntent)) {
    return undefined
  }

  const runtimeId = `dry-rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('preview', runtimeId, resolveStateRoot())
  const directAgentHarness =
    shouldUseHeadlessTransport(previewIntent) &&
    (previewIntent.harness.id === 'agent-harness' || previewIntent.harness.id === 'pi-sdk')
  const client = directAgentHarness ? undefined : await startAspcFacadeBrokerClient(timing)

  try {
    const compiled = directAgentHarness
      ? {
          admitted: true as const,
          ...(await buildDirectAgentHarnessPlan({
            intent: previewIntent,
            session: {
              hostSessionId: 'dry-run-host-session',
              scopeRef:
                previewIntent.placement.correlation?.sessionRef?.scopeRef ??
                options.sessionRef.split('/lane:')[0] ??
                options.sessionRef,
              laneRef: previewIntent.placement.correlation?.sessionRef?.laneRef ?? 'main',
              generation: 0,
            } as HrcSessionRecord,
            runtimeId,
            runId: `dry-run-${randomUUID()}`,
            dispatchEnv: {},
            now: new Date().toISOString(),
            resolveProfileYolo: async () => undefined,
          })),
          diagnostics: [],
        }
      : await compileBrokerRuntimePlan(
          {
            intent: previewIntent,
            hostSessionId: 'dry-run-host-session',
            generation: 0,
            continuation: undefined,
          },
          {
            compileHarnessInvocation: (request) => {
              if (client === undefined) {
                throw new Error('ASPC facade client is unavailable for broker preview')
              }
              return client.compileHarnessInvocation(request)
            },
            timing,
            ids: {
              requestId: () => `dry-req-${randomUUID()}`,
              operationId: () => `dry-op-${randomUUID()}`,
              runtimeId: () => runtimeId,
              invocationId: () => `dry-inv-${randomUUID()}`,
              initialInputId: () => `dry-input-${randomUUID()}`,
              runId: () => `dry-run-${randomUUID()}`,
              traceId: () => `dry-trace-${randomUUID()}`,
            },
          }
        )

    if (!compiled.admitted) {
      return undefined
    }

    const spec = compiled.startRequest.spec
    const launchInitialPrompt = spec.launch?.initialPrompt
    const env: Record<string, string> = { ...(spec.process.lockedEnv ?? {}) }
    const primingPrompt = resolvePrimingPrompt(
      launchInitialPrompt,
      compiled.startRequest.initialInput
    )
    // A prompt-zone resolution failure must not take the whole plan preview
    // down: the plan is still worth showing without the framed prompts.
    const promptZones = await resolvePromptZones(env, options.sessionRef).catch(() => undefined)
    const warnings = (compiled.profile.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.level !== 'error')
      .map((diagnostic) => diagnostic.message)

    return {
      controllerKind: 'harness-broker',
      brokerDriver: compiled.profile.brokerDriver,
      interactionMode: compiled.profile.interactionMode,
      profileId: compiled.profile.profileId,
      profileHash: compiled.profile.profileHash,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      process: {
        command: spec.process.command,
        args: spec.process.args,
        cwd: spec.process.cwd,
      },
      initialInput: compiled.startRequest.initialInput !== undefined,
      ...(typeof launchInitialPrompt === 'string'
        ? { launchInitialPromptLength: launchInitialPrompt.length }
        : {}),
      inputQueue: spec.interaction?.inputQueue ?? 'none',
      interrupt: compiled.profile.expectedCapabilities.turns.interrupt,
      ...(compiled.profile.brokerTerminal?.host === 'tmux'
        ? { resource: 'runtime-owned broker tmux lease socket' }
        : {}),
      warnings,
      ...(typeof spec.launch?.systemPromptFile === 'string'
        ? { systemPromptFile: spec.launch.systemPromptFile }
        : {}),
      ...(spec.launch?.systemPromptMode === 'append' || spec.launch?.systemPromptMode === 'replace'
        ? { systemPromptMode: spec.launch.systemPromptMode }
        : {}),
      ...(primingPrompt !== undefined ? { primingPrompt } : {}),
      ...(promptZones ?? {}),
      env,
      planHash: compiled.plan.planHash,
      compileId: compiled.plan.compileId,
      bundleIdentity: compiled.plan.resolvedBundle.bundleIdentity,
      model: {
        provider: compiled.plan.model.provider,
        modelId: compiled.plan.model.modelId,
        ...(compiled.plan.model.requestedModel !== undefined
          ? { requestedModel: compiled.plan.model.requestedModel }
          : {}),
      },
    }
  } finally {
    await client?.close().catch(() => undefined)
  }
}
