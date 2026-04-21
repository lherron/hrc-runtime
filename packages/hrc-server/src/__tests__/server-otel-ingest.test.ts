/**
 * OTLP/HTTP JSON log ingest tests (CODEX_OTEL_HRC_SPEC.md §6-§10).
 *
 * Coverage:
 *   1. Valid single-record batch appends one event with source='otel'
 *   2. Multi-record batch appends in order with monotonic seq
 *   3. Missing/malformed auth header returns 401/403 and appends nothing
 *   4. Invalid secret returns 403 and appends nothing
 *   5. Malformed JSON body returns 400
 *   6. Partial-success batch appends valid rows + returns partialSuccess JSON
 *   7. Post-exit grace: 403 when launch exited > 30s ago, success within window
 *   8. Daemon restart: reauthenticates off persisted artifact
 *   9. OTEL ingest stays out of the hrc-only /v1/events stream
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcLaunchArtifact } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createUserPromptPayload } from '../hrc-event-helper'
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

// Ephemeral ports across this test file to avoid collision with a running daemon on 4318.
function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return fixture.serverOpts({ otelPreferredPort: 0, ...overrides })
}

async function startServer(
  overrides: Partial<HrcServerOptions> = {}
): Promise<{ server: HrcServer; endpoint: string }> {
  const srv = await createHrcServer(serverOpts(overrides))
  const endpoint = srv.otelEndpoint
  if (!endpoint) throw new Error('test expected OTEL listener to be active')
  return { server: srv, endpoint }
}

function makeOtlpLogsBody(
  records: Array<{
    timeUnixNano?: string
    eventName?: string
    conversationId?: string
    model?: string
    severityText?: string
    attributes?: Record<string, unknown>
  }>
) {
  function encodeAnyValue(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') return { stringValue: value }
    if (typeof value === 'boolean') return { boolValue: value }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    }
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map((item) => encodeAnyValue(item)) } }
    }
    if (value && typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value).map(([key, nested]) => ({
            key,
            value: encodeAnyValue(nested),
          })),
        },
      }
    }
    return { stringValue: String(value) }
  }

  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'codex' } }],
        },
        scopeLogs: [
          {
            scope: { name: 'codex' },
            logRecords: records.map((r) => ({
              timeUnixNano: r.timeUnixNano ?? '1713370000000000000',
              severityNumber: 9,
              severityText: r.severityText ?? 'INFO',
              attributes: [
                ...(r.eventName
                  ? [{ key: 'event.name', value: { stringValue: r.eventName } }]
                  : []),
                ...(r.conversationId
                  ? [{ key: 'conversation.id', value: { stringValue: r.conversationId } }]
                  : []),
                ...(r.model ? [{ key: 'model', value: { stringValue: r.model } }] : []),
                ...Object.entries(r.attributes ?? {}).map(([key, value]) => ({
                  key,
                  value: encodeAnyValue(value),
                })),
              ],
              body: { kvlistValue: { values: [] } },
            })),
          },
        ],
      },
    ],
  }
}

type SeedParams = {
  launchId?: string
  secret?: string
  runtimeId?: string
  exitedAt?: string
  withOtelBlock?: boolean
  argv?: string[]
}

type SeedResult = {
  launchId: string
  secret: string
  hostSessionId: string
  runtimeId: string
  scopeRef: string
  laneRef: string
  artifactPath: string
  authHeader: string
}

async function seedCodexLaunch(params: SeedParams = {}): Promise<SeedResult> {
  const launchId = params.launchId ?? `launch-${randomUUID()}`
  const secret = params.secret ?? randomUUID()
  const scopeRef = `agent:codex-test-${randomUUID()}`
  const laneRef = 'default'
  const hostSessionId = `hsid-${randomUUID()}`
  const runtimeId = params.runtimeId ?? `rt-${randomUUID()}`
  const launchesDir = join(fixture.stateRoot, 'launches')
  await mkdir(launchesDir, { recursive: true })
  const artifactPath = join(launchesDir, `${launchId}.json`)

  const artifact: HrcLaunchArtifact = {
    launchId,
    hostSessionId,
    generation: 1,
    runtimeId,
    harness: 'codex-cli',
    provider: 'openai',
    argv: params.argv ?? ['codex'],
    env: {},
    cwd: '/tmp',
    callbackSocketPath: fixture.socketPath,
    spoolDir: fixture.spoolDir,
    correlationEnv: {},
    ...(params.withOtelBlock === false
      ? {}
      : {
          otel: {
            transport: 'otlp-http-json',
            endpoint: 'http://127.0.0.1:0/v1/logs',
            authHeaderName: 'x-hrc-launch-auth',
            authHeaderValue: `${launchId}.${secret}`,
            secret,
          },
        }),
  }
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8')

  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.launches.insert({
      launchId,
      hostSessionId,
      generation: 1,
      runtimeId,
      harness: 'codex-cli',
      provider: 'openai',
      launchArtifactPath: artifactPath,
      status: params.exitedAt ? 'exited' : 'child_started',
      ...(params.exitedAt ? { exitedAt: params.exitedAt } : {}),
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return {
    launchId,
    secret,
    hostSessionId,
    runtimeId,
    scopeRef,
    laneRef,
    artifactPath,
    authHeader: `${launchId}.${secret}`,
  }
}

async function getAllEvents(): Promise<unknown[]> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.events.listFromSeq(1)
  } finally {
    db.close()
  }
}

async function getAllHrcEvents(): Promise<unknown[]> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1)
  } finally {
    db.close()
  }
}

async function postOtlp(
  endpoint: string,
  body: unknown,
  headers: Record<string, string>
): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function collectFollowEvents(path: string, durationMs: number): Promise<any[]> {
  const res = await fixture.fetchSocket(path)
  const reader = res.body?.getReader()
  if (!reader) {
    return []
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const events: any[] = []
  const deadline = Date.now() + durationMs

  try {
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs)),
      ])

      if (result === null) {
        break
      }

      const { value, done } = result
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        events.push(JSON.parse(line))
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* noop */
    }
  }

  return events
}

function expectMatchingOtelMetadata(rawEvent: any, typedEvent: any, seed: SeedResult): void {
  expect(typedEvent.source).toBe('otel')
  expect(typedEvent.ts).toBe(rawEvent.ts)
  expect(typedEvent.hostSessionId).toBe(seed.hostSessionId)
  expect(typedEvent.scopeRef).toBe(seed.scopeRef)
  expect(typedEvent.laneRef).toBe(seed.laneRef)
  expect(typedEvent.generation).toBe(rawEvent.generation)
  expect(typedEvent.runtimeId).toBe(seed.runtimeId)
  expect(rawEvent.hostSessionId).toBe(seed.hostSessionId)
  expect(rawEvent.scopeRef).toBe(seed.scopeRef)
  expect(rawEvent.laneRef).toBe(seed.laneRef)
  expect(rawEvent.generation).toBe(1)
  expect(rawEvent.runtimeId).toBe(seed.runtimeId)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-otel-ingest-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

describe('OTLP/HTTP JSON ingest', () => {
  it('appends one event per valid LogRecord with source="otel"', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await postOtlp(
      started.endpoint,
      makeOtlpLogsBody([
        { eventName: 'codex.api_request', conversationId: 'conv-1', model: 'gpt-5.4' },
      ]),
      { 'x-hrc-launch-auth': seed.authHeader }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({})

    const events = await getAllEvents()
    const otelEvents = events.filter((e: any) => e.source === 'otel')
    expect(otelEvents).toHaveLength(1)
    const e = otelEvents[0] as any
    expect(e.eventKind).toBe('codex.api_request')
    expect(e.hostSessionId).toBe(seed.hostSessionId)
    expect(e.scopeRef).toBe(seed.scopeRef)
    expect(e.laneRef).toBe(seed.laneRef)
    expect(e.generation).toBe(1)
    expect(e.runtimeId).toBe(seed.runtimeId)
    expect(e.eventJson?.codex?.eventName).toBe('codex.api_request')
    expect(e.eventJson?.codex?.conversationId).toBe('conv-1')
    expect(e.eventJson?.hrc?.launchId).toBe(seed.launchId)
  })

  it('preserves order across a multi-record batch with monotonic seq', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await postOtlp(
      started.endpoint,
      makeOtlpLogsBody([
        { eventName: 'codex.conversation_start', timeUnixNano: '1713370000000000000' },
        { eventName: 'codex.api_request', timeUnixNano: '1713370000100000000' },
        { eventName: 'codex.sse_delta', timeUnixNano: '1713370000200000000' },
      ]),
      { 'x-hrc-launch-auth': seed.authHeader }
    )
    expect(res.status).toBe(200)

    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events.map((e: any) => e.eventKind)).toEqual([
      'codex.conversation_start',
      'codex.api_request',
      'codex.sse_delta',
    ])
    for (let i = 1; i < events.length; i++) {
      expect((events[i] as any).seq).toBeGreaterThan((events[i - 1] as any).seq)
    }
  })

  it('returns 401 for missing auth header and appends nothing', async () => {
    const started = await startServer()
    server = started.server
    await seedCodexLaunch()

    const res = await postOtlp(started.endpoint, makeOtlpLogsBody([{ eventName: 'codex.x' }]), {})
    expect(res.status).toBe(401)
    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events).toHaveLength(0)
  })

  it('returns 403 for invalid secret and appends nothing', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await postOtlp(started.endpoint, makeOtlpLogsBody([{ eventName: 'codex.x' }]), {
      'x-hrc-launch-auth': `${seed.launchId}.wrong-secret`,
    })
    expect(res.status).toBe(403)
    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events).toHaveLength(0)
  })

  it('returns 400 for malformed JSON body', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await postOtlp(started.endpoint, '{not json', {
      'x-hrc-launch-auth': seed.authHeader,
    })
    expect(res.status).toBe(400)
    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events).toHaveLength(0)
  })

  it('returns 400 for JSON body that is not an OTLP ExportLogsServiceRequest', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await postOtlp(
      started.endpoint,
      { something: 'else' },
      {
        'x-hrc-launch-auth': seed.authHeader,
      }
    )
    expect(res.status).toBe(400)
  })

  it('returns partialSuccess JSON when some records are malformed', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const mixed = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'codex' } }],
          },
          scopeLogs: [
            {
              scope: { name: 'codex' },
              logRecords: [
                {
                  timeUnixNano: '1713370000000000000',
                  attributes: [{ key: 'event.name', value: { stringValue: 'codex.ok' } }],
                  body: { kvlistValue: { values: [] } },
                },
                'not-an-object',
              ],
            },
          ],
        },
      ],
    }

    const res = await postOtlp(started.endpoint, mixed, {
      'x-hrc-launch-auth': seed.authHeader,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.partialSuccess).toBeDefined()
    expect(body.partialSuccess.rejectedLogRecords).toBe('1')

    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events).toHaveLength(1)
    expect((events[0] as any).eventKind).toBe('codex.ok')
  })

  it('allows requests within 30s of launch.exitedAt (post-exit grace)', async () => {
    const started = await startServer()
    server = started.server
    const exitedAt = new Date(Date.now() - 5_000).toISOString()
    const seed = await seedCodexLaunch({ exitedAt })

    const res = await postOtlp(
      started.endpoint,
      makeOtlpLogsBody([{ eventName: 'codex.late_flush' }]),
      {
        'x-hrc-launch-auth': seed.authHeader,
      }
    )
    expect(res.status).toBe(200)
    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events).toHaveLength(1)
  })

  it('rejects requests beyond the 30s post-exit grace window', async () => {
    const started = await startServer()
    server = started.server
    const exitedAt = new Date(Date.now() - 60_000).toISOString()
    const seed = await seedCodexLaunch({ exitedAt })

    const res = await postOtlp(
      started.endpoint,
      makeOtlpLogsBody([{ eventName: 'codex.too_late' }]),
      {
        'x-hrc-launch-auth': seed.authHeader,
      }
    )
    expect(res.status).toBe(403)
  })

  it('reauthenticates against persisted artifact after daemon restart', async () => {
    const first = await startServer()
    server = first.server
    const seed = await seedCodexLaunch()

    // Smoke: baseline works
    const r1 = await postOtlp(first.endpoint, makeOtlpLogsBody([{ eventName: 'codex.a' }]), {
      'x-hrc-launch-auth': seed.authHeader,
    })
    expect(r1.status).toBe(200)

    // Restart the daemon (new listener/port, same DB + artifacts on disk)
    await first.server.stop()
    server = undefined
    const second = await startServer()
    server = second.server

    const r2 = await postOtlp(second.endpoint, makeOtlpLogsBody([{ eventName: 'codex.b' }]), {
      'x-hrc-launch-auth': seed.authHeader,
    })
    expect(r2.status).toBe(200)

    const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
    expect(events.map((e: any) => e.eventKind)).toEqual(['codex.a', 'codex.b'])
  })

  it('does not deliver OTEL events to hrc-only /v1/events followers', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const followerPromise = collectFollowEvents('/v1/events?follow=true&fromSeq=1', 400)

    // Small delay so the follower is attached before the ingest POST.
    await new Promise((r) => setTimeout(r, 50))
    const res = await postOtlp(
      started.endpoint,
      makeOtlpLogsBody([{ eventName: 'codex.live_delivery' }]),
      { 'x-hrc-launch-auth': seed.authHeader }
    )
    expect(res.status).toBe(200)

    const streamed = await followerPromise
    expect(streamed).toEqual([])
  })

  it('rejects launches without an otel block in their artifact', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch({ withOtelBlock: false })

    const res = await postOtlp(started.endpoint, makeOtlpLogsBody([{ eventName: 'codex.x' }]), {
      'x-hrc-launch-auth': seed.authHeader,
    })
    expect(res.status).toBe(403)
  })

  it('returns 415 when Content-Type is not application/json', async () => {
    const started = await startServer()
    server = started.server
    const seed = await seedCodexLaunch()

    const res = await fetch(started.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'x-hrc-launch-auth': seed.authHeader,
      },
      body: new Uint8Array([0]),
    })
    expect(res.status).toBe(415)
  })

  it('returns 404 for OTLP paths other than /v1/logs', async () => {
    const started = await startServer()
    server = started.server
    await seedCodexLaunch()

    const base = started.endpoint.replace('/v1/logs', '')
    const res = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  describe('typed event derivation', () => {
    it('derives tool_execution_start from codex.tool_decision while preserving the raw audit row', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.tool_decision',
            timeUnixNano: '1713370000000000000',
            attributes: {
              call_id: 'call_abc123',
              tool_name: 'exec_command',
              arguments: '{"cmd":"ls","workdir":"/tmp"}',
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
      expect(events).toHaveLength(2)
      expect(events.map((e: any) => e.eventKind)).toEqual([
        'codex.tool_decision',
        'tool_execution_start',
      ])

      const rawEvent = events[0] as any
      const typedEvent = events[1] as any
      const hrcEvents = await getAllHrcEvents()
      expectMatchingOtelMetadata(rawEvent, typedEvent, seed)
      expect(rawEvent.eventJson?.codex?.eventName).toBe('codex.tool_decision')
      expect(typedEvent.eventJson).toEqual({
        type: 'tool_execution_start',
        toolUseId: 'call_abc123',
        toolName: 'exec_command',
        input: { cmd: 'ls', workdir: '/tmp' },
      })
      expect(hrcEvents.some((e: any) => e.eventKind === 'turn.tool_call')).toBe(true)
    })

    it('derives tool_execution_end from successful codex.tool_result events', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.tool_result',
            attributes: {
              call_id: 'call_ok',
              tool_name: 'exec_command',
              output: 'hello world',
              success: true,
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
      const hrcEvents = await getAllHrcEvents()
      expect(events.map((e: any) => e.eventKind)).toEqual([
        'codex.tool_result',
        'tool_execution_end',
      ])

      const typedEvent = events[1] as any
      expect(typedEvent.eventJson?.type).toBe('tool_execution_end')
      expect(typedEvent.eventJson?.toolUseId).toBe('call_ok')
      expect(typedEvent.eventJson?.toolName).toBe('exec_command')
      expect(typedEvent.eventJson?.isError).toBe(false)
      expect(typedEvent.eventJson?.result?.content?.[0]?.text).toBe('hello world')
      expect(hrcEvents.some((e: any) => e.eventKind === 'turn.tool_result')).toBe(true)
    })

    it('marks derived tool_execution_end as an error when codex.tool_result reports success=false', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.tool_result',
            attributes: {
              call_id: 'call_err',
              tool_name: 'exec_command',
              output: 'command failed',
              success: false,
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
      expect(events.map((e: any) => e.eventKind)).toEqual([
        'codex.tool_result',
        'tool_execution_end',
      ])
      expect((events[1] as any).eventJson?.isError).toBe(true)
    })

    it('derives a semantic turn.user_prompt from codex.user_prompt while preserving raw rows', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const prompt = 'fix the OTEL bridge in hrc-server'
      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.user_prompt',
            attributes: {
              prompt,
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
      expect(events.map((e: any) => e.eventKind)).toEqual(['codex.user_prompt', 'notice'])
      expect((events[1] as any).eventJson).toMatchObject({
        type: 'notice',
        level: 'info',
      })
      expect((events[1] as any).eventJson?.message).toContain(prompt)

      const hrcEvents = await getAllHrcEvents()
      const turnPrompts = hrcEvents.filter((e: any) => e.eventKind === 'turn.user_prompt')
      expect(turnPrompts).toHaveLength(1)
      expect(turnPrompts[0]?.payload).toEqual({
        type: 'message_end',
        message: {
          role: 'user',
          content: prompt,
        },
      })
    })

    it('suppresses the duplicated initial Codex prompt when dispatch already emitted it', async () => {
      const started = await startServer()
      server = started.server

      const prompt = 'Reply READY'
      const seed = await seedCodexLaunch({
        argv: ['codex', prompt, '--model', 'gpt-5.4'],
      })

      const db = openHrcDatabase(fixture.dbPath)
      try {
        db.hrcEvents.append({
          ts: fixture.now(),
          hostSessionId: seed.hostSessionId,
          scopeRef: seed.scopeRef,
          laneRef: seed.laneRef,
          generation: 1,
          runtimeId: seed.runtimeId,
          launchId: seed.launchId,
          category: 'turn',
          eventKind: 'turn.user_prompt',
          payload: createUserPromptPayload(prompt),
        })
      } finally {
        db.close()
      }

      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.user_prompt',
            attributes: {
              prompt,
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const hrcEvents = await getAllHrcEvents()
      const turnPrompts = hrcEvents.filter((e: any) => e.eventKind === 'turn.user_prompt')
      expect(turnPrompts).toHaveLength(1)
      expect(turnPrompts[0]?.payload).toEqual(createUserPromptPayload(prompt))
    })

    it('does not append a typed event for codex.api_request', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.api_request',
            attributes: {
              method: 'POST',
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const events = (await getAllEvents()).filter((e: any) => e.source === 'otel')
      expect(events).toHaveLength(1)
      expect((events[0] as any).eventKind).toBe('codex.api_request')
    })

    it('fans out semantic turn events derived from OTEL to hrc-only followers', async () => {
      const started = await startServer()
      server = started.server
      const seed = await seedCodexLaunch()

      const followerPromise = collectFollowEvents('/v1/events?follow=true&fromSeq=1', 400)

      await new Promise((r) => setTimeout(r, 50))
      const res = await postOtlp(
        started.endpoint,
        makeOtlpLogsBody([
          {
            eventName: 'codex.tool_decision',
            attributes: {
              call_id: 'call_follow',
              tool_name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
            },
          },
        ]),
        { 'x-hrc-launch-auth': seed.authHeader }
      )
      expect(res.status).toBe(200)

      const streamed = await followerPromise
      expect(streamed.map((event: any) => event.eventKind)).toEqual(['turn.tool_call'])
    })
  })
})
