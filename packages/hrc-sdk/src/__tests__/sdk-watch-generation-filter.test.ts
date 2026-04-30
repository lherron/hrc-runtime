/**
 * RED tests: client.watch() does not support hostSessionId + generation filters.
 *
 * These tests prove that the HrcClient.watch() method and WatchOptions type
 * do not currently expose hostSessionId or generation filter params.
 * Phase 1b will extend WatchOptions and the watch() method to support them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent } from 'hrc-core'

import { HrcClient } from '../client'

let tmpDir: string
let stubSocketPath: string
let stubServer: ReturnType<typeof Bun.serve> | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-gen-filter-'))
  stubSocketPath = join(tmpDir, 'gen-filter.sock')
})

afterEach(async () => {
  if (stubServer) {
    stubServer.stop(true)
    stubServer = undefined
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 10,
    ts: '2026-04-30T00:00:00.000Z',
    hostSessionId: 'hsid-default',
    scopeRef: 'agent:test:project:sdk-gen',
    laneRef: 'default',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.started',
    replayed: false,
    payload: {},
    ...overrides,
  }
}

// ===========================================================================
// DELIVERABLE 5: SDK watch filter tests
// ===========================================================================

describe('client.watch() hostSessionId + generation filtering', () => {
  it('passes hostSessionId as query parameter to /v1/events', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    // Pass hostSessionId in watch options — this field does NOT exist on
    // WatchOptions today, so we cast to any. The test asserts that the
    // SDK forwards it as a query param, which it currently does not.
    for await (const _event of client.watch({
      hostSessionId: 'hsid-filter-test',
    } as any)) {
      // should be empty
    }

    expect(capturedUrl).toContain('hostSessionId=hsid-filter-test')
  })

  it('passes generation as query parameter to /v1/events', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({
      generation: 3,
    } as any)) {
      // should be empty
    }

    expect(capturedUrl).toContain('generation=3')
  })

  it('passes both hostSessionId and generation together', async () => {
    let capturedUrl = ''

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch(req) {
        capturedUrl = req.url
        return new Response('', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)

    for await (const _event of client.watch({
      fromSeq: 1,
      hostSessionId: 'hsid-combo',
      generation: 2,
    } as any)) {
      // should be empty
    }

    expect(capturedUrl).toContain('hostSessionId=hsid-combo')
    expect(capturedUrl).toContain('generation=2')
    expect(capturedUrl).toContain('fromSeq=1')
  })

  it('only yields events matching hostSessionId when filtered', async () => {
    const events: HrcLifecycleEvent[] = [
      makeEvent({ hrcSeq: 1, streamSeq: 10, hostSessionId: 'hsid-match', generation: 1 }),
      makeEvent({ hrcSeq: 2, streamSeq: 11, hostSessionId: 'hsid-other', generation: 1 }),
      makeEvent({ hrcSeq: 3, streamSeq: 12, hostSessionId: 'hsid-match', generation: 1 }),
    ]

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        // Server returns all events — filtering should happen server-side,
        // but today it doesn't. This test will pass once the full pipeline
        // is wired: SDK sends params → server filters → only matching returned.
        const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcLifecycleEvent[] = []

    for await (const event of client.watch({
      hostSessionId: 'hsid-match',
    } as any)) {
      collected.push(event)
    }

    // Today: we get ALL 3 events because the SDK doesn't pass the filter
    // and even if it did, the stub server doesn't filter.
    // Phase 1b will make watch() send the query param AND the real server
    // will honour it. This assertion proves the gap.
    expect(collected).toHaveLength(2)
    expect(collected.every((e) => e.hostSessionId === 'hsid-match')).toBe(true)
  })

  it('only yields events matching generation when filtered', async () => {
    const events: HrcLifecycleEvent[] = [
      makeEvent({ hrcSeq: 1, streamSeq: 10, hostSessionId: 'hsid-gen', generation: 1 }),
      makeEvent({ hrcSeq: 2, streamSeq: 11, hostSessionId: 'hsid-gen', generation: 2 }),
      makeEvent({ hrcSeq: 3, streamSeq: 12, hostSessionId: 'hsid-gen', generation: 1 }),
    ]

    stubServer = Bun.serve({
      unix: stubSocketPath,
      fetch() {
        const ndjson = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        return new Response(ndjson, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
      },
    })

    const client = new HrcClient(stubSocketPath)
    const collected: HrcLifecycleEvent[] = []

    for await (const event of client.watch({
      hostSessionId: 'hsid-gen',
      generation: 1,
    } as any)) {
      collected.push(event)
    }

    // Expect only gen-1 events; today we get all 3
    expect(collected).toHaveLength(2)
    expect(collected.every((e) => e.generation === 1)).toBe(true)
  })
})
