import { afterEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, TranscriptTurn } from 'hrc-store-sqlite'

import { createTranscriptIndexer } from '../controller.js'
import { aggregateByRuntime, sanitizeTranscriptQuery, searchTurns } from '../search/query.js'

let db: HrcDatabase | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function store(): HrcDatabase {
  db = openHrcDatabase(':memory:')
  return db
}

function append(
  target: HrcDatabase,
  invocationId: string,
  runtimeId: string,
  seq: number,
  type: string,
  payload: unknown = {}
): void {
  target.brokerInvocationEvents.appendEvent({
    invocationId,
    runtimeId,
    seq,
    type,
    time: `2026-09-04T14:${String(seq).padStart(2, '0')}:00.000Z`,
    payload,
  })
}

function assistant(text: string, final = false): unknown {
  return { content: [{ type: 'text', text }], final }
}

function indexer(target: HrcDatabase, batchSize = 100) {
  return createTranscriptIndexer(
    { db: target, log: () => undefined },
    { enabled: true, tickIntervalMs: 2_000, batchSize }
  )
}

describe('ledger-derived transcript segmentation', () => {
  it('covers no-start, late-start, terminal-less, and double-start segments', async () => {
    const target = store()
    append(target, 'inv-no-start', 'rt-a', 1, 'input.accepted')
    append(
      target,
      'inv-no-start',
      'rt-a',
      2,
      'assistant.message.completed',
      assistant('no start', true)
    )
    append(target, 'inv-no-start', 'rt-a', 3, 'turn.completed')

    append(target, 'inv-late-start', 'rt-b', 4, 'assistant.message.completed', assistant('early'))
    append(target, 'inv-late-start', 'rt-b', 5, 'turn.started')
    append(target, 'inv-late-start', 'rt-b', 6, 'user.message', { content: 'question' })
    append(
      target,
      'inv-late-start',
      'rt-b',
      7,
      'assistant.message.completed',
      assistant('answer', true)
    )
    append(target, 'inv-late-start', 'rt-b', 8, 'turn.completed')

    append(target, 'inv-open', 'rt-c', 1, 'assistant.message.completed', assistant('never closes'))

    append(target, 'inv-double', 'rt-d', 1, 'turn.started')
    append(target, 'inv-double', 'rt-d', 2, 'turn.started')
    append(
      target,
      'inv-double',
      'rt-d',
      3,
      'assistant.message.completed',
      assistant('one row', true)
    )
    append(target, 'inv-double', 'rt-d', 4, 'turn.completed')

    await indexer(target).tickOnce()
    expect(target.transcriptIndex.listTurnsForInvocation('inv-no-start')).toMatchObject([
      { seqFrom: 1, seqTo: 3, finalText: 'no start' },
    ])
    expect(target.transcriptIndex.listTurnsForInvocation('inv-late-start')).toMatchObject([
      { seqFrom: 4, seqTo: 8, finalText: 'answer', midText: 'early' },
    ])
    expect(target.transcriptIndex.listTurnsForInvocation('inv-open')).toEqual([])
    expect(target.transcriptIndex.listTurnsForInvocation('inv-double')).toHaveLength(1)
  })

  it('splits failed and completed turns and honors shared finality', async () => {
    const target = store()
    append(
      target,
      'inv-split',
      'rt-a',
      1,
      'assistant.message.completed',
      assistant('failed A', true)
    )
    append(target, 'inv-split', 'rt-a', 2, 'turn.failed')
    append(target, 'inv-split', 'rt-a', 3, 'input.accepted')
    append(target, 'inv-split', 'rt-a', 4, 'turn.started')
    append(
      target,
      'inv-split',
      'rt-a',
      5,
      'assistant.message.completed',
      assistant('completed B', true)
    )
    append(
      target,
      'inv-split',
      'rt-a',
      6,
      'assistant.message.completed',
      assistant('trailer', false)
    )
    append(target, 'inv-split', 'rt-a', 7, 'turn.completed')
    await indexer(target).tickOnce()

    const turns = target.transcriptIndex.listTurnsForInvocation('inv-split')
    expect(turns).toMatchObject([
      { terminalStatus: 'failed', finalText: 'failed A', midText: '' },
      { terminalStatus: 'completed', finalText: 'completed B', midText: 'trailer' },
    ])
  })

  it('derives seq boundaries across id inversions in one or multiple batches', async () => {
    for (const batchSize of [10, 1]) {
      const target = store()
      append(target, `inv-${batchSize}`, 'rt-a', 80, 'input.accepted')
      append(
        target,
        `inv-${batchSize}`,
        'rt-a',
        78,
        'assistant.message.completed',
        assistant('prior', true)
      )
      append(target, `inv-${batchSize}`, 'rt-a', 79, 'turn.completed')
      append(
        target,
        `inv-${batchSize}`,
        'rt-a',
        81,
        'assistant.message.completed',
        assistant('next', true)
      )
      append(target, `inv-${batchSize}`, 'rt-a', 82, 'turn.completed')
      await indexer(target, batchSize).tickOnce()
      expect(target.transcriptIndex.listTurnsForInvocation(`inv-${batchSize}`)).toMatchObject([
        { seqFrom: 78, seqTo: 79, finalText: 'prior' },
        { seqFrom: 80, seqTo: 82, finalText: 'next' },
      ])
      target.close()
      db = undefined
    }
  })

  it('repairs late prose below an emitted terminal and excludes tool results', async () => {
    const target = store()
    append(target, 'inv-late', 'rt-a', 1, 'turn.started')
    append(target, 'inv-late', 'rt-a', 4, 'turn.completed')
    const worker = indexer(target)
    await worker.tickOnce()
    append(
      target,
      'inv-late',
      'rt-a',
      2,
      'assistant.message.completed',
      assistant('late searchable', true)
    )
    append(target, 'inv-late', 'rt-a', 3, 'tool.call.completed', { result: 'TOOL_SENTINEL' })
    await worker.tickOnce()

    expect(target.transcriptIndex.listTurnsForInvocation('inv-late')).toMatchObject([
      { seqFrom: 1, seqTo: 4, finalText: 'late searchable' },
    ])
    expect(worker.stats().invocationsReindexed).toBe(1)
    expect(searchTurns(target, 'TOOL_SENTINEL')).toEqual([])
  })

  it('persists the cursor and converges over trailing ignored event types', async () => {
    const target = store()
    append(target, 'inv-a', 'rt-a', 1, 'turn.started')
    append(target, 'inv-a', 'rt-a', 2, 'turn.completed')
    append(target, 'inv-a', 'rt-a', 3, 'driver.notice', { notice: 'ignored' })
    const first = indexer(target, 1)
    await first.tickOnce()
    expect(first.stats().lagEvents).toBe(0)
    const persisted = target.transcriptIndex.getCursor()
    await indexer(target, 1).tickOnce()
    expect(target.transcriptIndex.getCursor()).toBe(persisted)
    expect(target.transcriptIndex.listTurnsForInvocation('inv-a')).toHaveLength(1)
  })

  it('rebuilds to the same row count from the authoritative ledger', async () => {
    const target = store()
    append(target, 'inv-rebuild', 'rt-a', 1, 'turn.started')
    append(
      target,
      'inv-rebuild',
      'rt-a',
      2,
      'assistant.message.completed',
      assistant('first', true)
    )
    append(target, 'inv-rebuild', 'rt-a', 3, 'turn.completed')
    append(target, 'inv-rebuild', 'rt-a', 4, 'input.accepted')
    append(
      target,
      'inv-rebuild',
      'rt-a',
      5,
      'assistant.message.completed',
      assistant('second', true)
    )
    append(target, 'inv-rebuild', 'rt-a', 6, 'turn.completed')
    const worker = indexer(target, 1)
    await worker.tickOnce()
    const before = worker.stats().turnsIndexed
    const activeTail = worker.tickOnce()
    await Promise.all([activeTail, worker.rebuild()])
    expect(worker.stats()).toMatchObject({ turnsIndexed: before, lagEvents: 0 })
  })
})

function turn(
  overrides: Partial<TranscriptTurn> &
    Pick<TranscriptTurn, 'invocationId' | 'runtimeId' | 'seqFrom'>
): TranscriptTurn {
  return {
    invocationId: overrides.invocationId,
    runtimeId: overrides.runtimeId,
    seqFrom: overrides.seqFrom,
    seqTo: overrides.seqFrom + 1,
    startedAt: '2026-09-04T10:00:00.000Z',
    completedAt: '2026-09-04T10:01:00.000Z',
    terminalStatus: 'completed',
    messageCount: 1,
    truncated: false,
    userText: '',
    finalText: '',
    midText: '',
    ...overrides,
  }
}

describe('FTS5 search and aggregation', () => {
  it('runs the two-stage CTE and ranks one strong runtime above five weak turns', () => {
    const target = store()
    target.transcriptIndex.upsertTurn(
      turn({
        invocationId: 'inv-a',
        runtimeId: 'rt-a',
        seqFrom: 1,
        scopeRef: 'agent:cody:project:hrc-runtime:task:A',
        generation: 1,
        finalText: 'quasar quasar quasar decisive',
      })
    )
    for (let index = 0; index < 5; index += 1) {
      target.transcriptIndex.upsertTurn(
        turn({
          invocationId: 'inv-b',
          runtimeId: 'rt-b',
          seqFrom: index * 2 + 1,
          scopeRef: 'agent:cody:project:hrc-runtime:task:B',
          generation: 1,
          midText: `quasar weak filler ${'filler '.repeat(30)}`,
        })
      )
    }

    const hits = searchTurns(target, 'quasar', { candidateLimit: 300 })
    const runtimes = aggregateByRuntime(hits)
    expect(runtimes.map((result) => result.runtimeId)).toEqual(['rt-a', 'rt-b'])
    expect(runtimes[0]!.score).toBeGreaterThan(runtimes[1]!.score)
  })

  it('supports phrases, implicit AND, facets, and within-runtime seq order', () => {
    const target = store()
    target.transcriptIndex.upsertTurn(
      turn({
        invocationId: 'inv-a',
        runtimeId: 'rt-a',
        seqFrom: 5,
        finalText: 'blue comet',
        agent: 'cody',
      })
    )
    target.transcriptIndex.upsertTurn(
      turn({
        invocationId: 'inv-a',
        runtimeId: 'rt-a',
        seqFrom: 1,
        finalText: 'blue bright comet',
        agent: 'cody',
      })
    )
    expect(sanitizeTranscriptQuery('blue comet')).toBe('"blue" AND "comet"')
    expect(
      searchTurns(target, '"blue comet"', { runtimeId: 'rt-a' }).map((hit) => hit.seqFrom)
    ).toEqual([5])
    expect(searchTurns(target, 'blue comet', { runtimeId: 'rt-a', agent: 'nobody' })).toEqual([])
    expect(() => sanitizeTranscriptQuery('"broken')).toThrow('unparseable query')
  })
})
