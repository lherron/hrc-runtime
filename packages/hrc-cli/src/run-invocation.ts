/**
 * `hrc run export` / `hrc run annotate` — HRC invocation exposure surface
 * (H-00104 Node C, contract C-0004).
 *
 * These commands project one concrete HRC runtime attempt into the stable
 * `HrcInvocationExposure` DTO and let an operator stamp opaque correlation
 * metadata on a run. The boundary is strict (see invocation-exposure.ts in
 * hrc-core): HRC exposes attempts and stores correlation verbatim; it never
 * writes DAG nodes/edges and never interprets the correlation it stores. The
 * DAG node-to-run attempt edge is authoritative — HRC-side correlation is an
 * operator convenience that must not be read back as graph truth.
 *
 * Both commands read/write SQLite directly via `openHrcDatabase`, the same
 * pattern `hrc monitor watch/wait` already use. The correlation column is new
 * and written only here, so there is no write contention with hrc-server.
 */

import { CliUsageError } from 'cli-kit'
import {
  type HrcInvocationExposure,
  type HrcRunCorrelation,
  type HrcRunRecord,
  type HrcSelector,
  buildHrcInvocationExposure,
  canonicalCorrelationJson,
  correlationConflicts,
  normalizeCorrelation,
  parseSelector,
  resolveDatabasePath,
} from 'hrc-core'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import { CliStatusExit } from './cli/shared.js'
import { matchStringFlag } from './monitor-args.js'
import { printJson } from './print.js'

// -- export -------------------------------------------------------------------

type RunExportOptions = {
  target?: string | undefined
  format?: string | undefined
  json: boolean
}

export async function cmdRunExport(args: string[]): Promise<void> {
  const options = parseExportArgs(args)
  if (options.target === undefined) {
    throw new CliUsageError('missing required argument: <runId-or-selector>')
  }
  // `invocation-exposure` is the only format this command produces; it is the
  // stable machine projection a DAG coordinator consumes. Accept it explicitly
  // and reject anything else so a typo never silently returns the wrong shape.
  if (options.format !== undefined && options.format !== 'invocation-exposure') {
    throw new CliUsageError(
      `--format must be "invocation-exposure" for run export (got "${options.format}")`
    )
  }

  const db = openHrcDatabase(resolveDatabasePath())
  try {
    const run = resolveRun(db, options.target)
    const cursors = eventCursors(db, run.runId)
    const correlation = readCorrelation(db, run.runId)
    const exposure: HrcInvocationExposure = buildHrcInvocationExposure({
      run,
      eventHighWaterSeq: cursors.high,
      eventsFromSeq: cursors.from,
      ...(correlation ? { correlation } : {}),
    })
    printJson(exposure)
  } finally {
    db.close()
  }
}

function parseExportArgs(args: string[]): RunExportOptions {
  let target: string | undefined
  let format: string | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--json') {
      json = true
      continue
    }
    const formatMatch = matchStringFlag(arg, '--format', args, i)
    if (formatMatch) {
      format = formatMatch.value
      i = formatMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    if (target !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`)
    }
    target = arg
  }

  return { target, format, json }
}

// -- annotate -----------------------------------------------------------------

type RunAnnotateOptions = {
  target?: string | undefined
  correlation?: string | undefined
  replace: boolean
  json: boolean
}

export async function cmdRunAnnotate(args: string[]): Promise<void> {
  const options = parseAnnotateArgs(args)
  if (options.target === undefined) {
    throw new CliUsageError('missing required argument: <runId>')
  }
  if (options.correlation === undefined) {
    throw new CliUsageError('--correlation <json> is required')
  }
  const incoming = parseCorrelationJson(options.correlation)

  const db = openHrcDatabase(resolveDatabasePath())
  try {
    const run = resolveRun(db, options.target)
    const existing = readCorrelation(db, run.runId)
    const incomingCanonical = canonicalCorrelationJson(incoming)

    // Idempotent: re-writing the same correlation is always safe (no-op).
    if (existing && canonicalCorrelationJson(existing) === incomingCanonical) {
      printJson({
        runId: run.runId,
        status: 'unchanged',
        correlation: normalizeCorrelation(incoming),
      })
      return
    }

    // Conflicting write requires explicit --replace, else fail without mutating.
    if (existing && correlationConflicts(existing, incoming) && !options.replace) {
      printJson({
        error: {
          code: 'correlation_conflict',
          message:
            'run already has a different correlation; pass --replace to overwrite, or write the same value',
          runId: run.runId,
          existing: normalizeCorrelation(existing),
          incoming: normalizeCorrelation(incoming),
        },
      })
      throw new CliStatusExit(1)
    }

    db.runs.setCorrelationJson(run.runId, incomingCanonical)
    printJson({
      runId: run.runId,
      status: existing ? 'replaced' : 'written',
      correlation: normalizeCorrelation(incoming),
    })
  } finally {
    db.close()
  }
}

function parseAnnotateArgs(args: string[]): RunAnnotateOptions {
  let target: string | undefined
  let correlation: string | undefined
  let replace = false
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--replace') {
      replace = true
      continue
    }
    const correlationMatch = matchStringFlag(arg, '--correlation', args, i)
    if (correlationMatch) {
      correlation = correlationMatch.value
      i = correlationMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    if (target !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`)
    }
    target = arg
  }

  return { target, correlation, replace, json }
}

const CORRELATION_FIELDS = [
  'invocationNodeId',
  'attemptRef',
  'taskId',
  'workflowInstanceId',
] as const

function parseCorrelationJson(raw: string): HrcRunCorrelation {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`--correlation must be valid JSON: ${message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUsageError('--correlation must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const correlation: HrcRunCorrelation = {}
  for (const field of CORRELATION_FIELDS) {
    const value = record[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new CliUsageError(`--correlation.${field} must be a string`)
    }
    correlation[field] = value
  }
  const unknownKeys = Object.keys(record).filter(
    (key) => !(CORRELATION_FIELDS as readonly string[]).includes(key)
  )
  if (unknownKeys.length > 0) {
    throw new CliUsageError(
      `--correlation has unknown field(s): ${unknownKeys.join(', ')} (allowed: ${CORRELATION_FIELDS.join(', ')})`
    )
  }
  if (Object.keys(correlation).length === 0) {
    throw new CliUsageError(
      `--correlation must set at least one of: ${CORRELATION_FIELDS.join(', ')}`
    )
  }
  return correlation
}

// -- shared helpers -----------------------------------------------------------

/**
 * Resolve a `<runId-or-selector>` argument to exactly one run. A literal run id
 * wins (a run id and a selector are two doors to one projection); otherwise the
 * selector resolves to the latest run for the matching runtime/session/scope.
 */
function resolveRun(db: HrcDatabase, target: string): HrcRunRecord {
  const direct = db.runs.getByRunId(target)
  if (direct) return direct

  let selector: HrcSelector
  try {
    selector = parseSelector(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`no run "${target}" and not a valid selector: ${message}`)
  }

  const filters = runFiltersForSelector(selector, target)
  const run = db.runs.listRuns({ ...filters, limit: 1 })[0]
  if (!run) {
    throw new CliUsageError(`selector "${target}" did not match any run`)
  }
  return run
}

function runFiltersForSelector(
  selector: HrcSelector,
  raw: string
): { runtimeId?: string; hostSessionId?: string; scopeRef?: string; laneRef?: string } {
  switch (selector.kind) {
    case 'runtime':
      return { runtimeId: selector.runtimeId }
    case 'host':
      return { hostSessionId: selector.hostSessionId }
    case 'concrete':
      return { hostSessionId: selector.hostSessionId }
    case 'scope':
      return { scopeRef: selector.scopeRef }
    case 'session':
    case 'target':
    case 'stable': {
      const { scopeRef, laneRef } = splitSessionRefParts(selector.sessionRef)
      return { scopeRef, laneRef }
    }
    default:
      throw new CliUsageError(
        `selector "${raw}" (${selector.kind}) is not a run selector; use a runId, runtime:, scope:, session:, or host: selector`
      )
  }
}

function splitSessionRefParts(sessionRef: string): { scopeRef: string; laneRef: string } {
  const [scopeRef, laneSuffix] = sessionRef.split('/lane:')
  return {
    scopeRef: scopeRef ?? sessionRef,
    laneRef: laneSuffix ?? 'main',
  }
}

function eventCursors(db: HrcDatabase, runId: string): { high: number; from: number } {
  const row = db.sqlite
    .query<{ lo: number | null; hi: number | null }, [string]>(
      'SELECT MIN(hrc_seq) AS lo, MAX(hrc_seq) AS hi FROM hrc_events WHERE run_id = ?'
    )
    .get(runId)
  return {
    high: row?.hi ?? 0,
    // A fresh consumer replays this run's events from its first seq; default to
    // 1 (the global stream floor) when the run has no events yet.
    from: row?.lo ?? 1,
  }
}

function readCorrelation(db: HrcDatabase, runId: string): HrcRunCorrelation | null {
  const json = db.runs.getCorrelationJson(runId)
  if (json === null) return null
  try {
    const parsed = JSON.parse(json) as HrcRunCorrelation
    return normalizeCorrelation(parsed)
  } catch {
    // Stored value is opaque; if it is somehow unparseable, treat as absent
    // rather than failing the read. HRC never interprets correlation.
    return null
  }
}
