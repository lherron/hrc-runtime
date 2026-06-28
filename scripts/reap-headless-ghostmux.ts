#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { Chalk } from 'chalk'

type Options = {
  dryRun: boolean
  simulate: boolean
  assumeYes: boolean
  paneRole: string
  titleRegex: string
  closePromptRegex: string
  waitSeconds: number
  reapTimeoutMs: number
  hrcDbPath: string
}

type Pane = {
  id: string
  title: string
}

// Discovery now keys off the durable ghostmux metadata role rather than the
// surface TITLE (T-05237 renamed headless titles from `hrc headless agent:...`
// to the compact `<proj> · <task> · <agent>` form, which broke the old title
// regex). A DiscoveredPane carries the resolved metadata forward so queryStatus
// does not re-fetch it.
type DiscoveredPane = Pane & {
  metadata: Record<string, unknown>
}

// The role stamped on each per-agent headless pane inside the consolidated
// "Headless Sessions" window (T-05237). The window anchor itself carries
// `headless-window-anchor` and is intentionally excluded.
const HEADLESS_PANE_ROLE = 'headless-agent-pane'

type PaneStatus = Pane & {
  agent: string
  scopeRef: string
  runtimeId: string
  runtimeStatus: string
  transport: string
  controllerKind: string
  activeRunId: string
  turnStatus: string
  runId: string
  lastEventUtc: string
  lastEventLocal: string
  lastEventKind: string
  // Presentation-aware reap fields (T-04923, Phase C of T-04905). Sourced from
  // the persisted broker hosting state (runtime_state_json). OPTIONAL because the
  // legacy metadata path (and the original eligibleStatus fixtures) never set
  // them — `undefined` means "no hosting-state info, fall back to the raw
  // transport gate"; `''` means "json_extract returned NULL → malformed/absent
  // broker.presentation block".
  presentationKind?: string
  substrateKind?: string
}

const color = new Chalk({
  level: process.env.NO_COLOR ? 0 : process.stdout.isTTY || process.env.FORCE_COLOR ? 1 : 0,
})

function usage(): never {
  console.log(`Usage:
  scripts/reap-headless-ghostmux.sh [--dry-run] [--simulate] [--yes]
  bun scripts/reap-headless-ghostmux.ts [--dry-run] [--simulate] [--yes]

Find Ghostty headless-agent panes by their durable metadata role (hrc_role ==
PANE_ROLE), print HRC status, ask for confirmation, then reap each eligible
broker-tmux runtime over the broker RPC channel via 'hrc runtime terminate
--no-drop-continuation --reason operator_reap' (continuation preserved), wait,
and send Enter only to panes whose captured contents match CLOSE_PROMPT_REGEX.

Discovery is by metadata role, NOT title — the consolidated "Headless Sessions"
window (T-05237) renamed pane titles to '<proj> · <task> · <agent>', so the old
title regex no longer matched. TITLE_REGEX remains an OPTIONAL secondary filter.

Eligible = surface resolves to one runtime with controllerKind=harness-broker,
a tmux TUI window (transport=tmux, OR transport=headless with a leased-tmux
substrate + presentation.kind=tmux-tui — the codex app-server viewer pane),
status=ready, NO active run, latest turn=completed.

Environment:
  PANE_ROLE            Default: ${HEADLESS_PANE_ROLE} (ghostmux hrc_role metadata)
  TITLE_REGEX          Optional extra title filter (default: none)
  CLOSE_PROMPT_REGEX   Default: Press (enter to exit|any key to close)
  WAIT_SECONDS         Default: 10
  HRC_DB_PATH          Default: /Users/lherron/praesidium/var/state/hrc/state.sqlite

Options:
  --dry-run            Print intended reap/ghostmux actions without running them.
  --simulate           Run against built-in fake panes/captures; implies dry-run.
  -y, --yes            Skip the interactive confirmation before reaping.`)
  process.exit(0)
}

function parseArgs(argv: string[]): Options {
  const waitWasSet = process.env.WAIT_SECONDS !== undefined
  const options: Options = {
    dryRun: false,
    simulate: false,
    assumeYes: false,
    paneRole: process.env.PANE_ROLE ?? HEADLESS_PANE_ROLE,
    titleRegex: process.env.TITLE_REGEX ?? '',
    closePromptRegex: process.env.CLOSE_PROMPT_REGEX ?? 'Press (enter to exit|any key to close)',
    waitSeconds: Number(process.env.WAIT_SECONDS ?? '10'),
    // Per-runtime ceiling on `hrc runtime terminate`. A wedged broker never acks
    // the dispose RPC, and neither the SDK fetch nor `hrc` itself has a timeout —
    // so without this the whole SEQUENTIAL sweep freezes on one bad pane. 0
    // disables the bound (legacy hang-forever behavior).
    reapTimeoutMs: Math.round(Number(process.env.REAP_TIMEOUT_SECONDS ?? '20') * 1000),
    hrcDbPath: process.env.HRC_DB_PATH ?? '/Users/lherron/praesidium/var/state/hrc/state.sqlite',
  }

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--simulate') {
      options.simulate = true
      options.dryRun = true
      if (!waitWasSet) options.waitSeconds = 0
    } else if (arg === '-y' || arg === '--yes') {
      options.assumeYes = true
    } else if (arg === '-h' || arg === '--help') {
      usage()
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.waitSeconds) || options.waitSeconds < 0) {
    throw new Error(`WAIT_SECONDS must be a non-negative number, got ${options.waitSeconds}`)
  }
  if (!Number.isFinite(options.reapTimeoutMs) || options.reapTimeoutMs < 0) {
    throw new Error(`REAP_TIMEOUT_SECONDS must be a non-negative number`)
  }
  return options
}

function run(argv: string[], input?: string): string {
  const proc = Bun.spawnSync(argv, {
    stdin: input ? new TextEncoder().encode(input) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)
  if (proc.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed (${proc.exitCode}): ${stderr || stdout}`)
  }
  return stdout
}

function tryRun(argv: string[]): string {
  try {
    return run(argv)
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCommand(command: string): void {
  const proc = Bun.spawnSync(['bash', '-lc', `command -v ${command}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) throw new Error(`missing required command: ${command}`)
}

function sqlQuote(value: string): string {
  return value.replaceAll("'", "''")
}

function scopeFromTitle(title: string): string {
  const prefix = 'hrc headless '
  return title.startsWith(prefix) ? title.slice(prefix.length) : ''
}

function agentFromScope(scopeRef: string): string {
  if (!scopeRef.startsWith('agent:')) return 'unknown'
  const rest = scopeRef.slice('agent:'.length)
  return rest.split(':')[0] || 'unknown'
}

function handleFromScope(scopeRef: string): string {
  const parts = scopeRef.split(':')
  const agent = parts[0] === 'agent' ? parts[1] : ''
  let project = ''
  let task = ''
  let role = ''

  for (let i = 2; i < parts.length - 1; i += 2) {
    const key = parts[i]
    const value = parts[i + 1] ?? ''
    if (key === 'project') project = value
    if (key === 'task') task = value
    if (key === 'role') role = value
  }

  if (!agent) return scopeRef
  let handle = agent
  if (project) handle += `@${project}`
  if (task) handle += `:${task}`
  if (role) handle += `/${role}`
  return handle
}

function projectHandleFromScope(scopeRef: string): string {
  const handle = handleFromScope(scopeRef)
  return handle.split(':')[0] || handle
}

function formatDurationAgo(timestamp: string): string {
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

function shortRuntime(runtimeId: string): string {
  return runtimeId.startsWith('rt-') ? `rt-${runtimeId.slice(3, 11)}` : runtimeId || 'unknown'
}

function shortRun(runId: string): string {
  return runId.startsWith('run-') ? `run-${runId.slice(4, 12)}` : runId || 'none'
}

function statusColor(value: string): string {
  if (value === 'ready' || value === 'completed') return color.green(value)
  if (value === 'busy' || value === 'started' || value === 'accepted') return color.yellow(value)
  if (value === 'terminated' || value === 'stale') return color.dim(value)
  if (value === 'failed' || value === 'dead' || value === 'crashed') return color.red(value)
  return color.white(value)
}

function eventKindColor(eventKind: string): string {
  if (eventKind === 'turn.completed') return color.green(eventKind)
  if (!eventKind || eventKind === 'unknown') return color.dim('unknown')
  return color.yellow(eventKind)
}

// Operator idle-viewer reap invariant (T-04423, daedalus ruling): a reap is
// valid iff the surface metadata resolves to exactly ONE broker-tmux runtime
// that is idle-and-complete with NO active run. The `activeRunId` guard is the
// HIGH-severity one: without it, terminating a `ready`-with-active-run runtime
// makes `finalizeRuntimeTermination` fail the live run. The transport/controller
// guards keep us off true headless/sdk runtimes (where `/v1/terminate` only
// finalizes HRC state without a broker dispose) and off non-broker tmux panes.
//
// `skipReasons` is the single source of truth: it returns one human-readable
// line per failed guard (empty array == eligible). `isQuitEligible` is just
// "no reasons". Add new scenarios here over time; keep each reason actionable
// (say what state we saw AND why it disqualifies / what to do instead).
function skipReasons(status: PaneStatus): string[] {
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
          'runtime already terminated — nothing live to reap (leftover viewer pane only; ' +
            'close it directly with ghostmux)'
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

  return reasons
}

function isQuitEligible(status: PaneStatus): boolean {
  return skipReasons(status).length === 0
}

// A leftover viewer is a pane whose HRC runtime is already gone (terminated or
// stale) — there is nothing live to reap, but the Ghostty terminal is often
// still parked on the harness "Press enter to exit" close prompt. Such panes are
// NOT reap-eligible (no live broker), yet we still want to send Enter to close
// the dead terminal. The actual keystroke stays gated by the close-prompt regex
// at send time, so a runtime-gone pane that is NOT showing the prompt is left
// untouched. A pane with an active run is never a leftover viewer.
function isLeftoverViewer(status: PaneStatus): boolean {
  return (
    status.runtimeId !== '' &&
    status.activeRunId === '' &&
    (status.runtimeStatus === 'terminated' || status.runtimeStatus === 'stale')
  )
}

function simPanes(): DiscoveredPane[] {
  return [
    {
      id: '7BF21FAF',
      // Post-T-05237 compact title: '<proj> · <task> · <agent>'.
      title: 'acp · T-02864 · smokey',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-smokey-sim',
        hrc_scope_ref: 'agent:smokey:project:agent-control-plane:task:T-02864',
      },
    },
    {
      id: 'EB834507',
      title: 'acp · T-02864 · curly',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-curly-sim',
        hrc_scope_ref: 'agent:curly:project:agent-control-plane:task:T-02864',
      },
    },
    {
      // Already-terminated leftover viewer: no live runtime to reap, but parked
      // on the close prompt — exercises the leftover-viewer close path.
      id: 'C10D0144',
      title: 'spaces · primary · clod',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-clod-leftover-sim',
        hrc_scope_ref: 'agent:clod:project:agent-spaces:task:primary',
      },
    },
  ]
}

// Resolve a single surface's ghostmux metadata (the `--resolved` view merges
// inherited window/tab metadata down onto the pane). Tolerant: a surface with
// no metadata, or non-JSON output, yields {}.
function metadataForSurface(id: string): Record<string, unknown> {
  const raw = tryRun(['ghostmux', 'metadata', 'get', '-t', id, '--resolved', '--json'])
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> } | Record<string, unknown>
    return 'data' in parsed && isRecord(parsed.data)
      ? parsed.data
      : (parsed as Record<string, unknown>)
  } catch {
    return {}
  }
}

// Pure discovery core (unit-testable without ghostmux): keep surfaces whose
// resolved metadata role equals paneRole, optionally further filtered by a title
// regex. The metadata resolver is injected so tests can supply a fake.
function selectHeadlessPanes(
  terminals: Array<{ short_id?: string; id?: string; title?: string }>,
  resolveMetadata: (id: string) => Record<string, unknown>,
  paneRole: string,
  titleRegex?: string
): DiscoveredPane[] {
  const titleFilter = titleRegex ? new RegExp(titleRegex) : null
  const discovered: DiscoveredPane[] = []
  for (const terminal of terminals) {
    const id = terminal.short_id ?? terminal.id ?? ''
    if (!id) continue
    const title = terminal.title ?? ''
    if (titleFilter && !titleFilter.test(title)) continue
    const metadata = resolveMetadata(id)
    const role = typeof metadata.hrc_role === 'string' ? metadata.hrc_role : ''
    if (role !== paneRole) continue
    discovered.push({ id, title, metadata })
  }
  return discovered
}

function listPanes(options: Options): DiscoveredPane[] {
  if (options.simulate) return simPanes()
  const parsed = JSON.parse(run(['ghostmux', 'list-surfaces', '--json'])) as {
    terminals?: Array<{ short_id?: string; id?: string; title?: string }>
  }
  return selectHeadlessPanes(
    parsed.terminals ?? [],
    metadataForSurface,
    options.paneRole,
    options.titleRegex
  )
}

function queryStatus(pane: DiscoveredPane, options: Options): PaneStatus {
  const metadata = pane.metadata
  const scopeRef =
    typeof metadata.hrc_scope_ref === 'string' && metadata.hrc_scope_ref
      ? metadata.hrc_scope_ref
      : scopeFromTitle(pane.title)
  const runtimeId = typeof metadata.hrc_runtime_id === 'string' ? metadata.hrc_runtime_id : ''
  const agent = agentFromScope(scopeRef)

  if (options.simulate) {
    // C10D0144 simulates an already-terminated leftover viewer (no live runtime
    // to reap, but still parked on the close prompt).
    const leftover = pane.id === 'C10D0144'
    return {
      ...pane,
      agent,
      scopeRef,
      runtimeId,
      runtimeStatus: leftover ? 'terminated' : 'ready',
      transport: 'tmux',
      controllerKind: 'harness-broker',
      activeRunId: '',
      turnStatus: 'completed',
      runId: `run-sim-${pane.id}`,
      lastEventUtc: '2026-06-09T14:00:00.000Z',
      lastEventLocal: '2026-06-09 09:00:00',
      lastEventKind: leftover ? 'runtime.terminated' : 'turn.completed',
    }
  }

  if (!existsSync(options.hrcDbPath)) {
    return {
      ...pane,
      agent,
      scopeRef,
      runtimeId,
      runtimeStatus: 'unknown',
      transport: '',
      controllerKind: '',
      activeRunId: '',
      turnStatus: 'unknown',
      runId: '',
      lastEventUtc: '',
      lastEventLocal: '',
      lastEventKind: 'missing-db',
    }
  }

  const escapedScope = sqlQuote(scopeRef)
  const escapedRuntime = sqlQuote(runtimeId)
  const output = run([
    'sqlite3',
    '-tabs',
    '-noheader',
    options.hrcDbPath,
    `
      WITH target(scope_ref, runtime_id) AS (
        VALUES ('${escapedScope}', '${escapedRuntime}')
      ),
      latest_runtime AS (
        SELECT runtime_id, status, active_run_id, transport, controller_kind, runtime_state_json, updated_at
        FROM runtimes
        WHERE (runtime_id = (SELECT runtime_id FROM target) AND (SELECT runtime_id FROM target) <> '')
           OR (scope_ref = (SELECT scope_ref FROM target) AND (SELECT scope_ref FROM target) <> '')
        ORDER BY updated_at DESC
        LIMIT 1
      ),
      latest_run AS (
        SELECT run_id, status, updated_at
        FROM runs
        WHERE (
            runtime_id = COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime))
            AND COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime)) IS NOT NULL
          )
           OR (scope_ref = (SELECT scope_ref FROM target) AND (SELECT scope_ref FROM target) <> '')
        ORDER BY updated_at DESC
        LIMIT 1
      ),
      latest_event AS (
        SELECT ts, event_kind, hrc_seq
        FROM hrc_events
        WHERE (
            runtime_id = COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime))
            AND COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime)) IS NOT NULL
          )
           OR (scope_ref = (SELECT scope_ref FROM target) AND (SELECT scope_ref FROM target) <> '')
        ORDER BY hrc_seq DESC
        LIMIT 1
      )
      SELECT
        COALESCE(NULLIF('${escapedRuntime}', ''), (SELECT runtime_id FROM latest_runtime), ''),
        COALESCE((SELECT status FROM latest_runtime), 'unknown'),
        COALESCE((SELECT transport FROM latest_runtime), ''),
        COALESCE((SELECT controller_kind FROM latest_runtime), ''),
        COALESCE((SELECT active_run_id FROM latest_runtime), ''),
        COALESCE((SELECT status FROM latest_run), 'none'),
        COALESCE((SELECT run_id FROM latest_run), ''),
        COALESCE((SELECT ts FROM latest_event), ''),
        COALESCE(datetime((SELECT ts FROM latest_event), 'localtime'), ''),
        COALESCE((SELECT event_kind FROM latest_event), ''),
        -- Presentation-aware reap (T-04923). Two serialisation shapes (G2 compat):
        -- normalized broker.presentation.kind, or flat-fallback from broker.tuiWindow.
        COALESCE(
          json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.presentation.kind'),
          CASE
            WHEN json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.tuiWindow')
              IS NOT NULL THEN 'tmux-tui'
            ELSE 'none'
          END,
          ''
        ),
        COALESCE(
          json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.substrate.kind'),
          CASE
            WHEN json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.brokerWindow')
              IS NOT NULL THEN 'leased-tmux'
            ELSE 'daemon-child'
          END,
          ''
        );
    `,
  ])
  const [
    resolvedRuntime,
    runtimeStatus,
    transport,
    controllerKind,
    activeRunId,
    turnStatus,
    runId,
    lastEventUtc,
    lastEventLocal,
    lastEventKind,
    presentationKind,
    substrateKind,
  ] = output.trimEnd().split('\t')

  return {
    ...pane,
    agent,
    scopeRef,
    runtimeId: resolvedRuntime || runtimeId,
    runtimeStatus: runtimeStatus || 'unknown',
    transport: transport || '',
    controllerKind: controllerKind || '',
    activeRunId: activeRunId || '',
    turnStatus: turnStatus || 'none',
    runId: runId || '',
    lastEventUtc: lastEventUtc || '',
    lastEventLocal: lastEventLocal || '',
    lastEventKind: lastEventKind || '',
    // '' here means json_extract returned NULL (no parseable broker hosting
    // state) — skipReasons() treats that as malformed, distinct from `undefined`
    // (legacy metadata path with no hosting-state column at all).
    presentationKind: presentationKind ?? '',
    substrateKind: substrateKind ?? '',
  }
}

function capturePane(pane: Pane, options: Options): string {
  if (options.simulate) {
    return `[server exited]

session summary
  driver    claude-code-tmux    exit   /quit (prompt_input_exit)

Press enter to exit`
  }
  return tryRun(['ghostmux', 'capture-pane', '-t', pane.id])
}

type ReapResult =
  | { kind: 'sent' }
  | { kind: 'dry-run' }
  | { kind: 'already-terminated'; message: string }
  | { kind: 'timed-out'; seconds: number }
  | { kind: 'error'; message: string }

// A reap whose target runtime is already gone (terminated/pruned between the
// status snapshot and the terminate call) is benign — the desired end state is
// already true. Recognize it so the loop logs a warning instead of aborting.
function isAlreadyTerminatedError(message: string): boolean {
  return /runtime_unavailable|is terminated|already terminated|not found/i.test(message)
}

// Broker-backed operator reap (T-04423): instead of typing `/quit` into the
// live TUI prompt (timing-fragile keystroke injection), tear the broker-tmux
// runtime down deterministically over the broker RPC channel via the existing
// `hrc runtime terminate`. `--no-drop-continuation` preserves the session so the
// next turn resumes; `--reason operator_reap --source` stamps durable operator
// intent + attribution onto the `runtime.terminated` audit event.
//
// Returns a result instead of throwing: one runtime that fails to reap (already
// terminated, transient RPC error, etc.) must NOT abort the whole sweep — the
// caller warns and continues to the remaining eligible panes.
function sendReap(status: PaneStatus, options: Options): ReapResult {
  const argv = [
    'hrc',
    'runtime',
    'terminate',
    status.runtimeId,
    '--no-drop-continuation',
    '--reason',
    'operator_reap',
    '--source',
    'close-headless-ghostmux',
  ]
  if (options.dryRun) {
    console.log(color.dim(`  dry-run: ${argv.join(' ')}`))
    return { kind: 'dry-run' }
  }
  // Bounded exec (NOT the shared `run()` helper, which is unbounded): a wedged
  // broker never acks the dispose RPC, and neither `hrc` nor its SDK fetch has a
  // timeout, so an unbounded spawnSync here freezes the entire sequential sweep.
  // On timeout, SIGTERM the hung `hrc` child and treat it as a benign warn — the
  // runtime stays `ready` with continuation intact, and the sweep moves on.
  const proc = Bun.spawnSync(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.reapTimeoutMs > 0 ? { timeout: options.reapTimeoutMs, killSignal: 'SIGTERM' } : {}),
  })
  return classifyReapExec(
    {
      exitedDueToTimeout: proc.exitedDueToTimeout,
      exitCode: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    },
    argv,
    options.reapTimeoutMs
  )
}

type ReapExecOutcome = {
  exitedDueToTimeout?: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

// Pure classifier for a terminate exec result (unit-testable without spawning):
// a timeout (wedged broker, SIGTERM'd at the ceiling) is a benign warn so the
// sweep continues; exit 0 is success; a non-zero exit is already-terminated
// (benign) or a genuine error.
function classifyReapExec(outcome: ReapExecOutcome, argv: string[], timeoutMs: number): ReapResult {
  if (outcome.exitedDueToTimeout) {
    return { kind: 'timed-out', seconds: Math.round(timeoutMs / 1000) }
  }
  if (outcome.exitCode === 0) return { kind: 'sent' }
  const message = `${argv.join(' ')} failed (${outcome.exitCode}): ${
    outcome.stderr || outcome.stdout
  }`
  return isAlreadyTerminatedError(message)
    ? { kind: 'already-terminated', message }
    : { kind: 'error', message }
}

function sendEnter(pane: Pane, options: Options): void {
  if (options.dryRun) {
    console.log(color.dim(`  dry-run: ghostmux send-key -t ${pane.id} Enter`))
    return
  }
  run(['ghostmux', 'send-key', '-t', pane.id, 'Enter'])
}

function printStatus(statuses: PaneStatus[], options: Options): void {
  console.log(color.bold('HRC Headless Ghostty Cleanup'))
  const titleNote = options.titleRegex ? `  title=${options.titleRegex}` : ''
  const reapTimeoutNote =
    options.reapTimeoutMs > 0 ? `${Math.round(options.reapTimeoutMs / 1000)}s` : 'off'
  console.log(
    color.dim(
      `role=${options.paneRole}${titleNote}  wait=${options.waitSeconds}s  reap-timeout=${reapTimeoutNote}  db=${options.hrcDbPath}`
    )
  )
  if (options.dryRun) console.log(color.yellow('Mode: dry run, no keys will be sent'))
  console.log()

  if (statuses.length === 0) {
    console.log(color.dim('No matching panes.'))
    return
  }

  console.log(color.bold(`Matched panes (${statuses.length})`))
  statuses.forEach((status, index) => {
    const duration = formatDurationAgo(status.lastEventUtc)
    const reasons = skipReasons(status)
    const heading = [
      color.dim(`${String(index + 1).padStart(2)}.`),
      color.cyan(status.id),
      color.bold(projectHandleFromScope(status.scopeRef)),
      statusColor(status.runtimeStatus),
      color.dim('/'),
      statusColor(status.turnStatus),
      color.bold(color.cyan(duration)),
      reasons.length === 0 ? color.green('eligible') : color.yellow('skipped'),
    ].join(' ')

    console.log(heading)
    console.log(`    ${color.dim('scope')}      ${color.dim(handleFromScope(status.scopeRef))}`)
    console.log(
      `    ${color.dim('run')}        ${color.dim(shortRun(status.runId))} ${color.dim(
        shortRuntime(status.runtimeId)
      )}`
    )
    console.log(`    ${color.dim('last event')} ${eventKindColor(status.lastEventKind)}`)
    console.log(`    ${color.dim('title')}      ${color.dim(status.title)}`)
    // Explain exactly why a skipped pane is ineligible — one line per failed
    // guard, so the operator never has to reverse-engineer the predicate.
    reasons.forEach((reason, reasonIndex) => {
      const label = reasonIndex === 0 ? 'skipped' : ''
      console.log(`    ${color.yellow(label.padEnd(10))} ${color.yellow(reason)}`)
    })
  })
}

async function confirm(
  eligibleStatuses: PaneStatus[],
  leftoverStatuses: PaneStatus[],
  options: Options
): Promise<void> {
  if (eligibleStatuses.length === 0 && leftoverStatuses.length === 0) return
  if (options.dryRun) {
    console.log()
    console.log(color.dim('Confirmation skipped for dry-run.'))
    return
  }
  if (options.assumeYes) {
    console.log()
    console.log(color.dim('Confirmation skipped: --yes supplied.'))
    return
  }
  if (!process.stdin.isTTY) {
    throw Object.assign(
      new Error('confirmation required, but stdin is not a TTY; rerun with --yes to confirm'),
      { exitCode: 3 }
    )
  }

  // Word the prompt for exactly the work pending: reaping live runtimes,
  // closing already-dead leftover viewer panes, or both.
  const actions: string[] = []
  if (eligibleStatuses.length > 0) {
    actions.push(`reap ${eligibleStatuses.length} runtime(s) via hrc runtime terminate`)
  }
  if (leftoverStatuses.length > 0) {
    actions.push(`close ${leftoverStatuses.length} leftover viewer pane(s)`)
  }

  console.log()
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (
    await readline.question(
      color.yellow(`${capitalize(actions.join(' and '))}? Press Enter to continue: `)
    )
  ).trim()
  readline.close()
  if (answer !== '') {
    throw Object.assign(new Error('aborted before reaping'), { exitCode: 130 })
  }
  console.log(color.green('Confirmation accepted.'))
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

function printRemaining(options: Options): void {
  const remaining = listPanes(options)
  console.log()
  console.log(color.bold('Remaining panes'))
  if (remaining.length === 0) {
    console.log(`  ${color.green('none')}`)
  } else {
    for (const pane of remaining) {
      console.log(`  ${color.cyan(pane.id)} ${pane.title}`)
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options.simulate) {
    requireCommand('ghostmux')
    requireCommand('sqlite3')
    requireCommand('hrc')
  }

  const panes = listPanes(options)
  const statuses = panes.map((pane) => queryStatus(pane, options))
  const eligibleStatuses = statuses.filter(isQuitEligible)
  // Already-dead viewer panes: no live runtime to reap, but still parked on the
  // harness close prompt — close their Ghostty terminals in the same sweep.
  const leftoverStatuses = statuses.filter(isLeftoverViewer)
  // The close-prompt phase Enters BOTH the runtimes we just reaped and the
  // already-dead leftover viewers.
  const closeTargets = [...eligibleStatuses, ...leftoverStatuses]
  printStatus(statuses, options)
  if (statuses.length > 0) {
    const skipped = statuses.length - eligibleStatuses.length
    console.log()
    console.log(
      color.dim(
        `Reap eligibility: ${eligibleStatuses.length} eligible, ${skipped} skipped (requires controllerKind=harness-broker, a tmux TUI window (transport=tmux OR headless+leased-tmux+presentation=tmux-tui), runtime=ready, no active run, latest turn=completed).`
      )
    )
    if (leftoverStatuses.length > 0) {
      console.log(
        color.dim(
          `Leftover viewers: ${leftoverStatuses.length} already-terminated pane(s) will be closed if parked on the exit prompt.`
        )
      )
    }
  }
  await confirm(eligibleStatuses, leftoverStatuses, options)

  if (closeTargets.length === 0) {
    console.log(color.yellow('No eligible runtimes and no leftover viewers; nothing to do.'))
    printRemaining(options)
    return
  }

  if (eligibleStatuses.length === 0) {
    console.log()
    console.log(color.dim('No runtimes to reap; closing leftover viewer panes only.'))
  }

  if (eligibleStatuses.length > 0) {
    console.log()
    console.log(color.bold('Reaping (hrc runtime terminate --reason operator_reap)'))
    // A failure on any single runtime warns and continues — never aborts the
    // sweep, so the remaining eligible panes still get reaped and the
    // close-prompt phase still runs.
    let reapSent = 0
    let reapWarned = 0
    for (const status of eligibleStatuses) {
      const result = sendReap(status, options)
      const suffix = `${color.dim(status.agent)} ${color.dim(shortRuntime(status.runtimeId))}`
      if (result.kind === 'already-terminated') {
        reapWarned += 1
        console.log(`  ${color.cyan(status.id)} ${color.yellow('already terminated')} ${suffix}`)
      } else if (result.kind === 'timed-out') {
        reapWarned += 1
        console.log(
          `  ${color.cyan(status.id)} ${color.yellow(
            `reap timed out after ${result.seconds}s`
          )} ${suffix}`
        )
        console.log(
          `    ${color.dim(
            'broker likely wedged — left ready, continuation intact; investigate or retry'
          )}`
        )
      } else if (result.kind === 'error') {
        reapWarned += 1
        console.log(`  ${color.cyan(status.id)} ${color.red('reap failed')} ${suffix}`)
        console.log(`    ${color.red(result.message)}`)
      } else {
        reapSent += 1
        console.log(`  ${color.cyan(status.id)} ${color.green('reap sent')} ${suffix}`)
      }
    }
    if (reapWarned > 0) {
      console.log(color.dim(`Reap summary: sent=${reapSent}, warned=${reapWarned}`))
    }

    console.log()
    console.log(color.dim(`Waiting ${options.waitSeconds}s before close-prompt validation...`))
    await sleep(options.waitSeconds)
  }

  console.log()
  console.log(color.bold('Closing viewer summaries'))
  const closePrompt = new RegExp(options.closePromptRegex)
  let closed = 0
  let skipped = 0
  for (const status of closeTargets) {
    const capture = capturePane(status, options)
    if (closePrompt.test(capture)) {
      console.log()
      console.log(color.bold(`Final pane contents: ${status.id}`))
      console.log(color.dim('─'.repeat(72)))
      process.stdout.write(capture.endsWith('\n') ? capture : `${capture}\n`)
      console.log(color.dim('─'.repeat(72)))
      sendEnter(status, options)
      closed += 1
      console.log(`  ${color.cyan(status.id)} ${color.green('enter sent')}`)
    } else {
      skipped += 1
      console.log(
        `  ${color.cyan(status.id)} ${color.yellow('skipped')} ${color.dim('no close prompt')}`
      )
    }
  }
  console.log(color.dim(`Summary: enter sent=${closed}, skipped=${skipped}`))

  printRemaining(options)
}

// Only run as a CLI; guarded so importing the module for unit tests
// (e.g. the `isQuitEligible` predicate fixture) does not execute the reaper.
if (import.meta.main) {
  main().catch((error) => {
    console.error(color.red(error instanceof Error ? error.message : String(error)))
    process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1)
  })
}

export {
  HEADLESS_PANE_ROLE,
  classifyReapExec,
  isAlreadyTerminatedError,
  isLeftoverViewer,
  isQuitEligible,
  selectHeadlessPanes,
  skipReasons,
}
export type { DiscoveredPane, PaneStatus }
