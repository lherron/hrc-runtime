import { existsSync } from 'node:fs'
import { scopeFromTitle, sqlQuote } from './eligibility'
import { isRecord, run, tryRun } from './process'
import { type DiscoveredPane, HEADLESS_PANE_ROLE, type Options, type PaneStatus } from './types'

export function simPanes(): DiscoveredPane[] {
  return [
    {
      id: '7BF21FAF',
      // Post-T-05237 compact title: '<proj> · <task> · <agent>'.
      title: 'acp · T-02864 · smokey',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-smokey-sim',
        hrc_scope_ref: 'agent:smokey:project:agent-control-plane:task:T-02864',
      },
    },
    {
      id: 'EB834507',
      title: 'acp · T-02864 · curly',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-curly-sim',
        hrc_scope_ref: 'agent:curly:project:agent-control-plane:task:T-02864',
      },
    },
    {
      // Legacy title-derived scope: metadata identifies the runtime and pane
      // role, but the title is the only available scope source.
      id: 'A11CE003',
      title: 'hrc headless agent:larry:project:hrc-runtime:task:primary',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-larry-title-sim',
      },
    },
    {
      // chief attention-thread seat (hcs context): task-scoped, NOT :primary,
      // otherwise fully eligible — exempt by agent (T-07819).
      id: 'CH1EF001',
      title: 'hcs · T-07818 · chief',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-chief-sim',
        hrc_scope_ref: 'agent:chief:project:hcs:task:T-07818',
      },
    },
    {
      // Already-terminated leftover viewer: no live runtime to reap, but parked
      // on the close prompt — exercises the leftover-viewer close path.
      id: 'C10D0144',
      title: 'spaces · primary · clod',
      metadata: {
        hrc_role: HEADLESS_PANE_ROLE,
        hrc_runtime_id: 'rt-clod-leftover-sim',
        hrc_scope_ref: 'agent:clod:project:agent-spaces:task:primary',
      },
    },
  ]
}

// Resolve a single surface's ghostmux metadata (the `--resolved` view merges
// inherited window/tab metadata down onto the pane). Tolerant: a surface with
// no metadata, or non-JSON output, yields {}.
export function metadataForSurface(id: string): Record<string, unknown> {
  const raw = tryRun(['ghostmux', 'metadata', 'get', '-t', id, '--resolved', '--json'])
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as { data?: Record<string, unknown> } | Record<string, unknown>
    return 'data' in parsed && isRecord(parsed.data)
      ? parsed.data
      : (parsed as Record<string, unknown>)
  } catch {
    return {}
  }
}

// Pure discovery core (unit-testable without ghostmux): keep surfaces whose
// resolved metadata role equals paneRole, optionally further filtered by a title
// regex. The metadata resolver is injected so tests can supply a fake.
export function selectHeadlessPanes(
  terminals: Array<{ short_id?: string; id?: string; title?: string }>,
  resolveMetadata: (id: string) => Record<string, unknown>,
  paneRole: string,
  titleRegex?: string
): DiscoveredPane[] {
  const titleFilter = titleRegex ? new RegExp(titleRegex) : null
  const discovered: DiscoveredPane[] = []
  for (const terminal of terminals) {
    const id = terminal.short_id ?? terminal.id ?? ''
    if (!id) continue
    const title = terminal.title ?? ''
    if (titleFilter && !titleFilter.test(title)) continue
    const metadata = resolveMetadata(id)
    const role = typeof metadata.hrc_role === 'string' ? metadata.hrc_role : ''
    if (role !== paneRole) continue
    discovered.push({ id, title, metadata })
  }
  return discovered
}

export function listPanes(options: Options): DiscoveredPane[] {
  if (options.simulate) return simPanes()
  const parsed = JSON.parse(run(['ghostmux', 'list-surfaces', '--json'])) as {
    terminals?: Array<{ short_id?: string; id?: string; title?: string }>
  }
  return selectHeadlessPanes(
    parsed.terminals ?? [],
    metadataForSurface,
    options.paneRole,
    options.titleRegex
  )
}

export function queryStatus(pane: DiscoveredPane, options: Options): PaneStatus {
  const metadata = pane.metadata
  const scopeRef =
    typeof metadata.hrc_scope_ref === 'string' && metadata.hrc_scope_ref
      ? metadata.hrc_scope_ref
      : scopeFromTitle(pane.title)
  const runtimeId = typeof metadata.hrc_runtime_id === 'string' ? metadata.hrc_runtime_id : ''
  const agent = 'unknown'

  if (options.simulate) {
    // C10D0144 simulates an already-terminated leftover viewer (no live runtime
    // to reap, but still parked on the close prompt).
    const leftover = pane.id === 'C10D0144'
    const simulationIdentities: Record<string, NonNullable<PaneStatus['identity']>> = {
      '7BF21FAF': {
        kind: 'project-task',
        agentId: 'smokey',
        projectId: 'agent-control-plane',
        taskId: 'T-02864',
      },
      EB834507: {
        kind: 'project-task',
        agentId: 'curly',
        projectId: 'agent-control-plane',
        taskId: 'T-02864',
      },
      A11CE003: {
        kind: 'project-task',
        agentId: 'larry',
        projectId: 'hrc-runtime',
        taskId: 'primary',
      },
      CH1EF001: { kind: 'project-task', agentId: 'chief', projectId: 'hcs', taskId: 'T-07818' },
      C10D0144: {
        kind: 'project-task',
        agentId: 'clod',
        projectId: 'agent-spaces',
        taskId: 'primary',
      },
    }
    const identity = simulationIdentities[pane.id]
    return {
      ...pane,
      agent: identity?.agentId ?? agent,
      identity,
      scopeRef,
      runtimeId,
      runtimeStatus: leftover ? 'terminated' : 'ready',
      transport: 'tmux',
      controllerKind: 'harness-broker',
      activeRunId: '',
      turnStatus: 'completed',
      runId: `run-sim-${pane.id}`,
      lastActivityUtc: '2026-06-09T14:00:00.000Z',
      lastActivityLocal: '2026-06-09 09:00:00',
      latestTurnEventKind: leftover ? 'runtime.terminated' : 'turn.completed',
    }
  }

  if (!existsSync(options.hrcDbPath)) {
    return {
      ...pane,
      agent,
      scopeRef,
      runtimeId,
      runtimeStatus: 'unknown',
      transport: '',
      controllerKind: '',
      activeRunId: '',
      turnStatus: 'unknown',
      runId: '',
      lastActivityUtc: '',
      lastActivityLocal: '',
      latestTurnEventKind: 'missing-db',
    }
  }

  const output = run([
    'sqlite3',
    '-tabs',
    '-noheader',
    options.hrcDbPath,
    statusSql(scopeRef, runtimeId, ''),
  ])
  return paneStatusFromFields(pane, scopeRef, runtimeId, agent, output.trimEnd().split('\t'))
}

// The per-pane status query. `tag` is emitted as a leading column so that N of
// these can be concatenated into ONE sqlite3 invocation and the resulting rows
// re-associated with their pane — a stray newline inside a field then corrupts
// only its own row instead of shifting every row after it. An empty tag emits
// no tag column (single-pane form).
export function statusSql(scopeRef: string, runtimeId: string, tag: string): string {
  const escapedScope = sqlQuote(scopeRef)
  const escapedRuntime = sqlQuote(runtimeId)
  const tagColumn = tag ? `'${sqlQuote(tag)}',` : ''
  return `
      WITH target(scope_ref, runtime_id) AS (
        VALUES ('${escapedScope}', '${escapedRuntime}')
      ),
      latest_runtime AS (
        SELECT runtime_id, scope_ref, lane_ref, status, active_run_id, transport, controller_kind,
               runtime_state_json, last_activity_at, updated_at
        FROM runtimes
        WHERE (runtime_id = (SELECT runtime_id FROM target) AND (SELECT runtime_id FROM target) <> '')
           OR (scope_ref = (SELECT scope_ref FROM target) AND (SELECT scope_ref FROM target) <> '')
        ORDER BY updated_at DESC
        LIMIT 1
      ),
      latest_dispatch AS (
        SELECT run_id, status, accepted_at, coalesced_into_run_id
        FROM runs
        WHERE (
            runtime_id = COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime))
            AND COALESCE(NULLIF((SELECT runtime_id FROM target), ''), (SELECT runtime_id FROM latest_runtime)) IS NOT NULL
          )
           OR (scope_ref = (SELECT scope_ref FROM target) AND (SELECT scope_ref FROM target) <> '')
        -- accepted_at is immutable dispatch chronology. updated_at is a
        -- maintenance clock: the zombie sweeper legitimately advances it and
        -- must not make an older orphan look like the latest dispatched turn.
        ORDER BY accepted_at DESC, run_id DESC
        LIMIT 1
      ),
      -- A coalesced run is a terminal SUCCESS, not an unfinished turn: its
      -- prompt was absorbed into an owner run that carried the work (in-flight
      -- steer merge, or a queued input claimed into a live turn). An absorbed
      -- run never starts, never emits turn.completed, and ALWAYS has a later
      -- accepted_at than the run of record -- so dispatch chronology alone
      -- picks the auxiliary and the turn gate would reject a seat whose work
      -- actually finished. Chase coalesced_into_run_id so both the eligibility
      -- gate and the displayed turn event describe the run that really ran.
      -- A missing or dangling pointer falls back to the auxiliary itself, and
      -- skipReasons() then reports the unresolved coalesce instead of reaping.
      latest_run AS (
        SELECT
          COALESCE(owner.run_id, dispatched.run_id) AS run_id,
          COALESCE(owner.status, dispatched.status) AS status,
          COALESCE(owner.accepted_at, dispatched.accepted_at) AS accepted_at
        FROM latest_dispatch AS dispatched
        LEFT JOIN runs AS owner
          ON dispatched.status = 'coalesced'
         AND NULLIF(dispatched.coalesced_into_run_id, '') IS NOT NULL
         AND owner.run_id = dispatched.coalesced_into_run_id
      ),
      latest_event AS (
        SELECT ts, event_kind, hrc_seq
        FROM hrc_events
        WHERE run_id = (SELECT run_id FROM latest_run)
        ORDER BY hrc_seq DESC
        LIMIT 1
      )
      SELECT
        ${tagColumn}
        COALESCE(NULLIF('${escapedRuntime}', ''), (SELECT runtime_id FROM latest_runtime), ''),
        COALESCE((SELECT status FROM latest_runtime), 'unknown'),
        COALESCE((SELECT transport FROM latest_runtime), ''),
        COALESCE((SELECT controller_kind FROM latest_runtime), ''),
        COALESCE((SELECT active_run_id FROM latest_runtime), ''),
        COALESCE((SELECT status FROM latest_run), 'none'),
        COALESCE((SELECT run_id FROM latest_run), ''),
        COALESCE((SELECT last_activity_at FROM latest_runtime), ''),
        COALESCE(datetime((SELECT last_activity_at FROM latest_runtime), 'localtime'), ''),
        COALESCE((SELECT event_kind FROM latest_event), ''),
        -- Presentation-aware reap (T-04923). Two serialisation shapes (G2 compat):
        -- normalized broker.presentation.kind, or flat-fallback from broker.tuiWindow.
        COALESCE(
          json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.presentation.kind'),
          CASE
            WHEN json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.tuiWindow')
              IS NOT NULL THEN 'tmux-tui'
            ELSE 'none'
          END,
          ''
        ),
        COALESCE(
          json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.substrate.kind'),
          CASE
            WHEN json_extract((SELECT runtime_state_json FROM latest_runtime), '$.broker.brokerWindow')
              IS NOT NULL THEN 'leased-tmux'
            ELSE 'daemon-child'
          END,
          ''
        ),
        (SELECT json_object('kind',scope_kind,'agentId',agent_id,'projectId',project_id,'taskId',task_id,'roleName',role_name) FROM continuities WHERE scope_ref=(SELECT scope_ref FROM latest_runtime) AND lane_ref=(SELECT lane_ref FROM latest_runtime));
    `
}

// Assemble a PaneStatus from one row of statusSql output (tag column already
// stripped). Shared by the single-pane and batched paths so both agree.
export function paneStatusFromFields(
  pane: DiscoveredPane,
  scopeRef: string,
  runtimeId: string,
  agent: string,
  fields: string[]
): PaneStatus {
  const [
    resolvedRuntime,
    runtimeStatus,
    transport,
    controllerKind,
    activeRunId,
    turnStatus,
    runId,
    lastActivityUtc,
    lastActivityLocal,
    latestTurnEventKind,
    presentationKind,
    substrateKind,
    identityJson,
  ] = fields

  const raw = identityJson ? JSON.parse(identityJson) : undefined
  const identity = raw
    ? (Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== null)
      ) as PaneStatus['identity'])
    : undefined
  return {
    ...pane,
    agent: identity?.agentId ?? agent,
    identity,
    scopeRef,
    runtimeId: resolvedRuntime || runtimeId,
    runtimeStatus: runtimeStatus || 'unknown',
    transport: transport || '',
    controllerKind: controllerKind || '',
    activeRunId: activeRunId || '',
    turnStatus: turnStatus || 'none',
    runId: runId || '',
    lastActivityUtc: lastActivityUtc || '',
    lastActivityLocal: lastActivityLocal || '',
    latestTurnEventKind: latestTurnEventKind || '',
    // '' here means json_extract returned NULL (no parseable broker hosting
    // state) — skipReasons() treats that as malformed, distinct from `undefined`
    // (legacy metadata path with no hosting-state column at all).
    presentationKind: presentationKind ?? '',
    substrateKind: substrateKind ?? '',
  }
}

// Batched status resolution: one sqlite3 process for the whole sweep instead of
// one per pane. Each pane contributes an identical, independently-tagged copy of
// the single-pane query, so semantics are unchanged — only the process count and
// the number of opens against the (multi-GB) state DB drop. Panes whose row is
// missing from the output fall back to an individual query rather than being
// silently dropped.
export function queryStatuses(panes: DiscoveredPane[], options: Options): PaneStatus[] {
  if (options.simulate || !existsSync(options.hrcDbPath) || panes.length === 0) {
    return panes.map((pane) => queryStatus(pane, options))
  }

  const targets = panes.map((pane, index) => {
    const metadata = pane.metadata
    const scopeRef =
      typeof metadata.hrc_scope_ref === 'string' && metadata.hrc_scope_ref
        ? metadata.hrc_scope_ref
        : scopeFromTitle(pane.title)
    const runtimeId = typeof metadata.hrc_runtime_id === 'string' ? metadata.hrc_runtime_id : ''
    return { pane, index, scopeRef, runtimeId, tag: `r${index}` }
  })

  let output: string
  try {
    output = run([
      'sqlite3',
      '-tabs',
      '-noheader',
      options.hrcDbPath,
      targets.map((t) => statusSql(t.scopeRef, t.runtimeId, t.tag)).join('\n'),
    ])
  } catch {
    // One malformed row must not lose the whole sweep — fall back to per-pane.
    return panes.map((pane) => queryStatus(pane, options))
  }

  const rows = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    const tag = fields[0]
    if (tag && /^r\d+$/.test(tag)) rows.set(tag, fields.slice(1))
  }

  return targets.map((t) => {
    const fields = rows.get(t.tag)
    if (!fields) return queryStatus(t.pane, options)
    return paneStatusFromFields(t.pane, t.scopeRef, t.runtimeId, 'unknown', fields)
  })
}
