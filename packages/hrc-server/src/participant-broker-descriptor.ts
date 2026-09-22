import {
  type ParticipantBrokerDescriptor,
  neutralParticipantBrokerDescriptorHash,
  validateParticipantBrokerDescriptor,
} from 'spaces-runtime-contracts'

/**
 * Read a descriptor that has already crossed the external attach boundary.
 * It is deliberately not a v1-profile fallback: a row containing retired
 * material is not a runnable participant preparation.
 */
export function parseParticipantBrokerDescriptor(
  json: string | undefined,
  label = 'participant broker descriptor'
): ParticipantBrokerDescriptor {
  if (json === undefined) throw new Error(`participant attempt is missing ${label}`)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error(`participant attempt has invalid ${label}`)
  }
  const validated = validateParticipantBrokerDescriptor(value)
  if (!validated.ok) {
    throw new Error(
      `participant attempt has invalid ${label}: ${validated.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`
    )
  }
  if (validated.value.descriptorHash !== neutralParticipantBrokerDescriptorHash(validated.value)) {
    throw new Error(`participant attempt ${label} hash does not match its neutral semantics`)
  }
  return validated.value
}
