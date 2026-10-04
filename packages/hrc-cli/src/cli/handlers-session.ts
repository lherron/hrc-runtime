import { HrcErrorCode, splitSessionRef } from 'hrc-core'

import { printJson } from '../print.js'
import { parseProfileAwareSelector } from '../profile-aware-selector.js'
import { resolveSessionArg } from '../selector-resolve.js'
import { parseSinceMs, renderPorcelain, renderSessions } from '../session-render.js'
import { hasFlag, parseFlag, requireArg } from './argv.js'
import { isHrcDomainErrorLike } from './errors.js'
import { createClient, fatal } from './shared.js'

export async function cmdSessionResolve(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  if (!scope) fatal('--scope is required for session resolve')

  const lane = parseFlag(args, '--lane') ?? 'main'
  const sessionRef = `${scope}/lane:${lane}`
  const create = hasFlag(args, '--create')

  const client = createClient()
  // Deliberately NOT `summonIntent: 'explicit_local'`, though a human may well
  // be typing it. T-06609's AC names `hrc run` and `hrc start` as the operator
  // commands, and this verb is neither: it is the scripting/plumbing primitive
  // that SDK callers and test harnesses drive, and it prints JSON rather than
  // starting anything. Treating it as a placement declaration would hand every
  // script that calls it the authority to establish a scope wherever it happens
  // to run — the exact conflation federation spec §5 draws the line against.
  // Placing a scope from the shell is `hrc run`/`hrc start`.
  const result = await client.resolveSession({
    sessionRef,
    ...(create ? { create: true } : {}),
  })
  printJson(result)
}

export async function cmdSessionList(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  const lane = parseFlag(args, '--lane')
  const all = hasFlag(args, '--all')
  const since = parseFlag(args, '--since')

  const client = createClient()
  // T-07575 — the server bounds an unscoped read to a recency window, so the
  // two flags that widen the *render* window must widen the *read* too.
  // Otherwise `--all` or `--since 30d` would silently re-render the same seven
  // days and look like the store held nothing older.
  const { sessions, total, withheld } = await client.listSessionsWithProjection({
    ...(scope ? { scopeRef: scope } : {}),
    ...(lane ? { laneRef: lane } : {}),
    ...(all ? { all: true } : {}),
    ...(!all && since
      ? { updatedSince: new Date(Date.now() - parseSinceMs(since)).toISOString() }
      : {}),
  })

  if (hasFlag(args, '--porcelain')) {
    process.stdout.write(renderPorcelain(sessions))
    return
  }

  // JSON when forced or piped (keeps `hrc session list | jq` working); the
  // human render only kicks in for an interactive TTY launch.
  if (hasFlag(args, '--json') || !process.stdout.isTTY) {
    printJson(sessions)
    return
  }

  process.stdout.write(
    renderSessions(sessions, {
      now: new Date(),
      color: process.stdout.isTTY === true,
      all: hasFlag(args, '--all'),
      dormant: hasFlag(args, '--dormant'),
      gens: hasFlag(args, '--gens'),
      groupBy: hasFlag(args, '--by-project') ? 'project' : 'agent',
      ...(since ? { sinceMs: parseSinceMs(since) } : {}),
      ...(scope ? { scope } : {}),
    })
  )
  process.stdout.write(renderProjectionFooter({ shown: sessions.length, total, withheld }))
}

/**
 * T-07575 — say out loud when the read was bounded.
 *
 * The bug this change fixes was 8,319 rows arriving at every caller; the bug it
 * could introduce is a caller believing 525 rows are all there is. A bounded
 * read that does not announce itself is the second bug, so the footer names the
 * withheld count and the flag that lifts the bound.
 */
function renderProjectionFooter(input: {
  shown: number
  total?: number | undefined
  withheld?: number | undefined
}): string {
  if (input.withheld === undefined || input.withheld <= 0) return ''
  const total = input.total ?? input.shown + input.withheld
  return `\n${input.withheld} older session(s) withheld of ${total} stored — pass --all, --since, or --scope to reach them.\n`
}

export async function cmdSessionGet(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const live = hasFlag(args, '--live')
  const probe = hasFlag(args, '--probe')

  const client = createClient()
  if (!live) {
    try {
      if (
        hostSessionArg.startsWith('hsid-') ||
        hostSessionArg.startsWith('hsid_') ||
        hostSessionArg.startsWith('host:') ||
        !/[:@~]/.test(hostSessionArg)
      ) {
        const hostId =
          hostSessionArg.startsWith('hsid-') ||
          hostSessionArg.startsWith('hsid_') ||
          hostSessionArg.startsWith('host:')
            ? hostSessionArg.replace(/^host:/, '')
            : await resolveSessionArg(hostSessionArg, client)
        const session = await client.getSession(hostId)
        // Historical host rows have no continuity and honestly carry no identity.
        if (!session.identity) {
          printJson(session)
          return
        }
        printJson(
          await client.getSessionByContinuity({
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
          })
        )
      } else {
        printJson(
          await client.getSessionByContinuity(await sessionMetadataTarget(hostSessionArg, client))
        )
      }
    } catch (error) {
      if (isHrcDomainErrorLike(error) && error.code === HrcErrorCode.UNKNOWN_HOST_SESSION)
        fatal(error.message)
      throw error
    }
    return
  }
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const session = await client.getSession(hostSessionId)

  // --live: join the backing runtime generation(s). Broker-backed runtimes get
  // the broker read model (InvocationInspectionSummary); non-broker runtimes get
  // the HRC-derived fallback view (labeled source:'hrc-derived').
  const runtimes = await client.listRuntimes({ hostSessionId })
  const inspections = await Promise.all(
    runtimes.map(async (rt) => {
      try {
        const inspection = await client.brokerInspect({
          runtimeId: rt.runtimeId,
          ...(probe ? { probeLiveness: true } : {}),
        })
        return { runtimeId: rt.runtimeId, generation: rt.generation, inspection }
      } catch (error) {
        return {
          runtimeId: rt.runtimeId,
          generation: rt.generation,
          inspectionError: error instanceof Error ? error.message : String(error),
        }
      }
    })
  )

  printJson({ session, runtimes: inspections })
}

async function sessionMetadataTarget(target: string, client: ReturnType<typeof createClient>) {
  if (!target.startsWith('hsid-') && !target.startsWith('hsid_')) {
    const raw = target.startsWith('agent:')
      ? `${target.includes('/lane:') ? 'session' : 'scope'}:${target}`
      : target
    const selector = await parseProfileAwareSelector(raw)
    if (selector.kind === 'scope') return { scopeRef: selector.scopeRef, laneRef: 'main' }
    if (selector.kind === 'target' || selector.kind === 'session' || selector.kind === 'stable')
      return splitSessionRef(selector.sessionRef)
    if (selector.kind === 'host' || selector.kind === 'concrete') {
      const session = await client.getSession(selector.hostSessionId)
      return { scopeRef: session.scopeRef, laneRef: session.laneRef }
    }
  }
  const hostSessionId =
    target.startsWith('hsid-') || target.startsWith('hsid_')
      ? target
      : await resolveSessionArg(target, client)
  const session = await client.getSession(hostSessionId)
  return { scopeRef: session.scopeRef, laneRef: session.laneRef }
}

export async function cmdSessionMeta(args: string[]): Promise<void> {
  const operation = requireArg(args, 0, '<set|clear|get>')
  const target = requireArg(args, 1, '<target>')
  const client = createClient()
  const continuity = await sessionMetadataTarget(target, client)
  if (operation === 'get') {
    printJson(await client.getSessionMetadata(continuity))
    return
  }
  const key = requireArg(args, 2, '<key>')
  if (operation === 'clear') {
    printJson(await client.clearSessionMetadata(continuity, args.slice(2)))
    return
  }
  if (operation !== 'set') fatal(`unknown session meta operation: ${operation}`)
  const raw = requireArg(args, 3, '<value>')
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    /* Plain strings are valid metadata. */
  }
  printJson(await client.setSessionMetadata(continuity, { [key]: value }))
}

export async function cmdSessionRetitle(args: string[]): Promise<void> {
  const target = requireArg(args, 0, '<target>')
  const title = parseFlag(args, '--title')
  const regenerate = hasFlag(args, '--regenerate')
  if (title === undefined && !regenerate)
    fatal('session retitle requires exactly one of --title or --regenerate')
  if (title !== undefined && regenerate) fatal('--title and --regenerate are mutually exclusive')
  process.stderr.write('hrc: session retitle is deprecated; use session meta set/clear title\n')
  const client = createClient()
  const continuity = await sessionMetadataTarget(target, client)
  printJson(
    regenerate
      ? await client.clearSessionMetadata(continuity, ['title'])
      : await client.setSessionMetadata(continuity, { title })
  )
}

export async function cmdSessionDropContinuation(args: string[]): Promise<void> {
  const hostSessionArg = requireArg(args, 0, '<hostSessionId>')
  const reason = parseFlag(args, '--reason')

  const client = createClient()
  const hostSessionId = await resolveSessionArg(hostSessionArg, client)
  const result = await client.dropContinuation({
    hostSessionId,
    ...(reason ? { reason } : {}),
  })
  printJson(result)
}
