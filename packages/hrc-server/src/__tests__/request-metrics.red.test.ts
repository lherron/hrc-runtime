/**
 * T-06512 red bar: the unix-socket request choke writes bounded-cardinality
 * server metrics without changing or consuming the response it observes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { measureResponseBytes, normalizeRoute, pruneServerMetricFiles } from '../request-metrics'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

type ExactRouteHandler = (request: Request, url: URL) => Response | Promise<Response>

type InspectableServer = HrcServer & {
  exactRouteHandlers: Record<string, ExactRouteHandler>
}

type ServerMetric = {
  v: number
  kind: string
  ts: string
  route: string
  method: string
  ms: number
  status: number
  bytes?: number
  stream?: true
  reqId?: string
}

let fixture: HrcServerTestFixture | undefined
let server: InspectableServer | undefined
let originalMetrics: string | undefined
let originalStateDir: string | undefined

async function startServer(metrics = '1'): Promise<InspectableServer> {
  fixture = await createHrcTestFixture('hrc-request-metrics-')
  process.env['HRC_METRICS'] = metrics
  process.env['HRC_STATE_DIR'] = fixture.stateRoot
  server = (await createHrcServer(fixture.serverOpts())) as InspectableServer
  return server
}

async function readServerMetrics(): Promise<ServerMetric[]> {
  if (!fixture) throw new Error('fixture is not initialized')
  const metricsDir = join(fixture.stateRoot, 'metrics')
  const files = (await readdir(metricsDir)).filter((name) => /^server-.*\.ndjson$/.test(name))
  const records: ServerMetric[] = []
  for (const file of files) {
    const text = await readFile(join(metricsDir, file), 'utf8')
    records.push(
      ...text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ServerMetric)
    )
  }
  return records
}

beforeEach(() => {
  originalMetrics = process.env['HRC_METRICS']
  originalStateDir = process.env['HRC_STATE_DIR']
})

afterEach(async () => {
  await server?.stop()
  await fixture?.cleanup()
  server = undefined
  fixture = undefined
  process.env['HRC_METRICS'] = originalMetrics
  process.env['HRC_STATE_DIR'] = originalStateDir
})

describe.serial('server request metrics', () => {
  test('normalizes every dynamic route and never emits a concrete unknown path', () => {
    const exactKeys = new Set<string>()
    const cases = [
      ['GET', '/v1/sessions/by-host/abc123', '/v1/sessions/by-host/:hostSessionId', 'abc123'],
      [
        'GET',
        '/v1/active-run-contributions/input-42',
        '/v1/active-run-contributions/:inputApplicationId',
        'input-42',
      ],
      ['POST', '/v1/internal/launches/L-9/exited', '/v1/internal/launches/:launchId/exited', 'L-9'],
      ['GET', '/v1/nonesuch/xyz', 'unmatched', 'xyz'],
    ] as const

    for (const [method, pathname, expected, concreteId] of cases) {
      const route = normalizeRoute(method, pathname, exactKeys)
      expect(route).toBe(expected)
      expect(route).not.toContain(concreteId)
    }
  })

  test('normalizes every exact route registered by the actual server', async () => {
    const instance = await startServer('0')
    const exactKeys = new Set(Object.keys(instance.exactRouteHandlers))

    expect(exactKeys.size).toBeGreaterThan(0)
    for (const key of exactKeys) {
      const separator = key.indexOf(' ')
      const method = key.slice(0, separator)
      const pathname = key.slice(separator + 1)
      expect(normalizeRoute(method, pathname, exactKeys)).toBe(pathname)
      expect(normalizeRoute(method, pathname, exactKeys)).not.toBe('unmatched')
    }
  })

  test('marks a streamed response without consuming it and byte-counts multibyte bodies', async () => {
    const instance = await startServer()
    const streamPath = '/v1/test-metrics-stream'
    instance.exactRouteHandlers[`GET ${streamPath}`] = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('stream-\u2713'))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )

    if (!fixture) throw new Error('fixture is not initialized')
    const response = await fixture.fetchSocket(streamPath)
    expect(await response.text()).toBe('stream-\u2713')

    const [record] = await readServerMetrics()
    expect(record?.stream).toBeTrue()
    expect(record).not.toHaveProperty('bytes')

    const fixed = new Response('h\u00e9\ud83d\ude42')
    expect(await measureResponseBytes(fixed)).toEqual({
      bytes: Buffer.byteLength('h\u00e9\ud83d\ude42'),
    })
    expect(await fixed.text()).toBe('h\u00e9\ud83d\ude42')
  })

  test('records both unmatched 404 and caught 500 responses with their real status', async () => {
    const instance = await startServer()
    const errorPath = '/v1/test-metrics-error'
    instance.exactRouteHandlers[`GET ${errorPath}`] = () => {
      throw new Error('expected test handler failure')
    }

    if (!fixture) throw new Error('fixture is not initialized')
    const notFound = await fixture.fetchSocket('/v1/nonesuch/metric-status')
    expect(notFound.status).toBe(404)
    await notFound.text()
    const internalError = await fixture.fetchSocket(errorPath)
    expect(internalError.status).toBe(500)
    await internalError.text()

    const records = await readServerMetrics()
    expect(records.map((record) => record.status)).toEqual([404, 500])
  })

  test('writes a complete non-stream record and omits reqId when the header is absent', async () => {
    await startServer()
    if (!fixture) throw new Error('fixture is not initialized')

    const correlated = await fixture.fetchSocket('/v1/health', {
      headers: { 'x-hrc-request-id': 'request-metrics-id-1' },
    })
    const correlatedBody = await correlated.text()
    const uncorrelated = await fixture.fetchSocket('/v1/health')
    const uncorrelatedBody = await uncorrelated.text()

    const records = await readServerMetrics()
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      v: 1,
      kind: 'server',
      route: '/v1/health',
      method: 'GET',
      status: 200,
      bytes: Buffer.byteLength(correlatedBody),
      reqId: 'request-metrics-id-1',
    })
    expect(records[0]?.ms).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(records[0]?.ts ?? ''))).toBeFalse()
    expect(records[1]?.bytes).toBe(Buffer.byteLength(uncorrelatedBody))
    expect(records[1]).not.toHaveProperty('reqId')
  })

  test('creates no server metrics file when HRC_METRICS=0 at construction', async () => {
    await startServer('0')
    if (!fixture) throw new Error('fixture is not initialized')

    const response = await fixture.fetchSocket('/v1/health')
    expect(response.status).toBe(200)
    await response.text()

    const metricsDir = join(fixture.stateRoot, 'metrics')
    expect(await readdir(metricsDir).catch(() => [])).toEqual([])
  })

  test('prunes only old server files and treats retention failures as best-effort', async () => {
    await startServer('0')
    if (!fixture) throw new Error('fixture is not initialized')
    const metricsDir = join(fixture.stateRoot, 'metrics')
    await mkdir(metricsDir, { recursive: true })
    const now = new Date('2026-07-17T12:00:00.000Z')
    const oldTime = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)
    const recentTime = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000)
    const files = {
      oldServer: join(metricsDir, 'server-2026-07-02.ndjson'),
      recentServer: join(metricsDir, 'server-2026-07-04.ndjson'),
      todayServer: join(metricsDir, 'server-2026-07-17.ndjson'),
      oldCli: join(metricsDir, 'cli-2026-07-02.ndjson'),
      control: join(metricsDir, 'keep.txt'),
    }
    await Promise.all(Object.values(files).map((path) => writeFile(path, 'control\n')))
    await utimes(files.oldServer, oldTime, oldTime)
    await utimes(files.oldCli, oldTime, oldTime)
    await utimes(files.recentServer, recentTime, recentTime)

    expect(() => pruneServerMetricFiles(metricsDir, now.getTime())).not.toThrow()
    expect(await stat(files.oldServer).catch(() => undefined)).toBeUndefined()
    for (const path of [files.recentServer, files.todayServer, files.oldCli, files.control]) {
      expect((await stat(path)).isFile()).toBeTrue()
    }

    await chmod(metricsDir, 0o000)
    try {
      expect(() => pruneServerMetricFiles(metricsDir, now.getTime())).not.toThrow()
    } finally {
      await chmod(metricsDir, 0o700)
    }
  })
})
