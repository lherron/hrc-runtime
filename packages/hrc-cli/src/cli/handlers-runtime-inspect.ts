import type { BrokerInspectResponse, InspectRuntimeResponse } from 'hrc-core'
import type { CaptureStateView, EvidenceAuthorityMatrix } from 'spaces-harness-broker-protocol'

export function formatCaptureState(capture: CaptureStateView | undefined): string {
  if (capture === undefined) return '(unavailable)'
  if (capture.state === 'open') return `open (deferredCount=${capture.deferredCount})`
  const blocked = capture.blockedOn
  if (blocked === undefined) return `blocked (deferredCount=${capture.deferredCount})`
  return `blocked since ${blocked.sinceIso} on ${blocked.rawRecordId} (${blocked.family}/${blocked.nativeType}): ${blocked.message} (deferredCount=${capture.deferredCount})`
}

export function printRuntimeInspect(
  runtime: InspectRuntimeResponse & {
    capture?: CaptureStateView | undefined
    evidenceAuthority?: EvidenceAuthorityMatrix | undefined
  }
): void {
  const continuation = runtime.continuation
    ? `${runtime.continuation.provider}:${runtime.continuation.key ?? '(none)'}${
        runtime.continuationStale ? ' (stale)' : ''
      }`
    : '(none)'
  const lines = [
    `runtime ${runtime.runtimeId}`,
    `  scope         ${runtime.scopeRef}`,
    `  lane          ${runtime.laneRef}`,
    `  generation    ${runtime.generation}`,
    `  transport     ${runtime.transport}`,
    `  harness       ${runtime.harness}`,
    `  provider      ${runtime.provider}`,
    `  model         ${runtime.reportedModel ? `${runtime.reportedModel.id} (reported, source: ${runtime.reportedModel.source})` : '(none reported)'}`,
    `  status        ${runtime.status}`,
    `  createdAt     ${runtime.createdAt} (age: ${formatAgeSec(runtime.createdAgeSec)})`,
    `  lastActivity  ${runtime.lastActivityAt ?? '(none)'} (age: ${
      runtime.lastActivityAgeSec === null ? '(none)' : formatAgeSec(runtime.lastActivityAgeSec)
    })`,
    `  activeRunId   ${runtime.activeRunId ?? '(none)'}`,
    `  wrapperPid    ${runtime.wrapperPid ?? '(none)'}`,
    `  childPid      ${runtime.childPid ?? '(none)'}`,
    `  continuation  ${continuation}`,
  ]
  if (runtime.capture !== undefined) {
    lines.push(`  capture       ${formatCaptureState(runtime.capture)}`)
  }
  if (runtime.brokerDispatch !== undefined) {
    const dispatch = runtime.brokerDispatch
    const seat = dispatch.liveSeatProbe
    lines.push(
      `  dispatch gate ${dispatch.dispatchGate}`,
      `  live seat     ${seat.state ?? '(unknown)'} (${seat.availability}, observed ${seat.observedAt})`,
      `  projections   runtime=${dispatch.runtimeProjection} invocation=${dispatch.invocationProjection ?? '(none)'}`,
      `  agreement     ${dispatch.agreement}`
    )
    const submission = dispatch.submissions.at(-1) as
      | {
          submissionId?: string
          runId?: string | null
          lastMilestone?: string
          acceptedAt?: string | null
          handedToHarnessAt?: string | null
          turnStartedAt?: string | null
        }
      | undefined
    if (submission) {
      lines.push(
        `  submission    ${submission.submissionId ?? '(unknown)'} last=${submission.lastMilestone ?? '(unknown)'} run=${submission.runId ?? '(none)'}`
      )
    }
    const turn = dispatch.turns.at(-1) as
      | { turnId?: string | null; origin?: string; runId?: string | null }
      | undefined
    if (turn) {
      lines.push(
        `  latest turn   ${turn.turnId ?? '(unknown)'} origin=${turn.origin ?? 'unknown'} run=${turn.runId ?? '(none)'}`
      )
    }
    const close = dispatch.lastUnexpectedClose as {
      observedAt?: string
      invocationPhaseAtClose?: string
      brokerPid?: number | null
      childPid?: number | null
      exitCode?: number | null
      signal?: string | null
      output?: { availability?: string; source?: string; tail?: string | null }
    } | null
    if (close) {
      lines.push(
        `  broker close  ${close.observedAt ?? '(unknown)'} phase=${close.invocationPhaseAtClose ?? 'unknown'} brokerPid=${close.brokerPid ?? 'unknown'} childPid=${close.childPid ?? 'unknown'} exit=${close.exitCode ?? 'unknown'} signal=${close.signal ?? 'unknown'}`,
        `  close output  ${close.output?.availability ?? 'unavailable'} source=${close.output?.source ?? 'unavailable'}`
      )
      if (close.output?.tail) lines.push(`    ${close.output.tail.replaceAll('\n', '\n    ')}`)
    }
  }
  if (runtime.evidenceAuthority !== undefined) {
    lines.push(
      `  evidence      ${Object.entries(runtime.evidenceAuthority)
        .map(([family, authority]) => `${family}=${authority}`)
        .join(', ')}`
    )
  }
  if (runtime.authority) {
    const policy = runtime.authority.actuatorSplit
    lines.push(
      `  authority     ${policy.mode}:${policy.laneClass}:${policy.codeMutation}`,
      `  code paths    ${(policy.productionCodePaths ?? []).join(', ') || '(none)'}`
    )
    const approved = runtime.authority.approvedMutation
    if (approved) {
      lines.push(
        `  approval      ${approved.approvalRecordHash}`,
        `  artifact      ${approved.artifactContentHash}`,
        `  target paths  ${approved.targetPaths.join(', ') || '(none)'}`
      )
    }
  }
  if (runtime.tmux) {
    const t = runtime.tmux
    if (t.socketPath) lines.push(`  tmux socket   ${t.socketPath}`)
    if (t.sessionName) lines.push(`  tmux session  ${t.sessionName}`)
    if (t.paneId) lines.push(`  tmux pane     ${t.paneId}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ── broker inspect (T-01856 P3) ──────────────────────────────────────────────

/**
 * Minimal structural view of a broker InvocationInspectionSummary for rendering.
 * The server passes the broker read model through verbatim under `invocations`;
 * the CLI never recomputes retention/liveness (cody C-03259 render guards).
 */
type RenderedBrokerInvocation = {
  invocationId: string
  state: string
  driver?: string
  startedAt?: string
  lastActivityAt?: string
  currentTurn?: { turnId?: string } | undefined
  lifecycle?:
    | {
        retention?: {
          mode?: string
          idleTtlMs?: number
          idleSince?: string
          computedRetireAt?: string
          blockedBy?: string[]
        }
      }
    | undefined
  liveness?: { mode?: string; driver?: { state?: string } } | undefined
  terminalSurface?: { kind?: string; sessionName?: string } | undefined
}

export function printBrokerInspect(result: BrokerInspectResponse): void {
  const lines: string[] = [
    `broker inspect ${result.runtimeId}`,
    `  source        ${result.source}`,
    `  transport     ${result.transport}`,
    `  harness       ${result.harness}`,
    `  status        ${result.status}`,
    `  lastActivity  ${result.lastActivityAt ?? '(none)'}`,
  ]

  if (result.source === 'broker') {
    const invocations = (result.invocations ?? []) as RenderedBrokerInvocation[]
    if (invocations.length === 0) {
      lines.push('  invocations   (none active)')
    }
    for (const inv of invocations) {
      lines.push(`  invocation ${inv.invocationId}`)
      lines.push(`    state         ${inv.state}`)
      if (inv.driver) lines.push(`    driver        ${inv.driver}`)
      if (inv.startedAt) lines.push(`    startedAt     ${inv.startedAt}`)
      if (inv.lastActivityAt) lines.push(`    lastActivity  ${inv.lastActivityAt}`)
      // Missing/undefined currentTurn both mean "no active turn" (cody C-03259).
      lines.push(`    currentTurn   ${inv.currentTurn?.turnId ?? '(no active turn)'}`)
      const retention = inv.lifecycle?.retention
      if (retention) {
        const ttl = retention.idleTtlMs !== undefined ? ` idleTtlMs=${retention.idleTtlMs}` : ''
        // Render retention STRAIGHT from the broker — no recompute (cody C-03259).
        lines.push(`    retention     mode=${retention.mode ?? '(none)'}${ttl}`)
        if (retention.idleSince) lines.push(`      idleSince       ${retention.idleSince}`)
        const blockers = retention.blockedBy ?? []
        if (blockers.length > 0) {
          // blockedBy present → computedRetireAt is NOT an unconditional deadline.
          lines.push(`      retire          BLOCKED by: ${blockers.join(', ')}`)
          if (retention.computedRetireAt) {
            lines.push(`      computedRetireAt ${retention.computedRetireAt} (not firm — blocked)`)
          }
        } else if (retention.computedRetireAt) {
          lines.push(`      computedRetireAt ${retention.computedRetireAt}`)
        }
      }
      // liveness: render only when present; never synthesize. 'cached' shows cached.
      if (inv.liveness) {
        const driverState = inv.liveness.driver?.state
        lines.push(
          `    liveness      ${inv.liveness.mode ?? '(unknown)'}${
            driverState ? ` (driver: ${driverState})` : ''
          }`
        )
      }
      if (inv.terminalSurface) {
        lines.push(
          `    terminal      ${inv.terminalSurface.kind ?? ''} ${
            inv.terminalSurface.sessionName ?? ''
          }`.trimEnd()
        )
      }
    }
  } else {
    // HRC-derived fallback — labeled so a synthesized TTL is never read as
    // broker-enforced (T-01844 #5 must-not-mislead).
    const retention = result.lifecycle?.retention
    if (retention) {
      const ttl = retention.idleTtlMs !== undefined ? ` idleTtlMs=${retention.idleTtlMs}` : ''
      lines.push(`  retention     mode=${retention.mode}${ttl}`)
      if (retention.idleSince) lines.push(`    idleSince       ${retention.idleSince}`)
      if (retention.computedRetireAt) {
        lines.push(`    computedRetireAt ${retention.computedRetireAt}`)
      }
    }
    if (result.note) lines.push(`  note          ${result.note}`)
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

export function formatAgeSec(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/**
 * Resolve the shared `--dry-run`/`--yes`/`--json` mutation gate used by the
 * sweep/reconcile handlers. Fatals with the canonical (noun-parameterized)
 * message when a mutation is requested without `--yes` on a non-TTY stdout, and
 * returns the resolved flags plus the effective `dryRun` (which defaults to true
 * on a TTY when neither `--dry-run` nor `--yes` is given).
 */
