import { CliUsageError } from 'cli-kit'
import type { HrcCollectiveMessageRecord, HrcMessageFilter } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

export type MessageSelector =
  | { readonly kind: 'seq'; readonly input: string; readonly seq: number }
  | { readonly kind: 'messageId'; readonly input: string; readonly messageId: string }

function parsePositiveSeq(value: string, input: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`invalid message sequence: ${input}`)
  }
  const seq = Number(value)
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new CliUsageError(`invalid message sequence: ${input}`)
  }
  return seq
}

export function parseMessageSelector(input: string): MessageSelector {
  const normalized = input.trim()
  if (normalized.length === 0) throw new CliUsageError('message selector must not be empty')

  if (normalized.startsWith('seq:')) {
    return {
      kind: 'seq',
      input: normalized,
      seq: parsePositiveSeq(normalized.slice('seq:'.length), normalized),
    }
  }
  if (normalized.startsWith('msg:')) {
    const messageId = normalized.slice('msg:'.length).trim()
    if (messageId.length === 0) throw new CliUsageError(`invalid message ID: ${normalized}`)
    return { kind: 'messageId', input: normalized, messageId }
  }
  if (/^\d+$/.test(normalized)) {
    return { kind: 'seq', input: normalized, seq: parsePositiveSeq(normalized, normalized) }
  }
  return { kind: 'messageId', input: normalized, messageId: normalized }
}

function selectorFilter(selector: MessageSelector): HrcMessageFilter {
  return selector.kind === 'seq'
    ? { afterSeq: selector.seq - 1, limit: 1 }
    : { messageId: selector.messageId, limit: 1 }
}

function matchesSelector(record: HrcCollectiveMessageRecord, selector: MessageSelector): boolean {
  return selector.kind === 'seq'
    ? (record.collectiveSeq ?? record.messageSeq) === selector.seq
    : record.messageId === selector.messageId
}

export async function resolveMessageSelector(
  client: HrcClient,
  input: string
): Promise<{
  selector: MessageSelector
  record: HrcCollectiveMessageRecord
}> {
  const selector = parseMessageSelector(input)
  const result = await client.listMessages(selectorFilter(selector))
  const record = result.messages.find((candidate) => matchesSelector(candidate, selector))
  if (record === undefined) throw new CliUsageError(`message not found: ${input}`)
  return { selector, record }
}
