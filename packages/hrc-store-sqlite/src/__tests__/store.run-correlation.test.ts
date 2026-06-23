/**
 * H-00104 Node C (C-0004): opaque run correlation persistence.
 *
 * `hrc run annotate` stamps best-effort correlation metadata on an HRC run.
 * HRC stores and echoes it verbatim and never interprets it. These tests pin
 * the raw get/set surface the CLI builds idempotency/conflict semantics on top
 * of, and prove the column is additive (legacy runs read back null).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRunRecord } from 'hrc-core'

import { openHrcDatabase } from '../index'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:hrc-store:task:${key}`
}

function seedRun(db: ReturnType<typeof openHrcDatabase>, runId: string): HrcRunRecord {
  const now = ts()
  db.sessions.insert({
    hostSessionId: `hsid-${runId}`,
    scopeRef: scopeRef(runId),
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  return db.runs.insert({
    runId,
    hostSessionId: `hsid-${runId}`,
    scopeRef: scopeRef(runId),
    laneRef: 'default',
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    updatedAt: now,
    acceptedAt: now,
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-store-corr-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('run correlation (C-0004)', () => {
  it('reads back null when no correlation was annotated', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRun(db, 'run-corr-1')
      expect(db.runs.getCorrelationJson('run-corr-1')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('stores and echoes correlation JSON verbatim', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRun(db, 'run-corr-2')
      const json = '{"attemptRef":"att-1","invocationNodeId":"node-9"}'
      db.runs.setCorrelationJson('run-corr-2', json)
      expect(db.runs.getCorrelationJson('run-corr-2')).toBe(json)
    } finally {
      db.close()
    }
  })

  it('overwrites a prior correlation (replace path)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRun(db, 'run-corr-3')
      db.runs.setCorrelationJson('run-corr-3', '{"taskId":"T-1"}')
      db.runs.setCorrelationJson('run-corr-3', '{"taskId":"T-2"}')
      expect(db.runs.getCorrelationJson('run-corr-3')).toBe('{"taskId":"T-2"}')
    } finally {
      db.close()
    }
  })

  it('keeps correlation off the run record projection (operator metadata only)', () => {
    const db = openHrcDatabase(dbPath)
    try {
      seedRun(db, 'run-corr-4')
      db.runs.setCorrelationJson('run-corr-4', '{"taskId":"T-1"}')
      const record = db.runs.getByRunId('run-corr-4')
      expect(record).not.toBeNull()
      // The run projection must not carry operator-convenience correlation.
      expect(record as unknown as Record<string, unknown>).not.toHaveProperty('correlation')
      expect(record as unknown as Record<string, unknown>).not.toHaveProperty('correlationJson')
    } finally {
      db.close()
    }
  })
})
