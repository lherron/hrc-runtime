/**
 * Unit tests for the in-flight detection used by `hrc server stop` and
 * `hrc server restart`. We seed a synthetic hrc state.sqlite with a runs
 * table matching the real schema and verify the helpers report the
 * expected rows. Drain wait is exercised by mutating the table mid-poll.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatInFlightWork, listInFlightWork, waitForInFlightDrain } from '../cli-runtime'

async function makeDb(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'in-flight-gate-'))
  const path = join(dir, 'state.sqlite')
  const db = new Database(path)
  // Mirror only the runs+runtimes columns that listInFlightWork reads.
  db.run(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      transport TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE runtimes (
      runtime_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      active_run_id TEXT,
      last_activity_at TEXT
    );
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      runtime_id TEXT
    );
  `)
  db.close()
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Insert a run, a runtime pointing at it, and an hrc_events row whose ts
 * controls whether the runtime falls inside the recency window. Defaults give
 * a busy runtime with a "now" event so the row IS counted as in-flight unless
 * overridden.
 */
function insertActiveRun(
  path: string,
  row: {
    run_id: string
    scope_ref: string
    lane_ref?: string
    status?: string
    transport?: string | null
    started_at?: string | null
    runtime_status?: string
    last_event_at?: string | null
  }
): void {
  const db = new Database(path)
  const runtimeId = `rt-${row.run_id}`
  db.run(
    `INSERT INTO runs (run_id, scope_ref, lane_ref, status, transport, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [
      row.run_id,
      row.scope_ref,
      row.lane_ref ?? 'main',
      row.status ?? 'started',
      row.transport ?? null,
      row.started_at ?? new Date().toISOString(),
    ]
  )
  db.run(
    `INSERT INTO runtimes (runtime_id, status, active_run_id, last_activity_at)
     VALUES (?, ?, ?, ?)`,
    [runtimeId, row.runtime_status ?? 'busy', row.run_id, new Date().toISOString()]
  )
  if (row.last_event_at !== null) {
    db.run('INSERT INTO hrc_events (ts, runtime_id) VALUES (?, ?)', [
      row.last_event_at ?? new Date().toISOString(),
      runtimeId,
    ])
  }
  db.close()
}

function markCompleted(path: string, runId: string): void {
  const db = new Database(path)
  db.run(`UPDATE runs SET status='completed', completed_at='2026-01-01T00:00:01Z' WHERE run_id=?`, [
    runId,
  ])
  db.run(`UPDATE runtimes SET status='ready', active_run_id=NULL WHERE active_run_id=?`, [runId])
  db.close()
}

describe('listInFlightWork', () => {
  it('returns runs whose runtime is busy and recently active', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, {
        run_id: 'run-live',
        scope_ref: 'agent:heather',
        transport: 'sdk',
      })
      insertActiveRun(path, {
        run_id: 'run-also-live',
        scope_ref: 'agent:clod',
        status: 'accepted',
        transport: 'headless',
      })
      const inFlight = listInFlightWork(path)
      expect(inFlight.map((i) => i.runId).sort()).toEqual(['run-also-live', 'run-live'])
      expect(inFlight.find((i) => i.runId === 'run-live')?.transport).toBe('sdk')
    } finally {
      await cleanup()
    }
  })

  it('filters out runtimes with no recent hrc_events', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, {
        run_id: 'run-stale',
        scope_ref: 'agent:cody',
        last_event_at: '2025-01-01T00:00:00Z',
      })
      expect(listInFlightWork(path)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('filters out runtimes with no hrc_events at all', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, {
        run_id: 'run-no-events',
        scope_ref: 'agent:cody',
        last_event_at: null,
      })
      expect(listInFlightWork(path)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('filters out runtimes that are not in the busy state', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, {
        run_id: 'run-ready',
        scope_ref: 'agent:cody',
        runtime_status: 'ready',
      })
      insertActiveRun(path, {
        run_id: 'run-terminated',
        scope_ref: 'agent:cody',
        runtime_status: 'terminated',
      })
      expect(listInFlightWork(path)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('returns an empty list when the db file does not exist', () => {
    const result = listInFlightWork('/nonexistent/path/does/not/exist.sqlite')
    expect(result).toEqual([])
  })

  it("filters out the caller's own runId from HRC_RUN_ID", async () => {
    const { path, cleanup } = await makeDb()
    const originalEnv = process.env['HRC_RUN_ID']
    try {
      insertActiveRun(path, { run_id: 'run-self', scope_ref: 'agent:clod' })
      insertActiveRun(path, { run_id: 'run-other', scope_ref: 'agent:heather' })
      process.env['HRC_RUN_ID'] = 'run-self'
      const inFlight = listInFlightWork(path)
      expect(inFlight.map((i) => i.runId)).toEqual(['run-other'])
    } finally {
      if (originalEnv === undefined) {
        // biome-ignore lint/performance/noDelete: test cleanup; perf irrelevant
        delete process.env['HRC_RUN_ID']
      } else {
        process.env['HRC_RUN_ID'] = originalEnv
      }
      await cleanup()
    }
  })

  it("returns empty when the caller's own runId is the only in-flight work", async () => {
    const { path, cleanup } = await makeDb()
    const originalEnv = process.env['HRC_RUN_ID']
    try {
      insertActiveRun(path, { run_id: 'run-self', scope_ref: 'agent:clod' })
      process.env['HRC_RUN_ID'] = 'run-self'
      expect(listInFlightWork(path)).toEqual([])
    } finally {
      if (originalEnv === undefined) {
        // biome-ignore lint/performance/noDelete: test cleanup; perf irrelevant
        delete process.env['HRC_RUN_ID']
      } else {
        process.env['HRC_RUN_ID'] = originalEnv
      }
      await cleanup()
    }
  })

  it('returns empty when no rows exist at all', async () => {
    const { path, cleanup } = await makeDb()
    try {
      expect(listInFlightWork(path)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('drops rows whose transport is in excludeTransports', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-tmux', scope_ref: 'agent:cody', transport: 'tmux' })
      insertActiveRun(path, {
        run_id: 'run-headless',
        scope_ref: 'agent:clod',
        transport: 'headless',
      })
      insertActiveRun(path, { run_id: 'run-sdk', scope_ref: 'agent:rex', transport: 'sdk' })

      const all = listInFlightWork(path)
      expect(all.map((i) => i.runId).sort()).toEqual(['run-headless', 'run-sdk', 'run-tmux'])

      const headlessOnly = listInFlightWork(path, { excludeTransports: ['tmux'] })
      expect(headlessOnly.map((i) => i.runId).sort()).toEqual(['run-headless', 'run-sdk'])
    } finally {
      await cleanup()
    }
  })

  it('returns empty when every in-flight run is excluded by transport', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-tmux-a', scope_ref: 'agent:cody', transport: 'tmux' })
      insertActiveRun(path, { run_id: 'run-tmux-b', scope_ref: 'agent:clod', transport: 'tmux' })
      expect(listInFlightWork(path, { excludeTransports: ['tmux'] })).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('treats null transport as not-excluded (legacy rows are still reported)', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-legacy', scope_ref: 'agent:cody', transport: null })
      const filtered = listInFlightWork(path, { excludeTransports: ['tmux'] })
      expect(filtered.map((i) => i.runId)).toEqual(['run-legacy'])
    } finally {
      await cleanup()
    }
  })
})

describe('formatInFlightWork', () => {
  it('renders a placeholder when empty', () => {
    expect(formatInFlightWork([])).toContain('no in-flight work')
  })

  it('renders one line per item with scope and status', () => {
    const out = formatInFlightWork([
      {
        runId: 'run-1',
        scopeRef: 'agent:heather',
        laneRef: 'main',
        status: 'started',
        transport: 'sdk',
        startedAt: '2026-01-01T00:00:00Z',
      },
    ])
    expect(out).toContain('run-1')
    expect(out).toContain('agent:heather~main')
    expect(out).toContain('started')
    expect(out).toContain('[sdk]')
    expect(out).toContain('2026-01-01T00:00:00Z')
  })
})

describe('waitForInFlightDrain', () => {
  it('returns immediately when nothing is in flight', async () => {
    const { path, cleanup } = await makeDb()
    try {
      const result = await waitForInFlightDrain({ timeoutMs: 1_000, dbPath: path })
      expect(result).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('polls until the run completes', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-drain', scope_ref: 'agent:heather' })
      // Complete the run shortly after the wait starts.
      setTimeout(() => markCompleted(path, 'run-drain'), 150)
      const result = await waitForInFlightDrain({
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        dbPath: path,
      })
      expect(result).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('returns the still-in-flight items when the timeout fires', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-stuck', scope_ref: 'agent:heather' })
      const result = await waitForInFlightDrain({
        timeoutMs: 200,
        pollIntervalMs: 50,
        dbPath: path,
      })
      expect(result.map((i) => i.runId)).toEqual(['run-stuck'])
    } finally {
      await cleanup()
    }
  })

  it('returns immediately when only excluded transports are in flight', async () => {
    const { path, cleanup } = await makeDb()
    try {
      insertActiveRun(path, { run_id: 'run-tmux', scope_ref: 'agent:cody', transport: 'tmux' })
      const result = await waitForInFlightDrain({
        timeoutMs: 200,
        pollIntervalMs: 50,
        dbPath: path,
        filter: { excludeTransports: ['tmux'] },
      })
      expect(result).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
