import type { Database, SQLQueryBindings } from 'bun:sqlite'

import { execute } from './repositories/shared.js'

export type TranscriptTerminalStatus = 'completed' | 'failed' | 'interrupted'

export type TranscriptTurn = {
  turnRowid?: number | undefined
  invocationId: string
  runtimeId: string
  agent?: string | undefined
  project?: string | undefined
  task?: string | undefined
  scopeRef?: string | undefined
  generation?: number | undefined
  seqFrom: number
  seqTo: number
  startedAt: string
  completedAt: string
  terminalStatus: TranscriptTerminalStatus
  messageCount: number
  truncated: boolean
  userText: string
  finalText: string
  midText: string
}

export type TranscriptSearchHit = TranscriptTurn & {
  turnRowid: number
  score: number
  snippet: string
  scopeGenerationCount: number
}

export type TranscriptSearchFilters = {
  agent?: string | undefined
  project?: string | undefined
  task?: string | undefined
  scopeRef?: string | undefined
  runtimeId?: string | undefined
  invocationId?: string | undefined
  since?: string | undefined
  until?: string | undefined
}

export type TranscriptInvocationMark = {
  invocationId: string
  runtimeId: string
  lastTerminalSeq: number
  updatedAt: string
}

type TranscriptTurnRow = {
  turn_rowid: number
  invocation_id: string
  runtime_id: string
  agent: string | null
  project: string | null
  task: string | null
  scope_ref: string | null
  generation: number | null
  seq_from: number
  seq_to: number
  started_at: string
  completed_at: string
  terminal_status: TranscriptTerminalStatus
  message_count: number
  truncated: number
  user_text: string
  final_text: string
  mid_text: string
  score?: number | undefined
  snippet?: string | undefined
  scope_generation_count?: number | undefined
}

const TURN_COLUMNS = `
  turn_rowid, invocation_id, runtime_id, agent, project, task, scope_ref, generation,
  seq_from, seq_to, started_at, completed_at, terminal_status, message_count, truncated,
  user_text, final_text, mid_text`

function mapTurn(row: TranscriptTurnRow): TranscriptTurn {
  return {
    turnRowid: row.turn_rowid,
    invocationId: row.invocation_id,
    runtimeId: row.runtime_id,
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.project === null ? {} : { project: row.project }),
    ...(row.task === null ? {} : { task: row.task }),
    ...(row.scope_ref === null ? {} : { scopeRef: row.scope_ref }),
    ...(row.generation === null ? {} : { generation: row.generation }),
    seqFrom: row.seq_from,
    seqTo: row.seq_to,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    terminalStatus: row.terminal_status,
    messageCount: row.message_count,
    truncated: row.truncated !== 0,
    userText: row.user_text,
    finalText: row.final_text,
    midText: row.mid_text,
  }
}

export class TranscriptIndexRepository {
  constructor(private readonly db: Database) {}

  upsertTurn(turn: TranscriptTurn): TranscriptTurn {
    execute(
      this.db,
      `INSERT INTO transcript_turns (
         invocation_id, runtime_id, agent, project, task, scope_ref, generation,
         seq_from, seq_to, started_at, completed_at, terminal_status, message_count,
         truncated, user_text, final_text, mid_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invocation_id, seq_from) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         agent = excluded.agent,
         project = excluded.project,
         task = excluded.task,
         scope_ref = excluded.scope_ref,
         generation = excluded.generation,
         seq_to = excluded.seq_to,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         terminal_status = excluded.terminal_status,
         message_count = excluded.message_count,
         truncated = excluded.truncated,
         user_text = excluded.user_text,
         final_text = excluded.final_text,
         mid_text = excluded.mid_text`,
      turn.invocationId,
      turn.runtimeId,
      turn.agent ?? null,
      turn.project ?? null,
      turn.task ?? null,
      turn.scopeRef ?? null,
      turn.generation ?? null,
      turn.seqFrom,
      turn.seqTo,
      turn.startedAt,
      turn.completedAt,
      turn.terminalStatus,
      turn.messageCount,
      turn.truncated ? 1 : 0,
      turn.userText,
      turn.finalText,
      turn.midText
    )
    const stored = this.db
      .query<TranscriptTurnRow, [string, number]>(
        `SELECT ${TURN_COLUMNS} FROM transcript_turns WHERE invocation_id = ? AND seq_from = ?`
      )
      .get(turn.invocationId, turn.seqFrom)
    if (!stored)
      throw new Error(`failed to reload transcript turn ${turn.invocationId}:${turn.seqFrom}`)
    return mapTurn(stored)
  }

  deleteTurnsForInvocation(invocationId: string): void {
    execute(this.db, 'DELETE FROM transcript_turns WHERE invocation_id = ?', invocationId)
  }

  getCursor(): number {
    return (
      this.db
        .query<{ last_event_id: number }, []>(
          'SELECT last_event_id FROM transcript_index_cursor WHERE id = 1'
        )
        .get()?.last_event_id ?? 0
    )
  }

  setCursor(lastEventId: number, updatedAt = new Date().toISOString()): void {
    execute(
      this.db,
      `INSERT INTO transcript_index_cursor (id, last_event_id, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`,
      lastEventId,
      updatedAt
    )
  }

  getInvocationMark(invocationId: string): TranscriptInvocationMark | undefined {
    const row = this.db
      .query<
        {
          invocation_id: string
          runtime_id: string
          last_terminal_seq: number
          updated_at: string
        },
        [string]
      >(
        `SELECT invocation_id, runtime_id, last_terminal_seq, updated_at
         FROM transcript_index_invocations WHERE invocation_id = ?`
      )
      .get(invocationId)
    return row
      ? {
          invocationId: row.invocation_id,
          runtimeId: row.runtime_id,
          lastTerminalSeq: row.last_terminal_seq,
          updatedAt: row.updated_at,
        }
      : undefined
  }

  setInvocationMark(mark: TranscriptInvocationMark): void {
    execute(
      this.db,
      `INSERT INTO transcript_index_invocations (
         invocation_id, runtime_id, last_terminal_seq, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(invocation_id) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         last_terminal_seq = excluded.last_terminal_seq,
         updated_at = excluded.updated_at`,
      mark.invocationId,
      mark.runtimeId,
      mark.lastTerminalSeq,
      mark.updatedAt
    )
  }

  listTurnsForInvocation(invocationId: string): TranscriptTurn[] {
    return this.db
      .query<TranscriptTurnRow, [string]>(
        `SELECT ${TURN_COLUMNS} FROM transcript_turns
         WHERE invocation_id = ? ORDER BY seq_from ASC`
      )
      .all(invocationId)
      .map(mapTurn)
  }

  search(
    query: string,
    filters: TranscriptSearchFilters,
    options: {
      limit: number
      perRuntimeCap?: number | undefined
      weights?: readonly [number, number, number] | undefined
    }
  ): TranscriptSearchHit[] {
    const predicates = ['transcript_turns_fts MATCH ?']
    const values: SQLQueryBindings[] = [query]
    const add = (column: string, value: string | undefined, operator = '='): void => {
      if (value === undefined) return
      predicates.push(`t.${column} ${operator} ?`)
      values.push(value)
    }
    add('agent', filters.agent)
    add('project', filters.project)
    add('task', filters.task)
    add('scope_ref', filters.scopeRef)
    add('runtime_id', filters.runtimeId)
    add('invocation_id', filters.invocationId)
    add('completed_at', filters.since, '>=')
    add('completed_at', filters.until, '<=')

    const discovery = options.perRuntimeCap !== undefined
    const ranked = discovery
      ? `, ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY runtime_id ORDER BY score DESC) AS rank_in_runtime
           FROM scored
         )
         SELECT * FROM ranked WHERE rank_in_runtime <= ? ORDER BY score DESC LIMIT ?`
      : ' SELECT * FROM scored ORDER BY seq_from ASC LIMIT ?'
    if (discovery) values.push(options.perRuntimeCap as number)
    values.push(options.limit)
    const weights = options.weights ?? [1, 1, 1]
    if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      throw new Error('transcript BM25 weights must be finite non-negative numbers')
    }
    const weightSql = weights.map((weight) => String(weight)).join(', ')
    const rows = this.db
      .query<TranscriptTurnRow & { score: number; snippet: string }, SQLQueryBindings[]>(
        `WITH scored AS (
           SELECT t.*, -bm25(transcript_turns_fts, ${weightSql}) AS score,
                  snippet(transcript_turns_fts, -1, '[', ']', '…', 12) AS snippet
                  , (SELECT COUNT(DISTINCT sibling.generation)
                     FROM transcript_turns sibling
                     WHERE sibling.scope_ref = t.scope_ref) AS scope_generation_count
           FROM transcript_turns_fts
           JOIN transcript_turns t ON t.turn_rowid = transcript_turns_fts.rowid
           WHERE ${predicates.join(' AND ')}
         )${ranked}`
      )
      .all(...values)
    return rows.map((row) => ({
      ...mapTurn(row),
      turnRowid: row.turn_rowid,
      score: row.score,
      snippet: row.snippet,
      scopeGenerationCount: row.scope_generation_count ?? 0,
    }))
  }

  stats(): { turnsIndexed: number; lastEventId: number } {
    const turnsIndexed =
      this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM transcript_turns').get()
        ?.count ?? 0
    return { turnsIndexed, lastEventId: this.getCursor() }
  }

  truncateAll(): void {
    const truncate = this.db.transaction(() => {
      execute(this.db, 'DELETE FROM transcript_turns')
      execute(this.db, 'DELETE FROM transcript_index_invocations')
      this.setCursor(0)
    })
    truncate.immediate()
  }
}
