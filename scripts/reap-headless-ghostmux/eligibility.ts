import { type SessionIdentity, formatSessionIdentityHandle } from 'hrc-core'
import { MIN_IDLE_MINUTES, MIN_IDLE_MS, type PaneStatus, color } from './types'

export function sqlQuote(value: string): string {
  return value.replaceAll("'", "''")
}

export function scopeFromTitle(title: string): string {
  const prefix = 'hrc headless '
  return title.startsWith(prefix) ? title.slice(prefix.length) : ''
}

export function handleFromIdentity(scopeRef: string, identity?: SessionIdentity): string {
  return identity ? formatSessionIdentityHandle(identity) : scopeRef
}

export function projectHandleFromIdentity(scopeRef: string, identity?: SessionIdentity): string {
  return identity
    ? identity.agentId + (identity.projectId ? `@${identity.projectId}` : '')
    : scopeRef
}

export function formatDurationAgo(timestamp: string): string {
  if (!timestamp) return 'unknown'
  const eventMs = Date.parse(timestamp)
  if (!Number.isFinite(eventMs)) return 'unknown'
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - eventMs) / 1000))
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const deltaMinutes = Math.floor(deltaSeconds / 60)
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`
  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 48) return `${deltaHours}h ago`
  return `${Math.floor(deltaHours / 24)}d ago`
}

export function shortRuntime(runtimeId: string): string {
  return runtimeId.startsWith('rt-') ? `rt-${runtimeId.slice(3, 11)}` : runtimeId || 'unknown'
}

export function shortRun(runId: string): string {
  return runId.startsWith('run-') ? `run-${runId.slice(4, 12)}` : runId || 'none'
}

export function statusColor(value: string): string {
  if (value === 'ready' || value === 'completed') return color.green(value)
  if (value === 'busy' || value === 'started' || value === 'accepted') return color.yellow(value)
  if (value === 'terminated' || value === 'stale') return color.dim(value)
  if (value === 'failed' || value === 'dead' || value === 'crashed') return color.red(value)
  return color.white(value)
}

export function eventKindColor(eventKind: string): string {
  if (eventKind === 'turn.completed') return color.green(eventKind)
  if (!eventKind || eventKind === 'unknown') return color.dim('unknown')
  return color.yellow(eventKind)
}

export function isIdleLongerThanThreshold(lastActivityUtc: string): boolean {
  const lastActivityMs = Date.parse(lastActivityUtc)
  return Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs > MIN_IDLE_MS
}

// Operator idle-viewer reap invariant (T-04423, daedalus ruling): a reap is
// valid iff the surface metadata resolves to exactly ONE broker-tmux runtime
// that is idle-and-complete with NO active run and has seen no HRC activity for
// strictly more than 30 minutes. The `activeRunId` guard is the
// HIGH-severity one: without it, terminating a `ready`-with-active-run runtime
// makes `finalizeRuntimeTermination` fail the live run. The transport/controller
// guards keep us off true headless/sdk runtimes (where `/v1/terminate` only
// finalizes HRC state without a broker dispose) and off non-broker tmux panes.
//
// `skipReasons` is the single source of truth: it returns one human-readable
// line per failed guard (empty array == eligible). `isQuitEligible` is just
// "no reasons". Add new scenarios here over time; keep each reason actionable
// (say what state we saw AND why it disqualifies / what to do instead).
export function skipReasons(status: PaneStatus): string[] {
  // Root causes that make every downstream field 'unknown'/'' — report just the
  // root so the operator isn't buried in cascading noise.
  if (status.runtimeId === '') {
    return ['no HRC runtime resolved from this pane (orphaned viewer, or stale title/metadata)']
  }
  if (status.runtimeStatus === 'unknown') {
    return [
      `runtime ${shortRuntime(status.runtimeId)} not found in the HRC DB (already pruned, or wrong HRC_DB_PATH)`,
    ]
  }

  const reasons: string[] = []

  if (status.identity?.taskId === 'primary') {
    reasons.push(
      ':primary standing session — never reaped by this sweep; terminate manually with hrc runtime terminate if truly intended'
    )
  }

  // chief@* holds one hcs attention-thread seat per context (T-07729). These
  // are task-scoped by design (never :primary), and sitting idle between
  // Lance's visits is their NORMAL state — an idle chief seat is not an
  // abandoned one. Exempt by agent, not project, so chief seats stay safe
  // wherever they live (T-07819).
  if (status.identity?.agentId === 'chief') {
    reasons.push(
      'chief@* attention-thread seat — idle between visits is its normal state; never reaped by this sweep'
    )
  }

  if (status.controllerKind !== 'harness-broker') {
    reasons.push(
      status.controllerKind === ''
        ? 'controllerKind unknown — not a recognized broker runtime'
        : `controllerKind=${status.controllerKind}, not harness-broker — true headless/sdk runtimes finalize via HRC state only, not a broker reap`
    )
  }

  // Presentation-aware surface gate (T-04923). Two shapes are reapable:
  //   (a) legacy broker-tmux:  transport === 'tmux'           — accepted as-is.
  //   (b) codex app-server viewer:  transport === 'headless'  with a real tmux
  //       TUI window, i.e. presentation.kind === 'tmux-tui' over a leased-tmux
  //       substrate. The HRC transport is the broker channel to the daemon
  //       ('headless'), but the runtime still owns an operator-visible tmux pane.
  // The raw transport value alone is NOT sufficient — for headless runtimes the
  // persisted hosting state (presentationKind / substrateKind) decides.
  if (status.transport !== 'tmux') {
    if (status.presentationKind === undefined) {
      // No hosting-state presentation info (legacy metadata path): there is no
      // way to confirm a tmux TUI window, so fall back to the raw transport gate.
      reasons.push(
        status.transport === ''
          ? 'transport unknown — not a tmux-backed broker'
          : `transport=${status.transport}, not tmux — only broker-tmux panes are reaped here`
      )
    } else if (status.presentationKind === '') {
      // json_extract returned NULL: runtimeStateJson has no parseable
      // broker.presentation block — we cannot confirm a tmux-tui viewer window.
      reasons.push(
        'hosting state missing/malformed — no parseable broker.presentation; ' +
          'cannot confirm a tmux-tui viewer window for this headless runtime'
      )
    } else if (status.presentationKind !== 'tmux-tui') {
      // A true headless run: broker lives in a leased tmux session but exposes no
      // operator TUI window to reap/close.
      reasons.push(
        `presentation.kind=${status.presentationKind}, not tmux-tui — true headless runtime with no operator viewer pane to reap`
      )
    } else if (status.substrateKind !== 'leased-tmux') {
      // presentation claims a TUI window, but the broker is daemon-child hosted —
      // there is no leased tmux session/pane to terminate or key-close.
      reasons.push(
        `substrate.kind=${status.substrateKind || 'unknown'}, not leased-tmux — broker is daemon-child hosted; no leased tmux session/pane to close`
      )
    }
  }

  if (status.runtimeStatus !== 'ready') {
    switch (status.runtimeStatus) {
      case 'terminated':
        reasons.push(
          'runtime already terminated — nothing live to reap (hrc-viewer reaps the pane)'
        )
        break
      case 'stale':
        reasons.push('runtime is stale — no live broker left to terminate')
        break
      case 'busy':
      case 'started':
      case 'accepted':
        reasons.push(
          `runtime is ${status.runtimeStatus} — wait until it returns to ready/idle, then re-run`
        )
        break
      case 'failed':
      case 'dead':
      case 'crashed':
        reasons.push(
          `runtime is ${status.runtimeStatus} — not a clean live broker (investigate; do not reap)`
        )
        break
      default:
        reasons.push(`runtime status is ${status.runtimeStatus}, not ready`)
    }
  }

  // HIGH-severity guard: reaping a runtime with an active run would fail that run.
  if (status.activeRunId !== '') {
    reasons.push(
      `has an active run (${shortRun(status.activeRunId)}) — reaping would fail the live run`
    )
  }

  if (status.turnStatus !== 'completed') {
    switch (status.turnStatus) {
      case 'none':
        reasons.push('no turn recorded yet — nothing has run on this runtime')
        break
      case 'failed':
        reasons.push('latest turn failed/reaped, not completed — may be mid-recovery')
        break
      // statusSql resolves a coalesced run to its owner, so reaching this arm
      // means the pointer itself is unusable — do not guess which turn ran.
      case 'coalesced':
        reasons.push(
          'latest turn is coalesced but its owner run did not resolve — coalesced_into_run_id is missing or dangling; inspect the run before reaping'
        )
        break
      case 'started':
      case 'running':
      case 'accepted':
      case 'busy':
        reasons.push(`latest turn is ${status.turnStatus} (still in progress)`)
        break
      default:
        reasons.push(`latest turn is ${status.turnStatus}, not completed`)
    }
  }

  const lastActivityMs = Date.parse(status.lastActivityUtc)
  if (!Number.isFinite(lastActivityMs)) {
    reasons.push('latest activity time is missing or invalid — cannot confirm 30 minutes idle')
  } else if (!isIdleLongerThanThreshold(status.lastActivityUtc)) {
    reasons.push(
      `latest activity was ${formatDurationAgo(status.lastActivityUtc)} — requires more than ${MIN_IDLE_MINUTES} minutes idle`
    )
  }

  return reasons
}

export function isQuitEligible(status: PaneStatus): boolean {
  return skipReasons(status).length === 0
}
