/**
 * `GET /v1/presentation/runtimes` — the presentation read model (T-07594;
 * durable law `hrc-runtime.viewer-presentation-sidecar` §5.3–5.4).
 *
 * A projection over the STORE ONLY. It reads runtime rows, the persisted §5.1
 * presentation record, the hosting/tmux state already on the row, and
 * `session_metadata`, and returns. It deliberately does NOT call
 * `reconcileTmuxRuntimeLiveness`, probe tmux, attach, or append events — a
 * presentation consumer polls this on every reconcile, and a read that can mark
 * a runtime dead would let a cosmetic process change runtime state (§7
 * invariants 3 and 6).
 *
 * The consequence is accepted, not accidental: a row here can name a runtime
 * whose tmux has already died, until hrc's own sweep marks it. That is the same
 * window that exists today between substrate death and sweep.
 */
import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  HrcPresentationRuntimeRow,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  ListPresentationRuntimesResponse,
} from 'hrc-core'
import { type HrcDatabase, canonicalLaneRef } from 'hrc-store-sqlite'

import {
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { CONTEXT_READING_STATE_KEY } from './broker/event-mapper/context-reading.js'
import { canOperatorAttach } from './broker/runtime-hosting.js'
import { isRecord, parseJsonBody, parseSessionRef } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json } from './server-util.js'
import { SESSION_HAS_RUNNING_RUNTIME_SQL, SESSION_RECENCY_SQL } from './session-recency.js'

export function projectPresentationRuntime(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): HrcPresentationRuntimeRow {
  // Attachability for the tmux block comes from the persisted hosting state,
  // never from the record: the record reports what the last invocation decided,
  // the hosting state is what the substrate actually is.
  const socketPath = canOperatorAttach(runtime)
    ? getBrokerRuntimeTmuxSocketPath(runtime)
    : undefined
  const title = db.sessionTitles.getByHostSessionId(runtime.hostSessionId)?.title
  const contextReading = runtime.runtimeStateJson?.[CONTEXT_READING_STATE_KEY]
  const operatorSurfaces = db.surfaceBindings
    .findByRuntime(runtime.runtimeId)
    .flatMap((binding) =>
      binding.surfaceKind === 'ghostty' && binding.clientTty !== undefined
        ? [{ surfaceId: binding.surfaceId, clientTty: binding.clientTty }]
        : []
    )
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    ...(runtime.identity ? { identity: runtime.identity } : {}),
    metadata: db.sessionMetadata.get(runtime.scopeRef, runtime.laneRef).metadata,
    laneRef: canonicalLaneRef(runtime.laneRef),
    generation: runtime.generation,
    status: runtime.status,
    // Absent — not defaulted — for generations that predate the record (§5.5).
    ...(runtime.presentation !== undefined ? { presentation: runtime.presentation } : {}),
    ...(socketPath !== undefined
      ? { tmux: { socketPath, attachTarget: getBrokerRuntimeTmuxAttachTarget(runtime) } }
      : {}),
    ...(title !== undefined ? { title } : {}),
    // Copied exactly as stored, never validated or defaulted here: the reader
    // owns validation (runtime-context-reading; rust-migration §4.3).
    ...(contextReading !== undefined ? { contextReading } : {}),
    operatorSurfaces,
  }
}

export function handleListPresentationRuntimes(db: HrcDatabase): Response {
  const runtimes = db.runtimes
    .listAll()
    .filter((runtime) => !isRuntimeUnavailableStatus(runtime.status))
    .map((runtime) => projectPresentationRuntime(db, runtime))

  return json({ ok: true, runtimes } satisfies ListPresentationRuntimesResponse)
}

/** Stage-1 projector read: one local, store-only read of the batch's keys.
 * Keep the full read's recency/generation selection, including quiet live seats.
 * No all-session/event/runtime enumeration is allowed on this path.
 */
export async function handleReadPresentationSeats(
  db: HrcDatabase,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (
    !isRecord(body) ||
    !Array.isArray(body['sessionRefs']) ||
    !Array.isArray(body['runtimeIds']) ||
    [...body['sessionRefs'], ...body['runtimeIds']].some((k) => typeof k !== 'string' || !k)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRefs and runtimeIds must be arrays of nonempty strings'
    )
  }
  const keys = new Map<string, { scopeRef: string; laneRef: string }>()
  for (const ref of body['sessionRefs'] as string[]) keys.set(ref, parseSessionRef(ref))
  // Even an unavailable runtime names a seat that may need its inactive update.
  for (const id of new Set(body['runtimeIds'] as string[])) {
    const r = db.runtimes.getByRuntimeId(id)
    if (r)
      keys.set(`${r.scopeRef}/lane:${canonicalLaneRef(r.laneRef)}`, {
        scopeRef: r.scopeRef,
        laneRef: canonicalLaneRef(r.laneRef),
      })
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const recent = db.sqlite.query<{ present: number }, [string, string]>(`
    SELECT 1 AS present FROM sessions s WHERE s.host_session_id = ?
      AND (${SESSION_RECENCY_SQL} >= ? OR ${SESSION_HAS_RUNNING_RUNTIME_SQL})`)
  const sessions = new Map<string, HrcSessionRecord>()
  const runtimes = new Map<string, HrcRuntimeSnapshot>()
  for (const { scopeRef, laneRef } of keys.values()) {
    const candidates = db.sessions
      .listByScopeRef(scopeRef)
      .filter((s) => canonicalLaneRef(s.laneRef) === laneRef)
    const live = db.runtimes
      .listByScopeRef(scopeRef)
      .filter(
        (r) => canonicalLaneRef(r.laneRef) === laneRef && !isRuntimeUnavailableStatus(r.status)
      )
    let selected = candidates
      .filter((s) => recent.get(s.hostSessionId, since))
      .sort((a, b) => b.generation - a.generation)[0]
    // Full state() adds the latest scoped session when a presentation runtime
    // isn't represented by the window-selected generation.
    if (
      live.some(
        (r) =>
          !selected ||
          r.hostSessionId !== selected.hostSessionId ||
          r.generation !== selected.generation
      )
    ) {
      const latest = candidates.sort((a, b) => b.generation - a.generation)[0]
      if (latest && (!selected || latest.generation > selected.generation)) selected = latest
    }
    if (selected) sessions.set(selected.hostSessionId, selected)
    for (const r of live) runtimes.set(r.runtimeId, r)
  }
  const selected = [...sessions.values()]
  const events = selected.flatMap((s) => {
    const e = db.hrcEvents.findLatestBySession(s.hostSessionId, s.generation)
    return e ? [e] : []
  })
  // Titles are keyed too: decorateSessionTitles enumerates the entire title table.
  return json({
    sessions: selected.map((s) => {
      const title = db.sessionTitles.getByHostSessionId(s.hostSessionId)?.title
      return {
        ...s,
        laneRef: canonicalLaneRef(s.laneRef),
        ...(title === undefined ? {} : { title }),
      }
    }),
    runtimes: [...runtimes.values()].map((r) => projectPresentationRuntime(db, r)),
    events,
  })
}
