// Characterization tests for T-04731 (F4 — nullable-transform redundancy).
//
// These pin the load-bearing invariant the refactor must preserve: an explicit
// `null` in a patch MUST still write SQL NULL, and `undefined`/omitted columns
// MUST be left untouched. The audit established that `collectPatchEntries`
// already guarantees this NATIVELY (it filters `undefined` and passes `null`
// straight through), so the per-column `nullableTransform` wrappers are pure
// no-ops. This suite is written to pass BOTH before the transforms are dropped
// AND after — it characterizes the behavior, not the implementation.
//
// Run with: TMPDIR=/tmp bun run --filter hrc-store-sqlite test

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index'
import { collectPatchEntries } from '../repositories/shared.js'

let tmpDir: string
let dbPath: string

function ts(): string {
  return new Date().toISOString()
}

function scopeRef(key: string): string {
  return `agent:test:project:nullable-transform:task:${key}`
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-nulltx-test-'))
  dbPath = join(tmpDir, 'test.sqlite')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── unit-level invariant on the shared helper ──────────────────────────────
describe('collectPatchEntries null/undefined invariant', () => {
  it('passes an explicit null through as SQL NULL with NO transform', () => {
    const entries = collectPatchEntries({ foo: null } as { foo?: string | null }, [
      { key: 'foo', column: 'foo_col' },
    ])
    expect(entries).toEqual([['foo_col', null]])
  })

  it('omits an undefined field entirely (no SET clause emitted)', () => {
    const entries = collectPatchEntries({ foo: undefined } as { foo?: string }, [
      { key: 'foo', column: 'foo_col' },
    ])
    expect(entries).toEqual([])
  })

  it('passes a defined value through unchanged with NO transform', () => {
    const entries = collectPatchEntries({ foo: 'bar', n: 0 } as { foo?: string; n?: number }, [
      { key: 'foo', column: 'foo_col' },
      { key: 'n', column: 'n_col' },
    ])
    expect(entries).toEqual([
      ['foo_col', 'bar'],
      ['n_col', 0],
    ])
  })

  it('an explicit null with a transform present yields the same SQL NULL', () => {
    const passthrough = (v: unknown): string | number | null =>
      (v as string | number | null) ?? null
    const withTx = collectPatchEntries({ foo: null } as { foo?: string | null }, [
      { key: 'foo', column: 'foo_col', transform: passthrough },
    ])
    const withoutTx = collectPatchEntries({ foo: null } as { foo?: string | null }, [
      { key: 'foo', column: 'foo_col' },
    ])
    expect(withTx).toEqual(withoutTx)
    expect(withTx).toEqual([['foo_col', null]])
  })
})

// ── SQL round-trip: explicit null writes NULL on a real runtime row ─────────
describe('runtime update: explicit null writes SQL NULL', () => {
  function rawColumn(
    db: ReturnType<typeof openHrcDatabase>,
    table: string,
    column: string,
    idColumn: string,
    id: string
  ): unknown {
    const row = db.sqlite
      .query<Record<string, unknown>, [string]>(
        `SELECT ${column} AS value FROM ${table} WHERE ${idColumn} = ?`
      )
      .get(id)
    return row?.value
  }

  it('nulls runtimes.lifecycle_policy_hash when an explicit null is patched', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.sessions.insert({
        hostSessionId: 'hsid-nt',
        scopeRef: scopeRef('nt'),
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-nt',
        hostSessionId: 'hsid-nt',
        scopeRef: scopeRef('nt'),
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        lifecyclePolicyHash: 'lph-seed',
        createdAt: now,
        updatedAt: now,
      })
      expect(rawColumn(db, 'runtimes', 'lifecycle_policy_hash', 'runtime_id', 'rt-nt')).toBe(
        'lph-seed'
      )

      // Force an explicit null through the typed API (the column is T|undefined
      // at the contract level, but the binder/helper path must still null it).
      db.runtimes.update('rt-nt', {
        lifecyclePolicyHash: null,
        updatedAt: ts(),
      } as Parameters<typeof db.runtimes.update>[1])

      expect(rawColumn(db, 'runtimes', 'lifecycle_policy_hash', 'runtime_id', 'rt-nt')).toBeNull()
    } finally {
      db.close()
    }
  })

  it('nulls broker_invocations.lifecycle_terminal_reason when an explicit null is patched', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const now = ts()
      db.brokerInvocations.insert({
        invocationId: 'inv-nt',
        operationId: 'op-nt',
        runtimeId: 'rt-nt',
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-app-server',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({ input: true }),
        specHash: 'spec-1',
        startRequestHash: 'sr-1',
        selectedProfileHash: 'pf-1',
        lifecycleTerminalReason: 'escalation-pause',
        createdAt: now,
        updatedAt: now,
      })
      expect(
        rawColumn(db, 'broker_invocations', 'lifecycle_terminal_reason', 'invocation_id', 'inv-nt')
      ).toBe('escalation-pause')

      db.brokerInvocations.update('inv-nt', {
        lifecycleTerminalReason: null,
        updatedAt: ts(),
      } as Parameters<typeof db.brokerInvocations.update>[1])

      expect(
        rawColumn(db, 'broker_invocations', 'lifecycle_terminal_reason', 'invocation_id', 'inv-nt')
      ).toBeNull()
    } finally {
      db.close()
    }
  })
})
