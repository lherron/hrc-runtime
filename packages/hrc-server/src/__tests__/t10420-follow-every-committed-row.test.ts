/**
 * T-10420 — a live bounded follow delivers every committed ledger row for its
 * filter, whatever wrote it, exactly once and in order.
 *
 * Failure modes this pins:
 *  - a row persisted without notifyEvent (broker durable diagnostics) is skipped live;
 *  - a row appended inside a caller's transaction (session.metadata.changed) is skipped live;
 *  - a row that IS manually notified is delivered twice once the store also announces;
 *  - a rolled-back in-transaction append reaches followers;
 *  - an earlier held row is delivered after a later one (cursor order breaks);
 *  - the live seqs differ from the ledger's own tail for the same filter.
 */
import { afterEach, expect, test } from 'bun:test'

import type { HrcBoundedEventStreamRecord, HrcEventTail } from 'hrc-core'

import { appendHrcEvent, appendHrcEventWithinExistingTransaction } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:clod:project:hrc-runtime:task:T-10420'
const fixtures: HrcServerTestFixture[] = []
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

test('live follow delivers every committed row once, in order, matching the ledger', async () => {
  const f = await createHrcTestFixture('hrc-t10420-')
  fixtures.push(f)
  const server = await createHrcServer(f.serverOpts({ otelListenerEnabled: false }))
  try {
    const resolved = (await (
      await f.postJson('/v1/sessions/resolve', { sessionRef: `${SCOPE}/lane:main`, create: true })
    ).json()) as { hostSessionId: string; generation: number }
    const session = server.db.sessions.getByHostSessionId(resolved.hostSessionId)
    if (!session) throw new Error('session missing')
    const filter = `scopeRef=${encodeURIComponent(SCOPE)}&laneRef=main&hostSessionId=${session.hostSessionId}&generation=${session.generation}`
    const tail = (await (
      await f.fetchSocket(`/v1/events/tail?limit=1&${filter}`)
    ).json()) as HrcEventTail
    const cursor = tail.headHrcSeq

    const follow = await f.fetchSocket(
      `/v1/events/bounded-stream?follow=true&ledgerIncarnationId=${tail.ledgerIncarnationId}&afterSeq=${cursor}&${filter}`
    )
    expect(follow.status).toBe(200)
    const reader = follow.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    const records: HrcBoundedEventStreamRecord[] = []
    const readUntil = async (count: number) => {
      const deadline = Date.now() + 5_000
      while (records.filter((r) => r.type === 'event').length < count && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => null),
        ])
        if (next === null || next.done) break
        buffered += decoder.decode(next.value)
        for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
          const line = buffered.slice(0, nl)
          buffered = buffered.slice(nl + 1)
          if (line.length > 0) records.push(JSON.parse(line) as HrcBoundedEventStreamRecord)
        }
      }
    }
    await readUntil(0)

    const base = {
      ts: new Date().toISOString(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
    }
    // 1. Durable diagnostic: persisted, never notified (the broker.* path).
    appendHrcEvent(server.db, 'broker.seat.transition', { ...base, payload: { n: 1 } })
    // 2. In-transaction append (the session-metadata path), via a real PATCH.
    expect(
      (
        await f.fetchSocket('/v1/sessions/metadata', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeRef: SCOPE, set: { title: 'T-10420' } }),
        })
      ).status
    ).toBe(200)
    // 3. A rolled-back in-transaction append must never be seen.
    try {
      server.db.sqlite.transaction(() => {
        appendHrcEventWithinExistingTransaction(server.db, 'broker.turn.origin', {
          ...base,
          payload: { rolledBack: true },
        })
        throw new Error('roll back')
      })()
    } catch {
      // expected
    }
    // 4. Held in-transaction row, then a later own-transaction row before any
    //    microtask: the earlier one must still be delivered first.
    server.db.sqlite.transaction(() => {
      appendHrcEventWithinExistingTransaction(server.db, 'broker.submission.milestone', {
        ...base,
        payload: { n: 4 },
      })
    })()
    // 5. An ordinary append that the caller ALSO notifies: delivered once.
    const notified = appendHrcEvent(server.db, 'broker.turn.origin', { ...base, payload: { n: 5 } })
    server.notifyEvent(notified)

    const ledger = server.db.hrcEvents
      .tail(100, { scopeRef: SCOPE, laneRef: 'main', hostSessionId: session.hostSessionId })
      .events.filter((event) => event.hrcSeq > cursor)
      .map((event) => event.hrcSeq)
    await readUntil(ledger.length)
    await Bun.sleep(100)
    await readUntil(ledger.length + 1)
    await reader.cancel()

    const live = records
      .filter(
        (r): r is Extract<HrcBoundedEventStreamRecord, { type: 'event' }> => r.type === 'event'
      )
      .map((r) => r.event)
    const liveSeqs = live.map((event) => event.hrcSeq)
    expect(ledger.length).toBe(4)
    // Every committed row, once, ascending, exactly the ledger's own answer.
    expect(liveSeqs).toEqual(ledger)
    expect(live.map((event) => event.eventKind)).toEqual([
      'broker.seat.transition',
      'session.metadata.changed',
      'broker.submission.milestone',
      'broker.turn.origin',
    ])
    expect(live.some((event) => (event.payload as { rolledBack?: boolean }).rolledBack)).toBe(false)
    expect(records.some((r) => r.type === 'gap')).toBe(false)
  } finally {
    await server.stop()
  }
}, 30_000)
