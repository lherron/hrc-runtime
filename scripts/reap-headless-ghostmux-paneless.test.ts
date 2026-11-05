import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import {
  HRCPTY_MIN_IDLE_MS,
  MIN_IDLE_MS,
  PANELESS_CANDIDATE_MIN_IDLE_MS,
  PANELESS_MIN_IDLE_MS,
  type PaneStatus,
  isQuitEligible,
  panelessCandidatesSql,
  selectPanelessTargets,
  skipReasons,
} from './reap-headless-ghostmux'
import { eligibleStatus } from './reap-headless-ghostmux.fixtures'

describe('paneless inventory reap', () => {
  function inventoryFixture(rows: Array<[string, string, string, string | null]>): string[][] {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE runtimes (runtime_id TEXT PRIMARY KEY, scope_ref TEXT NOT NULL, status TEXT NOT NULL, last_activity_at TEXT)'
    )
    for (const row of rows) db.query('INSERT INTO runtimes VALUES (?, ?, ?, ?)').run(...row)
    try {
      return db.query(panelessCandidatesSql('2026-10-09T00:00:00.000Z')).values() as string[][]
    } finally {
      db.close()
    }
  }

  it('selects only ready runtimes whose activity predates the cutoff', () => {
    const rows = inventoryFixture([
      ['rt-old-ready', 'agent:a:project:p:task:T-1', 'ready', '2026-10-08T11:00:00.000Z'],
      ['rt-new-ready', 'agent:b:project:p:task:T-2', 'ready', '2026-10-09T01:00:00.000Z'],
      ['rt-old-busy', 'agent:c:project:p:task:T-3', 'busy', '2026-10-01T00:00:00.000Z'],
      ['rt-old-dead', 'agent:d:project:p:task:T-4', 'terminated', '2026-10-01T00:00:00.000Z'],
      ['rt-no-clock', 'agent:e:project:p:task:T-5', 'ready', null],
    ])
    expect(rows).toEqual([['rt-old-ready', 'agent:a:project:p:task:T-1']])
  })

  it('drops runtimes the pane sweep already resolved', () => {
    const targets = selectPanelessTargets(
      [
        { runtimeId: 'rt-has-pane', scopeRef: 'agent:a:project:p:task:T-1' },
        { runtimeId: 'rt-paneless', scopeRef: 'agent:b:project:p:task:T-2' },
      ],
      new Set(['rt-has-pane'])
    )
    expect(targets.map((t) => t.metadata.hrc_runtime_id)).toEqual(['rt-paneless'])
    expect(targets[0]?.metadata.hrc_scope_ref).toBe('agent:b:project:p:task:T-2')
  })

  it('requires strictly more than 12 hours idle, not 30 minutes', () => {
    const realDateNow = Date.now
    const now = Date.parse('2026-10-09T12:00:00.000Z')
    Date.now = () => now
    try {
      const at = (ms: number) =>
        eligibleStatus({ lastActivityUtc: new Date(now - ms).toISOString() })
      expect(isQuitEligible(at(6 * 60 * 60 * 1000), PANELESS_MIN_IDLE_MS)).toBe(false)
      expect(isQuitEligible(at(PANELESS_MIN_IDLE_MS), PANELESS_MIN_IDLE_MS)).toBe(false)
      expect(isQuitEligible(at(PANELESS_MIN_IDLE_MS + 1), PANELESS_MIN_IDLE_MS)).toBe(true)
      expect(
        skipReasons(at(6 * 60 * 60 * 1000), PANELESS_MIN_IDLE_MS).some((r) =>
          /more than 12 hours idle/.test(r)
        )
      ).toBe(true)
      // The pane sweep keeps its 30-minute clock.
      expect(isQuitEligible(at(6 * 60 * 60 * 1000))).toBe(true)
    } finally {
      Date.now = realDateNow
    }
  })

  it('keeps every other guard: a paneless :primary seat is never reaped', () => {
    const status = eligibleStatus({
      identity: { kind: 'project-task', agentId: 'mable', projectId: 'p', taskId: 'primary' },
    })
    expect(isQuitEligible(status, PANELESS_MIN_IDLE_MS)).toBe(false)
  })
})

// hrcpty task seats (2026-11-05, Lance via T-12500): the fleet runs on hrcpty, and
// the tmux-only surface gate left every idle hrcpty task seat live. An hrcpty
// runtime is reapable when it is a `T-…` task seat that is otherwise eligible and
// idle strictly more than 4 hours. That holds with a viewer pane (where tmux
// panes use 30 minutes) and without one (where other runtimes use 12 hours).
describe('hrcpty task seats reap after 4 hours', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  function hrcptyStatus(overrides: Partial<PaneStatus> = {}): PaneStatus {
    return {
      ...eligibleStatus(),
      identity: { kind: 'project-task', agentId: 'cody', projectId: 'p', taskId: 'T-12512' },
      scopeRef: 'agent:cody:project:p:task:T-12512',
      transport: 'hrcpty',
      presentationKind: 'hrcpty',
      substrateKind: '',
      lastActivityUtc: hoursAgo(5),
      ...overrides,
    } as PaneStatus
  }

  it('reaps an idle, complete hrcpty task seat past 4 hours, with or without a pane', () => {
    expect(skipReasons(hrcptyStatus(), MIN_IDLE_MS)).toEqual([])
    expect(skipReasons(hrcptyStatus(), PANELESS_MIN_IDLE_MS)).toEqual([])
  })

  it('keeps an hrcpty task seat idle under 4 hours, even with a pane', () => {
    const status = hrcptyStatus({ lastActivityUtc: hoursAgo(3) })
    expect(isQuitEligible(status, MIN_IDLE_MS)).toBe(false)
    expect(skipReasons(status, MIN_IDLE_MS).some((r) => /more than 4 hours idle/.test(r))).toBe(
      true
    )
  })

  it('never reaps a non-task hrcpty seat (placement homes like minisvc)', () => {
    const status = hrcptyStatus({
      identity: { kind: 'project-task', agentId: 'mable', projectId: 'p', taskId: 'minisvc' },
      scopeRef: 'agent:mable:project:p:task:minisvc',
    })
    expect(isQuitEligible(status, PANELESS_MIN_IDLE_MS)).toBe(false)
    expect(skipReasons(status, PANELESS_MIN_IDLE_MS).some((r) => /task seat/.test(r))).toBe(true)
  })

  it('keeps the primary, chief and active-run guards for hrcpty', () => {
    const primary = { kind: 'project-task', agentId: 'cody', projectId: 'p', taskId: 'primary' }
    const chief = { kind: 'project-task', agentId: 'chief', projectId: 'hcs', taskId: 'T-07818' }
    expect(isQuitEligible(hrcptyStatus({ identity: primary } as Partial<PaneStatus>))).toBe(false)
    expect(isQuitEligible(hrcptyStatus({ identity: chief } as Partial<PaneStatus>))).toBe(false)
    expect(isQuitEligible(hrcptyStatus({ activeRunId: 'run-live' }))).toBe(false)
    expect(isQuitEligible(hrcptyStatus({ runtimeStatus: 'busy' }))).toBe(false)
  })

  it('leaves non-hrcpty thresholds alone: a paneless tmux runtime still needs 12 hours', () => {
    const tmux = eligibleStatus({ lastActivityUtc: hoursAgo(5) })
    expect(isQuitEligible(tmux, PANELESS_MIN_IDLE_MS)).toBe(false)
    expect(isQuitEligible(tmux, MIN_IDLE_MS)).toBe(true)
  })

  it('lists hrcpty paneless candidates from 4 hours, so the inventory pre-filter does not hide them', () => {
    expect(PANELESS_CANDIDATE_MIN_IDLE_MS).toBe(HRCPTY_MIN_IDLE_MS)
    expect(HRCPTY_MIN_IDLE_MS).toBe(4 * 3_600_000)
  })
})
