use hrc_domain::store::json as serde_json;
// Explicit storage cascade. Caller owns the runtime safety decision; this module never reconciles.
use crate::{ReadTx, Result, StoreError, WriteTx};
use hrc_domain::store::*;
const SELECTED: &str =
    "WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?))";
const RUN_SCOPED: &str = "runtime_id IN (SELECT runtime_id FROM selected) OR run_id IN (SELECT run_id FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected))";
const PLANS: &str = "WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)), candidates AS MATERIALIZED (SELECT plan_hash FROM runtimes WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL UNION SELECT plan_hash FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected) AND plan_hash IS NOT NULL), referenced_elsewhere AS MATERIALIZED (SELECT runtime.plan_hash FROM runtimes runtime JOIN candidates ON candidates.plan_hash=runtime.plan_hash LEFT JOIN selected ON selected.runtime_id=runtime.runtime_id WHERE selected.runtime_id IS NULL UNION SELECT operation.plan_hash FROM runtime_operations operation JOIN candidates ON candidates.plan_hash=operation.plan_hash LEFT JOIN selected ON selected.runtime_id=operation.runtime_id WHERE selected.runtime_id IS NULL UNION SELECT operation.plan_hash FROM broker_invocations invocation JOIN runtime_operations operation ON operation.operation_id=invocation.operation_id JOIN candidates ON candidates.plan_hash=operation.plan_hash LEFT JOIN selected ON selected.runtime_id=invocation.runtime_id WHERE selected.runtime_id IS NULL)";
fn exists(db: &rusqlite::Connection, table: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)",
        [table],
        |r| r.get(0),
    )?)
}
impl ReadTx<'_> {
    pub fn count_runtime_prune_rows(
        &self,
        ids: &[String],
        include_ledgers: bool,
    ) -> Result<RuntimePruneCounts> {
        let selected = serde_json::to_string(ids)?;
        let count = |table: &str, predicate: &str| -> Result<i64> {
            Ok(self.db.query_row(
                &format!("{SELECTED} SELECT count(*) FROM {table} WHERE {predicate}"),
                [&selected],
                |r| r.get(0),
            )?)
        };
        let mut c = RuntimePruneCounts {
            events: count("events", RUN_SCOPED)?,
            runtime_buffers: count("runtime_buffers", RUN_SCOPED)?,
            surface_bindings: count(
                "surface_bindings",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?,
            local_bridges: count(
                "local_bridges",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?,
            runs: count("runs", "runtime_id IN (SELECT runtime_id FROM selected)")?,
            runtimes: count(
                "runtimes",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?,
            ..Default::default()
        };
        if include_ledgers {
            c.broker_invocation_events = count(
                "broker_invocation_events",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?;
            c.hrc_events = count(
                "hrc_events",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?;
            c.broker_invocations = count(
                "broker_invocations",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?;
            c.runtime_operations = count(
                "runtime_operations",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?;
            c.runtime_first_turn_watch = count(
                "runtime_first_turn_watch",
                "runtime_id IN (SELECT runtime_id FROM selected)",
            )?;
            c.runtime_artifacts = count(
                "runtime_artifacts",
                "operation_id IN (SELECT operation_id FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected))",
            )?;
            if exists(self.db, "tool_result_blob_parts")? {
                c.tool_result_blob_parts = count(
                    "tool_result_blob_parts",
                    "runtime_id IN (SELECT runtime_id FROM selected)",
                )?;
            }
            if exists(self.db, "tool_result_blobs")? {
                c.tool_result_blobs = count(
                    "tool_result_blobs",
                    "runtime_id IN (SELECT runtime_id FROM selected)",
                )?;
            }
            c.compiled_runtime_plans=self.db.query_row(&format!("{PLANS} SELECT count(*) FROM compiled_runtime_plans plan JOIN candidates ON candidates.plan_hash=plan.plan_hash LEFT JOIN referenced_elsewhere reference ON reference.plan_hash=plan.plan_hash WHERE reference.plan_hash IS NULL"),[&selected],|r|r.get(0))?;
        }
        Ok(c)
    }
}
impl WriteTx<'_> {
    pub fn prune_runtime(&mut self, id: &str, include_ledgers: bool) -> Result<bool> {
        Ok(self.prune_runtimes(&[id.into()], include_ledgers)? == 1)
    }
    pub fn prune_runtimes(&mut self, ids: &[String], include_ledgers: bool) -> Result<usize> {
        self.savepoint(|tx|{
        if !include_ledgers{
            let mut removed=0;for id in ids{for table in ["events","runtime_buffers"]{tx.db.execute(&format!("DELETE FROM {table} WHERE runtime_id=? OR run_id IN (SELECT run_id FROM runs WHERE runtime_id=?)"),rusqlite::params![id,id])?;}for table in ["surface_bindings","local_bridges","runs"]{tx.db.execute(&format!("DELETE FROM {table} WHERE runtime_id=?"),[id])?;}removed+=tx.db.execute("DELETE FROM runtimes WHERE runtime_id=?",[id])?;}return Ok(removed)
        }
        let selected=serde_json::to_string(ids)?;
        let present:i64=tx.db.query_row(&format!("{SELECTED} SELECT count(*) FROM runtimes WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected],|r|r.get(0))?;
        if present as usize!=ids.len(){return Err(StoreError::Conflict{code:"runtime_prune_manifest_changed",identity:format!("expected {}, found {present}",ids.len())})}
        for table in ["transcript_turns","transcript_index_invocations","broker_invocation_events","hrc_events"]{tx.db.execute(&format!("{SELECTED} DELETE FROM {table} WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;}
        tx.db.execute(&format!("{SELECTED} DELETE FROM runtime_artifacts WHERE operation_id IN (SELECT operation_id FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected))"),[&selected])?;
        for table in ["broker_invocations","runtime_first_turn_watch"]{tx.db.execute(&format!("{SELECTED} DELETE FROM {table} WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;}
        for table in ["tool_result_blob_parts","tool_result_blobs"]{if exists(tx.db,table)?{tx.db.execute(&format!("{SELECTED} DELETE FROM {table} WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;}}
        tx.db.execute(&format!("{PLANS} DELETE FROM compiled_runtime_plans AS plan WHERE plan.plan_hash IN (SELECT plan_hash FROM candidates) AND plan.plan_hash NOT IN (SELECT plan_hash FROM referenced_elsewhere)"),[&selected])?;
        tx.db.execute(&format!("{SELECTED} DELETE FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;
        for table in ["events","runtime_buffers"]{tx.db.execute(&format!("{SELECTED} DELETE FROM {table} WHERE {RUN_SCOPED}"),[&selected])?;}
        for table in ["surface_bindings","local_bridges","runs"]{tx.db.execute(&format!("{SELECTED} DELETE FROM {table} WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;}
        // Bun's Statement.run().changes includes writes made by the canonical runtime-delete
        // trigger. Preserve that observable return only at this source return site.
        // The deleted runtime count is independently available from count_runtime_prune_rows.
        let before=tx.db.total_changes();
        tx.db.execute(&format!("{SELECTED} DELETE FROM runtimes WHERE runtime_id IN (SELECT runtime_id FROM selected)"),[&selected])?;
        Ok((tx.db.total_changes()-before) as usize)
    })
    }
}
