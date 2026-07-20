/**
 * Runtime-stable capability inherited by dispatchers running inside an HRC
 * runtime. The value is deliberately a runtime identity, never a run identity:
 * one runtime can execute many rotating runs while keeping this environment
 * value stable for its lifetime.
 */
export const HRC_BIRTH_CREDENTIAL_ENV = 'HRC_BIRTH_CREDENTIAL'

/** Opaque on the wire. Only hrc-server may interpret or validate the value. */
export type HrcBirthCredential = string

/**
 * Producer-owned proof that one exact target is being dispatched as a child.
 *
 * This is deliberately separate from `HrcBirthCredential`: the credential
 * proves only a live parent origin, while this value carries target-bound
 * child intent. Servers validate the target against the requested scope and
 * never infer it from agent identity, task claims, scope names, or placement.
 */
export type HrcChildDispatchIntent = {
  targetScopeRef: string
}
