use crate::{
    ReadTx, Result, StoreError, WriteTx,
    row_codec::RowCodec,
    typed_sql::{many, one},
};
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
fn map_turn(r: rows::TranscriptTurnsRow) -> TranscriptTurn {
    TranscriptTurn {
        turn_rowid: Some(r.turn_rowid),
        invocation_id: r.invocation_id,
        runtime_id: r.runtime_id,
        agent: r.agent,
        project: r.project,
        task: r.task,
        scope_ref: r.scope_ref,
        generation: r.generation,
        seq_from: r.seq_from,
        seq_to: r.seq_to,
        started_at: r.started_at,
        completed_at: r.completed_at,
        terminal_status: r.terminal_status,
        message_count: r.message_count,
        truncated: r.truncated != 0,
        user_text: r.user_text,
        final_text: r.final_text,
        mid_text: r.mid_text,
    }
}
impl ReadTx<'_> {
    pub fn transcript_cursor(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row(
                "SELECT last_event_id FROM transcript_index_cursor WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn transcript_invocation_mark(&self, id: &str) -> Result<Option<TranscriptInvocationMark>> {
        one(
            self.db,
            "SELECT * FROM transcript_index_invocations WHERE invocation_id=?",
            [id],
        )
    }
    pub fn transcript_turns_for_invocation(&self, id: &str) -> Result<Vec<TranscriptTurn>> {
        let rows: Vec<rows::TranscriptTurnsRow> = many(
            self.db,
            "SELECT * FROM transcript_turns WHERE invocation_id=? ORDER BY seq_from ASC",
            [id],
        )?;
        Ok(rows.into_iter().map(map_turn).collect())
    }
    pub fn transcript_stats(&self) -> Result<TranscriptStats> {
        Ok(TranscriptStats {
            turns_indexed: self
                .db
                .query_row("SELECT count(*) FROM transcript_turns", [], |r| r.get(0))?,
            last_event_id: self.transcript_cursor()?,
        })
    }
    pub fn search_transcript(
        &self,
        query: &str,
        filters: &TranscriptSearchFilters,
        options: &TranscriptSearchOptions,
    ) -> Result<Vec<TranscriptSearchHit>> {
        if options.weights.iter().any(|w| !w.is_finite() || *w < 0.0) {
            return Err(StoreError::Invalid(
                "transcript BM25 weights must be finite non-negative numbers".into(),
            ));
        }
        let mut predicates = vec!["transcript_turns_fts MATCH ?".to_owned()];
        let mut values = vec![SqlValue::Text(query.into())];
        for (column, value, op) in [
            ("agent", &filters.agent, "="),
            ("project", &filters.project, "="),
            ("task", &filters.task, "="),
            ("scope_ref", &filters.scope_ref, "="),
            ("runtime_id", &filters.runtime_id, "="),
            ("invocation_id", &filters.invocation_id, "="),
            ("completed_at", &filters.since, ">="),
            ("completed_at", &filters.until, "<="),
        ] {
            if let Some(value) = value {
                predicates.push(format!("t.{column} {op} ?"));
                values.push(value.clone().into());
            }
        }
        let suffix = if let Some(cap) = options.per_runtime_cap {
            values.push((cap as i64).into());
            ", ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY runtime_id ORDER BY score DESC) AS rank_in_runtime FROM scored) SELECT * FROM ranked WHERE rank_in_runtime<=? ORDER BY score DESC LIMIT ?"
        } else {
            " SELECT * FROM scored ORDER BY seq_from ASC LIMIT ?"
        };
        values.push((options.limit as i64).into());
        let weights = options.weights.map(|x| x.to_string()).join(",");
        let sql = format!(
            "WITH scored AS (SELECT t.*,-bm25(transcript_turns_fts,{weights}) AS score,snippet(transcript_turns_fts,-1,'[',']','…',12) AS snippet,(SELECT count(DISTINCT sibling.generation) FROM transcript_turns sibling WHERE sibling.scope_ref=t.scope_ref) AS scope_generation_count FROM transcript_turns_fts JOIN transcript_turns t ON t.turn_rowid=transcript_turns_fts.rowid WHERE {}){suffix}",
            predicates.join(" AND ")
        );
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(values), |r| {
                Ok(TranscriptSearchHit {
                    turn: map_turn(rows::TranscriptTurnsRow::decode(r)?),
                    score: r.get("score")?,
                    snippet: r.get("snippet")?,
                    scope_generation_count: r.get("scope_generation_count")?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
}
impl WriteTx<'_> {
    pub fn upsert_transcript_turn(&mut self, t: &TranscriptTurn) -> Result<TranscriptTurn> {
        self.db.execute("INSERT INTO transcript_turns(invocation_id,runtime_id,agent,project,task,scope_ref,generation,seq_from,seq_to,started_at,completed_at,terminal_status,message_count,truncated,user_text,final_text,mid_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(invocation_id,seq_from) DO UPDATE SET runtime_id=excluded.runtime_id,agent=excluded.agent,project=excluded.project,task=excluded.task,scope_ref=excluded.scope_ref,generation=excluded.generation,seq_to=excluded.seq_to,started_at=excluded.started_at,completed_at=excluded.completed_at,terminal_status=excluded.terminal_status,message_count=excluded.message_count,truncated=excluded.truncated,user_text=excluded.user_text,final_text=excluded.final_text,mid_text=excluded.mid_text",params![t.invocation_id,t.runtime_id,t.agent,t.project,t.task,t.scope_ref,t.generation,t.seq_from,t.seq_to,t.started_at,t.completed_at,t.terminal_status,t.message_count,t.truncated,t.user_text,t.final_text,t.mid_text])?;
        let r: rows::TranscriptTurnsRow = crate::typed_sql::required(
            one(
                self.db,
                "SELECT * FROM transcript_turns WHERE invocation_id=? AND seq_from=?",
                params![t.invocation_id, t.seq_from],
            )?,
            t.invocation_id.clone(),
        )?;
        Ok(map_turn(r))
    }
    pub fn delete_transcript_turns_for_invocation(&mut self, id: &str) -> Result<usize> {
        Ok(self
            .db
            .execute("DELETE FROM transcript_turns WHERE invocation_id=?", [id])?)
    }
    pub fn set_transcript_cursor(&mut self, id: i64, at: &str) -> Result<()> {
        self.db.execute("INSERT INTO transcript_index_cursor(id,last_event_id,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET last_event_id=excluded.last_event_id,updated_at=excluded.updated_at",params![id,at])?;
        Ok(())
    }
    pub fn set_transcript_invocation_mark(&mut self, m: &TranscriptInvocationMark) -> Result<()> {
        self.db.execute("INSERT INTO transcript_index_invocations(invocation_id,runtime_id,last_terminal_seq,updated_at) VALUES (?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET runtime_id=excluded.runtime_id,last_terminal_seq=excluded.last_terminal_seq,updated_at=excluded.updated_at",params![m.invocation_id,m.runtime_id,m.last_terminal_seq,m.updated_at])?;
        Ok(())
    }
    pub fn truncate_transcript_index(&mut self, at: &str) -> Result<()> {
        self.db.execute("DELETE FROM transcript_turns", [])?;
        self.db
            .execute("DELETE FROM transcript_index_invocations", [])?;
        self.set_transcript_cursor(0, at)
    }
}
