import { selectFinalTurnMessage } from 'hrc-core'
import type { HrcBrokerInvocationEventRecord } from 'hrc-core'
import type { TranscriptTerminalStatus } from 'hrc-store-sqlite'

export const TRANSCRIPT_COLUMN_MAX_BYTES = 256 * 1024

export type TurnDocument = {
  invocationId: string
  runtimeId: string
  seqFrom: number
  seqTo: number
  startedAt: string
  completedAt: string
  terminalStatus: TranscriptTerminalStatus
  userText: string
  finalText: string
  midText: string
  messageCount: number
  truncated: boolean
}

type Payload = Record<string, unknown>

function record(value: unknown): Payload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : undefined
}

function payload(event: HrcBrokerInvocationEventRecord): unknown {
  try {
    const decoded = JSON.parse(event.brokerEventJson) as unknown
    const outer = record(decoded)
    return outer && Object.hasOwn(outer, 'payload') ? outer['payload'] : decoded
  } catch {
    return undefined
  }
}

function textBlocks(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => record(block))
    .filter((block): block is Payload => block?.['type'] === 'text')
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

function eventText(event: HrcBrokerInvocationEventRecord): string {
  const decoded = payload(event)
  const value = record(decoded)?.['content'] ?? decoded
  return textBlocks(value)
}

function terminalStatus(type: string): TranscriptTerminalStatus | undefined {
  if (type === 'turn.completed') return 'completed'
  if (type === 'turn.failed') return 'failed'
  if (type === 'turn.interrupted') return 'interrupted'
  return undefined
}

function cap(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= TRANSCRIPT_COLUMN_MAX_BYTES) {
    return { text, truncated: false }
  }
  let clipped = Buffer.from(text, 'utf8').subarray(0, TRANSCRIPT_COLUMN_MAX_BYTES).toString('utf8')
  while (Buffer.byteLength(clipped, 'utf8') > TRANSCRIPT_COLUMN_MAX_BYTES) {
    clipped = clipped.slice(0, -1)
  }
  return { text: clipped, truncated: true }
}

/** Build one prose-only document from a ledger-derived terminated segment. */
export function extractTurnDocument(
  inputEvents: readonly HrcBrokerInvocationEventRecord[]
): TurnDocument | undefined {
  const events = [...inputEvents].sort((left, right) => left.seq - right.seq)
  const first = events[0]
  const terminal = events.at(-1)
  if (!first || !terminal) return undefined
  const status = terminalStatus(terminal.type)
  if (!status) return undefined

  const users = events
    .filter((event) => event.type === 'user.message')
    .map(eventText)
    .filter((text) => text.length > 0)
  const assistants = events
    .filter((event) => event.type === 'assistant.message.completed')
    .map((event) => {
      const decoded = record(payload(event))
      return { event, text: eventText(event), final: decoded?.['final'] === true }
    })
    .filter((message) => message.text.length > 0)
  const final = selectFinalTurnMessage(assistants)
  const mid = assistants.filter((message) => message !== final).map((message) => message.text)

  const userText = cap(users.join('\n\n'))
  const finalText = cap(final?.text ?? '')
  const midText = cap(mid.join('\n\n'))
  return {
    invocationId: terminal.invocationId,
    runtimeId: terminal.runtimeId,
    seqFrom: first.seq,
    seqTo: terminal.seq,
    startedAt: first.time,
    completedAt: terminal.time,
    terminalStatus: status,
    userText: userText.text,
    finalText: finalText.text,
    midText: midText.text,
    messageCount: assistants.length,
    truncated: userText.truncated || finalText.truncated || midText.truncated,
  }
}
