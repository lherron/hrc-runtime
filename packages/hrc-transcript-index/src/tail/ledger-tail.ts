import type { HrcBrokerInvocationEventRecord } from 'hrc-core'
import type { TranscriptTurn } from 'hrc-store-sqlite'

import type { TranscriptIndexerContext } from '../context.js'
import { extractTurnDocument } from '../extract/turn-document.js'

export const TRANSCRIPT_TERMINALS = ['turn.completed', 'turn.failed', 'turn.interrupted'] as const
export const TRANSCRIPT_PROSE = ['user.message', 'assistant.message.completed'] as const
export const TRANSCRIPT_ALPHABET = [
  ...TRANSCRIPT_TERMINALS,
  'turn.started',
  'input.accepted',
  ...TRANSCRIPT_PROSE,
] as const

type RepairReason = 'late_prose' | 'terminal_inversion'

function isTerminal(type: string): boolean {
  return (TRANSCRIPT_TERMINALS as readonly string[]).includes(type)
}

function isProse(type: string): boolean {
  return (TRANSCRIPT_PROSE as readonly string[]).includes(type)
}

function parseScopeFacets(scopeRef: string): {
  agent?: string | undefined
  project?: string | undefined
  task?: string | undefined
} {
  const match = scopeRef.match(/^agent:([^:]+)(?::project:([^:]+))?(?::task:([^:]+))?/)
  return {
    ...(match?.[1] ? { agent: match[1] } : {}),
    ...(match?.[2] ? { project: match[2] } : {}),
    ...(match?.[3] ? { task: match[3] } : {}),
  }
}

function emitSegment(
  context: TranscriptIndexerContext,
  invocationId: string,
  runtimeId: string,
  lo: number,
  hi: number
): TranscriptTurn | undefined {
  const events = context.db.brokerInvocationEvents.listTranscriptRange(
    invocationId,
    lo,
    hi,
    TRANSCRIPT_ALPHABET
  )
  const document = extractTurnDocument(events)
  if (!document) return undefined
  const runtime = context.db.runtimes.getByRuntimeId(runtimeId)
  const scopeRef = runtime?.scopeRef
  return context.db.transcriptIndex.upsertTurn({
    ...document,
    ...(scopeRef ? { scopeRef, ...parseScopeFacets(scopeRef) } : {}),
    ...(runtime ? { generation: runtime.generation } : {}),
  })
}

export function reindexInvocation(
  context: TranscriptIndexerContext,
  invocationId: string,
  runtimeId: string,
  reason?: RepairReason | undefined
): number {
  context.db.transcriptIndex.deleteTurnsForInvocation(invocationId)
  const terminals = context.db.brokerInvocationEvents.listTranscriptTerminals(
    invocationId,
    TRANSCRIPT_TERMINALS
  )
  let previous = 0
  for (const terminal of terminals) {
    emitSegment(context, invocationId, runtimeId, previous, terminal.seq)
    previous = terminal.seq
  }
  context.db.transcriptIndex.setInvocationMark({
    invocationId,
    runtimeId,
    lastTerminalSeq: previous,
    updatedAt: new Date().toISOString(),
  })
  if (reason) {
    context.invocationsReindexed += 1
    context.log('INFO', 'transcript.index.invocation_reindexed', {
      invocationId,
      runtimeId,
      reason,
      lastTerminalSeq: previous,
    })
  }
  return previous
}

function processInvocationEvents(
  context: TranscriptIndexerContext,
  invocationId: string,
  events: readonly HrcBrokerInvocationEventRecord[]
): void {
  const ordered = [...events].sort(
    (left, right) => left.seq - right.seq || (left.id ?? 0) - (right.id ?? 0)
  )
  const runtimeId = ordered[0]?.runtimeId
  if (!runtimeId) return
  let lastTerminalSeq =
    context.db.transcriptIndex.getInvocationMark(invocationId)?.lastTerminalSeq ?? 0

  for (const event of ordered) {
    if (isTerminal(event.type)) {
      if (event.seq <= lastTerminalSeq) {
        lastTerminalSeq = reindexInvocation(context, invocationId, runtimeId, 'terminal_inversion')
      } else {
        emitSegment(context, invocationId, runtimeId, lastTerminalSeq, event.seq)
        lastTerminalSeq = event.seq
        context.db.transcriptIndex.setInvocationMark({
          invocationId,
          runtimeId,
          lastTerminalSeq,
          updatedAt: new Date().toISOString(),
        })
      }
    } else if (isProse(event.type) && event.seq <= lastTerminalSeq) {
      lastTerminalSeq = reindexInvocation(context, invocationId, runtimeId, 'late_prose')
    }
  }
}

/** Consume the bounded global-id tail while deriving every row by invocation seq. */
export async function runLedgerTail(context: TranscriptIndexerContext): Promise<void> {
  const ceiling = context.db.brokerInvocationEvents.maxEventId()
  let cursor = context.db.transcriptIndex.getCursor()
  while (!context.stopping && cursor < ceiling) {
    const events = context.db.brokerInvocationEvents.listTranscriptTail(
      cursor,
      ceiling,
      TRANSCRIPT_ALPHABET,
      context.batchSize
    )
    const fullBatch = events.length === context.batchSize
    const nextCursor = fullBatch ? (events.at(-1)?.id ?? cursor) : ceiling
    const applyBatch = context.db.sqlite.transaction(() => {
      const grouped = new Map<string, HrcBrokerInvocationEventRecord[]>()
      for (const event of events) {
        const group = grouped.get(event.invocationId) ?? []
        group.push(event)
        grouped.set(event.invocationId, group)
      }
      for (const [invocationId, invocationEvents] of grouped) {
        processInvocationEvents(context, invocationId, invocationEvents)
      }
      context.db.transcriptIndex.setCursor(nextCursor)
    })
    applyBatch.immediate()
    cursor = nextCursor
    if (fullBatch && cursor < ceiling) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
}
