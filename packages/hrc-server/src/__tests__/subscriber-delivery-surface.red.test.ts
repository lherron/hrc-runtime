import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import type { HrcBrokerInvocationEventRecord, HrcLifecycleEvent } from 'hrc-core'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import type { FollowSubscriber, RawBrokerSubscriber } from '../server-types'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

const RUNTIME_ID = 'rt-subscriber-delivery-surface'

describe('follow-stream subscriber inspection surface', () => {
  it('registers and advances admission counters for both follow routes without receipt labels', async () => {
    const fixture = await createHrcTestFixture('hrc-subscriber-routes-')
    const originalServe = Bun.serve
    let capturedOptions: Parameters<typeof Bun.serve>[0] | undefined
    let server: HrcServer | undefined
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = []

    Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      capturedOptions = options
      return { stop() {} } as ReturnType<typeof Bun.serve>
    }) as typeof Bun.serve

    try {
      server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
      fixture.seedSession('hsid-subscriber-delivery', 'agent:test:project:hrc-runtime')
      fixture.seedTmuxRuntime(
        'hsid-subscriber-delivery',
        'agent:test:project:hrc-runtime',
        RUNTIME_ID,
        { status: 'ready' }
      )

      const dispatch = async (path: string): Promise<Response> => {
        const fetchHandler = capturedOptions?.fetch
        if (!fetchHandler) throw new Error('Bun.serve fetch handler was not captured')
        return await fetchHandler(new Request(`http://localhost${path}`), {
          timeout() {},
        } as Parameters<NonNullable<typeof fetchHandler>>[1])
      }

      const eventsResponse = await dispatch('/v1/events?follow=true&fromSeq=1&scopeRef=agent:test')
      const eventsReader = eventsResponse.body?.getReader()
      if (!eventsReader) throw new Error('events follow response did not include a body')
      readers.push(eventsReader)
      await eventsReader.read()

      const brokerQuery = new URLSearchParams({
        invocationId: 'inv-subscriber-delivery',
        runtimeId: RUNTIME_ID,
        generation: '1',
        afterSeq: '0',
        follow: 'true',
      })
      const brokerResponse = await dispatch(`/v1/broker-events?${brokerQuery.toString()}`)
      const brokerReader = brokerResponse.body?.getReader()
      if (!brokerReader) throw new Error('broker follow response did not include a body')
      readers.push(brokerReader)
      await brokerReader.read()

      const fanoutServer = server as HrcServer & {
        followSubscribers: Set<FollowSubscriber>
        rawBrokerSubscribers: Set<RawBrokerSubscriber>
      }
      const lifecycleEvent: HrcLifecycleEvent = {
        hrcSeq: 5,
        streamSeq: 5,
        ts: '2026-07-18T12:03:00.000Z',
        hostSessionId: 'hsid-subscriber-delivery',
        scopeRef: 'agent:test',
        laneRef: 'default',
        generation: 1,
        runtimeId: RUNTIME_ID,
        category: 'turn',
        eventKind: 'turn.accepted',
        replayed: false,
        payload: {},
      }
      for (const subscriber of fanoutServer.followSubscribers) subscriber(lifecycleEvent)

      const envelope: InvocationEventEnvelope = {
        invocationId: 'inv-subscriber-delivery' as InvocationEventEnvelope['invocationId'],
        seq: 7,
        time: '2026-07-18T12:03:01.000Z',
        type: 'assistant.message.delta',
        payload: { delta: 'admitted' } as InvocationEventEnvelope['payload'],
      }
      const record: HrcBrokerInvocationEventRecord = {
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        time: envelope.time,
        type: envelope.type,
        runtimeId: RUNTIME_ID,
        brokerEventJson: JSON.stringify(envelope.payload),
        brokerEnvelopeJson: JSON.stringify(envelope),
      }
      for (const subscriber of fanoutServer.rawBrokerSubscribers) {
        subscriber({ envelope, record })
      }
      await eventsReader.read()
      await brokerReader.read()

      const response = await dispatch('/v1/server/subscribers')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        active: Array<Record<string, unknown> & { route: string; selector: unknown }>
      }
      expect(body.active).toHaveLength(2)
      expect(body.active.map((entry) => entry.route).sort()).toEqual(['broker-events', 'events'])
      expect(body.active.every((entry) => entry.selector !== undefined)).toBe(true)
      expect(body.active.find((entry) => entry.route === 'events')).toEqual(
        expect.objectContaining({
          lastEnqueuedSeq: 5,
          lastStreamAcceptedSeq: 5,
          enqueuedCount: 1,
          streamAcceptedCount: 1,
          pendingCount: 0,
          pendingSince: null,
          lastStreamAcceptedAt: expect.any(String),
          keepaliveOnlySince: null,
        })
      )
      expect(body.active.find((entry) => entry.route === 'broker-events')).toEqual(
        expect.objectContaining({
          lastEnqueuedSeq: 7,
          lastStreamAcceptedSeq: 7,
          enqueuedCount: 1,
          streamAcceptedCount: 1,
          pendingCount: 0,
          pendingSince: null,
          lastStreamAcceptedAt: expect.any(String),
          keepaliveOnlySince: null,
        })
      )
      const fieldNames = body.active.flatMap((entry) => Object.keys(entry)).join(' ')
      expect(fieldNames).not.toMatch(/delivered|flushed|socket|consumer|notDraining/i)
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => undefined)
      await server?.stop()
      Bun.serve = originalServe
      await fixture.cleanup()
    }
  })

  it('hrc server subscribers --json returns active and recently-closed admission gauges', async () => {
    const fixture = await createHrcTestFixture('hrc-subscriber-cli-')
    let server: HrcServer | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    try {
      server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
      const response = await fixture.fetchSocket(
        '/v1/events?follow=true&fromSeq=1&scopeRef=agent:test:project:hrc-runtime'
      )
      reader = response.body?.getReader()
      if (!reader) throw new Error('follow response did not include a body')
      await reader.read()

      const cliPath = join(import.meta.dir, '..', '..', '..', 'hrc-cli', 'src', 'cli.ts')
      const child = Bun.spawn(['bun', 'run', cliPath, 'server', 'subscribers', '--json'], {
        env: {
          ...globalThis.process.env,
          HRC_RUNTIME_DIR: fixture.runtimeRoot,
          HRC_STATE_DIR: fixture.stateRoot,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      const body = JSON.parse(stdout.trim()) as {
        active: Array<Record<string, unknown>>
        recentlyClosed: Array<Record<string, unknown>>
      }
      expect(Array.isArray(body.active)).toBe(true)
      expect(Array.isArray(body.recentlyClosed)).toBe(true)
      expect(body.active).toHaveLength(1)
      const active = body.active[0]
      expect(active).toEqual(
        expect.objectContaining({
          route: 'events',
          selector: expect.any(Object),
          openedAt: expect.any(String),
          enqueuedCount: expect.any(Number),
          streamAcceptedCount: expect.any(Number),
          pendingCount: expect.any(Number),
        })
      )
      expect(Object.hasOwn(active ?? {}, 'lastEnqueuedSeq')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'lastStreamAcceptedSeq')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'desiredSize')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'pendingSince')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'lastStreamAcceptedAt')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'keepaliveOnlySince')).toBe(true)
      expect(Object.keys(active ?? {}).join(' ')).not.toMatch(
        /delivered|flushed|socket|consumer|notDraining/i
      )
    } finally {
      await reader?.cancel().catch(() => undefined)
      await server?.stop()
      await fixture.cleanup()
    }
  })
})
