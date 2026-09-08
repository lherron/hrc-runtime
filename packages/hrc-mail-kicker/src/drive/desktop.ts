/**
 * Mail routing for a permanently registered Codex desktop conversation
 * (campaign P-00502 leg D; approved design §6, "Queue and mail semantics").
 *
 * The kicker's ordinary policy assumes HRC owns the seat: if nothing is seated
 * it BIRTHS one, and if the birth keeps failing it tells the sender the address
 * is `undeliverable`. Both halves are wrong for a desktop conversation, and
 * wrong in a way that is worse than not delivering:
 *
 *  - HRC does not own the desktop process. A birth here would start a headless
 *    Codex CLI on `stella@hrc-ios:primary-nova` — a SECOND runtime answering an
 *    address that names one specific conversation in Lance's ChatGPT app. The
 *    contract forbids it in as many words: "suppress ordinary cold-birth
 *    fallback for reserved desktop scopes, including after observer/runtime
 *    detach", and "no fallback to a newer standalone CLI".
 *  - Desktop unavailability is a NORMAL state with no promised bound. The queue
 *    watcher only starts loaded, eligible threads, so a conversation Lance has
 *    not opened may wait indefinitely and that is the designed behavior, not a
 *    delivery failure. §6: "Desktop unavailability leaves work pending under its
 *    registered address." Failing it `undeliverable` after five sweeps would
 *    tell the sender a lie about a conversation that is merely closed.
 *
 * So a desktop target has exactly one deferral verb — leave it pending, say why
 * — and this module is the single predicate the drive, the birth sweep and D3's
 * lapse path all consult. It reads the reservation table directly because that
 * table IS the fence: a row exists for the life of the conversation, whether or
 * not anything is currently observing it.
 */
import type { DesktopThreadRegistration } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import { kickerScopeRefFor } from './authority.js'

/**
 * The registration behind this target session ref, if it names one.
 *
 * Keyed on the SCOPE, not on any live runtime: a detached conversation, one
 * whose observer HRC just stopped, and one Lance has not opened in a week all
 * answer the same way, which is the whole point.
 */
export function desktopRegistrationForTarget(
  server: MailKickerContext,
  targetSessionRef: string
): DesktopThreadRegistration | undefined {
  const scopeRef = kickerScopeRefFor(targetSessionRef)
  if (scopeRef === undefined) return undefined
  return server.db.desktopThreadRegistrations.getByScopeRef(scopeRef) ?? undefined
}

/** Cheap boolean form for the guards that need no registration detail. */
export function isDesktopTarget(server: MailKickerContext, targetSessionRef: string): boolean {
  return desktopRegistrationForTarget(server, targetSessionRef) !== undefined
}

/**
 * Report that mail for a desktop conversation is WAITING, and change nothing.
 *
 * Deliberately INFO and deliberately not a refusal: no strike is charged, no
 * intent is opened or cleared, no birth is attempted and no envelope is failed.
 * The line exists so "nothing happened" is legible — a pending envelope against
 * a closed conversation is correct behavior, and correct behavior that logs
 * nothing is indistinguishable from a wedge.
 */
export function deferDesktopDelivery(
  server: MailKickerContext,
  input: {
    readonly targetSessionRef: string
    readonly registration: DesktopThreadRegistration
    readonly reason: string
    readonly envelopeIds?: readonly string[] | undefined
    readonly detail?: Record<string, unknown> | undefined
  }
): void {
  server.log('INFO', 'wrkq.kicker.desktop_delivery_deferred', {
    targetSessionRef: input.targetSessionRef,
    scopeRef: input.registration.scopeRef,
    nativeThreadId: input.registration.nativeThreadId,
    reason: input.reason,
    ...(input.envelopeIds === undefined ? {} : { envelopeIds: [...input.envelopeIds] }),
    ...(input.detail ?? {}),
    note: 'mail stays pending under the registered desktop address; no birth, no failure',
  })
}
