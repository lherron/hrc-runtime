import type { ParticipantAdapter } from 'spaces-runtime-contracts'

/**
 * Read-only, server-composed adapters for generic participant classes. HRC
 * never discovers or loads an adapter from a registration request.
 */
export class ParticipantAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, ParticipantAdapter>

  constructor(adapters: readonly ParticipantAdapter[]) {
    const byId = new Map<string, ParticipantAdapter>()
    for (const adapter of adapters) {
      if (byId.has(adapter.adapterId)) {
        throw new Error(
          `participant adapter registry contains duplicate adapterId "${adapter.adapterId}"`
        )
      }
      byId.set(adapter.adapterId, adapter)
    }
    this.#adapters = byId
  }

  get(adapterId: string): ParticipantAdapter | undefined {
    return this.#adapters.get(adapterId)
  }
}

export function requireParticipantClassAdapters(
  adapters: ParticipantAdapterRegistry,
  classes: readonly { classId: string; adapterId?: string | undefined }[]
): void {
  for (const registrationClass of classes) {
    if (registrationClass.adapterId === undefined) continue
    if (adapters.get(registrationClass.adapterId) === undefined) {
      throw new Error(
        `participant registration class "${registrationClass.classId}" references unavailable adapterId "${registrationClass.adapterId}"`
      )
    }
  }
}
