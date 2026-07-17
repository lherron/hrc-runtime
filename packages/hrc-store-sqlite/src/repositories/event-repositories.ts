import type { Database } from 'bun:sqlite'
import type { HrcEventEnvelope, HrcLifecycleEvent } from 'hrc-core'
import type { EventRow, HrcEventRow } from './rows.js'
import {
  EVENT_COLUMNS,
  type EventQueryFilters,
  HRC_EVENT_COLUMNS,
  type HrcLifecycleMonitorFilters,
  type HrcLifecycleQueryFilters,
  allocateStreamSeq,
  buildEventWhere,
  buildLifecycleWhere,
  execute,
  mapEventRow,
  mapHrcEventRow,
} from './shared.js'

/**
 * Curated "milestone" event kinds for `--milestone` filtering (T-04232):
 * turn boundaries, session lifecycle, and runtime lifecycle.
 */
const MILESTONE_KINDS = [
  'turn.started',
  'turn.completed',
  'turn.failed',
  'session.started',
  'session.cleared',
  'runtime.idle',
  'runtime.dead',
] as const

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * SQL predicate for the milestone preset. The `?` placeholders bind to
 * {@link MILESTONE_KINDS}; the tool-name / Bash-command predicates are
 * literal (a fixed curated set of operator actions).
 */
const MILESTONE_PREDICATE_SQL = `(
  event_kind IN (${MILESTONE_KINDS.map(() => '?').join(', ')})
  OR (event_kind = 'turn.tool_call' AND json_extract(payload_json, '$.toolName') IN ('Agent', 'Skill'))
  OR (
    event_kind = 'turn.tool_call'
    AND json_extract(payload_json, '$.toolName') = 'Bash'
    AND (
      payload_json LIKE '%hrcchat dm%'
      OR payload_json LIKE '%wrkq touch%'
      OR payload_json LIKE '%wrkq set%'
      OR payload_json LIKE '%wrkq comment%'
      OR payload_json LIKE '%git commit%'
    )
  )
)`

export type EventAppendInput = Omit<HrcEventEnvelope, 'seq' | 'streamSeq'>

export class EventRepository {
  private readonly appendInTransaction: (event: EventAppendInput) => HrcEventEnvelope

  constructor(private readonly db: Database) {
    this.appendInTransaction = db.transaction((event: EventAppendInput) => {
      const streamSeq = allocateStreamSeq(this.db)
      execute(
        this.db,
        `
          INSERT INTO events (
            stream_seq,
            ts,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            run_id,
            runtime_id,
            source,
            event_kind,
            event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        streamSeq,
        event.ts,
        event.hostSessionId,
        event.scopeRef,
        event.laneRef,
        event.generation,
        event.runId ?? null,
        event.runtimeId ?? null,
        event.source,
        event.eventKind,
        JSON.stringify(event.eventJson)
      )

      const inserted = this.db.query<{ seq: number }, []>('SELECT last_insert_rowid() AS seq').get()

      if (!inserted) {
        throw new Error('failed to read inserted event sequence')
      }

      const stored = this.db
        .query<EventRow, [number]>(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq = ?`)
        .get(inserted.seq)

      if (!stored) {
        throw new Error(`failed to reload event ${inserted.seq}`)
      }

      return mapEventRow(stored)
    })
  }

  append(event: EventAppendInput): HrcEventEnvelope {
    return this.appendInTransaction(event)
  }

  listFromSeq(fromSeq = 1, filters: Omit<EventQueryFilters, 'fromSeq'> = {}): HrcEventEnvelope[] {
    const where: string[] = ['seq >= ?']
    const values: Array<string | number> = [fromSeq]

    buildEventWhere(filters, where, values)

    const limitClause = filters.limit !== undefined ? ' LIMIT ?' : ''
    if (filters.limit !== undefined) {
      values.push(filters.limit)
    }

    const rows = this.db
      .query<EventRow, Array<string | number>>(
        `SELECT ${EVENT_COLUMNS} FROM events
          WHERE ${where.join(' AND ')}
          ORDER BY seq ASC${limitClause}`
      )
      .all(...values)

    return rows.map(mapEventRow)
  }

  count(filters: Omit<EventQueryFilters, 'limit'> = {}): number {
    const where: string[] = []
    const values: Array<string | number> = []

    if (filters.fromSeq !== undefined) {
      where.push('seq >= ?')
      values.push(filters.fromSeq)
    }
    buildEventWhere(filters, where, values)

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const row = this.db
      .query<{ count: number }, Array<string | number>>(
        `SELECT COUNT(*) AS count FROM events ${whereClause}`
      )
      .get(...values)

    return row?.count ?? 0
  }
}

export type HrcLifecycleEventInput = Omit<
  HrcLifecycleEvent,
  'hrcSeq' | 'streamSeq' | 'replayed'
> & {
  replayed?: boolean | undefined
}

export class HrcLifecycleEventRepository {
  private readonly appendInTransaction: (event: HrcLifecycleEventInput) => HrcLifecycleEvent

  constructor(private readonly db: Database) {
    this.appendInTransaction = db.transaction((event: HrcLifecycleEventInput) => {
      const streamSeq = allocateStreamSeq(this.db)
      execute(
        this.db,
        `
          INSERT INTO hrc_events (
            stream_seq,
            ts,
            host_session_id,
            scope_ref,
            lane_ref,
            generation,
            runtime_id,
            run_id,
            launch_id,
            app_id,
            app_session_key,
            category,
            event_kind,
            transport,
            error_code,
            replayed,
            payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        streamSeq,
        event.ts,
        event.hostSessionId,
        event.scopeRef,
        event.laneRef,
        event.generation,
        event.runtimeId ?? null,
        event.runId ?? null,
        event.launchId ?? null,
        event.appId ?? null,
        event.appSessionKey ?? null,
        event.category,
        event.eventKind,
        event.transport ?? null,
        event.errorCode ?? null,
        event.replayed ? 1 : 0,
        JSON.stringify(event.payload ?? {})
      )

      const inserted = this.db.query<{ seq: number }, []>('SELECT last_insert_rowid() AS seq').get()
      if (!inserted) {
        throw new Error('failed to read inserted hrc event sequence')
      }

      const stored = this.db
        .query<HrcEventRow, [number]>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events WHERE hrc_seq = ?`
        )
        .get(inserted.seq)
      if (!stored) {
        throw new Error(`failed to reload hrc event ${inserted.seq}`)
      }

      return mapHrcEventRow(stored)
    })
  }

  append(event: HrcLifecycleEventInput): HrcLifecycleEvent {
    return this.appendInTransaction(event)
  }

  listFromHrcSeq(
    fromHrcSeq = 1,
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, fromHrcSeq }, 'hrc_seq')
  }

  listFromStreamSeq(
    fromStreamSeq = 1,
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, fromStreamSeq }, 'stream_seq')
  }

  listByRun(
    runId: string,
    filters: Omit<HrcLifecycleQueryFilters, 'runId'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, runId }, 'hrc_seq')
  }

  listByLaunch(
    launchId: string,
    filters: Omit<HrcLifecycleQueryFilters, 'launchId'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, launchId }, 'hrc_seq')
  }

  listByKind(
    eventKind: string,
    filters: Omit<HrcLifecycleQueryFilters, 'eventKind'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, eventKind }, 'hrc_seq')
  }

  listByScope(
    scopeRef: string,
    filters: Omit<HrcLifecycleQueryFilters, 'scopeRef'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, scopeRef }, 'hrc_seq')
  }

  maxHrcSeq(): number {
    const row = this.db
      .query<{ max_seq: number | null }, []>('SELECT MAX(hrc_seq) AS max_seq FROM hrc_events')
      .get()
    return row?.max_seq ?? 0
  }

  /**
   * Server-side filtered monitor query (T-04232).
   *
   * Narrows `hrc_events` at the SQLite query layer by identity/scope plus the
   * monitor-specific predicates (`eventKinds`, `toolNames`, `payloadContains`,
   * or the `milestone` preset). This keeps the full firehose out of the CLI
   * process — a coordinator-grader only ever materializes matching rows.
   *
   * `milestone` supersedes `eventKinds`/`toolNames`/`payloadContains`. The
   * global high-water (`maxHrcSeq()`) is intentionally NOT affected by these
   * filters — cursor/high-water semantics must stay global (daedalus invariant).
   */
  listFromHrcSeqFiltered(
    fromHrcSeq: number,
    filters: HrcLifecycleMonitorFilters
  ): HrcLifecycleEvent[] {
    const baseFilters: HrcLifecycleQueryFilters = {
      fromHrcSeq,
      scopeRef: filters.scopeRef,
      laneRef: filters.laneRef,
      hostSessionId: filters.hostSessionId,
      generation: filters.generation,
      runtimeId: filters.runtimeId,
      runId: filters.runId,
    }
    const { where, values } = buildLifecycleWhere(baseFilters, { includeSeqPredicates: true })

    const scopeSetPredicates: string[] = []
    if (filters.scopeRefs && filters.scopeRefs.length > 0) {
      scopeSetPredicates.push(`scope_ref IN (${filters.scopeRefs.map(() => '?').join(', ')})`)
      values.push(...filters.scopeRefs)
    }
    if (filters.scopeRefPrefixes && filters.scopeRefPrefixes.length > 0) {
      scopeSetPredicates.push(...filters.scopeRefPrefixes.map(() => "scope_ref LIKE ? ESCAPE '\\'"))
      values.push(...filters.scopeRefPrefixes.map((prefix) => `${escapeLike(prefix)}%`))
    }
    if (filters.taskIds && filters.taskIds.length > 0) {
      for (const taskId of filters.taskIds) {
        scopeSetPredicates.push("(scope_ref LIKE ? ESCAPE '\\' OR scope_ref LIKE ? ESCAPE '\\')")
        const segment = escapeLike(`:task:${taskId}`)
        values.push(`%${segment}:%`, `%${segment}`)
      }
    }
    if (scopeSetPredicates.length > 0) {
      where.push(`(${scopeSetPredicates.join(' OR ')})`)
    }

    if (filters.milestone) {
      where.push(MILESTONE_PREDICATE_SQL)
      values.push(...MILESTONE_KINDS)
    } else {
      if (filters.eventKinds && filters.eventKinds.length > 0) {
        const placeholders = filters.eventKinds.map(() => '?').join(', ')
        where.push(`event_kind IN (${placeholders})`)
        values.push(...filters.eventKinds)
      }
      if (filters.toolNames && filters.toolNames.length > 0) {
        const placeholders = filters.toolNames.map(() => '?').join(', ')
        where.push(
          `(event_kind = 'turn.tool_call' AND json_extract(payload_json, '$.toolName') IN (${placeholders}))`
        )
        values.push(...filters.toolNames)
      }
      if (filters.payloadContains !== undefined) {
        where.push('payload_json LIKE ?')
        values.push(`%${filters.payloadContains}%`)
      }
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limitClause = filters.limit !== undefined ? ' LIMIT ?' : ''
    if (filters.limit !== undefined) {
      values.push(filters.limit)
    }

    const rows = this.db
      .query<HrcEventRow, Array<string | number>>(
        `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
          ${whereClause}
          ORDER BY hrc_seq ASC${limitClause}`
      )
      .all(...values)

    return rows.map(mapHrcEventRow)
  }

  /**
   * Return the latest HRC lifecycle event per `(host_session_id, generation)` group.
   *
   * Uses the `idx_hrc_events_host_session_generation_seq` covering index, so this is
   * O(unique sessions × generations) regardless of total event count; it does not
   * scan or buffer a bounded recent window. Callers should not paginate this query —
   * use it for freshness projection (latest seq/ts per session) only.
   *
   * Optional filters (`hostSessionId`, `generation`, `scopeRef`, `laneRef`,
   * `runtimeId`, `runId`, `launchId`, `eventKind`, `category`) narrow the search
   * window before grouping; `fromHrcSeq`/`fromStreamSeq`/`limit` are ignored.
   *
   * Tie-break / stable ordering on `hrc_seq` is enforced by the inner MAX(hrc_seq)
   * selection. The outer ORDER BY hrc_seq DESC returns the freshest groups first.
   */
  listLatestPerSession(
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq' | 'limit'> = {}
  ): HrcLifecycleEvent[] {
    const { where, values } = buildLifecycleWhere(filters, { includeSeqPredicates: false })

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    // Inner subquery finds (host_session_id, generation, MAX(hrc_seq)) using the
    // (host_session_id, generation, hrc_seq) index. Outer join re-reads the row.
    // hrc_seq is the AUTOINCREMENT primary key, so a single max value selects a
    // unique row — no further tie-break is necessary.
    const qualifiedColumns = HRC_EVENT_COLUMNS.split(',')
      .map((column) => `e.${column.trim()}`)
      .join(', ')
    const rows = this.db
      .query<HrcEventRow, Array<string | number>>(
        `SELECT ${qualifiedColumns}
           FROM hrc_events e
           INNER JOIN (
             SELECT host_session_id, generation, MAX(hrc_seq) AS max_hrc_seq
               FROM hrc_events
               ${whereClause}
              GROUP BY host_session_id, generation
           ) latest
             ON latest.host_session_id = e.host_session_id
            AND latest.generation = e.generation
            AND latest.max_hrc_seq = e.hrc_seq
          ORDER BY e.hrc_seq DESC`
      )
      .all(...values)

    return rows.map(mapHrcEventRow)
  }

  private runQuery(
    filters: HrcLifecycleQueryFilters,
    orderColumn: 'hrc_seq' | 'stream_seq'
  ): HrcLifecycleEvent[] {
    const { where, values } = buildLifecycleWhere(filters, { includeSeqPredicates: true })

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limitClause = filters.limit !== undefined ? ' LIMIT ?' : ''
    if (filters.limit !== undefined) {
      values.push(filters.limit)
    }

    const rows = this.db
      .query<HrcEventRow, Array<string | number>>(
        `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
          ${whereClause}
          ORDER BY ${orderColumn} ASC${limitClause}`
      )
      .all(...values)

    return rows.map(mapHrcEventRow)
  }
}
