import { describe, expect, it } from 'bun:test'

import { openHrcDatabase } from '../index'

describe('durable repository scalar counts', () => {
  it('counts every durable session and runtime row without listing records', () => {
    const db = openHrcDatabase(':memory:')
    const now = '2026-07-18T12:00:00.000Z'

    try {
      for (const index of [1, 2]) {
        db.sessions.insert({
          hostSessionId: `hsid-count-${index}`,
          scopeRef: `agent:test:project:hrc-runtime:task:count-${index}`,
          laneRef: 'default',
          generation: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          ancestorScopeRefs: [],
        })
      }

      for (const index of [1, 2, 3]) {
        const sessionIndex = index === 3 ? 2 : index
        db.runtimes.insert({
          runtimeId: `rt-count-${index}`,
          hostSessionId: `hsid-count-${sessionIndex}`,
          scopeRef: `agent:test:project:hrc-runtime:task:count-${sessionIndex}`,
          laneRef: 'default',
          generation: 1,
          transport: 'headless',
          harness: 'codex',
          provider: 'openai',
          status: 'ready',
          supportsInflightInput: true,
          adopted: false,
          createdAt: now,
          updatedAt: now,
        })
      }

      const sessions = db.sessions as unknown as { count?: () => number }
      const runtimes = db.runtimes as unknown as { count?: () => number }
      expect({ sessions: sessions.count?.(), runtimes: runtimes.count?.() }).toEqual({
        sessions: 2,
        runtimes: 3,
      })
    } finally {
      db.close()
    }
  })
})
