import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { timeLoopActivity } from '../event-loop-lag'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

function busyWait(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Hold the event loop, as a synchronous full-invocation reload does.
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type StallMetric = {
  kind: string
  lagMs: number
  activities: { tag: string; count: number; ms: number }[]
}

function stallMetrics(stateRoot: string): StallMetric[] {
  const dir = join(stateRoot, 'metrics')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StallMetric)
    .filter((record) => record.kind === 'event_loop_stall')
}

describe('event-loop lag monitor', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeAll(async () => {
    fixture = await createHrcTestFixture('hrc-event-loop-lag-')
    server = await createHrcServer(
      fixture.serverOpts({ eventLoopLag: { intervalMs: 20, stallThresholdMs: 200 } })
    )
  })

  afterAll(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  it('reports no stall while the loop is free', async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const body = (await (await fixture.fetchSocket('/v1/status?includeSessions=false')).json()) as {
      eventLoop?: { stallCount: number; maxLagMs: number }
    }
    expect(body.eventLoop?.stallCount).toBe(0)
    expect(body.eventLoop?.maxLagMs).toBeLessThan(200)
    expect(stallMetrics(fixture.stateRoot)).toHaveLength(0)
  })

  it('records one stall with its duration and the activity that held the loop', async () => {
    timeLoopActivity('test:synthetic-busy-wait', () => busyWait(600))

    const [stall] = await waitFor(() => {
      const found = stallMetrics(fixture.stateRoot)
      return found.length > 0 ? found : undefined
    })
    expect(stallMetrics(fixture.stateRoot)).toHaveLength(1)
    // The tick was due at most one interval into the wait, so lag is within
    // one interval of the blocked duration.
    expect(stall?.lagMs).toBeGreaterThanOrEqual(560)
    expect(stall?.lagMs).toBeLessThan(900)
    expect(stall?.activities[0]?.tag).toBe('test:synthetic-busy-wait')
    expect(stall?.activities[0]?.count).toBe(1)
    expect(stall?.activities[0]?.ms).toBeGreaterThanOrEqual(600)

    const body = (await (await fixture.fetchSocket('/v1/status?includeSessions=false')).json()) as {
      eventLoop?: {
        stallCount: number
        maxLagMs: number
        lastStall?: { lagMs: number; activities: { tag: string }[] }
      }
    }
    expect(body.eventLoop?.stallCount).toBe(1)
    expect(body.eventLoop?.maxLagMs).toBeGreaterThanOrEqual(560)
    expect(body.eventLoop?.lastStall?.activities[0]?.tag).toBe('test:synthetic-busy-wait')
  })
})
