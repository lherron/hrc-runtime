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

export function lifecycleKindForBrokerEvent(type: string): string | undefined {
  return BROKER_TO_HRC_LIFECYCLE_KIND[type]
}
