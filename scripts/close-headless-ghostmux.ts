#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { Chalk } from 'chalk'

type Options = {
  dryRun: boolean
  simulate: boolean
  assumeYes: boolean
  titleRegex: string
  closePromptRegex: string
  waitSeconds: number
  hrcDbPath: string
}

type Pane = {
  id: string
  title: string
}

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
}

const color = new Chalk({
  level: process.env.NO_COLOR ? 0 : process.stdout.isTTY || process.env.FORCE_COLOR ? 1 : 0,
})

function usage(): never {
  console.log(`Usage:
  scripts/close-headless-ghostmux.sh [--dry-run] [--simulate] [--yes]
  bun scripts/close-headless-ghostmux.ts [--dry-run] [--simulate] [--yes]

Find Ghostty panes whose titles match TITLE_REGEX, print HRC status, ask for
confirmation, then reap each eligible broker-tmux runtime over the broker RPC
channel via 'hrc runtime terminate --no-drop-continuation --reason operator_reap'
(continuation preserved), wait, and send Enter only to panes whose captured
contents match CLOSE_PROMPT_REGEX.

Eligible = surface resolves to one runtime with controllerKind=harness-broker,
transport=tmux, status=ready, NO active run, latest turn=completed.

Environment:
  TITLE_REGEX          Default: ^hrc headless agent:
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
    titleRegex: process.env.TITLE_REGEX ?? '^hrc headless agent:',
    closePromptRegex: process.env.CLOSE_PROMPT_REGEX ?? 'Press (enter to exit|any key to close)',
    waitSeconds: Number(process.env.WAIT_SECONDS ?? '10'),
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
function isQuitEligible(status: PaneStatus): boolean {
  return (
    status.runtimeId !== '' &&
    status.controllerKind === 'harness-broker' &&
    status.transport === 'tmux' &&
    status.runtimeStatus === 'ready' &&
    status.activeRunId === '' &&
    status.turnStatus === 'completed'
  )
}

function simPanes(): Pane[] {
  return [
    {
      id: '7BF21FAF',
      title: 'hrc headless agent:smokey:project:agent-control-plane:task:T-02864',
    },
    {
      id: 'EB834507',
      title: 'hrc headless agent:curly:project:agent-control-plane:task:T-02864',
    },
  ]
}

function listPanes(options: Options): Pane[] {
  if (options.simulate) return simPanes()
  const parsed = JSON.parse(run(['ghostmux', 'list-surfaces', '--json'])) as {
    terminals?: Array<{ short_id?: string; id?: string; title?: string }>
  }
  const re = new RegExp(options.titleRegex)
  return (parsed.terminals ?? [])
    .filter((terminal) => re.test(terminal.title ?? ''))
    .map((terminal) => ({
      id: terminal.short_id ?? terminal.id ?? '',
      title: terminal.title ?? '',
    }))
    .filter((pane) => pane.id.length > 0)
}

function metadataForPane(pane: Pane, options: Options): Record<string, unknown> {
  if (options.simulate) {
    const runtimeId = pane.id === '7BF21FAF' ? 'rt-smokey-sim' : 'rt-curly-sim'
    return {
      hrc_role: 'hrc-headless-viewer',
      hrc_runtime_id: runtimeId,
      hrc_scope_ref: scopeFromTitle(pane.title),
    }
  }

  const raw = tryRun(['ghostmux', 'metadata', 'get', '-t', pane.id, '--resolved', '--json'])
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as { data?: Record<string, unknown> } | Record<string, unknown>
  return 'data' in parsed && isRecord(parsed.data)
    ? parsed.data
    : (parsed as Record<string, unknown>)
}

function queryStatus(pane: Pane, options: Options): PaneStatus {
  const metadata = metadataForPane(pane, options)
  const scopeRef =
    typeof metadata.hrc_scope_ref === 'string' ? metadata.hrc_scope_ref : scopeFromTitle(pane.title)
  const runtimeId = typeof metadata.hrc_runtime_id === 'string' ? metadata.hrc_runtime_id : ''
  const agent = agentFromScope(scopeRef)

  if (options.simulate) {
    return {
      ...pane,
      agent,
      scopeRef,
      runtimeId,
      runtimeStatus: 'ready',
      transport: 'tmux',
      controllerKind: 'harness-broker',
      activeRunId: '',
      turnStatus: 'completed',
      runId: `run-sim-${pane.id}`,
      lastEventUtc: '2026-06-09T14:00:00.000Z',
      lastEventLocal: '2026-06-09 09:00:00',
      lastEventKind: 'turn.completed',
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
        SELECT runtime_id, status, active_run_id, transport, controller_kind, updated_at
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
        COALESCE((SELECT event_kind FROM latest_event), '');
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

// Broker-backed operator reap (T-04423): instead of typing `/quit` into the
// live TUI prompt (timing-fragile keystroke injection), tear the broker-tmux
// runtime down deterministically over the broker RPC channel via the existing
// `hrc runtime terminate`. `--no-drop-continuation` preserves the session so the
// next turn resumes; `--reason operator_reap --source` stamps durable operator
// intent + attribution onto the `runtime.terminated` audit event.
function sendReap(status: PaneStatus, options: Options): void {
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
    return
  }
  run(argv)
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
  console.log(
    color.dim(`title=${options.titleRegex}  wait=${options.waitSeconds}s  db=${options.hrcDbPath}`)
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
    const heading = [
      color.dim(`${String(index + 1).padStart(2)}.`),
      color.cyan(status.id),
      color.bold(projectHandleFromScope(status.scopeRef)),
      statusColor(status.runtimeStatus),
      color.dim('/'),
      statusColor(status.turnStatus),
      color.bold(color.cyan(duration)),
      isQuitEligible(status) ? color.green('eligible') : color.yellow('skipped'),
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
  })
}

async function confirm(eligibleStatuses: PaneStatus[], options: Options): Promise<void> {
  if (eligibleStatuses.length === 0) return
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

  console.log()
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (
    await readline.question(
      color.yellow(
        `Reap ${eligibleStatuses.length} eligible runtime(s) via hrc runtime terminate? Press Enter to continue: `
      )
    )
  ).trim()
  readline.close()
  if (answer !== '') {
    throw Object.assign(new Error('aborted before reaping'), { exitCode: 130 })
  }
  console.log(color.green('Confirmation accepted.'))
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
  printStatus(statuses, options)
  if (statuses.length > 0) {
    const skipped = statuses.length - eligibleStatuses.length
    console.log()
    console.log(
      color.dim(
        `Reap eligibility: ${eligibleStatuses.length} eligible, ${skipped} skipped (requires controllerKind=harness-broker, transport=tmux, runtime=ready, no active run, latest turn=completed).`
      )
    )
  }
  await confirm(eligibleStatuses, options)

  if (eligibleStatuses.length === 0) {
    console.log(color.yellow('No eligible panes; reap not sent.'))
    printRemaining(options)
    return
  }

  console.log()
  console.log(color.bold('Reaping (hrc runtime terminate --reason operator_reap)'))
  for (const status of eligibleStatuses) {
    sendReap(status, options)
    console.log(
      `  ${color.cyan(status.id)} ${color.green('reap sent')} ${color.dim(status.agent)} ${color.dim(
        shortRuntime(status.runtimeId)
      )}`
    )
  }

  console.log()
  console.log(color.dim(`Waiting ${options.waitSeconds}s before close-prompt validation...`))
  await sleep(options.waitSeconds)

  console.log()
  console.log(color.bold('Closing viewer summaries'))
  const closePrompt = new RegExp(options.closePromptRegex)
  let closed = 0
  let skipped = 0
  for (const status of eligibleStatuses) {
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

export { isQuitEligible }
export type { PaneStatus }
