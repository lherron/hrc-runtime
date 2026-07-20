/**
 * Runtime-stable capability inherited by dispatchers running inside an HRC
 * runtime. The value is deliberately a runtime identity, never a run identity:
 * one runtime can execute many rotating runs while keeping this environment
 * value stable for its lifetime.
 */
export const HRC_BIRTH_CREDENTIAL_ENV = 'HRC_BIRTH_CREDENTIAL'

/** Opaque on the wire. Only hrc-server may interpret or validate the value. */
export type HrcBirthCredential = string
