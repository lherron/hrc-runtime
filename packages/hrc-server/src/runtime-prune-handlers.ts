import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcNotFoundError,
} from 'hrc-core'
import type {
  HrcRuntimeSnapshot,
  PruneRuntimeResult,
  PruneRuntimesResponse,
  PruneRuntimesSummary,
  SweepRuntimeTransport,
} from 'hrc-core'
import { recordOperatorDisposition, retainedEvidenceHold } from './broker/offline-evidence'
import { settleTerminalInvocationAbsorbedAuxiliaries } from './broker/turn-ownership.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody, parsePruneRuntimesRequest } from './server-parsers.js'
import { json, timestamp } from './server-util.js'
import {
  evaluateDispositionStatusAdmission,
  evaluatePruneDisposition,
  evaluatePruneLivenessSafety,
  parseSweepDurationMs,
  runtimeMatchesSweepRequest,
} from './sweep-helpers.js'
import { createTmuxManager } from './tmux.js'

const MNEME_LEDGER_PRUNE_SCOPE_ALLOWLIST = new Set([
  'agent:mneme:project:signal-pipeline:task:signal-cluster',
  'agent:mneme:project:signal-pipeline:task:signal-summarize',
  'agent:mneme:project:signal-pipeline:task:signal-score',
])

function summarizePruneResults(
  results: PruneRuntimeResult[],
  matched = results.length
): PruneRuntimesSummary {
  return {
    type: 'summary',
    matched,
    pruned: results.filter((result) => result.status === 'pruned').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
  }
}

/**
 * Record-level GC for orphaned runtime store rows (T-05441). Distinct from
 * `handleSweepRuntimes`, which only ages abandoned runtimes stale — prune DELETES
 * the row (and its runtime-scoped satellites) for records that are genuinely
 * orphaned. It is dry-run unless the caller passes both a non-dry-run request
 * AND `yes:true`; every matched record is put through `evaluatePruneDisposition`
 * so a live/ready/busy/claimed/active-run record is always spared even when the
 * status filter would otherwise select it.
 */
export async function handlePruneRuntimes(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const raw = await parseJsonBody(request)
  // T-08566: disposition has its own grammar (one runtimeId, no includeLedgers),
  // so it is routed before the ledger-manifest pairing rule below.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Record<string, unknown>)['disposeRetainedEvidence'] === true
  ) {
    return disposeRetainedEvidence.call(this, raw as Record<string, unknown>)
  }
  const body = parsePruneRuntimesRequest(raw)
  if (body.runtimeIds && body.includeLedgers === true) {
    return handleLedgerManifestPrune.call(this, body.runtimeIds, {
      dryRun: body.dryRun === true,
      yes: body.yes === true,
    })
  }

  const statuses = body.status ?? ['stale']
  const nowMs = Date.now()
  const cutoffMs = nowMs - parseSweepDurationMs(body.olderThan ?? '24h')
  const mutate = body.dryRun !== true && body.yes === true

  const matched = this.db.runtimes.listAll().filter((runtime) =>
    runtimeMatchesSweepRequest(runtime, {
      cutoffMs,
      includeRecentUnavailable: false,
      nowMs,
      scope: body.scope,
      statuses,
      transport: body.transport,
    })
  )

  const results: PruneRuntimeResult[] = []
  for (const runtime of matched) {
    const transport = runtime.transport as SweepRuntimeTransport
    const base = {
      type: 'runtime' as const,
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport,
    }

    let disposition: { prunable: boolean; reason?: string }
    try {
      disposition = await evaluatePruneDisposition(runtime, this.tmux, this.db, {
        tmuxManagerFactory: this.brokerTmuxManagerFactory ?? createTmuxManager,
      })
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (!disposition.prunable) {
      results.push({
        ...base,
        status: 'skipped',
        ...(disposition.reason ? { reason: disposition.reason } : {}),
      })
      continue
    }

    if (!mutate) {
      results.push({ ...base, status: 'pruned', reason: 'dry_run' })
      continue
    }

    try {
      const removed = this.db.sqlite.transaction(() => {
        settleTerminalInvocationAbsorbedAuxiliaries(this.db, runtime.runtimeId, timestamp())
        return this.db.runtimes.pruneRuntime(runtime.runtimeId)
      })()
      results.push({
        ...base,
        status: removed ? 'pruned' : 'skipped',
        ...(removed ? {} : { reason: 'already_absent' }),
      })
    } catch (err) {
      results.push({
        ...base,
        status: 'error',
        errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return json({
    ok: true,
    results,
    summary: summarizePruneResults(results, matched.length),
  } satisfies PruneRuntimesResponse)
}

/**
 * T-08566 §4.2 — `hrc runtime prune --runtime-id <id> --dispose-retained-evidence
 * --reason <text> --yes`. Records `operator_disposed` for the held invocations,
 * then applies the ordinary prune, in one transaction. The audit rows are not
 * cascaded. Refused, with no mutation, unless the runtime is under hold.
 */
async function disposeRetainedEvidence(
  this: HrcServerInstanceForHandlers,
  raw: Record<string, unknown>
): Promise<Response> {
  const reason = typeof raw['reason'] === 'string' ? raw['reason'].trim() : ''
  if (reason.length === 0) {
    return json(
      {
        error: {
          code: 'disposition_reason_required',
          message: 'retained-evidence disposition requires a reason',
          detail: {},
        },
      },
      400
    )
  }
  const runtimeIds = Array.isArray(raw['runtimeIds'])
    ? raw['runtimeIds'].filter((entry): entry is string => typeof entry === 'string')
    : []
  if (runtimeIds.length !== 1 || raw['includeLedgers'] === true) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'retained-evidence disposition takes exactly one runtimeId',
      { runtimeIds }
    )
  }
  const runtimeId = runtimeIds[0] as string
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime: ${runtimeId}`)
  }
  const hold = retainedEvidenceHold(this.db, runtime)
  if (!hold.held) {
    return json(
      {
        error: {
          code: 'retained_evidence_not_held',
          message: 'runtime has no held retained evidence to dispose',
          detail: { runtimeId },
        },
      },
      409
    )
  }
  const transport = runtime.transport as SweepRuntimeTransport
  const base = {
    type: 'runtime' as const,
    runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport,
  }
  const admission = evaluateDispositionStatusAdmission(runtime)
  if (!admission.admitted) {
    return json({
      ok: true,
      results: [{ ...base, status: 'skipped', reason: admission.reason }],
      summary: { type: 'summary', matched: 1, pruned: 0, skipped: 1, errors: 0 },
    } satisfies PruneRuntimesResponse)
  }
  // H1b: disposition deletes the runtime row, so it passes the same liveness
  // safety as runtime prune before anything is recorded. A probe error is a
  // safety-gate error, never evidence that the runtime is gone.
  let safety: { prunable: boolean; reason?: string }
  try {
    safety = await evaluatePruneLivenessSafety(runtime, this.tmux, this.db, {
      tmuxManagerFactory: this.brokerTmuxManagerFactory ?? createTmuxManager,
    })
  } catch (err) {
    return json({
      ok: true,
      results: [
        {
          ...base,
          status: 'error',
          errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      ],
      summary: { type: 'summary', matched: 1, pruned: 0, skipped: 0, errors: 1 },
    } satisfies PruneRuntimesResponse)
  }
  if (!safety.prunable) {
    return json({
      ok: true,
      results: [{ ...base, status: 'skipped', reason: safety.reason ?? 'not_prunable' }],
      summary: { type: 'summary', matched: 1, pruned: 0, skipped: 1, errors: 0 },
    } satisfies PruneRuntimesResponse)
  }
  if (raw['dryRun'] === true || raw['yes'] !== true) {
    return json({
      ok: true,
      results: [{ ...base, status: 'skipped', reason: 'dry_run_disposition' }],
      summary: { type: 'summary', matched: 1, pruned: 0, skipped: 1, errors: 0 },
    } satisfies PruneRuntimesResponse)
  }
  const at = timestamp()
  const by = typeof raw['by'] === 'string' && raw['by'].length > 0 ? raw['by'] : 'operator'
  const removed = this.db.sqlite.transaction(() => {
    recordOperatorDisposition(this.db, runtime, { by, reason, at })
    settleTerminalInvocationAbsorbedAuxiliaries(this.db, runtimeId, at)
    return this.db.runtimes.pruneRuntime(runtimeId)
  })()
  const results: PruneRuntimeResult[] = [
    {
      ...base,
      status: removed ? 'pruned' : 'skipped',
      reason: removed ? 'operator_disposed' : 'already_absent',
    },
  ]
  return json({
    ok: true,
    results,
    summary: summarizePruneResults(results),
  } satisfies PruneRuntimesResponse)
}

async function handleLedgerManifestPrune(
  this: HrcServerInstanceForHandlers,
  runtimeIds: string[],
  options: { dryRun: boolean; yes: boolean }
): Promise<Response> {
  const mutate = !options.dryRun && options.yes
  const byRuntimeId = new Map(
    this.db.runtimes.listAll().map((runtime) => [runtime.runtimeId, runtime] as const)
  )
  const matched: HrcRuntimeSnapshot[] = []
  const gateFailures: Array<{
    runtimeId: string
    scopeRef?: string | undefined
    reasons: string[]
  }> = []

  // This complete preflight is the all-or-nothing boundary. No repository
  // mutation occurs until every manifest row passes both gates.
  for (const runtimeId of runtimeIds) {
    const runtime = byRuntimeId.get(runtimeId)
    if (!runtime) {
      gateFailures.push({ runtimeId, reasons: ['unknown_runtime'] })
      continue
    }

    const reasons: string[] = []
    if (!MNEME_LEDGER_PRUNE_SCOPE_ALLOWLIST.has(runtime.scopeRef)) {
      reasons.push('scope_not_allowlisted')
    }
    try {
      const disposition = await evaluatePruneDisposition(runtime, this.tmux, this.db, {
        tmuxManagerFactory: this.brokerTmuxManagerFactory ?? createTmuxManager,
      })
      if (!disposition.prunable) reasons.push(disposition.reason ?? 'not_prunable')
    } catch (error) {
      reasons.push(`safety_gate_error:${error instanceof Error ? error.message : String(error)}`)
    }

    if (reasons.length > 0) {
      gateFailures.push({ runtimeId, scopeRef: runtime.scopeRef, reasons })
    } else {
      matched.push(runtime)
    }
  }

  if (gateFailures.length > 0) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      `ledger-inclusive runtime prune refused: ${gateFailures.length} of ${runtimeIds.length} manifest runtimes failed the all-or-nothing safety gate`,
      {
        manifestCount: runtimeIds.length,
        failureCount: gateFailures.length,
        failures: gateFailures,
      }
    )
  }

  const deleteCounts = this.db.runtimes.countPruneRows(runtimeIds, { includeLedgers: true })
  if (mutate) {
    const removed = this.db.sqlite.transaction(() => {
      const at = timestamp()
      for (const runtimeId of runtimeIds) {
        settleTerminalInvocationAbsorbedAuxiliaries(this.db, runtimeId, at)
      }
      return this.db.runtimes.pruneRuntimes(runtimeIds, { includeLedgers: true })
    })()
    if (removed !== matched.length) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `ledger-inclusive runtime prune lost runtimes during apply: expected ${matched.length}, removed ${removed}`,
        { expected: matched.length, removed }
      )
    }
  }

  const results: PruneRuntimeResult[] = matched.map((runtime) => ({
    type: 'runtime',
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport: runtime.transport as SweepRuntimeTransport,
    status: 'pruned',
    ...(mutate ? {} : { reason: 'dry_run' }),
  }))
  return json({
    ok: true,
    results,
    summary: summarizePruneResults(results),
    deleteCounts,
  } satisfies PruneRuntimesResponse)
}

export const runtimePruneHandlersMethods = { handlePruneRuntimes }

export type RuntimePruneHandlersMethods = typeof runtimePruneHandlersMethods
