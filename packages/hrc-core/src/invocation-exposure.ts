/**
 * HRC invocation exposure surface (H-00104 Node C, contract C-0004).
 *
 * HRC exposes one concrete runtime attempt as a stable machine projection so a
 * cross-project Invocation-DAG coordinator can map it into an `AttemptRef`
 * (`external_run_ref = hrc:<runId>`). The boundary is strict:
 *
 *   - HRC run = concrete runtime attempt; DAG node = logical work invocation.
 *   - HRC exposes attempts plus OPAQUE correlation metadata. It never writes DAG
 *     nodes/edges and never interprets the correlation it stores.
 *   - The DAG node-to-run attempt edge is authoritative. HRC-side correlation is
 *     an operator convenience and must not be read back as graph truth.
 *
 * This module holds the DTO shape, a pure builder, and the correlation
 * idempotency/conflict predicate. It does NOT read or write storage; callers
 * pass in the resolved run record and computed cursors.
 */

import type { HrcRunRecord } from './contracts.js'

/**
 * Opaque, best-effort correlation metadata an operator can stamp on an HRC run
 * via `hrc run annotate --correlation`. HRC stores and echoes it verbatim and
 * never interprets it. It is convenience only — the DAG attempt edge wins.
 */
export type HrcRunCorrelation = {
  invocationNodeId?: string | undefined
  attemptRef?: string | undefined
  taskId?: string | undefined
  workflowInstanceId?: string | undefined
}

/** Stable machine projection of one HRC runtime attempt (C-0004). */
export type HrcInvocationExposure = {
  kind: 'hrc.invocation_exposure.v1'
  externalRunRef: `hrc:${string}`

  run: {
    runId: string
    hostSessionId: string
    runtimeId?: string | undefined
    scopeRef: string
    laneRef: string
    generation: number
    transport: string
    status: string
    acceptedAt?: string | undefined
    startedAt?: string | undefined
    completedAt?: string | undefined
    updatedAt: string
    errorCode?: string | undefined
    errorMessage?: string | undefined
    operationId?: string | undefined
    invocationId?: string | undefined
  }

  session: {
    sessionRef: string
    selector: string
  }

  cursors: {
    eventHighWaterSeq: number
    eventsFromSeq: number
  }

  refs: {
    monitorSnapshot: string
    events: string
    sessionLive?: string | undefined
  }

  correlation?: HrcRunCorrelation | undefined
}

export type BuildHrcInvocationExposureInput = {
  run: HrcRunRecord
  /** Per-run event high-water (max hrc_seq for this run; 0 when none). */
  eventHighWaterSeq: number
  /** Replay cursor a fresh consumer starts the event stream from. */
  eventsFromSeq: number
  /** Opaque correlation metadata, if any was annotated. */
  correlation?: HrcRunCorrelation | undefined
}

/** `<scopeRef>/lane:<laneRef>` — the canonical HRC session ref. */
export function sessionRefFor(run: Pick<HrcRunRecord, 'scopeRef' | 'laneRef'>): string {
  return `${run.scopeRef}/lane:${run.laneRef}`
}

/**
 * The stable monitor selector for a run: prefer the concrete `runtime:<id>` when
 * the run has a runtime, else the owning `scope:<scopeRef>`. Both resolve to the
 * same single projection (a run id and a selector are two doors to one DTO).
 */
export function selectorFor(run: Pick<HrcRunRecord, 'runtimeId' | 'scopeRef'>): string {
  return run.runtimeId !== undefined ? `runtime:${run.runtimeId}` : `scope:${run.scopeRef}`
}

/**
 * Build the stable exposure DTO from a resolved run plus computed cursors. Pure:
 * no storage access, no interpretation of correlation.
 */
export function buildHrcInvocationExposure(
  input: BuildHrcInvocationExposureInput
): HrcInvocationExposure {
  const { run, eventHighWaterSeq, eventsFromSeq, correlation } = input
  const sessionRef = sessionRefFor(run)
  const selector = selectorFor(run)

  return {
    kind: 'hrc.invocation_exposure.v1',
    externalRunRef: `hrc:${run.runId}`,
    run: {
      runId: run.runId,
      hostSessionId: run.hostSessionId,
      runtimeId: run.runtimeId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
      transport: run.transport,
      status: run.status,
      acceptedAt: run.acceptedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      updatedAt: run.updatedAt,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      operationId: run.operationId,
      invocationId: run.invocationId,
    },
    session: {
      sessionRef,
      selector,
    },
    cursors: {
      eventHighWaterSeq,
      eventsFromSeq,
    },
    refs: {
      monitorSnapshot: `hrc monitor show ${selector}`,
      events: `hrc monitor watch ${selector} --from-seq ${eventsFromSeq} --format invocation-events`,
      ...(run.runtimeId !== undefined ? { sessionLive: `hrc attach ${run.runtimeId}` } : {}),
    },
    ...(correlation !== undefined && hasCorrelationFields(correlation)
      ? { correlation: normalizeCorrelation(correlation) }
      : {}),
  }
}

const CORRELATION_FIELDS = [
  'invocationNodeId',
  'attemptRef',
  'taskId',
  'workflowInstanceId',
] as const satisfies ReadonlyArray<keyof HrcRunCorrelation>

function hasCorrelationFields(correlation: HrcRunCorrelation): boolean {
  return CORRELATION_FIELDS.some((field) => correlation[field] !== undefined)
}

/**
 * Drop undefined fields and sort keys so equal correlations serialize
 * identically — the basis for idempotent same-write detection in `annotate`.
 */
export function normalizeCorrelation(correlation: HrcRunCorrelation): HrcRunCorrelation {
  const out: HrcRunCorrelation = {}
  for (const field of CORRELATION_FIELDS) {
    const value = correlation[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/** Canonical JSON for a correlation (sorted keys, no undefined). */
export function canonicalCorrelationJson(correlation: HrcRunCorrelation): string {
  const normalized = normalizeCorrelation(correlation)
  const ordered: Record<string, string> = {}
  for (const field of CORRELATION_FIELDS) {
    const value = normalized[field]
    if (value !== undefined) ordered[field] = value
  }
  return JSON.stringify(ordered)
}

/**
 * True when `incoming` disagrees with `existing` on any set field. Writing the
 * same correlation again is NOT a conflict (idempotent); changing a field is,
 * unless the caller passes an explicit replace.
 */
export function correlationConflicts(
  existing: HrcRunCorrelation,
  incoming: HrcRunCorrelation
): boolean {
  return canonicalCorrelationJson(existing) !== canonicalCorrelationJson(incoming)
}
