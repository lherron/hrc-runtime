import { recordCliLaunch } from 'hrc-core'
import type { CliLaunchPhase, PhaseRecord, RunDiagnostics } from 'hrc-core'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import {
  emitScopeCommandErrorJson,
  explainScopeCommandError,
  isHrcDomainErrorLike,
} from './errors.js'
import {
  renderSessionSummary,
  spawnAttachDescriptor,
  waitForAttachProcess,
} from './runtime-select.js'
import { buildManagedRunIntent, parseScopePrompt, resolveManagedScopeContext } from './scope.js'
import { createClient, fatal } from './shared.js'

import { cmdAttach } from './handlers-scope-attach.js'
import {
  createLiveRunPhaseStream,
  failedRunPhases,
  printManagedScopeUsage,
} from './handlers-scope-managed.js'
import { printLocalRunPreview } from './handlers-scope-preview.js'

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

  // `--dry-run` prints a daemon-compiled plan and returns; it never resolves a session,
  // spawns a runtime, or attaches a terminal, so the interactive-only gate does
  // not apply to it. Reading the plan (and the compiled prompts) from a pipe is
  // the point of the flag.
  const dryRun = hasFlag(args, '--dry-run')
  if (!dryRun && (process.stdin.isTTY !== true || process.stdout.isTTY !== true)) {
    fatal(
      'hrc run is interactive-only (no TTY detected). To provision a non-interactive agent runtime use: hrc start <scope> [-p <prompt>]'
    )
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const newSession = hasFlag(args, '--new-session')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const jsonOutput = hasFlag(args, '--json')
  const verbose = hasFlag(args, '--verbose') || hasFlag(args, '-v')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const prompt = await parseScopePrompt(args, {
    command: 'run',
    passthroughFlags: [
      '--force-restart',
      '--new-session',
      '--dry-run',
      '--debug',
      '--no-register',
      '--json',
      '--verbose',
      '-v',
      '--project-id',
      '--project-root',
    ],
  })

  let sessionRef: string | undefined
  let attachHandoffReached = false
  const livePhases: PhaseRecord[] = []
  const liveStream = verbose && !dryRun ? createLiveRunPhaseStream() : undefined
  // The client step in progress, so a throw keeps its duration and status.
  let inFlight: { id: string; startedAt: number } | undefined
  const beginLivePhase = (id: string): void => {
    inFlight = { id, startedAt: performance.now() }
    liveStream?.begin(id)
  }
  const recordLivePhase = (phase: PhaseRecord): void => {
    inFlight = undefined
    livePhases.push(phase)
    liveStream?.complete(phase)
  }
  // No live counter for resolve-scope: it may prompt to register the scope, and
  // an in-place counter would overwrite that prompt.
  inFlight = { id: 'resolve-scope', startedAt: performance.now() }
  const localResolveStartedAt = inFlight.startedAt
  try {
    const scope = await resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
    const scopeMs = Number((performance.now() - localResolveStartedAt).toFixed(1))
    recordLivePhase({ id: 'resolve-scope', status: 'ok', ms: scopeMs })
    sessionRef = scope.sessionRef
    const intent = await buildManagedRunIntent(scope, { prompt, debug })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview(
        'run',
        scopeInput,
        sessionRef,
        intent,
        restartStyle,
        prompt,
        scope.placement?.resolution.reason,
        jsonOutput,
        verbose,
        scopeMs
      )
      return
    }

    const client = createClient()

    // Launch-timing instrumentation. `--dry-run` returns above before any of this
    // server round-trip work; these per-RPC durations localize where a real launch
    // spends its wall time. Two sinks, deliberately: the stderr line stays gated
    // behind HRC_LAUNCH_TIMING (or --debug) so a normal interactive run keeps a
    // clean terminal, while the phases are ALWAYS accumulated and written as one
    // durable `launch` record at the attach handoff below. Startup cost is only
    // answerable from a population, and a diagnostic nobody enables collects none.
    const launchTiming = debug || process.env['HRC_LAUNCH_TIMING'] === '1'
    const launchT0 = performance.now()
    const launchPhases: CliLaunchPhase[] = []
    const markLaunch = (phase: string, sinceMs: number): void => {
      const ms = Number((performance.now() - sinceMs).toFixed(1))
      launchPhases.push({ phase, ms })
      if (!launchTiming) return
      process.stderr.write(`[hrc-launch-timing] ${phase} dur=${ms.toFixed(1)}ms\n`)
    }

    const tResolve = performance.now()
    beginLivePhase('create-session')
    const resolved = await client.resolveSession({
      sessionRef,
      runtimeIntent: intent,
      create: true,
      // `hrc run` is a human starting this scope at THIS node, which federation
      // spec §5 makes a one-shot placement declaration for a virgin, unpinned
      // scope. Nothing else about the request can carry that — an SDK caller
      // sends a byte-identical `create: true`.
      summonIntent: 'explicit_local',
    })
    markLaunch('resolveSession', tResolve)
    recordLivePhase({
      id: 'create-session',
      status: 'ok',
      ms: Number((performance.now() - tResolve).toFixed(1)),
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
    const hasPrompt = prompt !== undefined && prompt.length > 0

    const tPrepare = performance.now()
    beginLivePhase('prepare-run')
    const prepared = await client.prepareAttachedRun({
      hostSessionId: targetSession.hostSessionId,
      intent,
      restartStyle,
      ...(hasPrompt ? { prompt } : {}),
    })
    markLaunch('prepareAttachedRun', tPrepare)
    recordLivePhase({
      id: 'prepare-run',
      status: 'ok',
      ms: Number((performance.now() - tPrepare).toFixed(1)),
      children: prepared.diagnostics.phases,
    })

    const tAttach = performance.now()
    beginLivePhase('attach')
    const attached = await spawnAttachDescriptor(client, prepared.attach, () => {
      // Last write before tmux owns the terminal: completing the phase clears
      // the in-place counter, and finish prints only what was not streamed.
      recordLivePhase({
        id: 'attach',
        status: 'ok',
        ms: Number((performance.now() - tAttach).toFixed(1)),
      })
      liveStream?.finish(
        {
          releases: prepared.diagnostics.releases,
          ids: prepared.diagnostics.ids,
          phases: livePhases,
        },
        { totalLabel: 'ready' }
      )
    })
    attachHandoffReached = true
    markLaunch('spawnAttach', tAttach)

    if (prepared.status === 'prepared') {
      const tResume = performance.now()
      await client.resumeAttachedRun({
        pendingStartId: prepared.pendingStartId,
      })
      markLaunch('resumeAttachedRun', tResume)
    }
    markLaunch('total(pre-attach)', launchT0)
    // The attach handoff is the end of startup: past this point the operator is
    // in the TUI and the remaining wall time is session length, not launch cost.
    recordCliLaunch({
      bin: 'hrc',
      cmd: opts.invokedAs === 'resume' ? 'resume' : 'run',
      startupMs: Number((performance.now() - launchT0).toFixed(1)),
      phases: launchPhases,
    })
    await waitForAttachProcess(attached, client, targetSession.hostSessionId)
    // The tmux client has restored the operator's terminal (primary screen) by
    // now, so anything we print lands cleanly in their shell scrollback. Render
    // the broker-pushed session summary recorded at graceful /quit, if any.
    await renderSessionSummary(client, prepared.attach.bindingFence.runtimeId, scopeInput)
  } catch (err) {
    liveStream?.clear()
    const failed = inFlight
    if (liveStream !== undefined && (failed !== undefined || isHrcDomainErrorLike(err))) {
      const detail = (isHrcDomainErrorLike(err) ? (err.detail ?? {}) : {}) as Record<
        string,
        unknown
      >
      const serverPhases = Array.isArray(detail['phases'])
        ? (detail['phases'] as PhaseRecord[])
        : []
      liveStream.finish({
        releases: {
          ...(detail['aspdRelease'] !== undefined
            ? { aspd: detail['aspdRelease'] as RunDiagnostics['releases']['aspd'] }
            : {}),
        },
        ids:
          typeof detail['ids'] === 'object' && detail['ids'] !== null
            ? (detail['ids'] as Record<string, string>)
            : {},
        phases:
          failed === undefined
            ? [...livePhases, ...serverPhases]
            : failedRunPhases(
                livePhases,
                {
                  id: failed.id,
                  ms: Number((performance.now() - failed.startedAt).toFixed(1)),
                },
                serverPhases
              ),
      })
    }
    if (jsonOutput && !attachHandoffReached) {
      emitScopeCommandErrorJson('run', err, scopeInput, sessionRef)
    }
    throw explainScopeCommandError('run', err, scopeInput, sessionRef)
  }
}
