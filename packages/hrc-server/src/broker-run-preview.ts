import { randomUUID } from 'node:crypto'

import type { BrokerRunPreview, BrokerRunPreviewPromptZones, HrcRuntimeIntent } from 'hrc-core'

export type { BrokerRunPreview, BrokerRunPreviewPromptZones } from 'hrc-core'

import type { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  isInteractiveTmuxBrokerIntent,
  normalizeClaudeInteractiveBrokerIntent,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'

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

/**
 * The broker-routable intent a preview compiles, or undefined when the intent has
 * no broker plan to preview (the caller then falls back to the direct spec view).
 */
export function resolvePreviewIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent | undefined {
  const previewIntent = shouldRedirectClaudeToInteractiveBroker(intent)
    ? normalizeClaudeInteractiveBrokerIntent(intent)
    : intent
  if (!isInteractiveTmuxBrokerIntent(previewIntent) && !shouldUseHeadlessTransport(previewIntent)) {
    return undefined
  }
  return previewIntent
}

/** Dry-run identities: nothing a preview compiles can collide with a real launch. */
export function previewCompileIds(runtimeId: string) {
  return {
    requestId: () => `dry-req-${randomUUID()}`,
    operationId: () => `dry-op-${randomUUID()}`,
    runtimeId: () => runtimeId,
    invocationId: () => `dry-inv-${randomUUID()}`,
    initialInputId: () => `dry-input-${randomUUID()}`,
    runId: () => `dry-run-${randomUUID()}`,
    traceId: () => `dry-trace-${randomUUID()}`,
  }
}

/**
 * T-08564: project an admitted compile into the preview shape. Shared by the
 * in-process CLI preview and the daemon's aspd-backed preview route so both
 * render byte-identical plan facts.
 */
export function projectBrokerRunPreview(
  compiled: Extract<Awaited<ReturnType<typeof compileBrokerRuntimePlan>>, { admitted: true }>,
  promptZones: BrokerRunPreviewPromptZones | undefined
): BrokerRunPreview {
  const spec = compiled.startRequest.spec
  const launchInitialPrompt = spec.launch?.initialPrompt
  const env: Record<string, string> = { ...(spec.process.lockedEnv ?? {}) }
  const primingPrompt = resolvePrimingPrompt(
    launchInitialPrompt,
    compiled.startRequest.initialInput
  )
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
}
