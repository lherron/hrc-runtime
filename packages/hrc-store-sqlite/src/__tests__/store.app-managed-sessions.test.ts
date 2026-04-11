import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'
import type { HrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function testScopeRef(scopeKey: string): string {
  return `agent:test:project:hrc-store-managed-sessions:task:${scopeKey}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-managed-session-store-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seedSession(
  db: HrcDatabase,
  opts: {
    hostSessionId: string
    scopeRef?: string
    laneRef?: string
    generation?: number
  }
) {
  const now = ts()
  db.sessions.insert({
    hostSessionId: opts.hostSessionId,
    scopeRef: opts.scopeRef ?? testScopeRef(opts.hostSessionId),
    laneRef: opts.laneRef ?? 'default',
    generation: opts.generation ?? 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

describe('Phase 7 migration — app_managed_sessions', () => {
  it('applies the managed-session registry migration and exposes the repository', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0005_app_managed_sessions')
      expect(db.appManagedSessions).toBeDefined()
      expect(db.appSessions).toBeDefined()
    } finally {
      db.close()
    }
  })
})

describe('AppManagedSessionRepository', () => {
  it('creates and reloads a harness managed session with stored runtime intent', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-harness' })

      const now = ts()
      const result = db.appManagedSessions.create({
        appId: 'workbench',
        appSessionKey: 'assistant',
        kind: 'harness',
        label: 'Assistant',
        metadata: { color: 'blue' },
        activeHostSessionId: 'hsid-harness',
        generation: 1,
        status: 'active',
        lastAppliedSpec: {
          kind: 'harness',
          runtimeIntent: {
            placement: 'workspace',
            harness: {
              provider: 'openai',
              interactive: true,
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      })

      expect(result.kind).toBe('harness')
      expect(result.activeHostSessionId).toBe('hsid-harness')
      expect(result.lastAppliedSpec?.kind).toBe('harness')
      expect(result.lastAppliedSpec?.runtimeIntent.harness.provider).toBe('openai')
    } finally {
      db.close()
    }
  })

  it('creates and reloads a command managed session with stored launch spec', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-command' })

      const now = ts()
      const result = db.appManagedSessions.create({
        appId: 'workbench',
        appSessionKey: 'logs',
        kind: 'command',
        activeHostSessionId: 'hsid-command',
        generation: 1,
        status: 'active',
        lastAppliedSpec: {
          kind: 'command',
          command: {
            launchMode: 'exec',
            argv: ['tail', '-f', 'server.log'],
            cwd: '/tmp/workbench',
          },
        },
        createdAt: now,
        updatedAt: now,
      })

      expect(result.kind).toBe('command')
      expect(result.lastAppliedSpec?.kind).toBe('command')
      expect(result.lastAppliedSpec?.command.argv).toEqual(['tail', '-f', 'server.log'])
    } finally {
      db.close()
    }
  })

  it('finds and filters managed sessions without disturbing legacy app_sessions rows', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })
      seedSession(db, { hostSessionId: 'hsid-2' })

      const now = ts()
      db.appSessions.create({
        appId: 'workbench',
        appSessionKey: 'assistant',
        hostSessionId: 'hsid-1',
        createdAt: now,
        updatedAt: now,
      })

      db.appManagedSessions.create({
        appId: 'workbench',
        appSessionKey: 'assistant',
        kind: 'harness',
        activeHostSessionId: 'hsid-1',
        generation: 2,
        status: 'active',
        lastAppliedSpec: {
          kind: 'harness',
          runtimeIntent: {
            placement: 'workspace',
            harness: {
              provider: 'anthropic',
              interactive: true,
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      })
      db.appManagedSessions.create({
        appId: 'workbench',
        appSessionKey: 'logs',
        kind: 'command',
        activeHostSessionId: 'hsid-2',
        generation: 1,
        status: 'removed',
        removedAt: now,
        lastAppliedSpec: {
          kind: 'command',
          command: {
            launchMode: 'shell',
          },
        },
        createdAt: now,
        updatedAt: now,
      })

      const found = db.appManagedSessions.findByKey('workbench', 'assistant')
      const visible = db.appManagedSessions.findByApp('workbench')
      const all = db.appManagedSessions.findByApp('workbench', { includeRemoved: true })
      const legacy = db.appSessions.findByKey('workbench', 'assistant')

      expect(found?.generation).toBe(2)
      expect(visible.map((session) => session.appSessionKey)).toEqual(['assistant'])
      expect(all.map((session) => session.appSessionKey)).toEqual(['assistant', 'logs'])
      expect(legacy?.hostSessionId).toBe('hsid-1')
    } finally {
      db.close()
    }
  })

  it('updates removal state and stored session specs', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, { hostSessionId: 'hsid-1' })
      seedSession(db, { hostSessionId: 'hsid-2' })

      const now = ts()
      db.appManagedSessions.create({
        appId: 'workbench',
        appSessionKey: 'assistant',
        kind: 'harness',
        activeHostSessionId: 'hsid-1',
        generation: 1,
        status: 'active',
        lastAppliedSpec: {
          kind: 'harness',
          runtimeIntent: {
            placement: 'workspace',
            harness: {
              provider: 'anthropic',
              interactive: true,
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      })

      const updated = db.appManagedSessions.update('workbench', 'assistant', {
        activeHostSessionId: 'hsid-2',
        generation: 2,
        status: 'removed',
        removedAt: now,
        lastAppliedSpec: {
          kind: 'command',
          command: {
            launchMode: 'exec',
            argv: ['printenv'],
          },
        },
        updatedAt: ts(),
      })

      expect(updated).not.toBeNull()
      expect(updated?.activeHostSessionId).toBe('hsid-2')
      expect(updated?.generation).toBe(2)
      expect(updated?.status).toBe('removed')
      expect(updated?.removedAt).toBe(now)
      expect(updated?.lastAppliedSpec?.kind).toBe('command')
      expect(updated?.lastAppliedSpec?.command.argv).toEqual(['printenv'])
    } finally {
      db.close()
    }
  })
})
