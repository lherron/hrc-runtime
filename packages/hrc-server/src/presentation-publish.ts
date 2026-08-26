/**
 * Publish one invocation's viewer-presentation decision (T-07594; durable law
 * `hrc-runtime.viewer-presentation-sidecar` §5.1–5.2).
 *
 * This is the single point every start/reuse invocation that would spawn an
 * in-daemon Ghostty viewer now goes through. It does three things, in order:
 *
 *  1. folds this invocation into the runtime row's DURABLE presentation record
 *     — `operatorAttachable` from the hosting state, and monotone
 *     `viewerRequested` which flips false → true on the first non-suppressed
 *     invocation of the generation and is never cleared;
 *  2. appends + notifies `runtime.presentation`, carrying the invocation-local
 *     `operatorAttachPending` (which is deliberately NEVER persisted) plus the
 *     tmux coordinates a consumer would otherwise have to obtain from an
 *     EFFECTFUL read;
 *  3. calls the existing in-daemon `spawnBrokerHeadlessViewer` with the same
 *     options, so behavior is unchanged until Phase 4 deletes it.
 *
 * Publishing is observational and must never gate a dispatch: every step is
 * wrapped, and a failure degrades to a log line, exactly as the viewer spawn
 * it fronts already does.
 */
import type { HrcRuntimePresentationRecord, HrcRuntimeSnapshot } from 'hrc-core'

import {
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSocketPath,
} from './broker-decisions.js'
import { canOperatorAttach } from './broker/runtime-hosting.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

export type PublishPresentationOptions = {
  /**
   * This invocation's operator terminal will attach, so the viewer is skipped
   * for THIS invocation only. Invocation-local: it rides on the event and is
   * never written to the runtime row.
   */
  operatorAttachPending?: boolean | undefined
}

/**
 * Fold this invocation into the persisted record. Monotone in `viewerRequested`
 * and latest-wins in `viewerWindow`; `operatorAttachable` always reflects the
 * hosting state as of this invocation.
 */
export function foldPresentationRecord(
  previous: HrcRuntimePresentationRecord | undefined,
  invocation: {
    operatorAttachable: boolean
    operatorAttachPending: boolean
    viewerWindow: string | undefined
  }
): HrcRuntimePresentationRecord {
  const viewerWindow = invocation.viewerWindow ?? previous?.viewerWindow
  return {
    operatorAttachable: invocation.operatorAttachable,
    viewerRequested: previous?.viewerRequested === true || !invocation.operatorAttachPending,
    ...(viewerWindow !== undefined ? { viewerWindow } : {}),
  }
}

export async function publishPresentation(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  options: PublishPresentationOptions = {}
): Promise<void> {
  const operatorAttachPending = options.operatorAttachPending === true
  try {
    // Re-read the row: callers hold snapshots taken before the substrate was
    // leased, and the monotone fold must read the record that is actually
    // persisted, not whatever the caller happened to be carrying.
    const current = this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    const operatorAttachable = canOperatorAttach(current)
    const session = this.db.sessions.getByHostSessionId(current.hostSessionId)
    const record = foldPresentationRecord(current.presentation, {
      operatorAttachable,
      operatorAttachPending,
      viewerWindow: session?.lastAppliedIntentJson?.presentation?.viewerWindow,
    })

    const now = timestamp()
    this.db.runtimes.update(current.runtimeId, { presentation: record, updatedAt: now })

    const socketPath = operatorAttachable ? getBrokerRuntimeTmuxSocketPath(current) : undefined
    const title = this.db.sessionTitles.getByHostSessionId(current.hostSessionId)?.title
    const event = appendHrcEvent(this.db, 'runtime.presentation', {
      ts: now,
      hostSessionId: current.hostSessionId,
      scopeRef: current.scopeRef,
      laneRef: current.laneRef,
      generation: current.generation,
      runtimeId: current.runtimeId,
      payload: {
        invocation: { operatorAttachPending },
        presentation: record,
        ...(socketPath !== undefined
          ? {
              tmux: {
                socketPath,
                attachTarget: getBrokerRuntimeTmuxAttachTarget(current),
              },
            }
          : {}),
        ...(title !== undefined ? { title } : {}),
      },
    })
    this.notifyEvent(event)
  } catch (error) {
    writeServerLog('WARN', 'runtime_presentation.publish_failed', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Until Phase 4 removes the in-daemon viewer, the publish still fronts it.
  await this.spawnBrokerHeadlessViewer(runtime, options)
}

export const presentationPublishMethods = {
  publishPresentation,
}

export type PresentationPublishMethods = typeof presentationPublishMethods
