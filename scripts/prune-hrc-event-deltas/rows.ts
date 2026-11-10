export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type SpillBrokerRow = {
  invocation_id: string
  seq: number
  runtime_id: string
  broker_event_json: string
  created_at: string
}

export type SpillLifecycleRow = {
  hrc_seq: number
  runtime_id: string | null
  payload_json: string
  ts: string
}
