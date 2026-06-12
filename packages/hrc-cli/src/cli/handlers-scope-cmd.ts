import { readFileSync } from 'node:fs'

import type { HrcRuntimeIntent } from 'hrc-core'
import { buildBrokerRunPreview, buildCliInvocation } from 'hrc-server'
import { displayPrompts, formatDisplayCommand, renderKeyValueSection } from 'spaces-execution'

import { printJson } from '../print.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { emitScopeCommandErrorJson, explainScopeCommandError } from './errors.js'
import {
  attachWithRetry,
  bindGhosttySurfaceIfPresent,
  execAttachCommand,
  renderSessionSummary,
  selectLatestUsableRuntime,
  spawnAttachDescriptor,
  waitForAttachProcess,
} from './runtime-select.js'
import {
  type ExecAttachDescriptor,
  buildManagedAttachIntent,
  buildManagedRunIntent,
  buildManagedStartIntent,
  parseScopePrompt,
  resolveManagedScopeContext,
} from './scope.js'
import { createClient, fatal } from './shared.js'

function printManagedScopeUsage(command: 'run' | 'start' | 'resume'): void {
  // `resume` is an exact alias of `run`; it renders run's option surface but
  // under its own usage banner so `hrc resume` (no args) self-describes.
  const isRunLike = command === 'run' || command === 'resume'
  const summary =
    command === 'start'
      ? 'Resolve a session and start its managed runtime without attaching.'
      : 'Launch or reattach an agent harness in a managed tmux session.'
  const attachSummary = isRunLike
    ? '\n  By default, rerunning the same scope reattaches to the existing\n  runtime and preserves the PTY/context. Use --force-restart to\n  replace the runtime with a fresh PTY.\n'
    : ''
  const noAttachOption = isRunLike
    ? '  --no-attach          Start/ensure without attaching to the tmux session\n  --attach-only        Reattach to the existing runtime without starting one\n'
    : ''
  const newSessionOption =
    command === 'start'
      ? '  --new-session        Rotate to a fresh host session before starting\n'
      : ''

  process.stdout.write(`Usage: hrc ${command} <scope> [options]

  ${summary}

  <scope>  Agent scope: agent, agent@project, or full scope ref.
           When run from a project directory, the project is inferred
           automatically (e.g. "larry" becomes "larry@agent-spaces").${attachSummary}

Options:
  --force-restart      Replace any existing runtime with a fresh PTY
${noAttachOption}${newSessionOption}  --dry-run            Local plan preview — no server calls, no side effects
  --debug              Keep tmux shell alive after harness exits
  --project-id <id>    Override the inferred project id (cwd is treated as its root)
  --project-root <dir> Override project root (defaults to cwd when --project-id is set)
  --no-register        Don't prompt to register cwd as a project marker
  -p <text>            Initial prompt to send to the harness
  --prompt-file <path> Read initial prompt from a file
`)
}

export async function cmdRun(
  args: string[],
  opts: { invokedAs?: 'run' | 'resume' } = {}
): Promise<void> {
  // `--attach-only` (daedalus D4): behave exactly like `hrc attach` — reuse the
  // existing runtime and attach without starting/ensuring a new one. Strip the
  // flag and delegate so attach's dry-run plan and real attach path are shared.
  if (hasFlag(args, '--attach-only')) {
    const attachArgs = args.filter((arg) => arg !== '--attach-only')
    await cmdAttach(attachArgs)
    return
  }

  if (args.length === 0) {
    printManagedScopeUsage(opts.invokedAs === 'resume' ? 'resume' : 'run')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const noAttach = hasFlag(args, '--no-attach')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const jsonOutput = hasFlag(args, '--json')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const prompt = await parseScopePrompt(args, {
    command: 'run',
    passthroughFlags: [
      '--force-restart',
      '--no-attach',
      '--dry-run',
      '--debug',
      '--no-register',
      '--json',
      '--project-id',
      '--project-root',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
    sessionRef = scope.sessionRef
    const intent = buildManagedRunIntent(scope, { prompt, debug })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview('run', scopeInput, sessionRef, intent, restartStyle, prompt)
      return
    }

    const client = createClient()

    // Launch-timing instrumentation (diagnostic). `--dry-run` returns above before
    // any of this server round-trip work; these per-RPC durations localize where a
    // real launch spends its wall time. Gated behind HRC_LAUNCH_TIMING (or --debug)
    // so normal interactive runs keep a clean terminal. Emitted to stderr so it
    // never pollutes the --no-attach JSON on stdout.
    const launchTiming = debug || process.env['HRC_LAUNCH_TIMING'] === '1'
    const launchT0 = performance.now()
    const markLaunch = (phase: string, sinceMs: number): void => {
      if (!launchTiming) return
      process.stderr.write(
        `[hrc-launch-timing] ${phase} dur=${(performance.now() - sinceMs).toFixed(1)}ms\n`
      )
    }

    const tResolve = performance.now()
    const resolved = await client.resolveSession({
      sessionRef,
      runtimeIntent: intent,
      create: true,
    })
    markLaunch('resolveSession', tResolve)
    if (!resolved.found) {
      throw new Error(`failed to create session for "${scopeInput}"`)
    }
    const hasPrompt = prompt !== undefined && prompt.length > 0

    if (noAttach) {
      const runtime = await (async () => {
        if (!hasPrompt) {
          const tRuntime = performance.now()
          const started = await client.startRuntime({
            hostSessionId: resolved.hostSessionId,
            intent,
            restartStyle,
          })
          markLaunch('startRuntime', tRuntime)
          return started
        }

        const tDispatch = performance.now()
        const dispatched = await client.dispatchTurn({
          hostSessionId: resolved.hostSessionId,
          prompt,
          runtimeIntent: intent,
        })
        markLaunch('dispatchTurn', tDispatch)
        return dispatched
      })()
      printJson({
        sessionRef,
        hostSessionId: runtime.hostSessionId,
        created: resolved.created,
        runtime,
      })
      return
    }

    const tPrepare = performance.now()
    const prepared = await client.prepareAttachedRun({
      hostSessionId: resolved.hostSessionId,
      intent,
      restartStyle,
      ...(hasPrompt ? { prompt } : {}),
    })
    markLaunch('prepareAttachedRun', tPrepare)

    const tAttach = performance.now()
    const attached = await spawnAttachDescriptor(client, prepared.attach)
    markLaunch('spawnAttach', tAttach)

    if (prepared.status === 'prepared') {
      const tResume = performance.now()
      await client.resumeAttachedRun({ pendingStartId: prepared.pendingStartId })
      markLaunch('resumeAttachedRun', tResume)
    }
    markLaunch('total(pre-attach)', launchT0)
    await waitForAttachProcess(attached, client, resolved.hostSessionId)
    // The tmux client has restored the operator's terminal (primary screen) by
    // now, so anything we print lands cleanly in their shell scrollback. Render
    // the broker-pushed session summary recorded at graceful /quit, if any.
    await renderSessionSummary(client, prepared.attach.bindingFence.runtimeId, scopeInput)
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('run', err, scopeInput, sessionRef)
    }
    throw explainScopeCommandError('run', err, scopeInput, sessionRef)
  }
}

export async function cmdStart(args: string[]): Promise<void> {
  if (args.length === 0) {
    printManagedScopeUsage('start')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const newSession = hasFlag(args, '--new-session')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const jsonOutput = hasFlag(args, '--json')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const prompt = await parseScopePrompt(args, {
    command: 'start',
    passthroughFlags: [
      '--force-restart',
      '--new-session',
      '--dry-run',
      '--debug',
      '--no-register',
      '--json',
      '--project-id',
      '--project-root',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
    sessionRef = scope.sessionRef
    const intent = buildManagedStartIntent(scope, { prompt, debug })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview('start', scopeInput, sessionRef, intent, restartStyle, prompt)
      return
    }

    const client = createClient()
    const resolved = await client.resolveSession({
      sessionRef,
      runtimeIntent: intent,
      create: true,
    })
    if (!resolved.found) {
      throw new Error(`failed to create session for "${scopeInput}"`)
    }
    const targetSession =
      newSession && !resolved.created
        ? await client.clearContext({
            hostSessionId: resolved.hostSessionId,
            dropContinuation: true,
          })
        : resolved
    const runtime = await client.startRuntime({
      hostSessionId: targetSession.hostSessionId,
      intent,
      restartStyle,
    })

    printJson({
      sessionRef,
      hostSessionId: targetSession.hostSessionId,
      created: resolved.created || newSession,
      runtime,
    })
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('start', err, scopeInput, sessionRef)
    }
    throw explainScopeCommandError('start', err, scopeInput, sessionRef)
  }
}

/** Max characters shown for an env value in the run/start dry-run preview. */
const PREVIEW_ENV_VALUE_MAX_CHARS = 160
/** Max characters shown for an `env overrides` value in the dry-run preview. */
const PREVIEW_ENV_OVERRIDE_MAX_CHARS = 120

type RunPreviewWriter = (s: string) => void

/**
 * Render the broker-plan branch of the run dry-run preview. Returns `true` when
 * a broker plan was rendered (caller should stop), `false` to fall through to
 * the spec-build preview. Emitted lines are byte-identical to the prior inline
 * branch.
 */
async function renderBrokerPlanPreview(
  w: RunPreviewWriter,
  intent: HrcRuntimeIntent,
  sessionRef: string,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined
): Promise<boolean> {
  const brokerPreview = await buildBrokerRunPreview(intent, {
    sessionRef,
    restartStyle,
    promptLength: prompt?.length,
  }).catch((err: unknown) => {
    w('')
    w(`  (broker plan build failed: ${err instanceof Error ? err.message : String(err)})`)
    return undefined
  })
  if (!brokerPreview) {
    return false
  }
  w('')
  w('  brokerPlan:   available')
  w(`  sessionRef:   ${sessionRef}`)
  w(`  restartStyle: ${restartStyle}`)
  w(`  controller:   ${brokerPreview.controllerKind}`)
  w(`  driver:       ${brokerPreview.brokerDriver}`)
  w(`  interaction:  ${brokerPreview.interactionMode}`)
  w(`  profileId:    ${brokerPreview.profileId}`)
  w(`  profileHash:  ${brokerPreview.profileHash}`)
  w(`  specHash:     ${brokerPreview.specHash}`)
  w(`  requestHash:  ${brokerPreview.startRequestHash}`)
  w(`  cwd:          ${brokerPreview.process.cwd}`)
  w(
    `  command:      ${formatDisplayCommand(brokerPreview.process.command, brokerPreview.process.args)}`
  )
  w(`  initialInput: ${brokerPreview.initialInput ? 'yes' : 'no'}`)
  w(
    `  initialPrompt: ${prompt !== undefined ? `${prompt.length} chars` : brokerPreview.launchInitialPromptLength !== undefined ? `${brokerPreview.launchInitialPromptLength} launch chars` : '(none)'}`
  )
  w(`  inputQueue:   ${brokerPreview.inputQueue}`)
  w(`  interrupt:    ${brokerPreview.interrupt}`)
  if (brokerPreview.resource) {
    w(`  resource:     ${brokerPreview.resource}`)
  }
  if (brokerPreview.warnings.length > 0) {
    w('')
    w('  warnings:')
    for (const warning of brokerPreview.warnings) {
      w(`    - ${warning}`)
    }
  }
  w('')
  w('  Note: this preview compiles the broker plan locally and does not')
  w('  inspect existing runtime, PTY, or tmux state. Run without --dry-run to execute.')
  return true
}

/**
 * Render the spec-build branch of the run/start dry-run preview: framed system
 * prompt + priming, metadata, env block, command line, and the trailing note.
 * Emitted bytes are identical to the prior inline branch.
 */
async function renderSpecBuildPreview(
  w: RunPreviewWriter,
  intent: HrcRuntimeIntent,
  sessionRef: string,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined
): Promise<void> {
  // Build the actual argv/env that the harness would launch with, then render
  // it through the shared display module so this matches `asp run --dry-run`
  // and `hrc launch exec` runtime output: framed system prompt + priming, then
  // metadata, env block, and a command line with `<N chars>` placeholders.
  try {
    const invocation = await buildCliInvocation(intent)
    const structuredSystemPrompt =
      invocation.prompts?.system?.content ?? readOptionalUtf8(invocation.systemPromptFile)
    const sysPrompt =
      extractSystemPromptFromArgv(invocation.argv) ??
      (structuredSystemPrompt !== undefined
        ? {
            content: structuredSystemPrompt,
            mode: invocation.prompts?.system?.mode ?? 'append',
          }
        : undefined)
    const primingPrompt =
      extractPrimingFromArgv(invocation.argv) ?? invocation.prompts?.priming?.content
    const envEntries = Object.keys(invocation.env)
      .sort()
      .map((k): [string, string] => {
        const val = invocation.env[k] ?? ''
        return [
          k,
          val.length > PREVIEW_ENV_VALUE_MAX_CHARS
            ? `${val.slice(0, PREVIEW_ENV_VALUE_MAX_CHARS - 3)}...`
            : val,
        ]
      })
    const envBlock = renderKeyValueSection('env', envEntries)
    const argvHead = invocation.argv[0] ?? ''
    const display = formatDisplayCommand(argvHead, invocation.argv.slice(1))

    // Metadata lives below the framed prompts: scope/session info first,
    // then the resolved invocation context, then env overrides if any.
    const betweenLines: string[] = []
    betweenLines.push('')
    betweenLines.push(`  sessionRef:   ${sessionRef}`)
    betweenLines.push(`  restartStyle: ${restartStyle}`)
    betweenLines.push(`  agentRoot:    ${intent.placement.agentRoot}`)
    betweenLines.push(`  projectRoot:  ${intent.placement.projectRoot ?? '(none)'}`)
    betweenLines.push(`  cwd:          ${intent.placement.cwd}`)
    betweenLines.push(`  provider:     ${intent.harness.provider}`)
    betweenLines.push(
      `  initialPrompt: ${prompt !== undefined ? `${prompt.length} chars` : '(none)'}`
    )
    betweenLines.push('')
    betweenLines.push(`  invocation cwd:      ${invocation.cwd}`)
    betweenLines.push(`  invocation provider: ${invocation.provider}`)
    betweenLines.push(`  invocation frontend: ${invocation.frontend}`)

    const envOverrides = intent.launch?.env
    if (envOverrides && Object.keys(envOverrides).length > 0) {
      betweenLines.push('')
      betweenLines.push('  env overrides:')
      for (const key of Object.keys(envOverrides).sort()) {
        const val = envOverrides[key]
        if (val === undefined) continue
        const valDisplay =
          val.length > PREVIEW_ENV_OVERRIDE_MAX_CHARS
            ? `${val.slice(0, PREVIEW_ENV_OVERRIDE_MAX_CHARS - 3)}...`
            : val
        betweenLines.push(`    ${key}=${valDisplay}`)
      }
    }

    if (envBlock.length > 0) {
      betweenLines.push('')
      betweenLines.push(...envBlock)
    }

    await displayPrompts({
      systemPrompt: sysPrompt?.content,
      systemPromptMode: sysPrompt?.mode,
      primingPrompt,
      betweenLines,
      command: display,
      showCommand: true,
    })

    if (invocation.warnings && invocation.warnings.length > 0) {
      w('')
      w('  warnings:')
      for (const warning of invocation.warnings) {
        w(`    - ${warning}`)
      }
    }
  } catch (err) {
    w('')
    w(`  (spec build failed: ${err instanceof Error ? err.message : String(err)})`)
  }

  w('')
  w('  Note: this preview shows the request the client would send. Server-side')
  w('  details (existing runtime, PTY state, tmux session) are not consulted.')
  w('  Run without --dry-run to execute.')
}

async function printLocalRunPreview(
  command: 'run' | 'start',
  scope: string,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined
): Promise<void> {
  const w: RunPreviewWriter = (s: string) => {
    process.stdout.write(`${s}\n`)
  }

  w(`hrc ${command} ${scope} --dry-run  (local plan preview — no server state consulted)`)

  if (command === 'run') {
    const rendered = await renderBrokerPlanPreview(w, intent, sessionRef, restartStyle, prompt)
    if (rendered) {
      return
    }
  }

  await renderSpecBuildPreview(w, intent, sessionRef, restartStyle, prompt)
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

function printAttachUsage(): void {
  process.stdout.write(`Usage: hrc attach <scope> [--dry-run]

  Resolve a managed session by scope and attach to its latest active runtime.

  Compatibility:
  attach <runtimeId>  Print the attach descriptor JSON for an explicit runtime ID.
`)
}

async function printLocalAttachPreview(scope: string, sessionRef: string): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`)

  w(`hrc attach ${scope} --dry-run  (local plan preview — no server state consulted)\n`)
  w(`  sessionRef:    ${sessionRef}`)
  w('  runtimeLookup: latest non-unavailable runtime for the resolved host session')
  w('  recovery:      detached OpenAI sessions materialize a fresh tmux runtime on attach')
  w('  action:        POST /v1/runtimes/attach for that runtime, then exec returned argv')
  w('')
  w('  Note: this preview does not resolve the session or inspect runtime state.')
  w('  Run without --dry-run to execute.')
}

export async function cmdAttach(args: string[]): Promise<void> {
  if (args.length === 0) {
    printAttachUsage()
    return
  }

  const target = requireArg(args, 0, '<scope>')
  const dryRun = hasFlag(args, '--dry-run')
  const jsonOutput = hasFlag(args, '--json')

  if (target.startsWith('rt-')) {
    if (dryRun) {
      fatal('attach --dry-run expects a scope, not a runtimeId')
    }
    const client = createClient()
    const descriptor = await client.getAttachDescriptor(target)
    await bindGhosttySurfaceIfPresent(client, descriptor)
    printJson(descriptor)
    return
  }

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(target)
    sessionRef = scope.sessionRef
    const intent = buildManagedAttachIntent(scope)

    if (dryRun) {
      await printLocalAttachPreview(target, sessionRef)
      return
    }

    const client = createClient()
    const resolved = await client.resolveSession({ sessionRef })
    if (!resolved.found) {
      throw new Error(`no active runtime found for "${target}"`)
    }

    const runtimes = await client.listRuntimes({ hostSessionId: resolved.hostSessionId })
    const runtime = selectLatestUsableRuntime(runtimes)
    if (!runtime) {
      throw new Error(`no active runtime found for "${target}"`)
    }

    const descriptor: ExecAttachDescriptor = await attachWithRetry(
      client,
      resolved.hostSessionId,
      runtime,
      intent
    )
    execAttachCommand(descriptor.argv, descriptor.env)
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('attach', err, target, sessionRef)
    }
    throw explainScopeCommandError('attach', err, target, sessionRef)
  }
}
