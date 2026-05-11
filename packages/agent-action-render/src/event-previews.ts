import { MAX_PREVIEW_CHARS, truncateText } from './budgets.js'

type PreviewExtractor = (payload: Record<string, unknown>) => string | undefined

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export const PRIMARY_FIELD_BY_KIND: Record<string, PreviewExtractor> = {
  'codex.user_prompt': (payload) =>
    stringField(payload, 'prompt') ?? stringField(asRecord(payload['message']), 'content'),
  'turn.user_prompt': (payload) =>
    stringField(asRecord(payload['message']), 'content') ?? stringField(payload, 'prompt'),
  'codex.tool_decision': (payload) =>
    stringField(payload, 'decision') ?? stringField(payload, 'summary'),
  notice: (payload) => stringField(payload, 'message'),
  'hook.ingested': (payload) => stringField(payload, 'hookName') ?? stringField(payload, 'name'),
  message_end: (payload) => stringField(asRecord(payload['message']), 'content'),
}

export function extractEventPreview(
  eventKind: string,
  payload: Record<string, unknown>
): string | undefined {
  return PRIMARY_FIELD_BY_KIND[eventKind]?.(payload)
}

export function formatEventPreviewLine(input: {
  icon: string
  eventKind: string
  preview?: string | undefined
}): string {
  if (input.preview === undefined) {
    return `${input.icon} ${input.eventKind}`
  }
  const prefix = `${input.icon} ${input.eventKind}  "`
  const preview = input.preview.replace(/\s+/g, ' ').trim()
  return `${prefix}${truncateText(preview, MAX_PREVIEW_CHARS, '…')}"`
}
