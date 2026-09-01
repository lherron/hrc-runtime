import { afterEach, describe, expect, test } from 'bun:test'

import type { FederationPeerHealthObservation, HrcRuntimeSnapshot } from 'hrc-core'

import {
  PeerRuntimeProjectionCache,
  peerRuntimeProjectionCacheKey,
} from '../federation/peer-runtime-projection-cache.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type PeerProbe = {
  health: FederationPeerHealthObservation
  runtimes?: readonly HrcRuntimeSnapshot[] | undefined
}

type PeerProjectionSubject = {
  collectFederationPeerHealth(options: {
    includeRuntimes: boolean
    filter: URLSearchParams
  }): Promise<PeerProbe[]>
  peerRuntimeProjectionCache: PeerRuntimeProjectionCache
}

function healthyProbe(): PeerProbe {
  const answeredAt = new Date().toISOString()
  return {
    health: {
      nodeId: 'peer-test',
      state: 'healthy',
      checkedAt: answeredAt,
      answeredAt,
      latencyMs: 1,
    },
    runtimes: [],
  }
}

describe('T-07208 peer runtime projection cache', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  test('ignored query parameters and query order share one semantic cache entry', async () => {
    const fixture = await createHrcTestFixture('hrc-t07208-semantic-key-')
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const subject = server as unknown as PeerProjectionSubject
    subject.collectFederationPeerHealth = async () => [healthyProbe()]

    try {
      const first = await fixture.fetchSocket('/v1/federation/runtimes?status=busy&cacheBust=first')
      const second = await fixture.fetchSocket(
        '/v1/federation/runtimes?cursor=ignored&cacheBust=second&status=%20busy%20&limit=1&json=true'
      )

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(subject.peerRuntimeProjectionCache.size).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test('semantic keys normalize equivalent filters and preserve effective differences', () => {
    const first = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?status=busy,ready&cacheBust=first')
    )
    const equivalent = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL(
        'http://localhost/v1/federation/runtimes?cursor=ignored&status=%20busy%20%2C%20ready%20&json=true&limit=10&cacheBust=second'
      )
    )
    const different = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?status=ready,busy')
    )
    const equivalentDuration = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?stale=true&olderThan=60s')
    )
    const alternateDuration = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?olderThan=1m&stale=1')
    )
    const duplicateStatusesAndExplicitDefault = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?all=true&status=busy,busy,ready')
    )
    const unfiltered = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes')
    )
    const inactiveStaleControls = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?stale=false&olderThan=1m')
    )
    const terminalDisabled = peerRuntimeProjectionCacheKey(
      'peer-test',
      new URL('http://localhost/v1/federation/runtimes?all=false')
    )

    expect(equivalent).toBe(first)
    expect(duplicateStatusesAndExplicitDefault).toBe(first)
    expect(different).not.toBe(first)
    expect(alternateDuration).toBe(equivalentDuration)
    expect(inactiveStaleControls).toBe(unfiltered)
    expect(terminalDisabled).not.toBe(unfiltered)
  })

  test('expired entries are removed at the TTL boundary', () => {
    let now = 1_000
    const cache = new PeerRuntimeProjectionCache({ now: () => now, ttlMs: 50 })
    const value = { answeredAt: new Date(0).toISOString(), runtimes: [] }
    cache.set('peer-test', value)

    now = 1_049
    expect(cache.get('peer-test')).toEqual(value)
    now = 1_050
    expect(cache.get('peer-test')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('size cap evicts the oldest successful answer and refreshes replacement order', () => {
    let now = 1_000
    const cache = new PeerRuntimeProjectionCache({
      now: () => now,
      maxEntries: 2,
    })
    const value = { answeredAt: new Date(0).toISOString(), runtimes: [] }
    cache.set('oldest', value)
    now += 1
    cache.set('refreshed', value)
    now += 1
    cache.set('oldest', value)
    now += 1
    cache.set('newest', value)

    expect(cache.size).toBe(2)
    expect(cache.get('refreshed')).toBeUndefined()
    expect(cache.get('oldest')).toEqual(value)
    expect(cache.get('newest')).toEqual(value)
  })

  test('stop clears retained peer runtime projections', async () => {
    const fixture = await createHrcTestFixture('hrc-t07208-stop-clear-')
    fixtures.push(fixture)
    const server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
    const subject = server as unknown as PeerProjectionSubject
    subject.peerRuntimeProjectionCache.set('peer-test', {
      answeredAt: new Date().toISOString(),
      runtimes: [],
    })

    await server.stop()

    expect(subject.peerRuntimeProjectionCache.size).toBe(0)
  })
})
