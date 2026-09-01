import type { Database } from 'bun:sqlite'
import {
  type HrcEventEnvelope,
  type HrcEventTail,
  type HrcLifecycleEvent,
  type ToolResultBlobKind,
  brokerToolResultBlobId,
  createToolResultSpillStub,
  lifecycleToolResultBlobId,
  readToolResultSpillDescriptor,
  toolResultExceedsSpillThreshold,
} from 'hrc-core'
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
import { ToolResultBlobRepository } from './tool-result-blob-repository.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    const append = db.transaction((event: EventAppendInput) => {
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
    // allocateStreamSeq reads before it updates. Reserve the WAL writer first
    // so ordinary busy_timeout handling applies instead of BUSY_SNAPSHOT.
    this.appendInTransaction = (event) => append.immediate(event)
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

export type ImportedHrcLifecycleEventInput = {
  sourceRef: string
  originSeq: number
  event: HrcLifecycleEvent
}

export type ImportedHrcLifecycleEventAppendResult = {
  event: HrcLifecycleEvent
  idempotent: boolean
}

export class ImportedHrcLifecycleEventConflictError extends Error {
  constructor(
    readonly sourceRef: string,
    readonly originSeq: number
  ) {
    super(`conflicting imported hrc event at ${sourceRef}/${originSeq}`)
    this.name = 'ImportedHrcLifecycleEventConflictError'
  }
}

export class HrcEventLedgerIncarnationMismatchError extends Error {
  constructor(
    readonly expectedLedgerIncarnationId: string,
    readonly currentLedgerIncarnationId: string
  ) {
    super(
      `lifecycle-event ledger incarnation changed from ${expectedLedgerIncarnationId} to ${currentLedgerIncarnationId}`
    )
    this.name = 'HrcEventLedgerIncarnationMismatchError'
  }
}

/**
 * Reverse-history cursor for {@link HrcEventRepository.tail} (T-07719).
 *
 * Omitting `beforeHrcSeq` selects the newest page from the ledger head, which
 * is what every pre-existing caller does. Supplying it selects the bounded page
 * immediately *before* an already-loaded row, fenced by the incarnation the
 * caller received with its first page: a replaced ledger invalidates the cursor
 * rather than silently paging a different history.
 *
 * This is deliberately not the bounded live stream's `afterHrcSeq`: a history
 * cursor walks backwards and never advances a consumer's forward position.
 */
export type HrcEventTailCursor = {
  /** Exclusive upper bound — only rows with `hrc_seq < beforeHrcSeq` are selected. */
  beforeHrcSeq?: number | undefined
  /** Ledger incarnation the cursor was minted against. */
  expectedLedgerIncarnationId?: string | undefined
}

export type ScanHrcLifecycleReplayInput = {
  expectedLedgerIncarnationId: string
  afterHrcSeq: number
  filters?: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq' | 'limit'> | undefined
}

export type ScanHrcLifecycleReplayResult = {
  ledgerIncarnationId: string
  headHrcSeq: number
  complete: boolean
}

export class HrcLifecycleEventRepository {
  private readonly appendInTransaction: (event: HrcLifecycleEventInput) => HrcLifecycleEvent

  constructor(
    private readonly db: Database,
    private readonly toolResultBlobs = new ToolResultBlobRepository(db)
  ) {
    const append = db.transaction((event: HrcLifecycleEventInput) => {
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

      this.spillPersistedResult(
        inserted.seq,
        event.eventKind,
        event.runtimeId,
        event.payload,
        event.ts
      )

      const stored = this.db
        .query<HrcEventRow, [number]>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events WHERE hrc_seq = ?`
        )
        .get(inserted.seq)
      if (!stored) {
        throw new Error(`failed to reload hrc event ${inserted.seq}`)
      }

      return this.mapRow(stored)
    })
    // allocateStreamSeq reads before it updates. Reserve the WAL writer first
    // so ordinary busy_timeout handling applies instead of BUSY_SNAPSHOT.
    this.appendInTransaction = (event) => append.immediate(event)
  }

  private mapRow(row: HrcEventRow, options: { hydrate?: boolean } = {}): HrcLifecycleEvent {
    return mapHrcEventRow(
      row,
      options.hydrate === false
        ? (value) => value
        : (value) => this.toolResultBlobs.hydrateLifecyclePayload(value)
    )
  }

  private spillPersistedResult(
    hrcSeq: number,
    eventKind: string,
    runtimeId: string | undefined,
    payload: unknown,
    createdAt: string
  ): void {
    if (eventKind !== 'turn.tool_result' || !isRecord(payload)) return
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) return
    const result = payload['result']
    if (readToolResultSpillDescriptor(result) || !toolResultExceedsSpillThreshold(result)) return
    if (!runtimeId) throw new Error('large turn.tool_result requires runtimeId')
    const resultJson = JSON.stringify(result)
    const canonicalBytes = Buffer.byteLength(resultJson, 'utf8')
    const toolUseId = payload['toolUseId']
    const brokerBlobId =
      typeof toolUseId === 'string' && toolUseId.length > 0
        ? brokerToolResultBlobId(runtimeId, toolUseId)
        : undefined
    const brokerBlob = brokerBlobId ? this.toolResultBlobs.get(brokerBlobId) : null
    let blobId: string
    let kind: ToolResultBlobKind
    if (brokerBlob) {
      blobId = brokerBlob.blobId
      kind = 'broker_raw'
    } else {
      blobId = lifecycleToolResultBlobId(this.ledgerIncarnationId(), hrcSeq)
      kind = 'lifecycle_canonical'
      this.toolResultBlobs.insert({
        blobId,
        runtimeId,
        kind,
        bytes: canonicalBytes,
        resultJson,
        createdAt,
      })
    }
    const persistedPayload = JSON.stringify({
      ...payload,
      result: createToolResultSpillStub(result, {
        blobId,
        bytes: brokerBlob?.bytes ?? canonicalBytes,
        kind,
      }),
    })
    this.db
      .query<never, [string, number]>('UPDATE hrc_events SET payload_json = ? WHERE hrc_seq = ?')
      .run(persistedPayload, hrcSeq)
  }

  append(event: HrcLifecycleEventInput): HrcLifecycleEvent {
    return this.appendInTransaction(event)
  }

  ledgerIncarnationId(): string {
    const row = this.db
      .query<{ ledger_incarnation_id: string }, []>(
        `SELECT ledger_incarnation_id
           FROM hrc_event_ledger_metadata
          WHERE id = 1`
      )
      .get()
    if (!row) throw new Error('lifecycle-event ledger incarnation metadata is missing')
    return row.ledger_incarnation_id
  }

  /**
   * Bounded newest-first page, returned chronologically.
   *
   * `cursor.beforeHrcSeq` turns this into the exclusive-before reverse page:
   * the exact filters are applied in SQL before the descending `limit + 1`
   * read, so unrelated sessions and generations never consume page capacity,
   * and `truncated` reports whether still-older *matching* rows exist relative
   * to that boundary. The incarnation fence, head, and page are all read inside
   * the one transaction.
   */
  tail(
    limit: number,
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq' | 'limit'> = {},
    cursor: HrcEventTailCursor = {}
  ): HrcEventTail {
    const read = this.db.transaction(() => {
      const ledgerIncarnationId = this.ledgerIncarnationId()
      if (
        cursor.expectedLedgerIncarnationId !== undefined &&
        cursor.expectedLedgerIncarnationId !== ledgerIncarnationId
      ) {
        throw new HrcEventLedgerIncarnationMismatchError(
          cursor.expectedLedgerIncarnationId,
          ledgerIncarnationId
        )
      }
      const headHrcSeq = this.maxHrcSeq()
      const { where, values } = buildLifecycleWhere(filters, { includeSeqPredicates: false })
      if (cursor.beforeHrcSeq !== undefined) {
        where.push('hrc_seq < ?')
        values.push(cursor.beforeHrcSeq)
      }
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      values.push(limit + 1)
      const rows = this.db
        .query<HrcEventRow, Array<string | number>>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
            ${whereClause}
            ORDER BY hrc_seq DESC
            LIMIT ?`
        )
        .all(...values)
      const truncated = rows.length > limit
      if (truncated) rows.pop()
      return {
        events: rows.reverse().map((row) => this.mapRow(row)),
        ledgerIncarnationId,
        headHrcSeq,
        truncated,
      } satisfies HrcEventTail
    })
    return read()
  }

  /**
   * Visit the newest matching replay suffix inside the same read transaction
   * that validates the expected incarnation and captures the global head.
   * Returning false from `visitNewestFirst` stops SQLite iteration immediately,
   * allowing the server's serialized-byte admission bound to be authoritative.
   */
  scanReplayNewestFirst(
    input: ScanHrcLifecycleReplayInput,
    visitNewestFirst: (event: HrcLifecycleEvent) => boolean
  ): ScanHrcLifecycleReplayResult {
    const read = this.db.transaction(() => {
      const ledgerIncarnationId = this.ledgerIncarnationId()
      if (ledgerIncarnationId !== input.expectedLedgerIncarnationId) {
        throw new HrcEventLedgerIncarnationMismatchError(
          input.expectedLedgerIncarnationId,
          ledgerIncarnationId
        )
      }
      const headHrcSeq = this.maxHrcSeq()
      const { where, values } = buildLifecycleWhere(input.filters ?? {}, {
        includeSeqPredicates: true,
      })
      where.push('hrc_seq > ?')
      values.push(input.afterHrcSeq)
      where.push('hrc_seq <= ?')
      values.push(headHrcSeq)
      const rows = this.db
        .query<HrcEventRow, Array<string | number>>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
            WHERE ${where.join(' AND ')}
            ORDER BY hrc_seq DESC`
        )
        .iterate(...values)
      let complete = true
      for (const row of rows) {
        if (!visitNewestFirst(this.mapRow(row))) {
          complete = false
          break
        }
      }
      return { ledgerIncarnationId, headHrcSeq, complete }
    })
    return read()
  }

  appendImported(input: ImportedHrcLifecycleEventInput): ImportedHrcLifecycleEventAppendResult {
    if (!input.sourceRef.trim() || !Number.isSafeInteger(input.originSeq) || input.originSeq < 1) {
      throw new Error(
        'imported lifecycle event requires non-empty sourceRef and positive originSeq'
      )
    }
    const append = this.db.transaction(() => {
      const existing = this.db
        .query<HrcEventRow, [string, number]>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
            WHERE source_ref = ? AND origin_seq = ?`
        )
        .get(input.sourceRef, input.originSeq)
      if (existing) {
        const stored = this.mapRow(existing, { hydrate: false })
        const comparable = ({
          hrcSeq: _hrcSeq,
          streamSeq: _streamSeq,
          sourceRef: _sourceRef,
          originSeq: _originSeq,
          ...rest
        }: HrcLifecycleEvent) => rest
        if (JSON.stringify(comparable(stored)) !== JSON.stringify(comparable(input.event))) {
          throw new ImportedHrcLifecycleEventConflictError(input.sourceRef, input.originSeq)
        }
        return { event: stored, idempotent: true }
      }

      const streamSeq = allocateStreamSeq(this.db)
      execute(
        this.db,
        `INSERT INTO hrc_events (
          stream_seq, source_ref, origin_seq, ts, host_session_id, scope_ref, lane_ref,
          generation, runtime_id, run_id, launch_id, app_id, app_session_key, category,
          event_kind, transport, error_code, replayed, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        streamSeq,
        input.sourceRef,
        input.originSeq,
        input.event.ts,
        input.event.hostSessionId,
        input.event.scopeRef,
        input.event.laneRef,
        input.event.generation,
        input.event.runtimeId ?? null,
        input.event.runId ?? null,
        input.event.launchId ?? null,
        input.event.appId ?? null,
        input.event.appSessionKey ?? null,
        input.event.category,
        input.event.eventKind,
        input.event.transport ?? null,
        input.event.errorCode ?? null,
        input.event.replayed ? 1 : 0,
        JSON.stringify(input.event.payload ?? {})
      )
      const inserted = this.db
        .query<{ hrc_seq: number }, [string, number]>(
          'SELECT hrc_seq FROM hrc_events WHERE source_ref = ? AND origin_seq = ?'
        )
        .get(input.sourceRef, input.originSeq)
      if (!inserted) throw new Error(`failed to reload imported hrc event ${input.sourceRef}`)
      this.spillPersistedResult(
        inserted.hrc_seq,
        input.event.eventKind,
        input.event.runtimeId,
        input.event.payload,
        input.event.ts
      )
      const row = this.db
        .query<HrcEventRow, [string, number]>(
          `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
            WHERE source_ref = ? AND origin_seq = ?`
        )
        .get(input.sourceRef, input.originSeq)
      if (!row) throw new Error(`failed to reload imported hrc event ${input.sourceRef}`)
      return { event: this.mapRow(row), idempotent: false }
    })
    return append.immediate()
  }

  listFromHrcSeq(
    fromHrcSeq = 1,
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq'> = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, fromHrcSeq }, 'hrc_seq')
  }

  listFromStreamSeq(
    fromStreamSeq = 1,
    filters: Omit<HrcLifecycleQueryFilters, 'fromHrcSeq' | 'fromStreamSeq'> = {},
    options: { hydrate?: boolean } = {}
  ): HrcLifecycleEvent[] {
    return this.runQuery({ ...filters, fromStreamSeq }, 'stream_seq', options)
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

  findLatestByKind(
    eventKind: string,
    filters: Omit<HrcLifecycleQueryFilters, 'eventKind' | 'limit'> = {}
  ): HrcLifecycleEvent | null {
    const { where, values } = buildLifecycleWhere(
      { ...filters, eventKind },
      { includeSeqPredicates: true }
    )
    const row = this.db
      .query<HrcEventRow, Array<string | number>>(
        `SELECT ${HRC_EVENT_COLUMNS} FROM hrc_events
          WHERE ${where.join(' AND ')}
          ORDER BY hrc_seq DESC
          LIMIT 1`
      )
      .get(...values)

    return row ? this.mapRow(row) : null
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
      sourceRef: filters.sourceRef,
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

    return rows.map((row) => this.mapRow(row))
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

    return rows.map((row) => this.mapRow(row))
  }

  private runQuery(
    filters: HrcLifecycleQueryFilters,
    orderColumn: 'hrc_seq' | 'stream_seq',
    options: { hydrate?: boolean } = {}
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

    return rows.map((row) => this.mapRow(row, options))
  }
}
