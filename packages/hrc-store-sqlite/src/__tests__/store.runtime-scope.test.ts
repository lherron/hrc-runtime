import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcDatabase } from '../index.js'
import { openHrcDatabase } from '../index.js'

const TARGET_SCOPE = 'agent:astra:project:agent-control-plane:task:primary'

describe('runtime scope-local lookup', () => {
  let db: HrcDatabase

  beforeEach(() => {
    db = openHrcDatabase(':memory:')
  })

  afterEach(() => db.close())

  it('returns only the requested scope and uses the scope index', () => {
    for (const [runtimeId, scopeRef] of [
      ['rt-target-old', TARGET_SCOPE],
      ['rt-foreign', 'agent:cody:project:hrc-runtime:task:primary'],
      ['rt-target-new', TARGET_SCOPE],
    ] as const) {
      db.sessions.insert({
        hostSessionId: `hsid-${runtimeId}`,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: '2026-09-20T06:00:00.000Z',
        updatedAt: '2026-09-20T06:00:02.000Z',
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId: `hsid-${runtimeId}`,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-app-server',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: runtimeId.endsWith('new')
          ? '2026-09-20T06:00:01.000Z'
          : '2026-09-20T06:00:00.000Z',
        updatedAt: '2026-09-20T06:00:02.000Z',
      })
    }

    expect(db.runtimes.listByScopeRef(TARGET_SCOPE).map((row) => row.runtimeId)).toEqual([
      'rt-target-old',
      'rt-target-new',
    ])

    const detail = db.sqlite
      .query<{ detail: string }, [string]>(
        'EXPLAIN QUERY PLAN SELECT runtime_id FROM runtimes WHERE scope_ref = ?'
      )
      .all(TARGET_SCOPE)
      .map((row) => row.detail)
      .join('\n')
    expect(detail).toContain('idx_runtimes_scope_ref')
  })
})
