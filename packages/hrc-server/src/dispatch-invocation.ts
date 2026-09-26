import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

export function shellIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `invalid shell identifier "${value}"`,
      { value }
    )
  }

  return value
}

export function joinShellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ')
}

export function normalizeDispatchIntent(
  intent: HrcRuntimeIntent | undefined,
  session: HrcSessionRecord,
  runId?: string
): HrcRuntimeIntent {
  if (!intent) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required when the session has no prior intent'
    )
  }

  // Deployment-skew defense: an older sender may put the provision-only DM
  // fragment directly in front of a whole-intent consumer. Typed callers cannot
  // do this after HrcDmRuntimeIntent is narrowed by handleSemanticDm, but raw
  // JSON from a mismatched deployment must fail instead of half-applying with
  // the daemon cwd and an absent harness.
  if (intent.placement === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent must be complete before dispatch',
      { reason: 'directive_only_runtime_intent' }
    )
  }

  const cwd =
    intent.placement?.cwd ??
    intent.placement?.projectRoot ??
    intent.placement?.agentRoot ??
    process.cwd()
  const projectRoot = intent.placement?.projectRoot ?? cwd
  const agentRoot = intent.placement?.agentRoot ?? projectRoot

  // A stored `hrc start` intent carries harness.interactive=true with
  // execution.preferredMode='headless' ("provision the durable broker without
  // attaching"). Replayed at a dispatch boundary that shape is incoherent:
  // preferredMode forces the headless transport, where every executor
  // (decideHeadlessExecutionRoute, the broker plan compile) requires a
  // non-interactive harness — the interactive flag would dead-end the turn in
  // 'legacy-exec' or compile the wrong broker driver. The execution mode is
  // caller-authoritative here, so coerce the harness flag to match it.
  const harness =
    intent.execution?.preferredMode === 'headless' && intent.harness.interactive === true
      ? { ...intent.harness, interactive: false }
      : intent.harness

  return {
    ...intent,
    harness,
    placement: {
      ...intent.placement,
      agentRoot,
      projectRoot,
      cwd,
      runMode: intent.placement?.runMode ?? 'task',
      // Callers may legitimately omit a bundle; do not claim an agent identity here.
      bundle: intent.placement?.bundle ?? { kind: 'compose', compose: [] },
      dryRun: intent.placement?.dryRun ?? true,
      correlation: {
        sessionRef: {
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
        },
        hostSessionId: session.hostSessionId,
        ...(runId !== undefined ? { runId } : {}),
        generation: session.generation,
      },
    },
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}
