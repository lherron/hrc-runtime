import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

const RUNTIME_ID = 'rt-subscriber-delivery-surface'

describe('follow-stream subscriber inspection surface', () => {
  it('registers both follow routes with their route identity', async () => {
    const fixture = await createHrcTestFixture('hrc-subscriber-routes-')
    const originalServe = Bun.serve
    let capturedOptions: Parameters<typeof Bun.serve>[0] | undefined
    let server: HrcServer | undefined
    const streams: Response[] = []

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

      streams.push(await dispatch('/v1/events?follow=true&fromSeq=1&scopeRef=agent:test'))
      const brokerQuery = new URLSearchParams({
        invocationId: 'inv-subscriber-delivery',
        runtimeId: RUNTIME_ID,
        generation: '1',
        afterSeq: '0',
        follow: 'true',
      })
      streams.push(await dispatch(`/v1/broker-events?${brokerQuery.toString()}`))

      const response = await dispatch('/v1/server/subscribers')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        active: Array<{ route: string; selector: unknown }>
      }
      expect(body.active).toHaveLength(2)
      expect(body.active.map((entry) => entry.route).sort()).toEqual(['broker-events', 'events'])
      expect(body.active.every((entry) => entry.selector !== undefined)).toBe(true)
    } finally {
      for (const response of streams) await response.body?.cancel().catch(() => undefined)
      await server?.stop()
      Bun.serve = originalServe
      await fixture.cleanup()
    }
  })

  it('hrc server subscribers --json returns active and recently-closed gauges', async () => {
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
          deliveredCount: expect.any(Number),
        })
      )
      expect(Object.hasOwn(active ?? {}, 'lastDeliveredSeq')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'lastWriteAt')).toBe(true)
      expect(Object.hasOwn(active ?? {}, 'keepaliveOnlySince')).toBe(true)
    } finally {
      await reader?.cancel().catch(() => undefined)
      await server?.stop()
      await fixture.cleanup()
    }
  })
})
