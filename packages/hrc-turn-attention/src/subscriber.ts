import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HrcEventPage, HrcLifecycleEvent } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { type TurnText, classify, tail } from './classifier.js'

export type OpenTurn = { user: string; final: string }
export type Cursor = {
  ledgerIncarnationId: string
  afterSeq: number
  turns: Record<string, OpenTurn>
}
export function identity(scope: string): Pick<TurnText, 'agent' | 'project' | 'seat'> | undefined {
  const match = /^agent:([^:]+):project:([^:]+):task:([^:]+)$/.exec(scope)
  const agent = match?.[1]
  const project = match?.[2]
  const seat = match?.[3]
  if (!agent || !project || !seat || /^T-\d+$/.test(seat)) return
  return { agent, project, seat }
}
function text(payload: unknown, role: string): string | undefined {
  const p = payload as { type?: string; message?: { role?: string; content?: unknown } } | null
  if (p?.type !== 'message_end' || p.message?.role !== role) return
  const content = p.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
}
export class Subscriber {
  constructor(
    readonly cursor: Cursor,
    readonly classifyTurn: (turn: TurnText) => ReturnType<typeof classify>,
    readonly append: (body: unknown) => Promise<void>,
    readonly log: (message: string) => void = console.error
  ) {}
  async accept(event: HrcLifecycleEvent) {
    if (event.hrcSeq <= this.cursor.afterSeq) return
    const who = identity(event.scopeRef)
    const slot = `${event.hostSessionId}:${event.generation}`
    if (who && event.category === 'turn') {
      if (event.eventKind === 'turn.started' || event.eventKind === 'turn.accepted') {
        this.cursor.turns[slot] = { user: '', final: '' }
      }
      const turn = this.cursor.turns[slot] ?? { user: '', final: '' }
      if (event.eventKind === 'turn.user_prompt') {
        turn.user = tail(text(event.payload, 'user') ?? '', 400)
        this.cursor.turns[slot] = turn
      }
      if (event.eventKind === 'turn.message') {
        const final = text(event.payload, 'assistant')
        if (final !== undefined) turn.final = tail(final, 2500)
        this.cursor.turns[slot] = turn
      }
      if (event.eventKind === 'turn.completed') {
        const payload = event.payload as { turnId?: string; invocationId?: string }
        try {
          if (turn.final && payload.turnId && payload.invocationId && event.runtimeId) {
            const result = await this.classifyTurn({
              ...who,
              user_text_tail: turn.user,
              final_text: turn.final,
            })
            await this.append({
              eventKind: 'turn.attention',
              runtimeId: event.runtimeId,
              turnId: payload.turnId,
              payload: { invocationId: payload.invocationId, ...result },
            })
          }
        } catch (error) {
          this.log(`turn-attention dropped ${payload.turnId ?? event.hrcSeq}: ${String(error)}`)
        }
        delete this.cursor.turns[slot]
      }
      if (event.eventKind === 'turn.failed' || event.eventKind === 'turn.cancelled')
        delete this.cursor.turns[slot]
    }
    this.cursor.afterSeq = event.hrcSeq
  }
}
export async function saveCursor(path: string, cursor: Cursor) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(`${path}.next`, JSON.stringify(cursor), { mode: 0o600 })
  await chmod(`${path}.next`, 0o600)
  await rename(`${path}.next`, path)
}
export async function run(socket: string, statePath: string, key: string) {
  const client = new HrcClient(socket)
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`HRC ${path} HTTP ${response.status}`)
    return response.json()
  }
  let cursor: Cursor
  try {
    cursor = JSON.parse(await readFile(statePath, 'utf8')) as Cursor
    if (!cursor.ledgerIncarnationId || !Number.isSafeInteger(cursor.afterSeq) || !cursor.turns)
      throw new Error('invalid cursor')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // First deployment starts at the head, without historical backfill.
    const head = await client.tailEvents({ limit: 1 })
    cursor = { ledgerIncarnationId: head.ledgerIncarnationId, afterSeq: head.headHrcSeq, turns: {} }
    await saveCursor(statePath, cursor)
  }
  const subscriber = new Subscriber(
    cursor,
    (turn) => classify(turn, key),
    async (body) => {
      await request('/v1/events/append', body)
    }
  )
  const accept = async (event: HrcLifecycleEvent) => {
    await subscriber.accept(event)
    await saveCursor(statePath, cursor)
  }
  // Cover all missed events with ascending pages before following; bounded-stream
  // gaps return here too. This is cursor catch-up, never a classification retry.
  while (true) {
    while (true) {
      const page = (await request(
        `/v1/events/page?afterSeq=${cursor.afterSeq}&limit=500&ledgerIncarnationId=${encodeURIComponent(cursor.ledgerIncarnationId)}`
      )) as HrcEventPage
      if (page.ledgerIncarnationId !== cursor.ledgerIncarnationId)
        throw new Error('ledger replaced; refusing cursor reuse')
      for (const event of page.rows) await accept(event)
      cursor.afterSeq = page.scannedThrough
      await saveCursor(statePath, cursor)
      if (page.scannedThrough >= page.head) break
    }
    for await (const record of client.watchBoundedEvents({
      ledgerIncarnationId: cursor.ledgerIncarnationId,
      afterSeq: cursor.afterSeq,
      category: 'turn',
    })) {
      if (record.type === 'event') await accept(record.event)
      else if (record.type === 'gap') break
      else if (record.type === 'ledger_replaced' || record.type === 'home_unreachable')
        throw new Error(record.type)
    }
  }
}
