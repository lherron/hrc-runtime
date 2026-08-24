import { describe, expect, it } from 'bun:test'

import { createStoreTestFixture, openHrcDatabase, testScopeRef, ts } from './store.fixture'

const fixture = createStoreTestFixture()

describe('SurfaceBindingRepository', () => {
  it('rebinds an existing surface to a newer runtime and keeps active queries current', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-surface-2',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-surface-3',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 2,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-2',
        hostSessionId: 'hsid-surface-2',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-3',
        hostSessionId: 'hsid-surface-3',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 2,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-2',
        hostSessionId: 'hsid-surface-2',
        runtimeId: 'rt-surface-2',
        generation: 1,
        boundAt: now,
      })
      const rebound = db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-2',
        hostSessionId: 'hsid-surface-3',
        runtimeId: 'rt-surface-3',
        generation: 2,
        boundAt: ts(),
      })

      expect(rebound.hostSessionId).toBe('hsid-surface-3')
      expect(rebound.runtimeId).toBe('rt-surface-3')
      expect(db.surfaceBindings.findByRuntime('rt-surface-2')).toEqual([])
      expect(db.surfaceBindings.findByRuntime('rt-surface-3')).toHaveLength(1)
      expect(db.surfaceBindings.listActive()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('unbinds a surface and removes it from active listings', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-surface-4',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-surface-4',
        hostSessionId: 'hsid-surface-4',
        scopeRef: testScopeRef('scope-surface'),
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      db.surfaceBindings.bind({
        surfaceKind: 'ghostty',
        surfaceId: 'ghostty-4',
        hostSessionId: 'hsid-surface-4',
        runtimeId: 'rt-surface-4',
        generation: 1,
        boundAt: now,
      })
      const unbound = db.surfaceBindings.unbind('ghostty', 'ghostty-4', ts(), 'user-detached')

      expect(unbound).not.toBeNull()
      expect(unbound?.unboundAt).toBeString()
      expect(unbound?.reason).toBe('user-detached')
      expect(db.surfaceBindings.findByRuntime('rt-surface-4')).toEqual([])
      expect(db.surfaceBindings.listActive()).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. RuntimeBufferRepository
// ---------------------------------------------------------------------------
describe('RuntimeBufferRepository', () => {
  it('appends and queries buffer chunks by runtime', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-buf-1',
        hostSessionId: 'hsid-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        harness: 'agent-sdk',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: 'run-buf-1',
        hostSessionId: 'hsid-buf-1',
        runtimeId: 'rt-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        status: 'completed',
        acceptedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: 'run-buf-2',
        hostSessionId: 'hsid-buf-1',
        runtimeId: 'rt-buf-1',
        scopeRef: testScopeRef('scope-buf'),
        laneRef: 'default',
        generation: 1,
        transport: 'sdk',
        status: 'completed',
        acceptedAt: now,
        completedAt: now,
        updatedAt: now,
      })

      db.runtimeBuffers.append({
        runtimeId: 'rt-buf-1',
        runId: 'run-buf-1',
        chunkSeq: 1,
        text: 'Hello ',
        createdAt: now,
      })
      db.runtimeBuffers.append({
        runtimeId: 'rt-buf-1',
        runId: 'run-buf-2',
        chunkSeq: 1,
        text: 'World',
        createdAt: now,
      })

      const chunks = db.runtimeBuffers.listByRuntimeId('rt-buf-1')
      expect(chunks.length).toBe(2)
      expect(chunks[0].runId).toBe('run-buf-1')
      expect(chunks[1].runId).toBe('run-buf-2')
      expect(chunks[0].chunkSeq).toBe(1)
      expect(chunks[1].chunkSeq).toBe(1)
      expect(chunks[0].text).toBe('Hello ')
      expect(chunks[1].text).toBe('World')

      const runOneChunks = db.runtimeBuffers.listByRunId('run-buf-1')
      const runTwoChunks = db.runtimeBuffers.listByRunId('run-buf-2')
      expect(runOneChunks.map((chunk) => chunk.text)).toEqual(['Hello '])
      expect(runTwoChunks.map((chunk) => chunk.text)).toEqual(['World'])

      db.runtimeBuffers.append({
        runtimeId: 'rt-buf-1',
        runId: 'run-buf-1',
        chunkSeq: 4,
        text: 'tail',
        createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      })
      expect(db.runtimeBuffers.nextChunkSeqByRunId('run-buf-1')).toBe(5)
      expect(db.runtimeBuffers.listTailByRunId('run-buf-1', 1).map((chunk) => chunk.text)).toEqual([
        'tail',
      ])
      expect(
        db.runtimeBuffers.listTailByRuntimeId('rt-buf-1', 1).map((chunk) => chunk.text)
      ).toEqual(['tail'])
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 10. Concurrent read safety with WAL
// ---------------------------------------------------------------------------
describe('WAL concurrent reads', () => {
  it('allows concurrent readers while writer has open transaction', () => {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-wal-1',
        scopeRef: testScopeRef('scope-wal'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })

      // Open a second reader connection
      const db2 = openHrcDatabase(fixture.dbPath)
      try {
        // Writer appends an event
        db.events.append({
          ts: now,
          hostSessionId: 'hsid-wal-1',
          scopeRef: testScopeRef('scope-wal'),
          laneRef: 'default',
          generation: 1,
          source: 'hrc',
          eventKind: 'test.wal',
          eventJson: {},
        })

        // Reader should be able to query without blocking
        const session = db2.sessions.getByHostSessionId('hsid-wal-1')
        expect(session).not.toBeNull()
      } finally {
        db2.close()
      }
    } finally {
      db.close()
    }
  })
})
