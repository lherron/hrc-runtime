import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

/**
 * Handler-server double for participant establishment suites.
 *
 * Owns `notifyEvent`: establishment appends lifecycle events and notifies
 * listeners on the server itself (T-08395). A hand-rolled double without it
 * throws `server.notifyEvent is not a function` at the first append. Tests pass
 * only what differs (db, options, controller, attach token, registry…).
 */
export function participantServerDouble(
  fields: Record<string, unknown>
): HrcServerInstanceForHandlers {
  return {
    stopping: false,
    notifyEvent: () => undefined,
    ctx: { notifyEvent: () => undefined },
    ...fields,
  } as unknown as HrcServerInstanceForHandlers
}
