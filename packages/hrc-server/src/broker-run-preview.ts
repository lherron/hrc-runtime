import { randomUUID } from 'node:crypto'

import type { BrokerRunPreview, BrokerRunPreviewPromptZones, HrcRuntimeIntent } from 'hrc-core'

export type { BrokerRunPreview, BrokerRunPreviewPromptZones } from 'hrc-core'

import type { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'

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
 * A preview is an ordinary v2 compile. ASP decides whether the producer can
 * select an execution; HRC must not reject or redirect it based on a local
 * harness, provider, mode, or driver inference.
 */
export function resolvePreviewIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  return intent
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
  const warnings = (compiled.plan.diagnostics ?? []).flatMap((diagnostic) => {
    if (
      typeof diagnostic !== 'object' ||
      diagnostic === null ||
      (diagnostic as { level?: unknown }).level === 'error' ||
      typeof (diagnostic as { message?: unknown }).message !== 'string'
    ) {
      return []
    }
    return [(diagnostic as { message: string }).message]
  })
  const process = spec.process
  const previewProcess: BrokerRunPreview['process'] =
    'execution' in process && process.execution === 'native-worker'
      ? { execution: 'native-worker', cwd: process.cwd }
      : { command: process.command, args: process.args, cwd: process.cwd }

  return {
    controllerKind: 'harness-broker',
    specHash: compiled.specHash,
    startRequestHash: compiled.startRequestHash,
    selection: compiled.plan.selection,
    execution: {
      recipeId: compiled.execution.recipeId,
      driver: compiled.execution.driver,
      protocol: compiled.execution.protocol,
      hosting: compiled.execution.hosting,
      presentationFulfillment: compiled.execution.presentationFulfillment,
      ...(compiled.execution.presentationSurface !== undefined
        ? { presentationSurface: compiled.execution.presentationSurface }
        : {}),
      profile: compiled.execution.profile,
    },
    process: previewProcess,
    initialInput: compiled.startRequest.initialInput !== undefined,
    ...(typeof launchInitialPrompt === 'string'
      ? { launchInitialPromptLength: launchInitialPrompt.length }
      : {}),
    inputQueue: spec.interaction?.inputQueue ?? 'none',
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
    ...(compiled.executionRelease !== undefined
      ? {
          release: {
            releaseId: compiled.executionRelease.releaseId,
            sourceCommit: compiled.executionRelease.sourceCommit,
          },
        }
      : {}),
  }
}
