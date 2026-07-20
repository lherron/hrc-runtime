/**
 * `hrc target locate` and `hrc doctor` (T-06613, federation spec §5 / §10).
 *
 * DOCTOR-SURFACE RULING (recorded here because the code IS the ruling).
 *
 * The AC requires skew be "visible in locate and hrc doctor". `hrc doctor` did
 * not exist — T-06606 recorded that and deferred the question to this task.
 * The choice was between a new `hrc doctor` and bolting skew checks onto the
 * three surfaces that do exist (`hrc info`, `hrc server status`,
 * `hrcchat doctor`). This builds `hrc doctor`, for three reasons:
 *
 *   1. Skew is silent by construction. A pin edited to a new node produces no
 *      error anywhere — not at summon, not in the logs, because the established
 *      home keeps authority and the gate never reads the new value. It is only
 *      ever found by someone LOOKING. That is the definition of a doctor check,
 *      and it is not a status field.
 *   2. `hrc info` and `hrc server status` are the wrong shape. Both are
 *      descriptions of one thing (this CLI; this daemon) with a fixed layout
 *      and a documented exit-code contract. Neither has a place for "N of your
 *      bindings disagree with their pins", and adding a variable-length finding
 *      list to `server status` would change what its exit codes mean.
 *   3. `hrcchat doctor` is target-scoped and messaging-shaped — it answers "can
 *      I DM this target". Placement is an hrc-runtime concern reached through
 *      the same CLI that owns `hrc target locate`, so an operator investigating
 *      placement stays in one tool. It keeps its node-identity check; this does
 *      not replace it.
 *
 * Scoped deliberately small: daemon reachability, node identity, federation
 * config, and the placement-skew sweep. It is a real doctor for the checks that
 * had no home, not a second front-end for everything `server status` prints.
 *
 * EXIT CODES. 0 = all ok. 1 = a fail check. Skew is a WARN, not a fail: a
 * skewed binding is a live, working, correctly-serving scope whose declaration
 * has drifted. Exiting nonzero would make it an outage in every CI that runs
 * the doctor, and §5 is explicit that the established home keeps authority.
 */

import { resolveQualifiedScopeInput } from 'agent-scope'
import type {
  LocateBindingsReport,
  LocateDeclaredPolicy,
  LocateNote,
  LocateSkew,
  ScopeLocation,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

import { printJson } from '../print.js'
import { hasFlag } from './argv.js'
import { CliStatusExit, createClient, fatal } from './shared.js'

function resolveScopeArg(input: string): string {
  try {
    const projectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
    return resolveQualifiedScopeInput(input, {
      ...(projectId === undefined ? {} : { projectId }),
    }).scopeRef
  } catch (error) {
    return fatal(
      `could not resolve "${input}" to a scope: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function describeDeclared(declared: LocateDeclaredPolicy): string {
  switch (declared.source) {
    case 'pin':
      return `pin "${declared.pinKey}" = ${declared.nodeId}`
    case 'pin-invalid':
      return `pin "${declared.pinKey}" = ${declared.rawValue} (INVALID)`
    case 'task-default':
      return `task-default "${declared.taskKey}" = ${declared.nodeId}`
    case 'task-default-invalid':
      return `task-default "${declared.taskKey}" = ${declared.rawValue} (INVALID)`
    case 'default_home_node':
      return `default_home_node = ${declared.nodeId}`
    case 'default_home_node(local)':
      return `default_home_node = "local" -> ${declared.nodeId}`
    case 'none':
      return 'none declared'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'unrecognized'
  }
}

function describeSkewConstraint(skew: LocateSkew): string {
  return skew.kind === 'pin-vs-binding'
    ? `pin "${skew.pinKey}" = ${skew.pinnedNodeId}`
    : `task-default "${skew.taskKey}" = ${skew.taskDefaultNodeId}`
}

function describeAuthority(location: ScopeLocation): string {
  const authority = location.authority
  switch (authority.state) {
    case 'bound': {
      const record = authority.record
      const where = authority.isLocal ? ' (this node)' : ''
      return `${record.homeNodeId}${where}  epoch ${record.placementEpoch}  ${record.birthClass}  established by ${record.establishmentProvenance}`
    }
    case 'unbound':
      return 'unbound (no binding established yet)'
    case 'retired':
      return authority.successorNodeId === null
        ? `retired at epoch ${authority.placementEpoch} (terminal bar)`
        : `retired at epoch ${authority.placementEpoch} -> successor ${authority.successorNodeId}`
    case 'unknown':
      return `UNKNOWN — ${authority.detail}`
    default:
      return 'unrecognized'
  }
}

function formatLocation(location: ScopeLocation): string {
  const lines: string[] = []
  lines.push(`scope:      ${location.scopeRef}`)
  lines.push(`this node:  ${location.localNodeId} (gate: ${location.gateMode})`)
  lines.push('')
  lines.push(`declared:   ${describeDeclared(location.declared)}`)
  if ('profilePath' in location.declared && location.declared.profilePath !== undefined) {
    lines.push(`            ${location.declared.profilePath}`)
  }
  if (location.declared.source === 'unavailable' || location.declared.source === 'none') {
    lines.push(`            ${location.declared.detail}`)
  }
  if (
    location.declared.source === 'pin-invalid' ||
    location.declared.source === 'task-default-invalid'
  ) {
    lines.push(`            ${location.declared.detail}`)
  }

  lines.push(`authority:  ${describeAuthority(location)}`)
  if (location.authority.state === 'bound') {
    lines.push(`            source: ${location.authority.source}`)
    const prior = location.authority.record.priorHomeNodeId
    if (prior !== undefined) lines.push(`            rebound from: ${prior}`)
  }

  lines.push(
    `ledger:     ${location.ledger.state === 'absent' ? 'no row on this node' : `${location.ledger.state} -> ${location.ledger.record.homeNodeId}`}`
  )
  lines.push(
    `registry:   ${
      location.registry.outcome === 'bound'
        ? `bound -> ${location.registry.record.homeNodeId}`
        : location.registry.outcome === 'retired'
          ? location.registry.record.successorNodeId === null
            ? `retired at epoch ${location.registry.record.placementEpoch} (terminal bar)`
            : `retired at epoch ${location.registry.record.placementEpoch} -> successor ${location.registry.record.successorNodeId}`
          : location.registry.outcome === 'unbound'
            ? 'unbound'
            : `${location.registry.outcome} — ${location.registry.detail}`
    }`
  )

  const observed = location.observed
  lines.push(
    `observed:   ${observed.runtimeCount === 0 ? `no runtimes on ${observed.nodeId}` : `${observed.runtimeCount} runtime(s) on ${observed.nodeId}`} (local-node truth only)`
  )
  for (const runtime of observed.runtimes) {
    lines.push(`            ${runtime.runtimeId}  ${runtime.laneRef}  ${runtime.status}`)
  }

  if (location.birthChain.state === 'resolved') {
    lines.push('')
    lines.push('birth chain:')
    for (const link of location.birthChain.links) {
      lines.push(`            ${link.scopeRef}  ${link.birthClass}  @${link.homeNodeId}`)
    }
  } else if (location.birthChain.state === 'unresolved') {
    lines.push('')
    lines.push(`birth chain: ${location.birthChain.detail}`)
  }

  if (location.skew !== undefined) {
    lines.push('')
    lines.push('!! SKEW')
    for (const line of location.skew.detail.split('\n')) lines.push(`   ${line}`)
  }

  const notes = location.notes.filter((note: LocateNote) => note.code !== 'pin-honored')
  if (notes.length > 0) {
    lines.push('')
    for (const note of notes) lines.push(`note: ${note.detail}`)
  }

  return `${lines.join('\n')}\n`
}

export async function cmdTargetLocate(args: string[]): Promise<void> {
  const scopeArg = args.find((arg) => !arg.startsWith('-'))
  if (scopeArg === undefined) fatal('target locate requires a scope or target handle')

  const scopeRef = resolveScopeArg(scopeArg)
  const location = await createClient().locateScope(scopeRef)

  if (hasFlag(args, '--json')) {
    printJson(location)
  } else {
    process.stdout.write(formatLocation(location))
  }

  // Skew is a real finding an operator may want to gate on, but it is not a
  // failure: the scope is serving correctly from its established home.
  if (location.skew !== undefined && hasFlag(args, '--fail-on-skew')) {
    throw new CliStatusExit(1)
  }
}

type DoctorCheck = {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail?: string | undefined
}

const STATUS_GLYPH: Record<DoctorCheck['status'], string> = {
  ok: '+',
  warn: '~',
  fail: 'x',
}

async function checkDaemon(client: HrcClient): Promise<{
  checks: DoctorCheck[]
  reachable: boolean
}> {
  try {
    const status = await client.getStatus({ includeSessions: false })
    const node = status.node
    const checks: DoctorCheck[] = [
      { name: 'hrc-daemon', status: 'ok', detail: `up ${status.uptime}s` },
    ]
    if (node === undefined) {
      checks.push({
        name: 'node-identity',
        status: 'warn',
        detail: 'daemon reports no node identity',
      })
      return { checks, reachable: true }
    }
    checks.push({
      name: 'node-identity',
      status: node.nodeIdProvenance === 'derived' && node.peerCount > 0 ? 'warn' : 'ok',
      detail: `${node.nodeId} (${node.nodeIdProvenance}, ${node.mode}, ${node.peerCount} peer(s))`,
    })
    checks.push({
      name: 'federation-config',
      status: 'ok',
      detail: node.configExists ? node.configPath : `${node.configPath} (absent, single-node mode)`,
    })
    return { checks, reachable: true }
  } catch (error) {
    return {
      reachable: false,
      checks: [
        {
          name: 'hrc-daemon',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}

/**
 * The check skew exists for: nobody names a scope they do not already suspect.
 */
function placementSkewChecks(report: LocateBindingsReport): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  const { scan } = report

  if (scan.skewed.length === 0) {
    checks.push({
      name: 'placement-skew',
      status: 'ok',
      detail:
        scan.scanned === 0
          ? 'no placement bindings on this node'
          : `${scan.scanned} binding(s), no placement constraint disagrees with its established home`,
    })
  } else {
    for (const finding of scan.skewed) {
      checks.push({
        name: 'placement-skew',
        status: 'warn',
        detail: `${finding.scopeRef}: ${describeSkewConstraint(finding.skew)}, established on ${finding.skew.boundNodeId} (epoch ${finding.skew.placementEpoch}). ${finding.skew.boundNodeId} keeps summon authority; the policy edit is not acted on. Rebuild the binding to move it. See: hrc target locate ${finding.scopeRef}`,
      })
    }
  }

  for (const entry of scan.unreadable) {
    checks.push({
      name: 'placement-policy',
      status: 'warn',
      detail: `${entry.scopeRef}: declared policy unreadable, so skew cannot be assessed — ${entry.detail}`,
    })
  }

  return checks
}

export async function cmdDoctor(args: string[]): Promise<void> {
  const client = createClient()
  const { checks, reachable } = await checkDaemon(client)

  if (reachable) {
    try {
      checks.push(...placementSkewChecks(await client.listPlacementBindings()))
    } catch (error) {
      checks.push({
        name: 'placement-skew',
        status: 'warn',
        detail: `could not read placement bindings: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (hasFlag(args, '--json')) {
    printJson(checks)
  } else {
    for (const check of checks) {
      const detail = check.detail === undefined ? '' : ` (${check.detail})`
      process.stdout.write(`  ${STATUS_GLYPH[check.status]} ${check.name}${detail}\n`)
    }
  }

  if (checks.some((check) => check.status === 'fail')) {
    throw new CliStatusExit(1)
  }
  // A warn-only run exits 0 unless the operator explicitly asks otherwise.
  if (hasFlag(args, '--strict') && checks.some((check) => check.status === 'warn')) {
    throw new CliStatusExit(1)
  }
}

/** `hrc target bindings` — the raw skew sweep, for scripting. */
export async function cmdTargetBindings(args: string[]): Promise<void> {
  const report = await createClient().listPlacementBindings()
  if (hasFlag(args, '--json')) {
    printJson(report)
    return
  }
  process.stdout.write(
    `node: ${report.localNodeId}  federation: ${report.federationConfigured ? report.gateMode : 'not configured'}\n`
  )
  process.stdout.write(
    `bindings: ${report.scan.scanned}  skewed: ${report.scan.skewed.length}  policy-unreadable: ${report.scan.unreadable.length}\n`
  )
  for (const finding of report.scan.skewed) {
    process.stdout.write(
      `  SKEW ${finding.scopeRef}: ${describeSkewConstraint(finding.skew)} vs established ${finding.skew.boundNodeId}\n`
    )
  }
}
