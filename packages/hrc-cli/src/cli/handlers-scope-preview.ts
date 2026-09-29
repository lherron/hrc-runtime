import { readFileSync } from 'node:fs'

import { maskDiagnosticArgv, maskDiagnosticEnvironment } from 'hrc-core'
import type { BrokerRunPreview, HrcRuntimeIntent, PhaseRecord, RunDiagnostics } from 'hrc-core'

import { displayPrompts, formatDisplayCommand, renderKeyValueSection } from './dry-run-display.js'

import { printJson } from '../print.js'
import { isHrcDomainErrorLike } from './errors.js'
import { compactRunTimingFooter, renderRunDiagnostics } from './run-diagnostics-render.js'
import { createClient } from './shared.js'

const PREVIEW_ENV_VALUE_MAX_CHARS = 160

type RunPreviewWriter = (s: string) => void

/**
 * Key-sorted env entries with long values elided, for the dry-run env block.
 */
function previewEnvEntries(env: Record<string, string>): Array<[string, string]> {
  const masked = maskDiagnosticEnvironment(env)
  return Object.keys(masked)
    .sort()
    .map((key): [string, string] => {
      const value = masked[key] ?? ''
      return [
        key,
        value.length > PREVIEW_ENV_VALUE_MAX_CHARS
          ? `${value.slice(0, PREVIEW_ENV_VALUE_MAX_CHARS - 3)}...`
          : value,
      ]
    })
}

/**
 * Render the daemon-compiled broker plan of the run dry-run preview.
 *
 * T-08596 (T-08569A closure): the plan is compiled by the daemon
 * (`POST /v1/previews/run`) — no local facade spawn, no local interpretation.
 * Every plan line the prior version emitted is still emitted, verbatim, from
 * the daemon's preview document. An unreachable daemon surfaces the SDK's typed
 * `hrc_daemon_unreachable` refusal via the caller's error envelope.
 */
export async function renderBrokerPlanPreview(
  w: RunPreviewWriter,
  brokerPreview: BrokerRunPreview,
  prompt: string | undefined
): Promise<boolean> {
  const nativeWorker = brokerPreview.process.execution === 'native-worker'
  const processArgs = nativeWorker ? [] : (brokerPreview.process.args ?? [])
  const displayProcessArgs = maskDiagnosticArgv(processArgs)
  const processCommand = nativeWorker ? undefined : brokerPreview.process.command
  // Prefer the resolved prompt zones: they are the only source that covers
  // every route (codex passes no prompt flag and no prompt file) and the only
  // one carrying the reminder and per-section sizes `asp run --dry-run` shows.
  // The argv/file readings remain as fallbacks for a route that somehow has an
  // inline prompt but no resolvable context template.
  const argvSystemPrompt = extractSystemPromptFromArgv(processArgs)
  const fileSystemPrompt = readOptionalUtf8(brokerPreview.systemPromptFile)
  const systemPrompt =
    brokerPreview.systemPrompt !== undefined
      ? {
          content: brokerPreview.systemPrompt,
          mode: brokerPreview.systemPromptMode ?? 'append',
        }
      : (argvSystemPrompt ??
        (fileSystemPrompt !== undefined
          ? {
              content: fileSystemPrompt,
              mode: brokerPreview.systemPromptMode ?? 'append',
            }
          : undefined))
  const primingPrompt = brokerPreview.primingPrompt ?? extractPrimingFromArgv(processArgs)

  const lines: string[] = []
  lines.push('  brokerPlan:   available')
  lines.push(`  controller:   ${brokerPreview.controllerKind}`)
  lines.push(
    `  selection.harness: ${brokerPreview.selection.harness} (${brokerPreview.selection.provenance.harness})`
  )
  lines.push(
    `  selection.modelProvider: ${brokerPreview.selection.modelProvider} (${brokerPreview.selection.provenance.modelProvider})`
  )
  lines.push(
    `  selection.model: ${brokerPreview.selection.model} (${brokerPreview.selection.provenance.model})`
  )
  if (brokerPreview.selection.reasoningEffort !== undefined) {
    lines.push(
      `  selection.reasoningEffort: ${brokerPreview.selection.reasoningEffort} (${brokerPreview.selection.provenance.reasoningEffort ?? 'unknown'})`
    )
  }
  lines.push(
    `  selection.presentation: ${brokerPreview.selection.presentation} (${brokerPreview.selection.provenance.presentation})`
  )
  lines.push(`  recipe:       ${brokerPreview.execution.recipeId}`)
  lines.push(`  driver:       ${brokerPreview.execution.driver}`)
  lines.push(`  protocol:     ${brokerPreview.execution.protocol}`)
  lines.push(
    `  hosting:      ${brokerPreview.execution.hosting.executionTransport} / ${brokerPreview.execution.hosting.processExecution} / terminal=${brokerPreview.execution.hosting.terminalRequired ? 'yes' : 'no'}`
  )
  lines.push(`  fulfillment:  ${brokerPreview.execution.presentationFulfillment}`)
  if (brokerPreview.execution.presentationSurface !== undefined) {
    lines.push(
      `  surface:      ${brokerPreview.execution.presentationSurface.transport} / ${brokerPreview.execution.presentationSurface.terminalHost}`
    )
  }
  lines.push(`  profileId:    ${brokerPreview.execution.profile.profileId}`)
  lines.push(`  profileHash:  ${brokerPreview.execution.profile.profileHash}`)
  lines.push(`  compatibilityHash: ${brokerPreview.execution.profile.compatibilityHash}`)
  lines.push(`  compileId:    ${brokerPreview.compileId}`)
  lines.push(`  planHash:     ${brokerPreview.planHash}`)
  lines.push(`  specHash:     ${brokerPreview.specHash}`)
  lines.push(`  requestHash:  ${brokerPreview.startRequestHash}`)
  lines.push(`  cwd:          ${brokerPreview.process.cwd}`)
  if (brokerPreview.release !== undefined) {
    lines.push(`  release:      ${brokerPreview.release.releaseId}`)
    lines.push(`  sourceCommit: ${brokerPreview.release.sourceCommit}`)
  }
  if (nativeWorker) {
    lines.push('  execution:    native-worker')
  }
  lines.push(`  initialInput: ${brokerPreview.initialInput ? 'yes' : 'no'}`)
  // `launchInitialPromptLength` is the claude-route field; codex carries its
  // priming as the initial user turn, so fall back to the resolved priming
  // prompt rather than claiming "(none)" next to a rendered Priming Prompt.
  lines.push(
    `  initialPrompt: ${
      prompt !== undefined
        ? `${prompt.length} chars`
        : brokerPreview.launchInitialPromptLength !== undefined
          ? `${brokerPreview.launchInitialPromptLength} launch chars`
          : primingPrompt !== undefined
            ? `${primingPrompt.length} launch chars`
            : '(none)'
    }`
  )
  lines.push(`  inputQueue:   ${brokerPreview.inputQueue}`)
  if (brokerPreview.execution.hosting.terminalHost !== undefined) {
    lines.push(`  terminalHost: ${brokerPreview.execution.hosting.terminalHost}`)
  }
  if (brokerPreview.systemPromptFile !== undefined) {
    lines.push(`  promptFile:   ${brokerPreview.systemPromptFile}`)
  }
  if (brokerPreview.warnings.length > 0) {
    lines.push('')
    lines.push('  warnings:')
    for (const warning of brokerPreview.warnings) {
      lines.push(`    - ${warning}`)
    }
  }

  const envBlock = renderKeyValueSection('env', previewEnvEntries(brokerPreview.env))
  if (envBlock.length > 0) {
    lines.push('')
    lines.push(...envBlock)
  }

  await displayPrompts({
    ...(systemPrompt !== undefined
      ? {
          systemPrompt: systemPrompt.content,
          systemPromptMode: systemPrompt.mode,
        }
      : {}),
    ...(brokerPreview.reminderContent !== undefined
      ? { reminderContent: brokerPreview.reminderContent }
      : {}),
    ...(primingPrompt !== undefined ? { primingPrompt } : {}),
    ...(brokerPreview.promptSectionSizes !== undefined
      ? { promptSectionSizes: brokerPreview.promptSectionSizes }
      : {}),
    ...(brokerPreview.reminderSectionSizes !== undefined
      ? { reminderSectionSizes: brokerPreview.reminderSectionSizes }
      : {}),
    ...(brokerPreview.totalContextChars !== undefined
      ? { totalContextChars: brokerPreview.totalContextChars }
      : {}),
    ...(brokerPreview.maxChars !== undefined ? { maxChars: brokerPreview.maxChars } : {}),
    ...(brokerPreview.nearMaxChars !== undefined
      ? { nearMaxChars: brokerPreview.nearMaxChars }
      : {}),
    betweenLines: lines,
    ...(processCommand === undefined
      ? {}
      : { command: formatDisplayCommand(processCommand, displayProcessArgs) }),
    showCommand: !nativeWorker,
  })

  w('')
  w('  Note: this preview is compiled by the daemon and does not')
  w('  inspect existing runtime, PTY, or tmux state. Run without --dry-run to execute.')
  return true
}

export async function printLocalRunPreview(
  command: 'run' | 'start',
  scope: string,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined,
  placementReason: string | undefined,
  jsonOutput = false,
  verbose = false,
  resolveScopeMs = 0
): Promise<void> {
  const w: RunPreviewWriter = (s: string) => {
    process.stdout.write(`${s}\n`)
  }

  // Pi is a retired HRC-local harness, not a selectable v2 ASP harness. Keep
  // its established diagnostic offline: asking the daemon to compile it would
  // manufacture a selection request from a compatibility-shaped intent.
  if (intent.harness.id === 'pi') {
    const harnessId = intent.harness.id ?? intent.harness.provider
    if (jsonOutput) {
      printJson({
        preview: null,
        diagnostics: { releases: {}, ids: {}, phases: [] },
        reason: `no broker route for harness "${harnessId}"`,
      })
      return
    }
    w(`hrc ${command} ${scope} --dry-run  (daemon plan preview — no side effects)`)
    w('')
    w(
      `  no broker route for harness "${harnessId}" (provider ${intent.harness.provider}, interactive ${intent.harness.interactive}); nothing to preview`
    )
    w('')
    w('  Note: this preview shows the daemon-compiled plan. Server-side')
    w('  details (existing runtime, PTY state, tmux session) are not consulted.')
    w('  Run without --dry-run to execute.')
    return
  }
  const client = createClient()
  const daemonPreviewAt = performance.now()
  let brokerPreview: Awaited<ReturnType<typeof client.fetchRunPreview>>
  try {
    brokerPreview = await client.fetchRunPreview({
      intent,
      sessionRef,
      restartStyle,
      promptLength: prompt?.length,
    })
  } catch (error) {
    if (isHrcDomainErrorLike(error)) {
      const detail = (error.detail ?? {}) as Record<string, unknown>
      const children = Array.isArray(detail['phases']) ? (detail['phases'] as PhaseRecord[]) : []
      detail['phases'] = [
        { id: 'resolve-scope', status: 'ok', ms: resolveScopeMs },
        {
          id: 'daemon-preview',
          status: 'error',
          ms: Number((performance.now() - daemonPreviewAt).toFixed(1)),
          ...(children.length === 0 ? {} : { children }),
        },
        { id: 'build-preview', status: 'not-reached', reason: 'daemon preview failed' },
      ] satisfies PhaseRecord[]
    }
    throw error
  }
  const daemonPreviewMs = Number((performance.now() - daemonPreviewAt).toFixed(1))
  const buildStartedAt = performance.now()
  const maskedPreview = {
    ...brokerPreview,
    env: maskDiagnosticEnvironment(brokerPreview.env),
    process:
      brokerPreview.process.execution === 'native-worker'
        ? brokerPreview.process
        : { ...brokerPreview.process, args: maskDiagnosticArgv(brokerPreview.process.args) },
  }
  const phases: PhaseRecord[] = [
    { id: 'resolve-scope', status: 'ok', ms: resolveScopeMs },
    {
      id: 'daemon-preview',
      status: 'ok',
      ms: daemonPreviewMs,
      children: brokerPreview.diagnostics.phases,
    },
    {
      id: 'build-preview',
      status: 'ok',
      ms: Number((performance.now() - buildStartedAt).toFixed(1)),
    },
    { id: 'create-session', status: 'skipped', reason: 'skipped (dry run)' },
    { id: 'broker-start', status: 'skipped', reason: 'skipped (dry run)' },
    { id: 'broker-ready', status: 'skipped', reason: 'skipped (dry run)' },
    { id: 'attach', status: 'skipped', reason: 'skipped (dry run)' },
  ]
  const diagnostics: RunDiagnostics = { ...brokerPreview.diagnostics, phases }
  if (jsonOutput) {
    printJson({
      preview: maskedPreview,
      diagnostics,
    })
    if (verbose) renderRunDiagnostics(diagnostics)
    return
  }
  w(`hrc ${command} ${scope} --dry-run  (daemon plan preview — no side effects)`)
  if (placementReason) {
    w(`  placement:    ${placementReason}`)
  }
  w(`  sessionRef:   ${sessionRef}`)
  w(`  restartStyle: ${restartStyle}`)
  w(`  agentRoot:    ${intent.placement.agentRoot}`)
  w(`  projectRoot:  ${intent.placement.projectRoot ?? '(none)'}`)
  w(`  provider:     ${intent.harness.provider}`)
  w(`  cwd:          ${intent.placement.cwd}`)
  await renderBrokerPlanPreview(w, brokerPreview, prompt)
  if (verbose) {
    process.stderr.write(`hrc run ${scope}  ·  dry run (nothing will start)\n`)
    renderRunDiagnostics(diagnostics)
  } else {
    w(compactRunTimingFooter(diagnostics))
  }
}

function readOptionalUtf8(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined
  }
  try {
    const content = readFileSync(path, 'utf8')
    return content.length > 0 ? content : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the system prompt from a harness argv. Mirrors the logic in
 * `hrc-server/launch/exec.ts` so dry-run output matches runtime output.
 */
function extractSystemPromptFromArgv(
  argv: readonly string[]
): { content: string; mode: 'append' | 'replace' } | undefined {
  const appendIdx = argv.indexOf('--append-system-prompt')
  if (appendIdx !== -1 && argv[appendIdx + 1] !== undefined) {
    return { content: argv[appendIdx + 1] as string, mode: 'append' }
  }
  const replaceIdx = argv.indexOf('--system-prompt')
  if (replaceIdx !== -1 && argv[replaceIdx + 1] !== undefined) {
    return { content: argv[replaceIdx + 1] as string, mode: 'replace' }
  }
  return undefined
}

/**
 * Extract the priming prompt: convention is the value after `--`.
 */
function extractPrimingFromArgv(argv: readonly string[]): string | undefined {
  const dashIdx = argv.indexOf('--')
  if (dashIdx === -1) return undefined
  const value = argv[dashIdx + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
