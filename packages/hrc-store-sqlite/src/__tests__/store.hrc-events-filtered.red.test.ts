/**
 * RED tests — T-04232: hrc-store-sqlite filtered query for monitor watch
 *
 * These tests target a new method on HrcLifecycleEventRepository:
 *
 *   listFromHrcSeqFiltered(fromHrcSeq: number, filters: HrcLifecycleMonitorFilters): HrcLifecycleEvent[]
 *
 * with filter type:
 *
 *   export type HrcLifecycleMonitorFilters = {
 *     // Scope/identity narrowing (delegated to buildLifecycleWhere)
 *     scopeRef?: string | undefined
 *     laneRef?: string | undefined
 *     hostSessionId?: string | undefined
 *     generation?: number | undefined
 *     runtimeId?: string | undefined
 *     runId?: string | undefined
 *
 *     // Event-kind set filter (SQL: event_kind IN (?,...))
 *     eventKinds?: string[] | undefined
 *
 *     // Tool-name filter on turn.tool_call payload
 *     // SQL: event_kind = 'turn.tool_call' AND json_extract(payload_json,'$.toolName') IN (?,...))
 *     toolNames?: string[] | undefined
 *
 *     // Payload substring match (parameterized LIKE, combined with other narrowing)
 *     // SQL: payload_json LIKE ?   where ? = '%<value>%'
 *     payloadContains?: string | undefined
 *
 *     // Milestone curated preset (supersedes eventKinds/toolNames when true).
 *     // Exact predicate:
 *     //   event_kind IN ('turn.started','turn.completed','turn.failed',
 *     //                  'session.started','session.cleared',
 *     //                  'runtime.idle','runtime.dead')
 *     //   OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName') IN ('Agent','Skill'))
 *     //   OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName')='Bash'
 *     //       AND (payload_json LIKE '%hrcchat dm%'
 *     //            OR payload_json LIKE '%wrkq touch%'
 *     //            OR payload_json LIKE '%wrkq set%'
 *     //            OR payload_json LIKE '%wrkq comment%'
 *     //            OR payload_json LIKE '%git commit%'))
 *     milestone?: boolean | undefined
 *
 *     limit?: number | undefined
 *   }
 *
 * All tests FAIL against current HEAD: listFromHrcSeqFiltered does not exist.
 * Correct failure reason: TypeError — db.hrcEvents.listFromHrcSeqFiltered is not a function
 *
 * Daedalus invariant: filtering belongs at the SQLite query layer (not in-memory);
 * maxHrcSeq() must return the global max regardless of filter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from '../index'

// Import the new filter type — fails until exported from repositories.ts / index.ts
// The impl must export HrcLifecycleMonitorFilters from packages/hrc-store-sqlite/src/index.ts
import type { HrcLifecycleMonitorFilters } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:hrc-store:task:${key}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-events-filtered-red-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function seedSession(db: ReturnType<typeof openHrcDatabase>, hostSessionId: string, key: string) {
  const now = ts()
  db.sessions.insert({
    hostSessionId,
    scopeRef: scopeRef(key),
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

function baseEvent(hostSessionId: string, key: string) {
  return {
    ts: ts(),
    hostSessionId,
    scopeRef: scopeRef(key),
    laneRef: 'default',
    generation: 1,
    payload: {},
  }
}

// ---------------------------------------------------------------------------
// 1. eventKinds IN filter
// ---------------------------------------------------------------------------

describe('listFromHrcSeqFiltered — eventKinds set filter', () => {
  it('returns only rows whose event_kind is in the requested set', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-k', 'k')
      const base = baseEvent('hsid-k', 'k')

      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.started', payload: {} })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', command: 'echo hi' },
      })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.tool_result', payload: {} })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.completed', payload: {} })
      db.hrcEvents.append({ ...base, category: 'runtime', eventKind: 'runtime.idle', payload: {} })

      const filters: HrcLifecycleMonitorFilters = {
        eventKinds: ['turn.started', 'turn.completed'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(2)
      expect(
        result.every((e: HrcLifecycleEvent) =>
          ['turn.started', 'turn.completed'].includes(e.eventKind)
        )
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('returns empty array when no events match the kind set', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-k2', 'k2')
      const base = baseEvent('hsid-k2', 'k2')

      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.started', payload: {} })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.completed', payload: {} })

      const filters: HrcLifecycleMonitorFilters = {
        eventKinds: ['runtime.idle', 'runtime.dead'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('respects fromHrcSeq alongside eventKinds', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-k3', 'k3')
      const base = baseEvent('hsid-k3', 'k3')

      const e1 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.tool_call', payload: {} })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.started', payload: {} }) // seq > e1

      const filters: HrcLifecycleMonitorFilters = {
        eventKinds: ['turn.started'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(e1.hrcSeq + 1, filters)

      // Only the turn.started AFTER e1
      expect(result).toHaveLength(1)
      expect(result[0]!.hrcSeq).toBeGreaterThan(e1.hrcSeq)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. toolNames filter (json_extract on payload_json)
// ---------------------------------------------------------------------------

describe('listFromHrcSeqFiltered — toolNames (json_extract) filter', () => {
  it('returns only turn.tool_call events whose toolName is in the requested set', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-t', 't')
      const base = baseEvent('hsid-t', 't')

      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.started', payload: {} })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          type: 'tool_execution_start',
          toolName: 'Bash',
          toolUseId: 'tid-1',
          input: { command: 'ls' },
        },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          type: 'tool_execution_start',
          toolName: 'Read',
          toolUseId: 'tid-2',
          input: { file_path: '/tmp/x' },
        },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          type: 'tool_execution_start',
          toolName: 'Agent',
          toolUseId: 'tid-3',
          input: { prompt: 'do work' },
        },
      })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.completed', payload: {} })

      const filters: HrcLifecycleMonitorFilters = {
        toolNames: ['Bash', 'Agent'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      // Only 2 turn.tool_call events with toolName=Bash or Agent
      expect(result).toHaveLength(2)
      expect(
        result.every((e: HrcLifecycleEvent) => {
          const p = e.payload as Record<string, unknown>
          return (
            e.eventKind === 'turn.tool_call' && ['Bash', 'Agent'].includes(p['toolName'] as string)
          )
        })
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('toolNames filter does not return non-tool_call events even if payload contains tool name text', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-t2', 't2')
      const base = baseEvent('hsid-t2', 't2')

      // turn.started payload incidentally contains 'Bash' text — must not match toolNames filter
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.started',
        payload: { note: 'Bash run started' },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', toolUseId: 'tid-1', input: {} },
      })

      const filters: HrcLifecycleMonitorFilters = {
        toolNames: ['Bash'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(1)
      expect(result[0]!.eventKind).toBe('turn.tool_call')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. payloadContains (payload grep) filter
// ---------------------------------------------------------------------------

describe('listFromHrcSeqFiltered — payloadContains (grep) filter', () => {
  it('returns events whose payload_json contains the given substring', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-g', 'g')
      const base = baseEvent('hsid-g', 'g')

      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', input: { command: 'hrcchat dm cody@agent-spaces "hello"' } },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', input: { command: 'bun test' } },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', input: { command: 'hrcchat dm larry@hrc-runtime "start"' } },
      })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.completed', payload: {} })

      const filters: HrcLifecycleMonitorFilters = {
        payloadContains: 'hrcchat dm',
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(2)
      expect(
        result.every((e: HrcLifecycleEvent) => JSON.stringify(e.payload).includes('hrcchat dm'))
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('payloadContains combined with eventKinds narrows both dimensions', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-g2', 'g2')
      const base = baseEvent('hsid-g2', 'g2')

      // turn.tool_call with matching payload
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', input: { command: 'git commit -m "fix"' } },
      })
      // turn.started with matching text in payload (should NOT match because eventKinds excludes it)
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.started',
        payload: { note: 'git commit about to run' },
      })
      // turn.tool_call without matching payload
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Read', input: { file_path: '/tmp/x' } },
      })

      const filters: HrcLifecycleMonitorFilters = {
        eventKinds: ['turn.tool_call'],
        payloadContains: 'git commit',
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(1)
      expect(result[0]!.eventKind).toBe('turn.tool_call')
      expect(JSON.stringify(result[0]!.payload)).toContain('git commit')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. milestone curated preset
// ---------------------------------------------------------------------------
// Exact milestone predicate (documented for impl):
//   event_kind IN ('turn.started','turn.completed','turn.failed',
//                  'session.started','session.cleared',
//                  'runtime.idle','runtime.dead')
//   OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName') IN ('Agent','Skill'))
//   OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName')='Bash'
//       AND (payload_json LIKE '%hrcchat dm%'
//            OR payload_json LIKE '%wrkq touch%'
//            OR payload_json LIKE '%wrkq set%'
//            OR payload_json LIKE '%wrkq comment%'
//            OR payload_json LIKE '%git commit%'))

describe('listFromHrcSeqFiltered — milestone curated preset', () => {
  it('milestone=true returns turn lifecycle, runtime lifecycle, and operator tool calls; excludes read/write noise', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-m', 'm')
      const base = baseEvent('hsid-m', 'm')

      // MILESTONE events — must be returned
      const e1 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.started',
        payload: {},
      })
      const e2 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      })
      const e3 = db.hrcEvents.append({
        ...base,
        category: 'runtime',
        eventKind: 'runtime.idle',
        payload: {},
      })
      const e4 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Agent', toolUseId: 'tid-a', input: { prompt: 'do work' } },
      })
      const e5 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Bash',
          toolUseId: 'tid-b',
          input: { command: 'hrcchat dm cody@agent-spaces "hi"', description: 'send dm' },
        },
      })
      const e6 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Bash',
          toolUseId: 'tid-c',
          input: { command: 'wrkq touch inbox/task -t "New"', description: 'create task' },
        },
      })
      const e7 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Bash',
          toolUseId: 'tid-d',
          input: { command: 'git commit -m "feat: add filtering"' },
        },
      })

      // NON-MILESTONE events — must NOT be returned
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', toolUseId: 'tid-n1', input: { command: 'bun test' } },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Read', toolUseId: 'tid-n2', input: { file_path: '/tmp/x' } },
      })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Edit',
          toolUseId: 'tid-n3',
          input: { file_path: '/tmp/y', old_string: 'a', new_string: 'b' },
        },
      })
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.tool_result', payload: {} })
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.message',
        payload: { type: 'message_end', message: { role: 'assistant', content: 'ok' } },
      })

      const filters: HrcLifecycleMonitorFilters = { milestone: true }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      const resultIds = new Set(result.map((e: HrcLifecycleEvent) => e.hrcSeq))
      expect(resultIds.has(e1.hrcSeq)).toBe(true) // turn.started
      expect(resultIds.has(e2.hrcSeq)).toBe(true) // turn.completed
      expect(resultIds.has(e3.hrcSeq)).toBe(true) // runtime.idle
      expect(resultIds.has(e4.hrcSeq)).toBe(true) // Agent tool call
      expect(resultIds.has(e5.hrcSeq)).toBe(true) // Bash hrcchat dm
      expect(resultIds.has(e6.hrcSeq)).toBe(true) // Bash wrkq touch
      expect(resultIds.has(e7.hrcSeq)).toBe(true) // Bash git commit

      // total must match exactly the milestone count (7 events)
      expect(result).toHaveLength(7)
    } finally {
      db.close()
    }
  })

  it('milestone=true includes turn.failed and runtime.dead', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-m2', 'm2')
      const base = baseEvent('hsid-m2', 'm2')

      const e1 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.failed',
        payload: { errorCode: 'timeout' },
      })
      const e2 = db.hrcEvents.append({
        ...base,
        category: 'runtime',
        eventKind: 'runtime.dead',
        payload: { reason: 'killed' },
      })
      // non-milestone
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.tool_result', payload: {} })

      const filters: HrcLifecycleMonitorFilters = { milestone: true }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(2)
      const ids = new Set(result.map((e: HrcLifecycleEvent) => e.hrcSeq))
      expect(ids.has(e1.hrcSeq)).toBe(true)
      expect(ids.has(e2.hrcSeq)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('milestone=true with wrkq set and wrkq comment command predicates', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-m3', 'm3')
      const base = baseEvent('hsid-m3', 'm3')

      const e1 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Bash',
          toolUseId: 'tid-s1',
          input: { command: 'wrkq set T-04232 --state completed' },
        },
      })
      const e2 = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {
          toolName: 'Bash',
          toolUseId: 'tid-s2',
          input: { command: 'wrkq comment add T-04232 "done"' },
        },
      })
      // non-milestone Bash
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', toolUseId: 'tid-n', input: { command: 'ls -la' } },
      })

      const filters: HrcLifecycleMonitorFilters = { milestone: true }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      const ids = new Set(result.map((e: HrcLifecycleEvent) => e.hrcSeq))
      expect(ids.has(e1.hrcSeq)).toBe(true)
      expect(ids.has(e2.hrcSeq)).toBe(true)
      expect(result.length).toBeLessThanOrEqual(2)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. maxHrcSeq invariant — global high-water unaffected by filter
// ---------------------------------------------------------------------------
// Daedalus: "Selector semantics and cursor/high-water semantics must remain
// global, not filtered."

describe('listFromHrcSeqFiltered — global high-water invariant', () => {
  it('maxHrcSeq() returns global max even when filtered query returns fewer events', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-hw', 'hw')
      const base = baseEvent('hsid-hw', 'hw')

      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.started', payload: {} }) // seq 1
      db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: { toolName: 'Bash', input: {} },
      }) // seq 2
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.tool_result', payload: {} }) // seq 3
      db.hrcEvents.append({ ...base, category: 'turn', eventKind: 'turn.message', payload: {} }) // seq 4
      const lastEvent = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.completed',
        payload: {},
      }) // seq 5 — last

      // Filter to just 'turn.started' (seq 1)
      const filtered = db.hrcEvents.listFromHrcSeqFiltered(1, { eventKinds: ['turn.started'] })
      expect(filtered).toHaveLength(1)
      expect(filtered[0]!.hrcSeq).toBe(1)

      // Global max must still be the last event (seq 5), not the filtered max (seq 1)
      const globalMax = db.hrcEvents.maxHrcSeq()
      expect(globalMax).toBe(lastEvent.hrcSeq)
      expect(globalMax).toBeGreaterThan(filtered[0]!.hrcSeq)
    } finally {
      db.close()
    }
  })

  it('listFromHrcSeqFiltered with no events matching returns empty but maxHrcSeq remains valid', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-hw2', 'hw2')
      const base = baseEvent('hsid-hw2', 'hw2')

      const last = db.hrcEvents.append({
        ...base,
        category: 'turn',
        eventKind: 'turn.tool_call',
        payload: {},
      })

      const filtered = db.hrcEvents.listFromHrcSeqFiltered(1, { eventKinds: ['runtime.idle'] })
      expect(filtered).toHaveLength(0)

      // Even with zero filtered results, global max is intact
      expect(db.hrcEvents.maxHrcSeq()).toBe(last.hrcSeq)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. scopeRef combination — filtered query respects identity narrowing
// ---------------------------------------------------------------------------

describe('listFromHrcSeqFiltered — scope + kind combination', () => {
  it('scopeRef narrows before eventKinds filter so cross-scope noise is excluded', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedSession(db, 'hsid-s1', 's1')
      seedSession(db, 'hsid-s2', 's2')
      const baseS1 = baseEvent('hsid-s1', 's1')
      const baseS2 = baseEvent('hsid-s2', 's2')

      db.hrcEvents.append({ ...baseS1, category: 'turn', eventKind: 'turn.started', payload: {} })
      db.hrcEvents.append({ ...baseS2, category: 'turn', eventKind: 'turn.started', payload: {} })
      db.hrcEvents.append({ ...baseS2, category: 'turn', eventKind: 'turn.completed', payload: {} })

      // Only s1 scope, only turn.started
      const filters: HrcLifecycleMonitorFilters = {
        scopeRef: scopeRef('s1'),
        eventKinds: ['turn.started'],
      }
      const result = db.hrcEvents.listFromHrcSeqFiltered(1, filters)

      expect(result).toHaveLength(1)
      expect(result[0]!.scopeRef).toBe(scopeRef('s1'))
      expect(result[0]!.eventKind).toBe('turn.started')
    } finally {
      db.close()
    }
  })
})
