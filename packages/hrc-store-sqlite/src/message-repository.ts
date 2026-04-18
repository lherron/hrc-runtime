import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type {
  HrcMessageAddress,
  HrcMessageExecution,
  HrcMessageFilter,
  HrcMessageKind,
  HrcMessagePhase,
  HrcMessageRecord,
} from 'hrc-core'

// -- Row shape ----------------------------------------------------------------

type MessageRow = {
  message_seq: number
  message_id: string
  created_at: string
  kind: string
  phase: string
  from_kind: string
  from_ref: string
  to_kind: string
  to_ref: string
  reply_to_message_id: string | null
  root_message_id: string
  body: string
  body_format: string
  execution_state: string
  execution_mode: string | null
  session_ref: string | null
  host_session_id: string | null
  generation: number | null
  runtime_id: string | null
  run_id: string | null
  transport: string | null
  error_code: string | null
  error_message: string | null
  metadata_json: string | null
}

const MESSAGE_COLUMNS = `
  message_seq, message_id, created_at, kind, phase,
  from_kind, from_ref, to_kind, to_ref,
  reply_to_message_id, root_message_id,
  body, body_format,
  execution_state, execution_mode, session_ref,
  host_session_id, generation, runtime_id, run_id,
  transport, error_code, error_message, metadata_json
`

// -- Mapping ------------------------------------------------------------------

function mapAddress(kind: string, ref: string): HrcMessageAddress {
  if (kind === 'entity') {
    return { kind: 'entity', entity: ref as 'human' | 'system' }
  }
  return { kind: 'session', sessionRef: ref }
}

function flattenAddress(addr: HrcMessageAddress): { kind: string; ref: string } {
  if (addr.kind === 'entity') {
    return { kind: 'entity', ref: addr.entity }
  }
  return { kind: 'session', ref: addr.sessionRef }
}

function mapMessageRow(row: MessageRow): HrcMessageRecord {
  const execution: HrcMessageExecution = {
    state: row.execution_state as HrcMessageExecution['state'],
    mode: (row.execution_mode ?? undefined) as HrcMessageExecution['mode'],
    sessionRef: row.session_ref ?? undefined,
    hostSessionId: row.host_session_id ?? undefined,
    generation: row.generation ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    runId: row.run_id ?? undefined,
    transport: (row.transport ?? undefined) as HrcMessageExecution['transport'],
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  }

  return {
    messageSeq: row.message_seq,
    messageId: row.message_id,
    createdAt: row.created_at,
    kind: row.kind as HrcMessageKind,
    phase: row.phase as HrcMessagePhase,
    from: mapAddress(row.from_kind, row.from_ref),
    to: mapAddress(row.to_kind, row.to_ref),
    replyToMessageId: row.reply_to_message_id ?? undefined,
    rootMessageId: row.root_message_id,
    body: row.body,
    bodyFormat: 'text/plain',
    execution,
    metadataJson: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  }
}

// -- Input types --------------------------------------------------------------

export type MessageInsertInput = {
  messageId: string
  kind: HrcMessageKind
  phase: HrcMessagePhase
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  replyToMessageId?: string | undefined
  rootMessageId?: string | undefined
  execution?: Partial<HrcMessageExecution> | undefined
  metadataJson?: Record<string, unknown> | undefined
}

// -- Repository ---------------------------------------------------------------

function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}

export class MessageRepository {
  private readonly insertInTransaction: (input: MessageInsertInput) => HrcMessageRecord

  constructor(private readonly db: Database) {
    this.insertInTransaction = db.transaction((input: MessageInsertInput) => {
      const now = new Date().toISOString()
      const from = flattenAddress(input.from)
      const to = flattenAddress(input.to)
      const exec = input.execution ?? {}

      // For root messages, rootMessageId = messageId (self-referential)
      const rootMessageId = input.rootMessageId ?? input.messageId

      execute(
        this.db,
        `INSERT INTO messages (
          message_id, created_at, kind, phase,
          from_kind, from_ref, to_kind, to_ref,
          reply_to_message_id, root_message_id,
          body, body_format,
          execution_state, execution_mode, session_ref,
          host_session_id, generation, runtime_id, run_id,
          transport, error_code, error_message, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.messageId,
        now,
        input.kind,
        input.phase,
        from.kind,
        from.ref,
        to.kind,
        to.ref,
        input.replyToMessageId ?? null,
        rootMessageId,
        input.body,
        'text/plain',
        exec.state ?? 'not_applicable',
        exec.mode ?? null,
        exec.sessionRef ?? null,
        exec.hostSessionId ?? null,
        exec.generation ?? null,
        exec.runtimeId ?? null,
        exec.runId ?? null,
        exec.transport ?? null,
        exec.errorCode ?? null,
        exec.errorMessage ?? null,
        input.metadataJson ? JSON.stringify(input.metadataJson) : null
      )

      const inserted = this.db.query<{ seq: number }, []>('SELECT last_insert_rowid() AS seq').get()

      if (!inserted) {
        throw new Error('failed to read inserted message sequence')
      }

      const stored = this.db
        .query<MessageRow, [number]>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE message_seq = ?`
        )
        .get(inserted.seq)

      if (!stored) {
        throw new Error(`failed to reload message ${inserted.seq}`)
      }

      return mapMessageRow(stored)
    })
  }

  insert(input: MessageInsertInput): HrcMessageRecord {
    return this.insertInTransaction(input)
  }

  getById(messageId: string): HrcMessageRecord | undefined {
    const row = this.db
      .query<MessageRow, [string]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE message_id = ?`)
      .get(messageId)
    return row ? mapMessageRow(row) : undefined
  }

  getBySeq(seq: number): HrcMessageRecord | undefined {
    const row = this.db
      .query<MessageRow, [number]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE message_seq = ?`)
      .get(seq)
    return row ? mapMessageRow(row) : undefined
  }

  query(filter: HrcMessageFilter): HrcMessageRecord[] {
    const where: string[] = []
    const values: Array<string | number> = []

    if (filter.from) {
      const f = flattenAddress(filter.from)
      where.push('from_kind = ? AND from_ref = ?')
      values.push(f.kind, f.ref)
    }

    if (filter.to) {
      const t = flattenAddress(filter.to)
      where.push('to_kind = ? AND to_ref = ?')
      values.push(t.kind, t.ref)
    }

    if (filter.participant) {
      const p = flattenAddress(filter.participant)
      where.push('((from_kind = ? AND from_ref = ?) OR (to_kind = ? AND to_ref = ?))')
      values.push(p.kind, p.ref, p.kind, p.ref)
    }

    if (filter.thread) {
      where.push('root_message_id = ?')
      values.push(filter.thread.rootMessageId)
    }

    if (filter.afterSeq !== undefined) {
      where.push('message_seq > ?')
      values.push(filter.afterSeq)
    }

    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(', ')
      where.push(`kind IN (${placeholders})`)
      values.push(...filter.kinds)
    }

    if (filter.phases && filter.phases.length > 0) {
      const placeholders = filter.phases.map(() => '?').join(', ')
      where.push(`phase IN (${placeholders})`)
      values.push(...filter.phases)
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limitClause = filter.limit !== undefined ? ' LIMIT ?' : ''
    if (filter.limit !== undefined) {
      values.push(filter.limit)
    }
    const order = filter.order === 'desc' ? 'DESC' : 'ASC'

    const rows = this.db
      .query<MessageRow, Array<string | number>>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages ${whereClause} ORDER BY message_seq ${order}${limitClause}`
      )
      .all(...values)

    return rows.map(mapMessageRow)
  }

  /** Return the max message_seq, or 0 if empty. */
  maxSeq(): number {
    const row = this.db
      .query<{ max_seq: number | null }, []>('SELECT MAX(message_seq) AS max_seq FROM messages')
      .get()
    return row?.max_seq ?? 0
  }

  updateExecution(messageId: string, patch: Partial<HrcMessageExecution>): void {
    const sets: string[] = []
    const values: SQLQueryBindings[] = []

    if (patch.state !== undefined) {
      sets.push('execution_state = ?')
      values.push(patch.state)
    }
    if (patch.mode !== undefined) {
      sets.push('execution_mode = ?')
      values.push(patch.mode)
    }
    if (patch.sessionRef !== undefined) {
      sets.push('session_ref = ?')
      values.push(patch.sessionRef)
    }
    if (patch.hostSessionId !== undefined) {
      sets.push('host_session_id = ?')
      values.push(patch.hostSessionId)
    }
    if (patch.generation !== undefined) {
      sets.push('generation = ?')
      values.push(patch.generation)
    }
    if (patch.runtimeId !== undefined) {
      sets.push('runtime_id = ?')
      values.push(patch.runtimeId)
    }
    if (patch.runId !== undefined) {
      sets.push('run_id = ?')
      values.push(patch.runId)
    }
    if (patch.transport !== undefined) {
      sets.push('transport = ?')
      values.push(patch.transport)
    }
    if (patch.errorCode !== undefined) {
      sets.push('error_code = ?')
      values.push(patch.errorCode)
    }
    if (patch.errorMessage !== undefined) {
      sets.push('error_message = ?')
      values.push(patch.errorMessage)
    }

    if (sets.length === 0) return

    values.push(messageId)
    execute(this.db, `UPDATE messages SET ${sets.join(', ')} WHERE message_id = ?`, ...values)
  }
}
