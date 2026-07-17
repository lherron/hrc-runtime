import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HRC_EVENTS_KEEPALIVE_MS, createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

const READ_BOUND_MS = 250
const RUNTIME_ID = 'rt-stop-follow-streams'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let originalServe: typeof Bun.serve
let capturedOptions: Parameters<typeof Bun.serve>[0] | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-stop-follow-streams-')
  originalServe = Bun.serve
  capturedOptions = undefined

  Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    capturedOptions = options
    return {
      stop() {},
    } as ReturnType<typeof Bun.serve>
  }) as typeof Bun.serve

  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  Bun.serve = originalServe
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

async function dispatch(path: string, init?: RequestInit): Promise<Response> {
  const fetchHandler = capturedOptions?.fetch
  if (!fetchHandler) throw new Error('Bun.serve fetch handler was not captured')

  const request = new Request(`http://localhost${path}`, init)
  const fakeServer = {
    timeout() {},
  }
  return await fetchHandler(request, fakeServer as Parameters<NonNullable<typeof fetchHandler>>[1])
}

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`follow stream did not terminate within ${READ_BOUND_MS}ms`)),
          READ_BOUND_MS
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function expectStreamEndsOnStop(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  expect(response.body).not.toBeNull()
  const reader = response.body?.getReader()
  if (!reader) throw new Error('follow response did not include a body')

  try {
    expect(await reader.read()).toEqual({ done: false, value: new TextEncoder().encode('\n') })
    await server?.stop()
    const afterStop = await readWithin(reader)
    expect(afterStop.done).toBe(true)
    expect(afterStop.value).toBeUndefined()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

describe('HrcServer.stop follow stream shutdown', () => {
  it('terminates an in-flight events follow stream', async () => {
    const response = await dispatch('/v1/events?follow=true')

    await expectStreamEndsOnStop(response)
  })

  it('terminates an in-flight broker-events follow stream', async () => {
    fixture.seedSession('hsid-stop-follow-streams', 'agent:test:project:hrc-runtime')
    fixture.seedTmuxRuntime(
      'hsid-stop-follow-streams',
      'agent:test:project:hrc-runtime',
      RUNTIME_ID,
      { status: 'ready' }
    )
    const query = new URLSearchParams({
      invocationId: 'inv-stop-follow-streams',
      runtimeId: RUNTIME_ID,
      generation: '1',
      afterSeq: '0',
      follow: 'true',
    })
    const response = await dispatch(`/v1/broker-events?${query.toString()}`)

    await expectStreamEndsOnStop(response)
  })

  it('terminates an unbounded in-flight message watch', async () => {
    const response = await dispatch('/v1/messages/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ follow: true }),
    })

    await expectStreamEndsOnStop(response)
  })

  it('clears the events keepalive timer and leaves no post-stop bytes', async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const keepaliveHandles = new Set<ReturnType<typeof setInterval>>()
    const clearedKeepaliveHandles = new Set<ReturnType<typeof setInterval>>()

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = originalSetInterval(...args)
      if (args[1] === HRC_EVENTS_KEEPALIVE_MS) keepaliveHandles.add(handle)
      return handle
    }) as typeof setInterval
    globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
      const handle = args[0]
      if (handle && keepaliveHandles.has(handle)) clearedKeepaliveHandles.add(handle)
      return originalClearInterval(...args)
    }) as typeof clearInterval

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await dispatch('/v1/events?follow=true')
      reader = response.body?.getReader()
      if (!reader) throw new Error('follow response did not include a body')
      expect(await reader.read()).toEqual({ done: false, value: new TextEncoder().encode('\n') })

      await server?.stop()

      expect(keepaliveHandles.size).toBe(1)
      expect(clearedKeepaliveHandles).toEqual(keepaliveHandles)
      expect(await readWithin(reader)).toEqual({ done: true, value: undefined })
    } finally {
      await reader?.cancel().catch(() => undefined)
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  it('keeps a non-follow response readable while stop drains', async () => {
    const response = await dispatch('/v1/events')

    await server?.stop()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})
