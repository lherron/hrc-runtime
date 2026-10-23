use crate::{ReadTx, Result, WriteTx, typed_sql::many};
use hrc_domain::store::{json, *};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
pub(crate) fn fingerprint(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
}
impl ReadTx<'_> {
    pub fn collective_replications_due(
        &self,
        at: &str,
        limit: i64,
    ) -> Result<Vec<CollectiveReplicationRecord>> {
        let rows: Vec<rows::CollectiveHistoryReplicationsRow> = many(
            self.db,
            "SELECT * FROM collective_history_replications WHERE state='pending' AND next_attempt_at<=? ORDER BY source_message_seq,message_id LIMIT ?",
            params![at, limit],
        )?;
        rows.into_iter()
            .map(|r| {
                Ok(CollectiveReplicationRecord {
                    message_id: r.message_id,
                    source_node_id: r.source_node_id,
                    source_message_seq: r.source_message_seq,
                    source_role: r.source_role,
                    origin_node_id: r.origin_node_id,
                    accepted_destination_node_id: r.accepted_destination_node_id,
                    record: json::from_str(&r.record_json)?,
                    fingerprint: r.record_fingerprint,
                    total_attempts: r.total_attempts,
                    next_attempt_at: r.next_attempt_at,
                })
            })
            .collect()
    }
    pub fn collective_replication_pending_count(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM collective_history_replications WHERE state='pending'",
            [],
            |r| r.get(0),
        )?)
    }
}
impl WriteTx<'_> {
    pub fn enqueue_collective_replication(
        &mut self,
        input: &CollectiveObservationInput,
        at: &str,
    ) -> Result<()> {
        let raw = json::to_string(&input.record)?;
        let hash = fingerprint(&raw);
        let old: Option<String> = self
            .db
            .query_row(
                "SELECT record_fingerprint FROM collective_history_replications WHERE message_id=?",
                [&input.record.message_id],
                |r| r.get(0),
            )
            .optional()?;
        if old.as_deref() == Some(&hash) {
            return Ok(());
        }
        self.db.execute("INSERT INTO collective_history_replications(message_id,source_node_id,source_message_seq,source_role,origin_node_id,accepted_destination_node_id,record_json,record_fingerprint,state,total_attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?) ON CONFLICT(message_id) DO UPDATE SET source_node_id=excluded.source_node_id,source_message_seq=excluded.source_message_seq,source_role=excluded.source_role,origin_node_id=excluded.origin_node_id,accepted_destination_node_id=excluded.accepted_destination_node_id,record_json=excluded.record_json,record_fingerprint=excluded.record_fingerprint,state='pending',total_attempts=0,next_attempt_at=excluded.next_attempt_at,last_attempt_at=NULL,delivered_at=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=excluded.updated_at",params![input.record.message_id,input.source_node_id,input.record.message_seq,input.source_role,input.origin_node_id,input.accepted_destination_node_id,raw,hash,at,at,at])?;
        Ok(())
    }
    pub fn mark_collective_replication_delivered(
        &mut self,
        message: &str,
        hash: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE collective_history_replications SET state='delivered',total_attempts=total_attempts+1,last_attempt_at=?,delivered_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE message_id=? AND record_fingerprint=?",params![at,at,at,message,hash])?==1)
    }
    pub fn retry_collective_replication(&mut self, r: &CollectiveReplicationRetry) -> Result<bool> {
        Ok(self.db.execute("UPDATE collective_history_replications SET state='pending',total_attempts=total_attempts+1,last_attempt_at=?,next_attempt_at=?,last_error_code=?,last_error_message=?,updated_at=? WHERE message_id=? AND record_fingerprint=?",params![r.now,r.next_attempt_at,r.error_code,r.error_message,r.now,r.message_id,r.fingerprint])?==1)
    }
}
