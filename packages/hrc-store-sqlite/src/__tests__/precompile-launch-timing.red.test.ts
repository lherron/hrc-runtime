import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import { openHrcDatabase } from '../index'

type TimingFields = Record<string, unknown>

type TimingContext = {
  transport: 'headless' | 'interactive' | 'preview'
  runtimeId: string
  logger: {
    info(message: string, fields: TimingFields): void
    warn(message: string, fields: TimingFields): void
  }
}

describe('pre-compile session write timing (T-06402)', () => {
  it('emits updateIntent timing and same-handle WAL/checkpoint/synchronous evidence', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'hrc-precompile-timing-'))
    const db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
    const info: Array<{ message: string; fields: TimingFields }> = []
    const warnings: Array<{ message: string; fields: TimingFields }> = []

    try {
      const now = new Date().toISOString()
      db.sessions.insert({
        hostSessionId: 'hsid-precompile-timing',
        scopeRef: 'agent:test:project:hrc-runtime:task:precompile-timing',
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      // A separately opened SQLite handle would retain its own default. Seeing 0
      // in the timing payload proves the repository read the live owning handle.
      db.sqlite.exec('PRAGMA synchronous = OFF;')

      const timing: TimingContext = {
        transport: 'headless',
        runtimeId: 'runtime-update-intent',
        logger: {
          info: (message, fields) => info.push({ message, fields }),
          warn: (message, fields) => warnings.push({ message, fields }),
        },
      }
      const updateIntent = db.sessions.updateIntent.bind(db.sessions) as unknown as (
        hostSessionId: string,
        intent: HrcRuntimeIntent,
        updatedAt: string,
        timing: TimingContext
      ) => unknown

      updateIntent(
        'hsid-precompile-timing',
        {
          placement: {},
          harness: { provider: 'openai', id: 'codex-cli', interactive: false },
        } as HrcRuntimeIntent,
        now,
        timing
      )

      const entry = info.find(({ fields }) =>
        String(fields['phase']).match(/update.*intent|intent.*update/i)
      )
      expect(entry?.message).toBe('broker.timing')
      expect(entry?.fields).toMatchObject({
        transport: 'headless',
        runtimeId: 'runtime-update-intent',
        synchronous: 0,
      })
      expect(typeof entry?.fields['durMs']).toBe('number')
      expect(typeof entry?.fields['walBytesBefore']).toBe('number')
      expect(typeof entry?.fields['walBytesAfter']).toBe('number')
      expect(typeof entry?.fields['checkpointRan']).toBe('boolean')
      expect(typeof entry?.fields['checkpointMode']).toBe('string')
      expect(Object.keys(entry?.fields ?? {})).not.toContain('busyTimeout')
      expect(Object.keys(entry?.fields ?? {})).not.toContain('busy_timeout')
      expect(warnings).toHaveLength(0)
    } finally {
      db.close()
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
