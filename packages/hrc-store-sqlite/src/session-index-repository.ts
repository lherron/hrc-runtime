import type { Database, SQLQueryBindings } from 'bun:sqlite'

export type SessionIndexEffectiveStatus = 'active' | 'detached' | 'inactive' | 'stale'
export type SessionIndexExecutionMode = 'headless' | 'interactive' | 'nonInteractive'

export type SessionIndexRecord = {
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  agentId: string
  projectId?: string | undefined
  createdAt: string
  effectiveStatus: SessionIndexEffectiveStatus
  executionMode: SessionIndexExecutionMode
  lastActivityAt: string
}

export type SessionIndexFilters = {
  q?: string | undefined
  agentId?: string | undefined
  projectId?: string | undefined
  laneRef?: string | undefined
  effectiveStatus?: SessionIndexEffectiveStatus | undefined
  executionMode?: SessionIndexExecutionMode | undefined
}

export type SessionIndexCursor = {
  lastActivityAt: string
  hostSessionId: string
}

export type SessionIndexPage = {
  items: SessionIndexRecord[]
  hasMore: boolean
}

export type SessionIndexFacetCounts = {
  total: number
  nodeFacetCount: number
  byEffectiveStatus: Record<string, number>
  byExecutionMode: Record<string, number>
  byAgentId: Record<string, number>
}

export type SessionIndexBackfillEvidence = {
  migrationId: string
  rowCount: number
  changedRecencyCount: number
  recordedAt: string
}

type SessionIndexRow = {
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  agent_id: string
  project_id: string | null
  created_at: string
  effective_status: SessionIndexEffectiveStatus
  execution_mode: SessionIndexExecutionMode
  last_activity_at: string
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function buildWhere(
  filters: SessionIndexFilters,
  excludedDimension?: keyof Pick<
    SessionIndexFilters,
    'agentId' | 'effectiveStatus' | 'executionMode'
  >
): { clause: string; values: SQLQueryBindings[] } {
  const where: string[] = []
  const values: SQLQueryBindings[] = []

  if (filters.q !== undefined) {
    where.push("scope_ref LIKE ? ESCAPE '\\'")
    values.push(`%${escapeLike(filters.q)}%`)
  }
  if (filters.agentId !== undefined && excludedDimension !== 'agentId') {
    where.push('agent_id = ?')
    values.push(filters.agentId)
  }
  if (filters.projectId !== undefined) {
    where.push('project_id = ?')
    values.push(filters.projectId)
  }
  if (filters.laneRef !== undefined) {
    where.push('lane_ref = ?')
    values.push(filters.laneRef)
  }
  if (filters.effectiveStatus !== undefined && excludedDimension !== 'effectiveStatus') {
    where.push('effective_status = ?')
    values.push(filters.effectiveStatus)
  }
  if (filters.executionMode !== undefined && excludedDimension !== 'executionMode') {
    where.push('execution_mode = ?')
    values.push(filters.executionMode)
  }

  return {
    clause: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
    values,
  }
}

function mapRow(row: SessionIndexRow): SessionIndexRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    agentId: row.agent_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    createdAt: row.created_at,
    effectiveStatus: row.effective_status,
    executionMode: row.execution_mode,
    lastActivityAt: row.last_activity_at,
  }
}

function countMap(
  db: Database,
  column: 'agent_id' | 'effective_status' | 'execution_mode',
  filters: SessionIndexFilters,
  excludedDimension: 'agentId' | 'effectiveStatus' | 'executionMode'
): Record<string, number> {
  const { clause, values } = buildWhere(filters, excludedDimension)
  const rows = db
    .query<{ value: string; count: number }, SQLQueryBindings[]>(
      `SELECT ${column} AS value, COUNT(*) AS count
         FROM session_index
         ${clause}
        GROUP BY ${column}`
    )
    .all(...values)
  return Object.fromEntries(rows.map((row) => [row.value, row.count]))
}

export class SessionIndexRepository {
  constructor(private readonly db: Database) {}

  listPage(input: {
    filters?: SessionIndexFilters | undefined
    cursor?: SessionIndexCursor | undefined
    limit: number
  }): SessionIndexPage {
    const filters = input.filters ?? {}
    const built = buildWhere(filters)
    const where = built.clause === '' ? [] : [built.clause.slice('WHERE '.length)]
    const values = [...built.values]
    if (input.cursor !== undefined) {
      where.push('(last_activity_at, host_session_id) < (?, ?)')
      values.push(input.cursor.lastActivityAt, input.cursor.hostSessionId)
    }
    values.push(input.limit + 1)

    const rows = this.db
      .query<SessionIndexRow, SQLQueryBindings[]>(
        `SELECT
           host_session_id, scope_ref, lane_ref, generation, agent_id, project_id,
           created_at, effective_status, execution_mode, last_activity_at
         FROM session_index
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY last_activity_at DESC, host_session_id DESC
         LIMIT ?`
      )
      .all(...values)

    return {
      items: rows.slice(0, input.limit).map(mapRow),
      hasMore: rows.length > input.limit,
    }
  }

  facets(filters: SessionIndexFilters = {}): SessionIndexFacetCounts {
    const totalWhere = buildWhere(filters)
    const total =
      this.db
        .query<{ count: number }, SQLQueryBindings[]>(
          `SELECT COUNT(*) AS count FROM session_index ${totalWhere.clause}`
        )
        .get(...totalWhere.values)?.count ?? 0
    const nodeFacetCount =
      this.db
        .query<{ count: number }, SQLQueryBindings[]>(
          `SELECT COUNT(*) AS count
             FROM session_index
             ${totalWhere.clause}
            GROUP BY 1 = 1`
        )
        .get(...totalWhere.values)?.count ?? 0

    return {
      total,
      nodeFacetCount,
      byEffectiveStatus: countMap(this.db, 'effective_status', filters, 'effectiveStatus'),
      byExecutionMode: countMap(this.db, 'execution_mode', filters, 'executionMode'),
      byAgentId: countMap(this.db, 'agent_id', filters, 'agentId'),
    }
  }

  getBackfillEvidence(): SessionIndexBackfillEvidence | null {
    const row = this.db
      .query<
        {
          migration_id: string
          row_count: number
          changed_recency_count: number
          recorded_at: string
        },
        []
      >(
        `SELECT migration_id, row_count, changed_recency_count, recorded_at
           FROM session_index_backfill_evidence
          WHERE migration_id = '0041_session_index'`
      )
      .get()
    return row === null
      ? null
      : {
          migrationId: row.migration_id,
          rowCount: row.row_count,
          changedRecencyCount: row.changed_recency_count,
          recordedAt: row.recorded_at,
        }
  }
}
