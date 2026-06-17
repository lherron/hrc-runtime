import { createHash } from 'node:crypto'

export const BROKER_TO_HRC_LIFECYCLE_POLICY_ID = 'hrc-core.broker-to-hrc-lifecycle/v1'
export const BROKER_TO_HRC_LIFECYCLE_POLICY_VERSION = 'v1'

export const BROKER_TO_HRC_LIFECYCLE_KIND: Partial<Record<string, string>> = {
  'input.accepted': 'turn.accepted',
  'turn.started': 'turn.started',
  'user.message': 'turn.user_prompt',
  'assistant.message.completed': 'turn.message',
  'tool.call.started': 'turn.tool_call',
  'tool.call.completed': 'turn.tool_result',
  'tool.call.failed': 'turn.tool_result',
  'turn.completed': 'turn.completed',
  'turn.failed': 'turn.completed',
  'turn.interrupted': 'turn.completed',
}

export function brokerToHrcLifecyclePolicyHash(mapping: Partial<Record<string, string>>): string {
  const entries = Object.entries(mapping)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`
}

export const BROKER_TO_HRC_LIFECYCLE_POLICY_HASH = brokerToHrcLifecyclePolicyHash(
  BROKER_TO_HRC_LIFECYCLE_KIND
)

export function lifecycleKindForBrokerEvent(type: string): string | undefined {
  return BROKER_TO_HRC_LIFECYCLE_KIND[type]
}
