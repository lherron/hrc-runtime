import type {
  FederationRuntimeProjectionReport,
  GetFirstTurnDiagnosticsResponse,
  InspectRuntimeResponse,
  ListFirstTurnDiagnosticsResponse,
} from 'hrc-core'
import { parseSelector } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import type { CaptureStateView } from 'spaces-harness-broker-protocol'

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
import {
  formatAgeSec,
  formatCaptureState,
  printBrokerInspect,
  printRuntimeInspect,
} from './handlers-runtime-inspect.js'
import { cmdSessionList } from './handlers-server.js'
import { createClient, fatal } from './shared.js'

export { formatCaptureState, printBrokerInspect, printRuntimeInspect }
export {
  cmdRunReconcileActive,
  cmdRunRecoverUnstarted,
  cmdRunSweepZombies,
  cmdRuntimePrune,
  cmdRuntimeSweep,
} from './handlers-runtime-sweep.js'

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
  const filter = {
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(transport ? { transport } : {}),
    ...(status ? { status: splitCsv(status) } : {}),
    ...(hasFlag(args, '--stale') ? { stale: true } : {}),
    ...(olderThan ? { olderThan } : {}),
    ...(scope ? { scope } : {}),
    ...(agent ? { agent } : {}),
    ...(task ? { task } : {}),
    ...(jsonOutput ? { json: true } : {}),
    ...(hasFlag(args, '--all') ? { all: true } : {}),
  }
  if (hasFlag(args, '--all-nodes')) {
    const report = await client.listFederatedRuntimes(filter)
    if (jsonOutput) printJson(report)
    else process.stdout.write(formatFederatedRuntimes(report))
    return
  }
  const runtimes = await client.listRuntimes(filter)
  const body = `${JSON.stringify(
    runtimes.map((runtime) => ({
      ...runtime,
      statusChangedAt: runtime.statusChangedAt ?? 'unknown',
    })),
    null,
    2
  )}\n`
  process.stdout.write(body)
  if (runtimes.length > 100) {
    process.stderr.write(
      `hrc: runtime list returned ${runtimes.length} runtimes (${Buffer.byteLength(body)} bytes) — narrow with --task/--scope/--agent/--status/--transport/--session\n`
    )
  }
}

function formatFederatedRuntimes(report: FederationRuntimeProjectionReport): string {
  const lines = [
    `runtime projection from ${report.localNodeId} at ${report.generatedAt}: ${report.nodes.length} node(s)`,
  ]
  for (const node of report.nodes) {
    const answer =
      node.answeredAt === undefined
        ? 'never answered'
        : `answered ${node.answeredAt} (${formatAgeSec(
            Math.max(0, (Date.parse(report.generatedAt) - Date.parse(node.answeredAt)) / 1_000)
          )} old)`
    lines.push(
      `node ${node.nodeId}: ${node.state} — checked ${node.checkedAt}, ${answer}, ${node.latencyMs}ms, ${node.runtimes.length} runtime(s)`
    )
    if (node.detail !== undefined) lines.push(`  detail: ${node.detail}`)
    for (const runtime of node.runtimes) {
      lines.push(
        `  ${runtime.runtimeId}  ${runtime.scopeRef}  lane=${runtime.laneRef}  status=${runtime.status}`
      )
    }
  }
  return `${lines.join('\n')}\n`
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
  const probe = hasFlag(args, '--probe')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const [hrc, broker] = await Promise.all([
    client.inspectRuntime({ runtimeId }),
    client.brokerInspect({
      runtimeId,
      ...(probe ? { probeLiveness: true } : {}),
    }),
  ])

  if (jsonOutput) {
    printJson({ hrc, broker })
    return
  }

  process.stdout.write(
    `runtime inspect ${runtimeId}\n\nHRC authority (source: HRC runtime store)\n`
  )
  printRuntimeInspect(hrc)
  process.stdout.write(`\nBroker authority (source: ${broker.source})\n`)
  printBrokerInspect(broker)
}

export async function cmdRuntimeStatus(args: string[]): Promise<void> {
  const runtimeArg = requireArg(args, 0, '<target>')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()
  const runtimeId = await resolveRuntimeArg(runtimeArg, client)
  const runtime = (await client.inspectRuntime({ runtimeId })) as InspectRuntimeResponse & {
    capture?: CaptureStateView | undefined
  }
  if (jsonOutput) {
    printJson({
      runtimeId: runtime.runtimeId,
      status: runtime.status,
      ...(runtime.capture !== undefined ? { capture: runtime.capture } : {}),
    })
    return
  }
  process.stdout.write(
    `runtime ${runtime.runtimeId}: ${runtime.status}\ncapture: ${formatCaptureState(runtime.capture)}\n`
  )
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
async function resolveShowTarget(
  rawArg: string,
  snapshot: SelectorSnapshot
): Promise<ResolvedTarget> {
  const order: SelectorTargetKind[] = ['runtime', 'host-session', 'message']
  let lastTypeMismatch: SelectorResolutionError | undefined
  for (const expect of order) {
    try {
      return await resolveSelectorTarget(rawArg, { expect, snapshot })
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
  const target = await resolveShowTarget(selectorArg, snapshot)

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

const LS_NOUNS = ['runtimes', 'sessions', 'messages'] as const

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

/**
 * `hrc runtime diagnostics [trip-event-id|runtime-selector]` (T-07235).
 *
 * READ-ONLY, and the canonical retrieval path for a `first_turn_missing`
 * bundle: the trip event id is threaded through the durable event, the
 * `hrc runtime list` health detail, and every waiter error, so an operator or
 * an agent reaches the bundle without opening sqlite or knowing the filesystem
 * layout.
 */
export async function cmdRuntimeDiagnostics(args: string[]): Promise<void> {
  const selectorArg = args.find((arg) => !arg.startsWith('-'))
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()

  const tripEventSeq =
    selectorArg !== undefined && /^\d+$/.test(selectorArg)
      ? Number.parseInt(selectorArg, 10)
      : undefined

  if (tripEventSeq !== undefined) {
    const result = (await client.getFirstTurnDiagnostics({
      trip: tripEventSeq,
    })) as GetFirstTurnDiagnosticsResponse
    if (jsonOutput) {
      printJson(result)
      return
    }
    printFirstTurnTripDetail(result)
    return
  }

  const runtimeId =
    selectorArg !== undefined ? await resolveRuntimeArg(selectorArg, client) : undefined
  const result = (await client.getFirstTurnDiagnostics(
    runtimeId !== undefined ? { runtimeId } : {}
  )) as ListFirstTurnDiagnosticsResponse
  if (jsonOutput) {
    printJson(result)
    return
  }
  if (result.trips.length === 0) {
    process.stdout.write(
      `no first_turn_missing trips${runtimeId !== undefined ? ` for ${runtimeId}` : ''}\n`
    )
    return
  }
  process.stdout.write('first_turn_missing trips (newest first)\n')
  for (const trip of result.trips) {
    process.stdout.write(
      `  trip ${trip.tripEventSeq}  ${trip.trippedAt}  ${trip.runtimeId} gen=${trip.generation}  ${trip.scopeRef}  bundle=${trip.bundleAvailable ? 'yes' : 'no'}\n`
    )
  }
  process.stdout.write('\nInspect one: hrc runtime diagnostics <trip-event-id> [--json]\n')
}

function printFirstTurnTripDetail(result: GetFirstTurnDiagnosticsResponse): void {
  const trip = result.trip
  const lines = [
    `first_turn_missing trip ${trip.tripEventSeq}`,
    `  runtime       ${trip.runtimeId}`,
    `  generation    ${trip.generation}`,
    `  scope         ${trip.scopeRef}`,
    `  hostSession   ${trip.hostSessionId}`,
    `  runId         ${trip.runId ?? '(none)'}`,
    `  invocation    ${trip.invocationId ?? '(none)'}`,
    `  dispatchedAt  ${trip.primingDispatchedAt ?? '(unknown)'}`,
    `  deadlineAt    ${trip.firstTurnDeadlineAt ?? '(unknown)'}`,
    `  trippedAt     ${trip.trippedAt}`,
    `  bundleDir     ${trip.bundleDir ?? '(none)'}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)

  if (result.bundle === undefined) {
    // A trip is complete without its bundle; say so rather than implying the
    // detection itself was partial.
    process.stdout.write(`\nbundle unavailable: ${result.bundleError ?? 'unknown'}\n`)
    return
  }

  const bundle = result.bundle
  const shape = bundle.launchShape
  process.stdout.write('\nlaunch shape (prompt-bearing values are hashed by construction)\n')
  if (shape === undefined) {
    process.stdout.write('  (unavailable)\n')
  } else {
    process.stdout.write(`  frontend      ${shape.frontend ?? '(unknown)'}\n`)
    process.stdout.write(`  model         ${shape.model ?? '(unknown)'}\n`)
    process.stdout.write(`  cwd           ${shape.cwd ?? '(unknown)'}\n`)
    process.stdout.write(
      `  continuation  ${shape.continuation}${shape.continuationKey ? ` (${shape.continuationKey})` : ''}\n`
    )
    process.stdout.write(`  argv          ${shape.argv.join(' ')}\n`)
    for (const [key, value] of Object.entries(shape.promptEnv)) {
      process.stdout.write(`  env ${key}  ${value}\n`)
    }
  }

  const versions = bundle.versions
  process.stdout.write('\nversions at trip\n')
  process.stdout.write(`  harness       ${versions?.harnessVersion ?? '(unknown)'}\n`)
  process.stdout.write(`  hrc release   ${versions?.hrcReleaseId ?? '(unknown)'}\n`)
  if (versions?.aspContracts !== undefined) {
    for (const contract of versions.aspContracts) {
      process.stdout.write(`  asp-contract ${contract.name}  ${contract.version}\n`)
    }
  } else {
    process.stdout.write(`  agent-spaces  ${versions?.agentSpacesVersion ?? '(unknown)'}\n`)
  }

  const surfaces = bundle.surfaces
  if (surfaces !== undefined && Object.keys(surfaces).length > 0) {
    process.stdout.write('\nsurfaces\n')
    for (const [key, value] of Object.entries(surfaces)) {
      process.stdout.write(`  ${key.padEnd(16)} ${String(value)}\n`)
    }
  }

  if (Object.keys(bundle.failures).length > 0) {
    process.stdout.write('\nfields that could not be assembled\n')
    for (const [field, reason] of Object.entries(bundle.failures)) {
      process.stdout.write(`  ${field.padEnd(16)} ${reason}\n`)
    }
  }

  process.stdout.write('\npane capture\n')
  if (bundle.paneCapture === undefined) {
    process.stdout.write('  (none)\n')
  } else {
    process.stdout.write(`  capturedAt ${bundle.paneCapture.capturedAt}\n`)
    process.stdout.write(`${bundle.paneCapture.text}\n`)
  }
}
