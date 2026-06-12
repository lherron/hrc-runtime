/**
 * BrokerControllerError — the controller's typed error class.
 *
 * Extracted verbatim from controller.ts (pure mechanical move). Re-exported from
 * controller.ts so the public export surface is unchanged.
 */
export class BrokerControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'BrokerControllerError'
  }
}
