import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../database.js'

function appendEvent(
  db: ReturnType<typeof openHrcDatabase>,
  eventKind: string,
  scopeRef: string
): void {
  db.hrcEvents.append({
    ts: new Date().toISOString(),
    hostSessionId: `hsid-${scopeRef}`,
    scopeRef,
    laneRef: 'default',
    generation: 1,
    category: 'turn',
    eventKind,
    payload: { eventKind, nested: { preserved: true } },
  })
}

describe('T-07493 lifecycle-event ledger metadata and tail', () => {
  test('incarnation survives reopen and a new ledger gets a different identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-event-incarnation-'))
    const firstPath = join(dir, 'first.sqlite')
    const secondPath = join(dir, 'second.sqlite')
    try {
      const first = openHrcDatabase(firstPath)
      const incarnation = first.hrcEvents.ledgerIncarnationId()
      expect(incarnation).toMatch(/^[a-f0-9]{32}$/)
      first.close()

      const reopened = openHrcDatabase(firstPath)
      expect(reopened.hrcEvents.ledgerIncarnationId()).toBe(incarnation)
      reopened.close()

      const replacement = openHrcDatabase(secondPath)
      expect(replacement.hrcEvents.ledgerIncarnationId()).not.toBe(incarnation)
      replacement.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns an ascending filtered newest page with global head and truncation', () => {
    const db = openHrcDatabase(':memory:')
    try {
      appendEvent(db, 'turn.one', 'agent:test:a')
      appendEvent(db, 'turn.other', 'agent:test:b')
      appendEvent(db, 'turn.two', 'agent:test:a')
      appendEvent(db, 'turn.three', 'agent:test:a')

      const result = db.hrcEvents.tail(2, { scopeRef: 'agent:test:a' })
      expect(result.events.map((event) => event.eventKind)).toEqual(['turn.two', 'turn.three'])
      expect(result.events[0]!.hrcSeq).toBeLessThan(result.events[1]!.hrcSeq)
      expect(result.headHrcSeq).toBe(4)
      expect(result.truncated).toBe(true)
      expect(result.ledgerIncarnationId).toBe(db.hrcEvents.ledgerIncarnationId())
    } finally {
      db.close()
    }
  })

  test('tail query uses the equality/sequence index instead of scanning from zero', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const detail = db.sqlite
        .query<{ detail: string }, [string, number]>(
          `EXPLAIN QUERY PLAN
           SELECT hrc_seq FROM hrc_events
            WHERE scope_ref = ?
            ORDER BY hrc_seq DESC
            LIMIT ?`
        )
        .all('agent:test:index', 501)
        .map((row) => row.detail)
        .join('\n')
      expect(detail).toContain('idx_hrc_events_scope_ref_seq')
      expect(detail).not.toMatch(/\bSCAN hrc_events\b/)
    } finally {
      db.close()
    }
  })

  test('replay scan validates incarnation and stops SQLite iteration at caller admission', () => {
    const db = openHrcDatabase(':memory:')
    try {
      for (let index = 1; index <= 8; index += 1) {
        appendEvent(db, `turn.${index}`, 'agent:test:scan')
      }
      const seen: number[] = []
      const result = db.hrcEvents.scanReplayNewestFirst(
        {
          expectedLedgerIncarnationId: db.hrcEvents.ledgerIncarnationId(),
          afterHrcSeq: 0,
          filters: { scopeRef: 'agent:test:scan' },
        },
        (event) => {
          seen.push(event.hrcSeq)
          return seen.length < 3
        }
      )
      expect(seen).toEqual([8, 7, 6])
      expect(result).toMatchObject({ headHrcSeq: 8, complete: false })
    } finally {
      db.close()
    }
  })
})
