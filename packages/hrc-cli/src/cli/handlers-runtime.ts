import type {
  BrokerInspectResponse,
  InspectRuntimeResponse,
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
} from 'hrc-core'
import { parseSelector } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { printJson } from '../print.js'
import {
  type ResolvedTarget,
  SelectorResolutionError,
  type SelectorSnapshot,
  type SelectorTargetKind,
  fetchSelectorSnapshot,
  resolveRuntimeArg,
  resolveSelectorTarget,
} from '../selector-resolve.js'
import { hasFlag, parseFlag, parseTransportFlag, splitCsv } from './argv.js'
import { requireArg } from './argv.js'
import { printHrcDomainErrorBody } from './errors.js'
import { cmdSessionList } from './handlers-server.js'
import { createClient, fatal } from './shared.js'

export async function cmdRuntimeList(args: string[]): Promise<void> {
  const hostSessionIdFlag = parseFlag(args, '--host-session-id')
  const sessionFlag = parseFlag(args, '--session')
  if (hostSessionIdFlag && sessionFlag && hostSessionIdFlag !== sessionFlag) {
    fatal('--session and --host-session-id must name the same host session when used together')
  }
  const hostSessionId = sessionFlag ?? hostSessionIdFlag
  const transport = parseTransportFlag(args)
  const status = parseFlag(args, '--status')
  const olderThan = parseFlag(args, '--older-than')
  const scopeInput = parseFlag(args, '--scope')
  const scope = scopeInput ? canonicalScopeFilter(scopeInput) : undefined
  const agent = parseFlag(args, '--agent')
  const task = parseFlag(args, '--task')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()
  const runtimes = await client.listRuntimes({
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(transport ? { transport } : {}),
    ...(status ? { status: splitCsv(status) } : {}),
    ...(hasFlag(args, '--stale') ? { stale: true } : {}),
    ...(olderThan ? { olderThan } : {}),
    ...(scope ? { scope } : {}),
    ...(agent ? { agent } : {}),
    ...(task ? { task } : {}),
    ...(jsonOutput ? { json: true } : {}),
  })
  printJson(runtimes)
}

function canonicalScopeFilter(raw: string): string {
  const selector = parseSelector(raw.startsWith('agent:') ? `scope:${raw}` : raw)
  switch (selector.kind) {
    case 'scope':
    case 'session':
    case 'target':
      return selector.scopeRef
    default:
      fatal(`--scope requires a scope ref or target handle, not a ${selector.kind} selector`)
  }
}

export async function cmdRuntimeInspect(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.inspectRuntime({ runtimeId })

  if (jsonOutput) {
    printJson(result)
    return
  }

  printRuntimeInspect(result)
}

export function printRuntimeInspect(runtime: InspectRuntimeResponse): void {
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

export async function cmdBrokerInspect(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const jsonOutput = hasFlag(args, '--json')
  const probe = hasFlag(args, '--probe')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const result = await client.brokerInspect({
    runtimeId,
    ...(probe ? { probeLiveness: true } : {}),
  })

  if (jsonOutput) {
    printJson(result)
    return
  }

  printBrokerInspect(result)
}

function printBrokerInspect(result: BrokerInspectResponse): void {
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

function formatAgeSec(totalSec: number): string {
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
function resolveMutationGate(
  args: string[],
  noun: string
): { dryRunFlag: boolean; yes: boolean; jsonOutput: boolean; dryRun: boolean } {
  const dryRunFlag = hasFlag(args, '--dry-run')
  const yes = hasFlag(args, '--yes')
  const jsonOutput = hasFlag(args, '--json')
  if (!dryRunFlag && !yes && !process.stdout.isTTY) {
    fatal(`${noun} requires --yes to mutate when stdout is not a TTY`)
  }
  return {
    dryRunFlag,
    yes,
    jsonOutput,
    dryRun: dryRunFlag || (!yes && Boolean(process.stdout.isTTY)),
  }
}

export async function cmdRuntimeSweep(args: string[]): Promise<void> {
  const transport = parseTransportFlag(args)

  const { dryRunFlag, yes, jsonOutput, dryRun } = resolveMutationGate(args, 'runtime sweep')
  if (transport === 'tmux' && !yes && !dryRunFlag) {
    fatal('runtime sweep --transport tmux requires --yes')
  }

  const statusRaw = parseFlag(args, '--status')
  const scope = parseFlag(args, '--scope')
  const request: SweepRuntimesRequest = {
    ...(transport ? { transport } : {}),
    olderThan: parseFlag(args, '--older-than') ?? '24h',
    ...(statusRaw ? { status: splitCsv(statusRaw) } : {}),
    ...(scope ? { scope } : {}),
    ...(hasFlag(args, '--drop-continuation') ? { dropContinuation: true } : {}),
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.sweepRuntimes(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printSweepHuman(result, request.dryRun === true)
}

/**
 * Emit a `{ results, summary }` mutation result as NDJSON: one line per result
 * row followed by a final summary line. Shared by the runtime-sweep,
 * zombie-sweep, and active-reconcile commands (the per-command Human formatters
 * remain distinct).
 */
function printResultsNdjson(result: { results: readonly unknown[]; summary: unknown }): void {
  for (const row of result.results) {
    process.stdout.write(`${JSON.stringify(row)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result.summary)}\n`)
}

function printSweepHuman(result: SweepRuntimesResponse, dryRun: boolean): void {
  process.stdout.write(`runtime sweep${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(10)} ${row.runtimeId} ${row.transport} dropContinuation=${
        row.droppedContinuation
      }${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} stale=${result.summary.stale} terminated=${result.summary.terminated} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

/**
 * Record-level GC for orphaned runtime store rows (T-05441). Distinct from
 * `runtime sweep` (which terminates live processes/tmux): prune DELETES the
 * store row for genuinely orphaned records. Dry-run by default; mutation
 * requires `--yes`, mirroring the sweep mutation gate.
 */
export async function cmdRuntimePrune(args: string[]): Promise<void> {
  const transport = parseTransportFlag(args)

  const { dryRunFlag, yes, jsonOutput, dryRun } = resolveMutationGate(args, 'runtime prune')
  if (!yes && !dryRunFlag) {
    fatal('runtime prune requires --yes to delete records (use --dry-run to preview)')
  }

  const statusRaw = parseFlag(args, '--status')
  const scope = parseFlag(args, '--scope')
  const request: PruneRuntimesRequest = {
    ...(transport ? { transport } : {}),
    olderThan: parseFlag(args, '--older-than') ?? '24h',
    ...(statusRaw ? { status: splitCsv(statusRaw) } : {}),
    ...(scope ? { scope } : {}),
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.pruneRuntimes(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printPruneHuman(result, request.dryRun === true)
}

function printPruneHuman(result: PruneRuntimesResponse, dryRun: boolean): void {
  process.stdout.write(`runtime prune${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const detail = row.errorMessage ?? row.reason
    const suffix = detail ? ` ${detail}` : ''
    process.stdout.write(`  ${row.status.padEnd(8)} ${row.runtimeId} ${row.transport}${suffix}\n`)
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} pruned=${result.summary.pruned} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

/**
 * Emit the deprecation guidance for the legacy `hrc run sweep-zombies` /
 * `hrc run reconcile-active` aliases. daedalus D3: keep these functional (no
 * failing pointer) but point operators at the new `hrc admin runs ...`
 * namespace via stderr so existing automation keeps working byte-for-byte on
 * stdout.
 */
function emitRunAdminDeprecation(verb: 'sweep-zombies' | 'reconcile-active'): void {
  process.stderr.write(
    `hrc: 'hrc run ${verb}' is deprecated; use 'hrc admin runs ${verb}' instead\n`
  )
}

export async function cmdRunSweepZombies(
  args: string[],
  opts: { deprecatedAlias?: boolean } = {}
): Promise<void> {
  if (opts.deprecatedAlias) {
    emitRunAdminDeprecation('sweep-zombies')
  }
  const { yes, jsonOutput, dryRun } = resolveMutationGate(args, 'run sweep-zombies')

  const request: SweepZombieRunsRequest = {
    olderThan: parseFlag(args, '--older-than') ?? '30m',
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.sweepZombieRuns(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printZombieSweepHuman(result, request.dryRun === true)
}

function printZombieSweepHuman(result: SweepZombieRunsResponse, dryRun: boolean): void {
  process.stdout.write(`run zombie sweep${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(8)} ${row.runId} observed=${row.observedAt} source=${
        row.observedSource
      } ownershipCleared=${row.runtimeOwnershipCleared}${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} zombied=${result.summary.zombied} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

export async function cmdRunReconcileActive(
  args: string[],
  opts: { deprecatedAlias?: boolean } = {}
): Promise<void> {
  if (opts.deprecatedAlias) {
    emitRunAdminDeprecation('reconcile-active')
  }
  const { yes, jsonOutput, dryRun } = resolveMutationGate(args, 'run reconcile-active')

  const request: ReconcileActiveRunsRequest = {
    olderThan: parseFlag(args, '--older-than') ?? '30m',
    dryRun,
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.reconcileActiveRuns(request)
  if (jsonOutput) {
    printResultsNdjson(result)
    return
  }

  printReconcileActiveHuman(result, request.dryRun === true)
}

function printReconcileActiveHuman(result: ReconcileActiveRunsResponse, dryRun: boolean): void {
  process.stdout.write(`run active reconcile${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(8)} ${row.runId} ${row.transport} runtime=${
        row.runtimeStatus
      } reason=${row.reason} ownershipCleared=${row.runtimeOwnershipCleared}${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} reaped=${result.summary.reaped} suspect=${result.summary.suspect} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
}

export async function cmdLaunchList(args: string[]): Promise<void> {
  const hostSessionId = parseFlag(args, '--host-session-id')
  const runtimeId = parseFlag(args, '--runtime-id')
  const client = createClient()
  const launches = await client.listLaunches({
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(runtimeId ? { runtimeId } : {}),
  })
  printJson(launches)
}

// ── hrc show / hrc ls (T-04219 P2 — context-aware viewer + noun lister) ───────

/**
 * Resolve a `hrc show` selector to a concrete target by trying each accepted
 * kind in priority order. daedalus INVARIANT: for an ambiguous raw ID, runtime
 * wins, then host-session; explicit prefixes (`runtime:`, `host:`, `msg:`,
 * `seq:`) are honored directly. A `type-mismatch` from one kind means "try the
 * next kind"; any other resolution failure (ambiguous, parse-error) is fatal so
 * we never silently pick the wrong object.
 */
function resolveShowTarget(rawArg: string, snapshot: SelectorSnapshot): ResolvedTarget {
  const order: SelectorTargetKind[] = ['runtime', 'host-session', 'message']
  let lastTypeMismatch: SelectorResolutionError | undefined
  for (const expect of order) {
    try {
      return resolveSelectorTarget(rawArg, { expect, snapshot })
    } catch (err) {
      if (err instanceof SelectorResolutionError && err.code === 'type-mismatch') {
        lastTypeMismatch = err
        continue
      }
      throw err
    }
  }
  throw (
    lastTypeMismatch ??
    new SelectorResolutionError('not-found', `selector "${rawArg}" did not resolve to any target`)
  )
}

async function renderShowMessage(
  client: HrcClient,
  target: { kind: 'message'; messageId: string } | { kind: 'message-seq'; seq: number },
  jsonOutput: boolean
): Promise<void> {
  const { messages } = await client.listMessages({})
  const record =
    target.kind === 'message'
      ? messages.find((m) => m.messageId === target.messageId)
      : messages.find((m) => m.messageSeq === target.seq)

  if (!record) {
    const ref = target.kind === 'message' ? target.messageId : `seq:${target.seq}`
    fatal(`no message found for ${ref}`)
  }

  if (jsonOutput) {
    // Spread first, then pin the stable show contract: kind='message' + the
    // concrete identifiers. The record's own `kind` (dm|literal|system) is
    // preserved as `messageKind` so it isn't lost to the overlay.
    printJson({
      ...record,
      messageKind: record.kind,
      kind: 'message',
      messageId: record.messageId,
      seq: record.messageSeq,
    })
    return
  }

  const lines = [
    `message ${record.messageId}`,
    '  kind          message',
    `  seq           ${record.messageSeq}`,
    `  messageKind   ${record.kind}`,
    `  phase         ${record.phase}`,
    `  createdAt     ${record.createdAt}`,
    `  body          ${record.body}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

export async function cmdShow(args: string[]): Promise<void> {
  const selectorArg = requireArg(args, 0, '<selector>')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()

  const snapshot = await fetchSelectorSnapshot(client)
  const target = resolveShowTarget(selectorArg, snapshot)

  if (target.kind === 'runtime') {
    const result = await client.inspectRuntime({ runtimeId: target.runtimeId })
    if (jsonOutput) {
      printJson({ ...result, kind: 'runtime', runtimeId: target.runtimeId })
      return
    }
    process.stdout.write('kind: runtime\n')
    printRuntimeInspect(result)
    return
  }

  if (target.kind === 'host-session') {
    const session = await client.getSession(target.hostSessionId)
    if (jsonOutput) {
      printJson({ ...session, kind: 'host-session', hostSessionId: target.hostSessionId })
      return
    }
    process.stdout.write(`kind: host-session\nhostSessionId: ${target.hostSessionId}\n`)
    printJson(session)
    return
  }

  if (target.kind === 'bridge') {
    // resolveShowTarget never expects bridge, so this is unreachable in practice;
    // narrow defensively rather than mis-render.
    fatal(`selector "${selectorArg}" resolved to a bridge, which 'hrc show' does not render`)
  }

  // message / message-seq
  await renderShowMessage(client, target, jsonOutput)
}

const LS_NOUNS = ['runtimes', 'sessions', 'launches', 'messages'] as const

export async function cmdLs(noun: string | undefined, rest: string[]): Promise<void> {
  if (noun === undefined) {
    fatal(`ls requires a noun: ${LS_NOUNS.join(' | ')}`)
  }
  switch (noun) {
    case 'runtimes':
      await cmdRuntimeList(rest)
      return
    case 'sessions':
      await cmdSessionList(rest)
      return
    case 'launches':
      await cmdLaunchList(rest)
      return
    case 'messages': {
      const client = createClient()
      const { messages } = await client.listMessages({})
      printJson(messages)
      return
    }
    default:
      fatal(`unknown ls noun "${noun}"; accepted: ${LS_NOUNS.join(' | ')}`)
  }
}

export async function cmdAdopt(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  try {
    const runtimeId = await resolveRuntimeArg(runtimeArg, client)
    const result = await client.adoptRuntime(runtimeId)
    printJson(result)
  } catch (err) {
    if (printHrcDomainErrorBody(err)) {
      return
    }
    throw err
  }
}
