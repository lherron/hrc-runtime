import { CliUsageError } from 'cli-kit'
import { type HrcCollectiveMessageRecord, HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

/**
 * One selector grammar for every command that names a single message, so each
 * identity a command prints round-trips back into that same command (T-06970).
 *
 *   17932           bare numeric — accepted only when @N and #N are unambiguous
 *   seq:17932       collective seq, explicit
 *   @17932          collective seq, explicit
 *   #12             node-local message seq, the `#N` half of `@N/#N`
 *   msg-<uuid>      message id
 *   msg:msg-<uuid>  message id, explicit
 *
 * Pre-collective daemons omit `collectiveSeq`; there a collective-seq selector
 * falls back to the node-local seq, which is the only seq such a daemon prints.
 */
export type MessageSelector =
  | { readonly kind: 'bareSeq'; readonly input: string; readonly seq: number }
  | { readonly kind: 'collectiveSeq'; readonly input: string; readonly seq: number }
  | { readonly kind: 'messageSeq'; readonly input: string; readonly seq: number }
  | { readonly kind: 'messageId'; readonly input: string; readonly messageId: string }

export const MESSAGE_SELECTOR_SYNTAX =
  '<seq> | seq:<seq> | @<collectiveSeq> | #<messageSeq> | <messageId> | msg:<messageId>'

function parseSeq(value: string, input: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new CliUsageError(`invalid ${label}: ${input}`)
  const seq = Number(value)
  if (!Number.isSafeInteger(seq) || seq < 1) throw new CliUsageError(`invalid ${label}: ${input}`)
  return seq
}

export function parseMessageSelector(input: string): MessageSelector {
  const normalized = input.trim()
  if (normalized.length === 0) throw new CliUsageError('message selector must not be empty')

  if (normalized.startsWith('@')) {
    return {
      kind: 'collectiveSeq',
      input: normalized,
      seq: parseSeq(normalized.slice('@'.length), normalized, 'collective sequence'),
    }
  }
  if (normalized.startsWith('#')) {
    return {
      kind: 'messageSeq',
      input: normalized,
      seq: parseSeq(normalized.slice('#'.length), normalized, 'message sequence'),
    }
  }
  if (normalized.startsWith('seq:')) {
    return {
      kind: 'collectiveSeq',
      input: normalized,
      seq: parseSeq(normalized.slice('seq:'.length), normalized, 'message sequence'),
    }
  }
  if (normalized.startsWith('msg:')) {
    const messageId = normalized.slice('msg:'.length).trim()
    if (messageId.length === 0) throw new CliUsageError(`invalid message ID: ${normalized}`)
    return { kind: 'messageId', input: normalized, messageId }
  }
  if (/^\d+$/.test(normalized)) {
    return {
      kind: 'bareSeq',
      input: normalized,
      seq: parseSeq(normalized, normalized, 'message sequence'),
    }
  }
  return { kind: 'messageId', input: normalized, messageId: normalized }
}

async function fetchByMessageId(
  client: HrcClient,
  messageId: string,
  input: string
): Promise<HrcCollectiveMessageRecord> {
  const result = await client.listMessages({ messageId, limit: 1 })
  const record = result.messages.find((candidate) => candidate.messageId === messageId)
  if (record === undefined) throw new CliUsageError(`message not found: ${input}`)
  return record
}

/**
 * A node-local seq is not a pushable list filter, so trace is the resolver: it
 * is the one read that indexes messages by the seq the local node assigned.
 */
async function messageIdForMessageSeq(
  client: HrcClient,
  selector: Extract<MessageSelector, { kind: 'messageSeq' }>
): Promise<string> {
  const trace = await client.traceMessage({ messageSeq: selector.seq })
  return trace.message.messageId
}

async function findByMessageSeq(
  client: HrcClient,
  selector: Extract<MessageSelector, { kind: 'bareSeq' }>
): Promise<HrcCollectiveMessageRecord | undefined> {
  try {
    const trace = await client.traceMessage({ messageSeq: selector.seq })
    return trace.message
  } catch (error) {
    if (
      error instanceof HrcDomainError &&
      error.code === HrcErrorCode.MALFORMED_REQUEST &&
      error.message === `message not found: ${selector.seq}`
    ) {
      return undefined
    }
    throw error
  }
}

async function findByCollectiveSeq(
  client: HrcClient,
  seq: number
): Promise<HrcCollectiveMessageRecord | undefined> {
  const result = await client.listMessages({ afterSeq: seq - 1, limit: 1 })
  return result.messages.find(
    (candidate) => (candidate.collectiveSeq ?? candidate.messageSeq) === seq
  )
}

async function fetchBareSeqRecord(
  client: HrcClient,
  selector: Extract<MessageSelector, { kind: 'bareSeq' }>
): Promise<HrcCollectiveMessageRecord> {
  const [collectiveRecord, localRecord] = await Promise.all([
    findByCollectiveSeq(client, selector.seq),
    findByMessageSeq(client, selector),
  ])

  if (
    collectiveRecord !== undefined &&
    localRecord !== undefined &&
    collectiveRecord.messageId !== localRecord.messageId
  ) {
    throw new CliUsageError(
      `ambiguous message sequence ${selector.seq}: @${selector.seq} (collective seq) is ${collectiveRecord.messageId}, but #${selector.seq} (node-local message seq) is ${localRecord.messageId}; use @${selector.seq} or '#${selector.seq}'`
    )
  }

  const record = collectiveRecord ?? localRecord
  if (record === undefined) throw new CliUsageError(`message not found: ${selector.input}`)
  return record
}

async function fetchRecord(
  client: HrcClient,
  selector: MessageSelector
): Promise<HrcCollectiveMessageRecord> {
  if (selector.kind === 'messageId') {
    return fetchByMessageId(client, selector.messageId, selector.input)
  }
  if (selector.kind === 'bareSeq') {
    return fetchBareSeqRecord(client, selector)
  }
  if (selector.kind === 'messageSeq') {
    const messageId = await messageIdForMessageSeq(client, selector)
    return fetchByMessageId(client, messageId, selector.input)
  }
  const record = await findByCollectiveSeq(client, selector.seq)
  if (record === undefined) throw new CliUsageError(`message not found: ${selector.input}`)
  return record
}

export async function resolveMessageSelector(
  client: HrcClient,
  input: string
): Promise<{
  selector: MessageSelector
  record: HrcCollectiveMessageRecord
}> {
  const selector = parseMessageSelector(input)
  return { selector, record: await fetchRecord(client, selector) }
}

/**
 * Canonical message id for a selector, for callers that want the id rather than
 * the record (trace). Id selectors resolve without a round trip.
 */
export async function resolveMessageId(
  client: HrcClient,
  input: string
): Promise<{ selector: MessageSelector; messageId: string }> {
  const selector = parseMessageSelector(input)
  if (selector.kind === 'messageId') return { selector, messageId: selector.messageId }
  if (selector.kind === 'bareSeq') {
    const record = await fetchBareSeqRecord(client, selector)
    return { selector, messageId: record.messageId }
  }
  if (selector.kind === 'messageSeq') {
    return { selector, messageId: await messageIdForMessageSeq(client, selector) }
  }
  const record = await fetchRecord(client, selector)
  return { selector, messageId: record.messageId }
}

/**
 * Resolve the exclusive history cursor used by `messages --after`. The server
 * cursor is collective, so explicit collective selectors pass through while
 * node-local and bare selectors first resolve to one message identity.
 */
export async function resolveMessageAfterSeq(client: HrcClient, input: string): Promise<number> {
  const selector = parseMessageSelector(input)
  if (selector.kind === 'messageId') {
    throw new CliUsageError(
      `invalid --after cursor ${selector.input}: expected @<collectiveSeq>, '#<messageSeq>', seq:<collectiveSeq>, or an unambiguous bare sequence`
    )
  }
  if (selector.kind === 'collectiveSeq') return selector.seq

  const record = await fetchRecord(client, selector)
  return record.collectiveSeq ?? record.messageSeq
}
