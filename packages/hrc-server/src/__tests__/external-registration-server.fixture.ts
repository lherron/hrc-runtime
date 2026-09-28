import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

/**
 * Handler-server double for the external-registration (EPR) suites.
 *
 * Owns the members every EPR mint/establish path touches, including
 * `notifyEvent`: minting a registration appends `session.created` and notifies
 * listeners on the server itself (T-08395). A hand-rolled double without it
 * throws `server.notifyEvent is not a function` at the first mint. Tests pass
 * only what differs (db, options, controller, attach token, registry…).
 */
export function externalRegistrationServerDouble(
  fields: Record<string, unknown>
): HrcServerInstanceForHandlers {
  return {
    externalParticipantClients: new Map(),
    externalRegistrationOperations: new Map(),
    externalRegistrationEstablishmentOperations: new Map(),
    stopping: false,
    notifyEvent: () => undefined,
    ctx: { notifyEvent: () => undefined },
    ...fields,
  } as unknown as HrcServerInstanceForHandlers
}
