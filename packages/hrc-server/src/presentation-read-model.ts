/**
 * `GET /v1/presentation/runtimes` — the presentation read model (T-07594;
 * durable law `hrc-runtime.viewer-presentation-sidecar` §5.3–5.4).
 *
 * A projection over the STORE ONLY. It reads runtime rows, the persisted §5.1
 * presentation record, the hosting/tmux state already on the row, and
 * `session_titles`, and returns. It deliberately does NOT call
 * `reconcileTmuxRuntimeLiveness`, probe tmux, attach, or append events — a
 * presentation consumer polls this on every reconcile, and a read that can mark
 * a runtime dead would let a cosmetic process change runtime state (§7
 * invariants 3 and 6).
 *
 * The consequence is accepted, not accidental: a row here can name a runtime
 * whose tmux has already died, until hrc's own sweep marks it. That is the same
 * window that exists today between substrate death and sweep.
 */
import type {
  HrcPresentationRuntimeRow,
  HrcRuntimeSnapshot,
  ListPresentationRuntimesResponse,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { canOperatorAttach } from './broker/runtime-hosting.js'
import { isRuntimeUnavailableStatus, json } from './server-util.js'

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
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    scopeRef: runtime.scopeRef,
    laneRef: runtime.laneRef,
    generation: runtime.generation,
    status: runtime.status,
    // Absent — not defaulted — for generations that predate the record (§5.5).
    ...(runtime.presentation !== undefined ? { presentation: runtime.presentation } : {}),
    ...(socketPath !== undefined
      ? { tmux: { socketPath, attachTarget: getBrokerRuntimeTmuxAttachTarget(runtime) } }
      : {}),
    ...(title !== undefined ? { title } : {}),
  }
}

export function handleListPresentationRuntimes(db: HrcDatabase): Response {
  const runtimes = db.runtimes
    .listAll()
    .filter((runtime) => !isRuntimeUnavailableStatus(runtime.status))
    .map((runtime) => projectPresentationRuntime(db, runtime))

  return json({ ok: true, runtimes } satisfies ListPresentationRuntimesResponse)
}
