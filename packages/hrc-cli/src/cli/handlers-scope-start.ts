import { randomUUID } from 'node:crypto'

import { printJson } from '../print.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { emitScopeCommandErrorJson, explainScopeCommandError } from './errors.js'
import {
  renderSessionSummary,
  spawnAttachDescriptor,
  waitForAttachProcess,
} from './runtime-select.js'
import {
  buildManagedRunIntent,
  buildManagedStartIntent,
  parseScopePrompt,
  resolveManagedScopeContext,
} from './scope.js'
import { createClient, fatal } from './shared.js'

import {
  buildStartFollowCommands,
  executeManagedStart,
  localCliDispatchOrigin,
  printManagedScopeUsage,
  printStartFollowHint,
} from './handlers-scope-managed.js'
import { printLocalRunPreview } from './handlers-scope-preview.js'

function printResumeUsage(): void {
  process.stdout.write(`Usage: hrc resume <scope> [options]

  Resume the most recent stored continuation for a target, REGARDLESS of its
  HRC status (archived / dormant / broken / removed-orphaned). Unlike \`hrc run\`,
  resume NEVER starts a fresh session and NEVER attaches as a substitute for
  resume — it requires a captured provider continuation and fails clearly if
  none was ever recorded. Explicit clear/drop/end operations do not erase or
  invalidate the stored provider continuation.

  <scope>  Agent scope: agent, agent@project, or full scope ref.
           When run from a project directory, the project is inferred
           automatically (e.g. "larry" becomes "larry@agent-spaces").

Options:
  --no-attach          Resume and start without attaching to the tmux session
  --prior              Resume the current session's immediate predecessor
  --host-session <id>  Resume an exact historical host session
  --dry-run            Local plan preview — no side effects
  --debug              Keep tmux shell alive after harness exits
  --project-id <id>    Override the inferred project id (cwd is treated as its root)
  --project-root <dir> Override project root (defaults to cwd when --project-id is set)
  --cwd <path>         Set execution cwd without changing the resolved project root
  --no-register        Don't prompt to register cwd as a project marker
  -p <text>            Initial prompt to send to the resumed harness
  --prompt-file <path> Read initial prompt from a file
`)
}

/**
 * T-04836 Part A — `hrc resume`. A DISTINCT continuation-resume verb (no longer
 * an alias of `hrc run`). It asks the server to select the latest recorded
 * continuation, mint an active successor, and then starts/prepares/dispatches
 * ONLY against that successor with stale-generation rotation disabled. Clear,
 * drop, and terminate audit events do not block explicit resume.
 */
export async function cmdResumeContinuation(args: string[]): Promise<void> {
  if (hasFlag(args, '--attach-only')) {
    fatal('hrc resume does not support --attach-only; use `hrc attach` to reattach a live runtime')
  }
  if (hasFlag(args, '--force-restart')) {
    fatal(
      'hrc resume does not support --force-restart; it always preserves the resumed continuation'
    )
  }
  if (hasFlag(args, '--prior') && parseFlag(args, '--host-session') !== undefined) {
    fatal('hrc resume accepts either --prior or --host-session, not both')
  }

  if (args.length === 0) {
    printResumeUsage()
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const noAttach = hasFlag(args, '--no-attach')
  const prior = hasFlag(args, '--prior')
  const pinnedHostSessionId = parseFlag(args, '--host-session')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const jsonOutput = hasFlag(args, '--json')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const cwdOverride = parseFlag(args, '--cwd')
  const prompt = await parseScopePrompt(args, {
    command: 'run',
    passthroughFlags: [
      '--no-attach',
      '--prior',
      '--host-session',
      '--dry-run',
      '--debug',
      '--no-register',
      '--json',
      '--project-id',
      '--project-root',
      '--cwd',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = await resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      cwdOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
    sessionRef = scope.sessionRef
    const intent = await buildManagedRunIntent(scope, { prompt, debug })

    if (dryRun) {
      const w = (s: string) => process.stdout.write(`${s}\n`)
      w(`hrc resume ${scopeInput} --dry-run  (local plan preview — no server state consulted)`)
      // Same `placement:` line run/start already print, from the resolution the
      // scope context above has already produced (T-06974).
      const placementReason = scope.placement?.resolution.reason
      if (placementReason) {
        w(`  placement:    ${placementReason}`)
      }
      w('')
      w(`  sessionRef:   ${sessionRef}`)
      w(`  projectRoot:  ${intent.placement.projectRoot ?? '(none)'}`)
      w(`  cwd:          ${intent.placement.cwd}`)
      w(
        `  selection:    ${prior ? 'immediate predecessor of the active session (--prior)' : pinnedHostSessionId !== undefined ? `exact host session ${pinnedHostSessionId}` : 'latest recorded continuation (default)'}`
      )
      w('  action:       POST /v1/sessions/resume-continuation (mint successor from the')
      w('                selected recorded continuation), then prepare/start against it with')
      w('                allowStaleGeneration:true. Fails if no captured continuation exists.')
      w(`  attach:       ${noAttach ? 'no (--no-attach)' : 'yes'}`)
      w(`  initialPrompt: ${prompt !== undefined ? `${prompt.length} chars` : '(none)'}`)
      w('')
      w('  Note: this preview does not resolve the session or inspect continuation state.')
      w('  Run without --dry-run to execute.')
      return
    }

    const client = createClient()

    let priorHostSessionId = pinnedHostSessionId
    if (prior) {
      const current = await client.resolveSession({
        sessionRef,
        create: false,
      })
      if (!current.found) {
        throw new Error(`cannot resume prior session for "${scopeInput}": no session exists`)
      }
      priorHostSessionId = current.session.priorHostSessionId
      if (priorHostSessionId === undefined) {
        throw new Error(
          `cannot resume prior session for "${scopeInput}": the current session has no predecessor`
        )
      }
    }

    const resumed = await client.resumeContinuation({
      sessionRef,
      intent,
      ...(priorHostSessionId !== undefined ? { priorHostSessionId } : {}),
    })
    const hostSessionId = resumed.hostSessionId
    const hasPrompt = prompt !== undefined && prompt.length > 0

    if (noAttach) {
      const runtime = hasPrompt
        ? await client.dispatchTurn({
            hostSessionId,
            prompt,
            runtimeIntent: intent,
            allowStaleGeneration: true,
            origin: localCliDispatchOrigin(),
          })
        : await client.startRuntime({
            hostSessionId,
            intent,
            restartStyle: 'reuse_pty',
            allowStaleGeneration: true,
          })
      printJson({
        sessionRef,
        hostSessionId,
        priorHostSessionId: resumed.priorHostSessionId,
        continuation: resumed.continuation,
        runtime,
      })
      return
    }

    const prepared = await client.prepareAttachedRun({
      hostSessionId,
      intent,
      restartStyle: 'reuse_pty',
      allowStaleGeneration: true,
      ...(hasPrompt ? { prompt } : {}),
    })

    const attached = await spawnAttachDescriptor(client, prepared.attach)
    if (prepared.status === 'prepared') {
      await client.resumeAttachedRun({
        pendingStartId: prepared.pendingStartId,
      })
    }
    await waitForAttachProcess(attached, client, hostSessionId)
    await renderSessionSummary(client, prepared.attach.bindingFence.runtimeId, scopeInput)
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('resume', err, scopeInput, sessionRef)
    }
    throw explainScopeCommandError('resume', err, scopeInput, sessionRef)
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
  const waitToken = args.find((arg) => arg === '--wait' || arg.startsWith('--wait='))
  const waitIndex = args.indexOf('--wait')
  const followingWaitMode = waitIndex >= 0 ? args[waitIndex + 1] : undefined
  const waitMode = waitToken?.startsWith('--wait=')
    ? waitToken.slice('--wait='.length)
    : followingWaitMode === 'started' || followingWaitMode === 'completed'
      ? followingWaitMode
      : waitToken === '--wait'
        ? 'completed'
        : undefined
  const waitFor =
    waitMode === 'started'
      ? ('turn_started' as const)
      : waitMode === 'completed'
        ? 'terminal'
        : undefined
  const idempotencyKey = parseFlag(args, '--idempotency-key')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const cwdOverride = parseFlag(args, '--cwd')
  const viewerWindow = parseFlag(args, '--viewer-window')
  const noViewer = hasFlag(args, '--no-viewer')
  if (noViewer && viewerWindow !== undefined) {
    fatal('start --no-viewer declines the viewer, so --viewer-window cannot place one')
  }
  const appServerViewer = hasFlag(args, '--app-server-viewer')
  if (noViewer && appServerViewer) {
    fatal('start --no-viewer and --app-server-viewer choose opposite presentations')
  }
  const onConflict = parseFlag(args, '--on-conflict')
  if (onConflict !== undefined && onConflict !== 'suffix' && onConflict !== 'reject') {
    fatal('start --on-conflict accepts "suffix" or "reject"')
  }
  const prompt = await parseScopePrompt(args, {
    command: 'start',
    passthroughFlags: [
      '--force-restart',
      '--new-session',
      '--dry-run',
      '--debug',
      '--no-register',
      '--json',
      '--wait',
      '--idempotency-key',
      '--project-id',
      '--project-root',
      '--cwd',
      '--viewer-window',
      '--no-viewer',
      '--app-server-viewer',
      '--on-conflict',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = await resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      cwdOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
    sessionRef = scope.sessionRef
    const intent = await buildManagedStartIntent(scope, {
      prompt,
      debug,
      ...(viewerWindow !== undefined ? { viewerWindow } : {}),
      ...(noViewer ? { operatorPresentation: 'none' as const } : {}),
      ...(appServerViewer ? { operatorPresentation: 'tmux-tui' as const } : {}),
    })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview(
        'start',
        scopeInput,
        sessionRef,
        intent,
        restartStyle,
        prompt,
        scope.placement?.resolution.reason,
        jsonOutput
      )
      return
    }

    const client = createClient()

    // `--on-conflict suffix` (T-07118): the daemon picks, claims, and starts a
    // free roster slot inside ONE request. The CLI deliberately does NOT
    // pre-scan, resolve, or clear context — it never holds a session identifier
    // it could race against, and learns which slot it got only from the settled
    // start response. The idempotency key is REQUIRED by that surface, so one is
    // generated per logical invocation when the operator did not pin one.
    if (onConflict === 'suffix') {
      const runtime = await client.startRuntime({
        baseSessionRef: sessionRef,
        runtimeIntent: intent,
        conflictPolicy: 'suffix',
        summonIntent: 'explicit_local',
        idempotencyKey: idempotencyKey ?? `hrc-start-suffix-${randomUUID()}`,
        restartStyle,
      })
      printJson({
        sessionRef: runtime.claim?.sessionRef ?? sessionRef,
        hostSessionId: runtime.hostSessionId,
        created: true,
        ...(runtime.claim !== undefined ? { claim: runtime.claim } : {}),
        runtime,
      })
      return
    }

    // `--on-conflict reject` (T-07302): claim EXACTLY this scope or refuse.
    // `summonIntent: 'implicit'` is not a formality here — it is what makes HRC,
    // rather than this terminal, decide where the scope lives, so a pinned scope
    // such as `cody@hrc-runtime:hrcdev` provisions on its own node instead of
    // being declared into existence wherever the operator happened to type.
    if (onConflict === 'reject') {
      const runtime = await client.startRuntime({
        sessionRef,
        runtimeIntent: intent,
        conflictPolicy: 'reject',
        summonIntent: 'implicit',
        idempotencyKey: idempotencyKey ?? `hrc-start-exact-${randomUUID()}`,
        restartStyle,
      })
      printJson({
        sessionRef: runtime.claim?.sessionRef ?? sessionRef,
        hostSessionId: runtime.hostSessionId,
        created: true,
        ...(runtime.claim !== undefined ? { claim: runtime.claim } : {}),
        runtime,
      })
      return
    }

    const resolved = await client.resolveSession({
      sessionRef,
      runtimeIntent: intent,
      create: true,
      // `hrc start` is the detached twin of `hrc run` — same operator, same
      // placement declaration (spec §5).
      summonIntent: 'explicit_local',
    })
    if (!resolved.found) {
      throw new Error(`failed to create session for "${scopeInput}"`)
    }
    const targetSession =
      newSession && !resolved.created
        ? await client.clearContext({
            hostSessionId: resolved.hostSessionId,
            dropContinuation: true,
            runtimeIntent: intent,
          })
        : resolved
    const runtime = await executeManagedStart(client, {
      hostSessionId: targetSession.hostSessionId,
      intent,
      prompt,
      restartStyle,
      waitFor,
      idempotencyKey,
    })

    const follow = prompt === undefined ? undefined : buildStartFollowCommands(scope.scopeRef)
    printJson({
      sessionRef,
      hostSessionId: targetSession.hostSessionId,
      created: resolved.created || newSession,
      runtime,
      ...(jsonOutput && follow !== undefined ? { follow } : {}),
    })
    if (!jsonOutput && follow !== undefined) {
      printStartFollowHint(
        follow,
        'stage' in runtime ? (runtime.stage as 'accepted' | 'turn_started' | 'terminal') : undefined
      )
    }
  } catch (err) {
    if (jsonOutput) {
      emitScopeCommandErrorJson('start', err, scopeInput, sessionRef)
    }
    throw explainScopeCommandError('start', err, scopeInput, sessionRef)
  }
}

/** Max characters shown for an env value in the run/start dry-run preview. */
