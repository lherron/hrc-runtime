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
  it('keeps receipt opt-in per follow route and never claims it for legacy clients', async () => {
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

      const dispatch = async (path: string, init?: RequestInit): Promise<Response> => {
        const fetchHandler = capturedOptions?.fetch
        if (!fetchHandler) throw new Error('Bun.serve fetch handler was not captured')
        return await fetchHandler(new Request(`http://localhost${path}`, init), {
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
        receipt: 'consumer-ack-v1',
      })
      const brokerResponse = await dispatch(`/v1/broker-events?${brokerQuery.toString()}`)
      const brokerSubscriberId = brokerResponse.headers.get('x-hrc-subscriber-id')
      const brokerReceiptToken = brokerResponse.headers.get('x-hrc-receipt-token')
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
      const brokerAck = await dispatch('/v1/server/subscribers/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscriberId: brokerSubscriberId,
          receiptToken: brokerReceiptToken,
          seq: 7,
        }),
      })
      expect(brokerAck.status).toBe(200)

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
          receiptMode: 'none',
          receiptState: 'not-requested',
          lastConsumerAcknowledgedSeq: null,
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
          receiptMode: 'consumer-ack-v1',
          receiptState: 'caught-up',
          lastConsumerAcknowledgedSeq: 7,
        })
      )
      const fieldNames = body.active.flatMap((entry) => Object.keys(entry)).join(' ')
      expect(fieldNames).not.toMatch(/receiptToken|delivered|flushed|socket|notDraining/i)
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
      expect(active).toEqual(
        expect.objectContaining({
          receiptMode: 'none',
          receiptState: 'not-requested',
          lastConsumerAcknowledgedSeq: null,
        })
      )
      expect(Object.keys(active ?? {}).join(' ')).not.toMatch(
        /receiptToken|delivered|flushed|socket|notDraining/i
      )
    } finally {
      await reader?.cancel().catch(() => undefined)
      await server?.stop()
      await fixture.cleanup()
    }
  })

  it('shows an opted-in stopped consumer behind before response buffering saturates', async () => {
    const fixture = await createHrcTestFixture('hrc-subscriber-receipt-')
    const originalServe = Bun.serve
    let capturedOptions: Parameters<typeof Bun.serve>[0] | undefined
    let server: HrcServer | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      capturedOptions = options
      return { stop() {} } as ReturnType<typeof Bun.serve>
    }) as typeof Bun.serve

    try {
      server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
      const dispatch = async (path: string, init?: RequestInit): Promise<Response> => {
        const fetchHandler = capturedOptions?.fetch
        if (!fetchHandler) throw new Error('Bun.serve fetch handler was not captured')
        return await fetchHandler(new Request(`http://localhost${path}`, init), {
          timeout() {},
        } as Parameters<NonNullable<typeof fetchHandler>>[1])
      }

      const response = await dispatch('/v1/events?follow=true&fromSeq=1&receipt=consumer-ack-v1')
      const subscriberId = response.headers.get('x-hrc-subscriber-id')
      const receiptToken = response.headers.get('x-hrc-receipt-token')
      expect(subscriberId).toMatch(/^sub-/)
      expect(receiptToken).toMatch(/^receipt-/)
      expect(response.headers.get('x-hrc-receipt-ack-path')).toBe('/v1/server/subscribers/ack')
      reader = response.body?.getReader()
      if (!reader) throw new Error('events follow response did not include a body')
      await reader.read() // initial keepalive

      const fanoutServer = server as HrcServer & {
        followSubscribers: Set<FollowSubscriber>
      }
      const event = (hrcSeq: number): HrcLifecycleEvent => ({
        hrcSeq,
        streamSeq: hrcSeq,
        ts: '2026-07-18T12:04:00.000Z',
        hostSessionId: 'hsid-subscriber-receipt',
        scopeRef: 'agent:test',
        laneRef: 'main',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.message',
        replayed: false,
        payload: {},
      })

      for (const subscriber of fanoutServer.followSubscribers) subscriber(event(5))
      await reader.read()
      const ackResponse = await dispatch('/v1/server/subscribers/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriberId, receiptToken, seq: 5 }),
      })
      expect(ackResponse.status).toBe(200)
      expect(await ackResponse.json()).toEqual(
        expect.objectContaining({ disposition: 'advanced', lastConsumerAcknowledgedSeq: 5 })
      )

      for (const subscriber of fanoutServer.followSubscribers) subscriber(event(6))
      await Bun.sleep(0)
      const snapshotResponse = await dispatch('/v1/server/subscribers')
      const snapshot = (await snapshotResponse.json()) as {
        active: Array<Record<string, unknown>>
      }
      expect(snapshot.active[0]).toEqual(
        expect.objectContaining({
          subscriberId,
          lastStreamAcceptedSeq: 6,
          streamAcceptedCount: 2,
          receiptMode: 'consumer-ack-v1',
          receiptState: 'behind',
          lastConsumerAcknowledgedSeq: 5,
          consumerReceiptBehindSince: expect.any(String),
        })
      )
      expect(JSON.stringify(snapshot)).not.toContain(String(receiptToken))
    } finally {
      await reader?.cancel().catch(() => undefined)
      await server?.stop()
      Bun.serve = originalServe
      await fixture.cleanup()
    }
  })
})
