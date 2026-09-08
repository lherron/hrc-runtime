/**
 * The trigger that turns a registration into a live observer (T-08294 §3, §5).
 *
 * Registration and observation are deliberately separate facts — a desktop
 * conversation keeps its permanent address whether or not HRC is watching it —
 * but they are not independent ACTIONS. Without this module `attachDesktopObserver`
 * is unreachable: registrations accumulate addresses and every one of them
 * reports `unattached` forever.
 *
 * Two properties matter more than the mechanism:
 *
 *  - **Attachment never blocks registration.** The hook is in front of a turn
 *    Lance is waiting on, and the permanent mapping is already committed by the
 *    time we get here. So this is scheduled, not awaited, and a failure is
 *    DEGRADED OBSERVATION recorded on the registration — never an unregistered
 *    conversation and never a statement about desktop.
 *  - **HRC may reattach its own observer freely.** That is the one lifecycle
 *    power §3 grants it. Re-registration of a conversation whose observer died
 *    starts a new one on the SAME permanent address; it does not mint a name, it
 *    does not touch desktop, and it does not birth a CLI.
 */

import { existsSync } from 'node:fs'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { DesktopThreadRegistration } from 'hrc-store-sqlite'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

import { writeServerLog } from '../server-log.js'
import { CODEX_DESKTOP_BROKER_DRIVER, type CodexDesktopDriverSpec } from './observer-attachment.js'

/**
 * Conventional location of the desktop-bundled Codex on macOS. This is a
 * CANDIDATE that must exist on disk, never a hardcoded production path: the
 * compatibility readback is explicit that the observed values are observations
 * of one installation. An absent bundle leaves observation pending with a
 * diagnostic rather than handing the driver a path to nothing.
 */
const CONVENTIONAL_DESKTOP_BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/codex'

/** Operator override, for a desktop installed somewhere else. */
export const DESKTOP_BUNDLE_ENV = 'HRC_CODEX_DESKTOP_BUNDLE'

/**
 * Resolve the bundled executable the driver should use.
 *
 * Order is evidence-first: what the helper observed inside desktop's own process
 * beats an operator override, which beats a convention. Every candidate must
 * exist, so a stale recorded path falls through to one that does not.
 */
export function resolveDesktopBundleExecutable(input: {
  readonly reported?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}): string | undefined {
  const env = input.env ?? process.env
  const candidates = [input.reported, env[DESKTOP_BUNDLE_ENV], CONVENTIONAL_DESKTOP_BUNDLE]
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)
  )
}

/**
 * The observer runtime currently serving a registration, if any.
 *
 * "Currently" excludes terminated/disposed rows on purpose: an observer that
 * exited is not an observer, and §5 requires that an observer exit be
 * recoverable rather than permanent. It says NOTHING about the desktop thread.
 */
export function liveDesktopObserverRuntime(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration
): HrcRuntimeSnapshot | undefined {
  return server.db.runtimes
    .listByHostSessionId(registration.hostSessionId)
    .find((runtime) => runtime.status !== 'terminated' && runtime.status !== 'disposed')
}

/** In-flight attachments, per server instance. One attempt per registration. */
const attachmentOperations = new WeakMap<HrcServerInstanceForHandlers, Map<string, Promise<void>>>()

function operationsFor(server: HrcServerInstanceForHandlers): Map<string, Promise<void>> {
  let operations = attachmentOperations.get(server)
  if (operations === undefined) {
    operations = new Map<string, Promise<void>>()
    attachmentOperations.set(server, operations)
  }
  return operations
}

export type DesktopAttachmentDisposition =
  | { readonly scheduled: true }
  | { readonly scheduled: false; readonly reason: string; readonly detail: string }

/**
 * Build the private driver spec for a registration, or say why it cannot be built.
 *
 * The rollout path is required and must EXIST. The compatibility readback records
 * that a freshly started thread may not have persisted a rollout yet, so an
 * absent one is a retryable pending — the next hook attaches — not a failure of
 * the registration and not a claim about desktop.
 */
export function buildDesktopDriverSpec(
  registration: DesktopThreadRegistration,
  env?: Record<string, string | undefined> | undefined
):
  | { readonly driver: CodexDesktopDriverSpec }
  | { readonly reason: string; readonly detail: string } {
  const rolloutPath = registration.rolloutPath
  if (rolloutPath === undefined || !existsSync(rolloutPath)) {
    return {
      reason: 'rollout_unavailable',
      detail:
        rolloutPath === undefined
          ? 'registration has no recorded rollout path yet'
          : `rollout ${rolloutPath} is not readable`,
    }
  }
  const bundleExecutable = resolveDesktopBundleExecutable({
    ...(registration.bundlePath === undefined ? {} : { reported: registration.bundlePath }),
    ...(env === undefined ? {} : { env }),
  })
  if (bundleExecutable === undefined) {
    return {
      reason: 'bundle_unresolved',
      detail: `no desktop-bundled Codex executable found; set ${DESKTOP_BUNDLE_ENV}`,
    }
  }
  return {
    driver: {
      kind: CODEX_DESKTOP_BROKER_DRIVER,
      bundleExecutable,
      codexHome: registration.homeIdentity,
      sqliteHome: registration.sqliteHome,
      threadId: registration.nativeThreadId,
      rolloutPath,
    },
  }
}

/**
 * Schedule (never await) an observer attachment for a registration.
 *
 * Idempotent three ways: a live observer short-circuits, an in-flight attempt is
 * joined rather than duplicated, and the broker controller itself is the final
 * fence. Returning a disposition rather than a promise is deliberate — callers
 * report what was scheduled; they must not be able to wait on it.
 */
export function scheduleDesktopObserverAttachment(
  server: HrcServerInstanceForHandlers,
  registration: DesktopThreadRegistration
): DesktopAttachmentDisposition {
  const live = liveDesktopObserverRuntime(server, registration)
  if (live !== undefined) {
    return {
      scheduled: false,
      reason: 'already_attached',
      detail: `runtime ${live.runtimeId} is already observing this conversation`,
    }
  }
  const operations = operationsFor(server)
  if (operations.has(registration.registrationKey)) {
    return {
      scheduled: false,
      reason: 'attachment_in_flight',
      detail: 'an attachment attempt for this conversation is already running',
    }
  }
  const built = buildDesktopDriverSpec(registration)
  if (!('driver' in built)) {
    writeServerLog('INFO', 'desktop_observer.attach_deferred', {
      scopeRef: registration.scopeRef,
      nativeThreadId: registration.nativeThreadId,
      reason: built.reason,
      detail: built.detail,
    })
    return { scheduled: false, reason: built.reason, detail: built.detail }
  }

  const operation = server
    .attachDesktopObserver({ registration, driver: built.driver })
    .then((outcome) => {
      if (!outcome.attached) {
        // Degraded observation, recorded and left recoverable. The permanent
        // address, the mapping and the desktop conversation are all untouched.
        writeServerLog('WARN', 'desktop_observer.attach_degraded', {
          scopeRef: registration.scopeRef,
          nativeThreadId: registration.nativeThreadId,
          reason: outcome.reason,
          detail: outcome.detail,
        })
      }
    })
    .catch((error: unknown) => {
      writeServerLog('WARN', 'desktop_observer.attach_error', {
        scopeRef: registration.scopeRef,
        nativeThreadId: registration.nativeThreadId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      operations.delete(registration.registrationKey)
    })
  operations.set(registration.registrationKey, operation)
  return { scheduled: true }
}
