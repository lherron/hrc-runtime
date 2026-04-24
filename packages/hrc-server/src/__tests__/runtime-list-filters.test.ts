import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
let originalStaleGenerationHours: string | undefined

beforeEach(async () => {
  originalStaleGenerationHours = process.env['HRC_STALE_GENERATION_HOURS']
  fixture = await createHrcTestFixture('hrc-runtime-list-filters-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (originalStaleGenerationHours === undefined) {
    process.env['HRC_STALE_GENERATION_HOURS'] = undefined
  } else {
    process.env['HRC_STALE_GENERATION_HOURS'] = originalStaleGenerationHours
  }

  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

type SeedRuntimeOptions = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  transport: 'tmux' | 'headless' | 'sdk'
  status: string
  createdAt?: string | undefined
}

type RuntimeListRow = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  transport: string
  status: string
  createdAt: string
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function seedRuntime(options: SeedRuntimeOptions): void {
  fixture.seedSession(options.hostSessionId, options.scopeRef)

  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  const createdAt = options.createdAt ?? now

  try {
    db.runtimes.insert({
      runtimeId: options.runtimeId,
      hostSessionId: options.hostSessionId,
      scopeRef: options.scopeRef.startsWith('agent:')
        ? options.scopeRef
        : `agent:${options.scopeRef}`,
      laneRef: 'default',
      generation: 1,
      transport: options.transport,
      harness: options.transport === 'tmux' ? 'claude-code' : 'agent-sdk',
      provider: 'anthropic',
      status: options.status,
      ...(options.transport === 'tmux'
        ? {
            tmuxJson: {
              socketPath: fixture.tmuxSocketPath,
              sessionName: 'hrc-missing-session',
              windowName: 'main',
              sessionId: '$dead',
              windowId: '@dead',
              paneId: '%dead',
            },
          }
        : {}),
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: createdAt,
      createdAt,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

async function listRuntimes(query = ''): Promise<RuntimeListRow[]> {
  const path = query ? `/v1/runtimes?${query}` : '/v1/runtimes'
  const res = await fixture.fetchSocket(path)
  expect(res.status).toBe(200)
  return (await res.json()) as RuntimeListRow[]
}

function runtimeIds(rows: RuntimeListRow[]): string[] {
  return rows.map((row) => row.runtimeId)
}

describe('GET /v1/runtimes list filters', () => {
  it('filters by transport for tmux, headless, and sdk runtimes', async () => {
    seedRuntime({
      runtimeId: 'rt-filter-tmux',
      hostSessionId: 'hsid-filter-tmux',
      scopeRef: 'agent:list-filter-tmux',
      transport: 'tmux',
      status: 'dead',
    })
    seedRuntime({
      runtimeId: 'rt-filter-headless',
      hostSessionId: 'hsid-filter-headless',
      scopeRef: 'agent:list-filter-headless',
      transport: 'headless',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-filter-sdk',
      hostSessionId: 'hsid-filter-sdk',
      scopeRef: 'agent:list-filter-sdk',
      transport: 'sdk',
      status: 'ready',
    })

    expect(runtimeIds(await listRuntimes('transport=tmux'))).toEqual(['rt-filter-tmux'])
    expect(runtimeIds(await listRuntimes('transport=headless'))).toEqual(['rt-filter-headless'])
    expect(runtimeIds(await listRuntimes('transport=sdk'))).toEqual(['rt-filter-sdk'])
  })

  it('filters by a single status value', async () => {
    seedRuntime({
      runtimeId: 'rt-status-ready',
      hostSessionId: 'hsid-status-ready',
      scopeRef: 'agent:list-status-ready',
      transport: 'headless',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-status-busy',
      hostSessionId: 'hsid-status-busy',
      scopeRef: 'agent:list-status-busy',
      transport: 'headless',
      status: 'busy',
    })
    seedRuntime({
      runtimeId: 'rt-status-terminated',
      hostSessionId: 'hsid-status-terminated',
      scopeRef: 'agent:list-status-terminated',
      transport: 'headless',
      status: 'terminated',
    })

    expect(runtimeIds(await listRuntimes('status=busy'))).toEqual(['rt-status-busy'])
  })

  it('filters by a comma-separated status union', async () => {
    seedRuntime({
      runtimeId: 'rt-status-list-ready',
      hostSessionId: 'hsid-status-list-ready',
      scopeRef: 'agent:list-status-list-ready',
      transport: 'sdk',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-status-list-busy',
      hostSessionId: 'hsid-status-list-busy',
      scopeRef: 'agent:list-status-list-busy',
      transport: 'sdk',
      status: 'busy',
    })
    seedRuntime({
      runtimeId: 'rt-status-list-dead',
      hostSessionId: 'hsid-status-list-dead',
      scopeRef: 'agent:list-status-list-dead',
      transport: 'sdk',
      status: 'dead',
    })

    expect(runtimeIds(await listRuntimes('status=ready,busy'))).toEqual([
      'rt-status-list-ready',
      'rt-status-list-busy',
    ])
  })

  it('filters by scope prefix', async () => {
    seedRuntime({
      runtimeId: 'rt-scope-cody',
      hostSessionId: 'hsid-scope-cody',
      scopeRef: 'agent:cody/project:agent-spaces/task:T-01219',
      transport: 'headless',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-scope-cody-other',
      hostSessionId: 'hsid-scope-cody-other',
      scopeRef: 'agent:cody/project:wrkq',
      transport: 'headless',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-scope-clod',
      hostSessionId: 'hsid-scope-clod',
      scopeRef: 'agent:clod/project:agent-spaces',
      transport: 'headless',
      status: 'ready',
    })

    expect(runtimeIds(await listRuntimes('scope=agent:cody'))).toEqual([
      'rt-scope-cody',
      'rt-scope-cody-other',
    ])
  })

  it('filters stale runtimes with an explicit olderThan duration', async () => {
    seedRuntime({
      runtimeId: 'rt-stale-explicit-old-ready',
      hostSessionId: 'hsid-stale-explicit-old-ready',
      scopeRef: 'agent:list-stale-explicit-old-ready',
      transport: 'headless',
      status: 'ready',
      createdAt: isoHoursAgo(3),
    })
    seedRuntime({
      runtimeId: 'rt-stale-explicit-old-busy',
      hostSessionId: 'hsid-stale-explicit-old-busy',
      scopeRef: 'agent:list-stale-explicit-old-busy',
      transport: 'headless',
      status: 'busy',
      createdAt: isoHoursAgo(2),
    })
    seedRuntime({
      runtimeId: 'rt-stale-explicit-fresh',
      hostSessionId: 'hsid-stale-explicit-fresh',
      scopeRef: 'agent:list-stale-explicit-fresh',
      transport: 'headless',
      status: 'ready',
      createdAt: isoHoursAgo(0.25),
    })

    expect(runtimeIds(await listRuntimes('stale=true&olderThan=1h'))).toEqual([
      'rt-stale-explicit-old-ready',
      'rt-stale-explicit-old-busy',
    ])
  })

  it('uses HRC_STALE_GENERATION_HOURS when stale is requested without olderThan', async () => {
    process.env['HRC_STALE_GENERATION_HOURS'] = '2'

    seedRuntime({
      runtimeId: 'rt-stale-default-old',
      hostSessionId: 'hsid-stale-default-old',
      scopeRef: 'agent:list-stale-default-old',
      transport: 'sdk',
      status: 'ready',
      createdAt: isoHoursAgo(3),
    })
    seedRuntime({
      runtimeId: 'rt-stale-default-fresh',
      hostSessionId: 'hsid-stale-default-fresh',
      scopeRef: 'agent:list-stale-default-fresh',
      transport: 'sdk',
      status: 'ready',
      createdAt: isoHoursAgo(1),
    })

    expect(runtimeIds(await listRuntimes('stale=true'))).toEqual(['rt-stale-default-old'])
  })

  it('excludes terminal statuses from stale results even when older than the threshold', async () => {
    seedRuntime({
      runtimeId: 'rt-stale-terminal-ready',
      hostSessionId: 'hsid-stale-terminal-ready',
      scopeRef: 'agent:list-stale-terminal-ready',
      transport: 'headless',
      status: 'ready',
      createdAt: isoHoursAgo(5),
    })
    seedRuntime({
      runtimeId: 'rt-stale-terminal-terminated',
      hostSessionId: 'hsid-stale-terminal-terminated',
      scopeRef: 'agent:list-stale-terminal-terminated',
      transport: 'headless',
      status: 'terminated',
      createdAt: isoHoursAgo(5),
    })
    seedRuntime({
      runtimeId: 'rt-stale-terminal-dead',
      hostSessionId: 'hsid-stale-terminal-dead',
      scopeRef: 'agent:list-stale-terminal-dead',
      transport: 'headless',
      status: 'dead',
      createdAt: isoHoursAgo(5),
    })

    expect(runtimeIds(await listRuntimes('stale=true&olderThan=1h'))).toEqual([
      'rt-stale-terminal-ready',
    ])
  })

  it('returns --json as a predictable JSON array shape', async () => {
    seedRuntime({
      runtimeId: 'rt-json-headless',
      hostSessionId: 'hsid-json-headless',
      scopeRef: 'agent:list-json-headless',
      transport: 'headless',
      status: 'ready',
    })
    seedRuntime({
      runtimeId: 'rt-json-sdk',
      hostSessionId: 'hsid-json-sdk',
      scopeRef: 'agent:list-json-sdk',
      transport: 'sdk',
      status: 'ready',
    })

    const rows = await listRuntimes('json=true&transport=headless')

    expect(rows).toEqual([
      expect.objectContaining({
        runtimeId: 'rt-json-headless',
        hostSessionId: 'hsid-json-headless',
        scopeRef: 'agent:list-json-headless',
        transport: 'headless',
        status: 'ready',
      }),
    ])
  })

  it('composes transport and stale filters', async () => {
    seedRuntime({
      runtimeId: 'rt-compose-headless-old',
      hostSessionId: 'hsid-compose-headless-old',
      scopeRef: 'agent:list-compose-headless-old',
      transport: 'headless',
      status: 'ready',
      createdAt: isoHoursAgo(4),
    })
    seedRuntime({
      runtimeId: 'rt-compose-sdk-old',
      hostSessionId: 'hsid-compose-sdk-old',
      scopeRef: 'agent:list-compose-sdk-old',
      transport: 'sdk',
      status: 'ready',
      createdAt: isoHoursAgo(4),
    })
    seedRuntime({
      runtimeId: 'rt-compose-headless-fresh',
      hostSessionId: 'hsid-compose-headless-fresh',
      scopeRef: 'agent:list-compose-headless-fresh',
      transport: 'headless',
      status: 'ready',
      createdAt: isoHoursAgo(0.5),
    })

    expect(runtimeIds(await listRuntimes('transport=headless&stale=true&olderThan=1h'))).toEqual([
      'rt-compose-headless-old',
    ])
  })
})
