use crate::{
    ReadTx, Result, StoreError, WriteTx,
    execution_mapping::*,
    typed_sql::{insert, many, one, required},
};
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
impl ReadTx<'_> {
    pub fn runtime_count(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT count(*) FROM runtimes", [], |r| r.get(0))?)
    }
    pub fn runtime_by_id(&self, id: &str) -> Result<Option<RuntimeRecord>> {
        let r: Option<rows::RuntimesRow> =
            one(self.db, "SELECT * FROM runtimes WHERE runtime_id=?", [id])?;
        r.map(|r| runtime_from_row(self.db, r)).transpose()
    }
    pub fn latest_runtime_by_host(&self, host: &str) -> Result<Option<RuntimeRecord>> {
        self.runtime_rows("SELECT * FROM runtimes WHERE host_session_id=? ORDER BY created_at DESC,runtime_id DESC LIMIT 1",[host]).map(|v|v.into_iter().next())
    }
    pub fn runtimes_by_host(&self, host: &str) -> Result<Vec<RuntimeRecord>> {
        self.runtime_rows(
            "SELECT * FROM runtimes WHERE host_session_id=? ORDER BY created_at ASC,runtime_id ASC",
            [host],
        )
    }
    pub fn runtimes_by_scope(&self, scope: &str) -> Result<Vec<RuntimeRecord>> {
        self.runtime_rows(
            "SELECT * FROM runtimes WHERE scope_ref=? ORDER BY created_at ASC,runtime_id ASC",
            [scope],
        )
    }
    pub fn all_runtimes(&self) -> Result<Vec<RuntimeRecord>> {
        self.runtime_rows(
            "SELECT * FROM runtimes ORDER BY created_at ASC,runtime_id ASC",
            [],
        )
    }
    pub fn available_runtimes(&self) -> Result<Vec<RuntimeRecord>> {
        self.runtime_rows("SELECT * FROM runtimes WHERE status NOT IN ('terminated','dead','stale','crashed','detached','exited') ORDER BY created_at ASC,runtime_id ASC",[])
    }
    pub fn runtimes_by_status(&self, statuses: &[String]) -> Result<Vec<RuntimeRecord>> {
        if statuses.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT * FROM runtimes WHERE status IN ({}) ORDER BY created_at ASC,runtime_id ASC",
            vec!["?"; statuses.len()].join(",")
        );
        self.runtime_rows(&sql, params_from_iter(statuses))
    }
    fn runtime_rows(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<RuntimeRecord>> {
        let rows: Vec<rows::RuntimesRow> = many(self.db, sql, params)?;
        rows.into_iter()
            .map(|r| runtime_from_row(self.db, r))
            .collect()
    }
    pub fn live_session_refs(&self) -> Result<Vec<String>> {
        Ok(self.db.prepare("SELECT DISTINCT scope_ref||'/lane:'||lane_ref AS session_ref FROM runtimes WHERE status IN ('starting','ready','busy','awaiting_input','stopping') AND scope_ref LIKE 'agent:%' ORDER BY session_ref ASC")?.query_map([],|r|r.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    pub fn live_session_ref_rows(&self) -> Result<Vec<LiveSeatRef>> {
        Ok(self.db.prepare("SELECT scope_ref,lane_ref,runtime_id,host_session_id FROM runtimes WHERE status IN ('starting','ready','busy','awaiting_input','stopping') AND scope_ref LIKE 'agent:%' ORDER BY scope_ref ASC,lane_ref ASC,runtime_id ASC")?.query_map([],|r|Ok(LiveSeatRef{scope_ref:r.get(0)?,lane_ref:r.get(1)?,runtime_id:r.get(2)?,host_session_id:r.get(3)?}))?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    pub fn run_by_id(&self, id: &str) -> Result<Option<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE run_id=?", [id])
            .map(|v| v.into_iter().next())
    }
    pub fn run_by_dispatch_idempotency_key(
        &self,
        host: &str,
        key: &str,
    ) -> Result<Option<RunRecord>> {
        self.run_rows(
            "SELECT * FROM runs WHERE host_session_id=? AND dispatch_idempotency_key=? LIMIT 1",
            params![host, key],
        )
        .map(|v| v.into_iter().next())
    }
    pub fn run_by_dispatched_input_id(&self, id: &str) -> Result<Option<RunRecord>> {
        self.run_rows(
            "SELECT * FROM runs WHERE dispatched_input_id=? LIMIT 1",
            [id],
        )
        .map(|v| v.into_iter().next())
    }
    pub fn run_by_broker_submission_id(&self, id: &str) -> Result<Option<RunRecord>> {
        self.run_rows(
            "SELECT * FROM runs WHERE broker_submission_id=? LIMIT 1",
            [id],
        )
        .map(|v| v.into_iter().next())
    }
    pub fn run_by_turn_key(&self, key: &str) -> Result<Option<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE turn_key=? LIMIT 1", [key])
            .map(|v| v.into_iter().next())
    }
    pub fn runs_by_runtime(&self, runtime: &str) -> Result<Vec<RunRecord>> {
        self.run_rows(
            "SELECT * FROM runs WHERE runtime_id=? ORDER BY accepted_at ASC,run_id ASC",
            [runtime],
        )
    }
    pub fn correlated_runs_by_invocation(&self, invocation: &str) -> Result<Vec<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE invocation_id=? AND correlation_json IS NOT NULL ORDER BY accepted_at ASC,run_id ASC",[invocation])
    }
    pub fn queued_runs_by_host(&self, host: &str) -> Result<Vec<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE host_session_id=? AND status='queued' ORDER BY queued_input_seq ASC,rowid ASC",[host])
    }
    pub fn run_correlation_json(&self, run: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT correlation_json FROM runs WHERE run_id=?",
                [run],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }
    pub fn list_runs(&self, f: &RunFilters) -> Result<Vec<RunRecord>> {
        let mut p = Vec::new();
        let mut v = Vec::<SqlValue>::new();
        for (c, x) in [
            ("run_id", &f.run_id),
            ("host_session_id", &f.host_session_id),
            ("runtime_id", &f.runtime_id),
            ("scope_ref", &f.scope_ref),
            ("lane_ref", &f.lane_ref),
        ] {
            if let Some(x) = x {
                p.push(format!("{c}=?"));
                v.push(x.clone().into())
            }
        }
        if let Some(g) = f.generation {
            p.push("generation=?".into());
            v.push(g.into())
        }
        if !f.statuses.is_empty() {
            p.push(format!(
                "status IN ({})",
                vec!["?"; f.statuses.len()].join(",")
            ));
            v.extend(f.statuses.iter().cloned().map(SqlValue::Text))
        }
        let clause = if p.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", p.join(" AND "))
        };
        v.push((f.limit.unwrap_or(100) as i64).into());
        self.run_rows(&format!("SELECT * FROM runs {clause} ORDER BY updated_at DESC,coalesce(completed_at,started_at,accepted_at,updated_at) DESC,run_id DESC LIMIT ?"),params_from_iter(v))
    }
    pub fn latest_run_for_session(
        &self,
        host: &str,
        generation: Option<i64>,
    ) -> Result<Option<RunRecord>> {
        self.list_runs(&RunFilters {
            host_session_id: Some(host.into()),
            generation,
            limit: Some(1),
            ..Default::default()
        })
        .map(|v| v.into_iter().next())
    }
    pub(crate) fn run_rows(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<RunRecord>> {
        let rows: Vec<rows::RunsRow> = many(self.db, sql, params)?;
        rows.into_iter().map(|r| run_from_row(self.db, r)).collect()
    }
}
fn apply_patch(
    db: &rusqlite::Connection,
    table: &'static str,
    pk: &'static str,
    id: &str,
    entries: Vec<(&'static str, SqlValue)>,
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "UPDATE {table} SET {} WHERE {pk}=?",
        entries
            .iter()
            .map(|(c, _)| format!("{c}=?"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let values = entries
        .into_iter()
        .map(|(_, v)| v)
        .chain(std::iter::once(id.to_owned().into()));
    db.execute(&sql, params_from_iter(values))?;
    Ok(())
}
fn run_writer(r: &RunRecord) -> RunWriter {
    RunWriter {
        runtime_id: r.runtime_id.clone(),
        operation_id: r.operation_id.clone(),
        host_session_id: r.host_session_id.clone(),
        generation: r.generation,
    }
}
fn runtime_writer(r: &RuntimeRecord) -> RunWriter {
    RunWriter {
        runtime_id: Some(r.runtime_id.clone()),
        operation_id: r.active_operation_id.clone(),
        host_session_id: r.host_session_id.clone(),
        generation: r.generation,
    }
}
pub(crate) fn run_terminal(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "failed"
            | "cancelled"
            | "interrupted"
            | "degraded"
            | "zombie"
            | "reaped"
            | "coalesced"
            | "exited"
    )
}
impl WriteTx<'_> {
    pub fn insert_runtime(&mut self, r: &RuntimeRecord) -> Result<RuntimeRecord> {
        self.assert_can_name_active_run(r.active_run_id.as_deref(), &runtime_writer(r))?;
        insert(self.db, "runtimes", &runtime_to_row(r)?)?;
        let record = required(
            self.read().runtime_by_id(&r.runtime_id)?,
            r.runtime_id.clone(),
        )?;
        self.changes.push(CommittedChange::Runtime {
            runtime_id: r.runtime_id.clone(),
        });
        Ok(record)
    }
    pub fn update_runtime(&mut self, id: &str, p: &RuntimePatch) -> Result<Option<RuntimeRecord>> {
        let current = self.read().runtime_by_id(id)?;
        if let Some(r) = &current
            && let Patch::Set(run) = &p.active_run_id
        {
            let writer = RunWriter {
                runtime_id: Some(id.into()),
                operation_id: match &p.active_operation_id {
                    Patch::Set(v) => Some(v.clone()),
                    Patch::Clear => None,
                    _ => r.active_operation_id.clone(),
                },
                host_session_id: match &p.host_session_id {
                    Patch::Set(v) => v.clone(),
                    _ => r.host_session_id.clone(),
                },
                generation: match p.generation {
                    Patch::Set(v) => v,
                    _ => r.generation,
                },
            };
            self.assert_can_name_active_run(Some(run), &writer)?
        }
        let changed =
            matches!(&p.status,Patch::Set(v) if current.as_ref().is_none_or(|r|r.status!=*v));
        let mut entries = runtime_patch_entries(p)?;
        if !changed {
            entries.retain(|(c, _)| *c != "status_changed_at")
        }
        apply_patch(self.db, "runtimes", "runtime_id", id, entries)?;
        let updated = self.read().runtime_by_id(id)?;
        if changed && updated.is_some() {
            self.changes.push(CommittedChange::Runtime {
                runtime_id: id.into(),
            })
        }
        Ok(updated)
    }
    pub fn update_runtime_status(
        &mut self,
        id: &str,
        status: &str,
        at: &str,
    ) -> Result<Option<RuntimeRecord>> {
        self.update_runtime(
            id,
            &RuntimePatch {
                status: Patch::Set(status.into()),
                status_changed_at: Patch::Set(at.into()),
                updated_at: Patch::Set(at.into()),
                ..Default::default()
            },
        )
    }
    pub fn update_runtime_run_id(
        &mut self,
        id: &str,
        run: Option<&str>,
        at: &str,
    ) -> Result<Option<RuntimeRecord>> {
        if let Some(run) = run
            && let Some(current) = self.read().runtime_by_id(id)?
        {
            self.assert_can_name_active_run(Some(run), &runtime_writer(&current))?;
        }
        self.db.execute(
            "UPDATE runtimes SET active_run_id=?,updated_at=? WHERE runtime_id=?",
            params![run, at, id],
        )?;
        self.read().runtime_by_id(id)
    }
    pub fn update_runtime_activity(
        &mut self,
        id: &str,
        activity: &str,
        at: &str,
    ) -> Result<Option<RuntimeRecord>> {
        self.db.execute(
            "UPDATE runtimes SET last_activity_at=?,updated_at=? WHERE runtime_id=?",
            params![activity, at, id],
        )?;
        self.read().runtime_by_id(id)
    }
    pub fn insert_run(&mut self, r: &RunRecord) -> Result<RunRecord> {
        self.assert_can_create_run(&r.run_id, &run_writer(r))?;
        insert(self.db, "runs", &run_to_row(r)?)?;
        required(self.read().run_by_id(&r.run_id)?, r.run_id.clone())
    }
    pub fn set_run_correlation_json(&mut self, id: &str, value: Option<&str>) -> Result<()> {
        self.db.execute(
            "UPDATE runs SET correlation_json=? WHERE run_id=?",
            params![value, id],
        )?;
        Ok(())
    }
    pub fn update_run(&mut self, id: &str, p: &RunPatch) -> Result<Option<RunRecord>> {
        self.assert_run_patch(id, p)?;
        let mut entries = run_patch_entries(p)?;
        if let Patch::Set(status) = &p.status
            && !run_terminal(status)
            && !matches!(p.completed_at, Patch::Clear)
            && self
                .read()
                .run_by_id(id)?
                .is_some_and(|r| r.completed_at.is_some())
        {
            entries.retain(|(c, _)| !matches!(*c, "status" | "started_at" | "accepted_at"));
        }
        apply_patch(self.db, "runs", "run_id", id, entries)?;
        self.read().run_by_id(id)
    }
    pub fn update_run_status(
        &mut self,
        id: &str,
        status: &str,
        at: &str,
    ) -> Result<Option<RunRecord>> {
        self.update_run(
            id,
            &RunPatch {
                status: Patch::Set(status.into()),
                updated_at: Patch::Set(at.into()),
                ..Default::default()
            },
        )
    }
    pub fn fence_broker_input(
        &mut self,
        id: &str,
        at: &str,
        reason: &str,
    ) -> Result<Option<RunRecord>> {
        self.update_run(
            id,
            &RunPatch {
                broker_input_fenced_at: Patch::Set(at.into()),
                broker_input_fence_reason: Patch::Set(reason.into()),
                updated_at: Patch::Set(at.into()),
                ..Default::default()
            },
        )
    }
    pub fn mark_run_completed(
        &mut self,
        id: &str,
        status: &str,
        completed: &str,
        at: &str,
        error_code: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<Option<RunRecord>> {
        self.db.execute("UPDATE runs SET status=?,completed_at=?,updated_at=?,error_code=?,error_message=? WHERE run_id=?",params![status,completed,at,error_code,error_message,id])?;
        self.read().run_by_id(id)
    }
    pub fn snapshot_queued_by_host(
        &mut self,
        host: &str,
        snapshot: &str,
        at: &str,
    ) -> Result<Vec<RunRecord>> {
        self.savepoint(|tx|{
        let old:Option<String>=tx.db.query_row("SELECT queue_snapshot_id FROM runs WHERE host_session_id=? AND status='queued' AND queue_snapshot_id IS NOT NULL ORDER BY queued_input_seq ASC,rowid ASC LIMIT 1",[host],|r|r.get(0)).optional()?;
        let chosen=old.as_deref().unwrap_or(snapshot);if old.is_none(){let ids=tx.db.prepare("SELECT run_id FROM runs WHERE host_session_id=? AND status='queued' AND queue_snapshot_id IS NULL ORDER BY queued_input_seq ASC,rowid ASC")?.query_map([host],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;for(position,id)in ids.iter().enumerate(){if tx.db.execute("UPDATE runs SET queue_snapshot_id=?,queue_snapshot_position=?,updated_at=? WHERE run_id=? AND status='queued' AND queue_snapshot_id IS NULL",params![chosen,position as i64,at,id])?!=1{return Err(StoreError::Conflict{code:"queued_snapshot_conflict",identity:id.clone()})}}}
        tx.read().run_rows("SELECT * FROM runs WHERE host_session_id=? AND status='queued' AND queue_snapshot_id=? ORDER BY queue_snapshot_position ASC",params![host,chosen])
    })
    }
    pub fn mark_queued_coalesced(
        &mut self,
        id: &str,
        owner: &str,
        position: i64,
        completed: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE runs SET status='coalesced',completed_at=?,updated_at=?,coalesced_into_run_id=?,coalesced_position=? WHERE run_id=? AND status='queued'",params![completed,at,owner,position,id])?==1)
    }
    pub fn claim_queued_run(
        &mut self,
        id: &str,
        runtime: Option<&str>,
        invocation: Option<&str>,
        operation: Option<&str>,
        input: Option<&str>,
        at: &str,
    ) -> Result<bool> {
        self.assert_run_binding_update(
            id,
            &runtime
                .map(|s| Patch::Set(s.into()))
                .unwrap_or(Patch::Unchanged),
            &operation
                .map(|s| Patch::Set(s.into()))
                .unwrap_or(Patch::Unchanged),
            &Patch::Unchanged,
            &Patch::Unchanged,
        )?;
        Ok(self.db.execute("UPDATE runs SET status='accepted',runtime_id=?,invocation_id=?,operation_id=?,dispatched_input_id=?,updated_at=? WHERE run_id=? AND status='queued'",params![runtime,invocation,operation,input,at,id])?==1)
    }
}
