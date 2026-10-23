use crate::{
    ReadTx, Result, WriteTx,
    typed_sql::{insert, many, one, required},
};
use hrc_domain::store::*;
use rusqlite::params;
impl ReadTx<'_> {
    pub fn bridge_by_id(&self, id: &str) -> Result<Option<LocalBridge>> {
        one(
            self.db,
            "SELECT * FROM local_bridges WHERE bridge_id=?",
            [id],
        )
    }
    pub fn bridge_by_target(&self, transport: &str, target: &str) -> Result<Option<LocalBridge>> {
        one(
            self.db,
            "SELECT * FROM local_bridges WHERE transport=? AND target=? ORDER BY created_at ASC LIMIT 1",
            params![transport, target],
        )
    }
    pub fn active_bridges(&self) -> Result<Vec<LocalBridge>> {
        many(
            self.db,
            "SELECT * FROM local_bridges WHERE closed_at IS NULL ORDER BY created_at ASC,bridge_id ASC",
            [],
        )
    }
    pub fn surface_binding(&self, kind: &str, id: &str) -> Result<Option<SurfaceBinding>> {
        one(
            self.db,
            "SELECT * FROM surface_bindings WHERE surface_kind=? AND surface_id=?",
            params![kind, id],
        )
    }
    pub fn surface_bindings_by_runtime(&self, runtime: &str) -> Result<Vec<SurfaceBinding>> {
        many(
            self.db,
            "SELECT * FROM surface_bindings WHERE runtime_id=? AND unbound_at IS NULL ORDER BY bound_at ASC,surface_kind ASC,surface_id ASC",
            [runtime],
        )
    }
    pub fn active_surface_bindings(&self) -> Result<Vec<SurfaceBinding>> {
        many(
            self.db,
            "SELECT * FROM surface_bindings WHERE unbound_at IS NULL ORDER BY bound_at ASC,surface_kind ASC,surface_id ASC",
            [],
        )
    }
    pub fn runtime_buffers_by_runtime(&self, runtime: &str) -> Result<Vec<RuntimeBuffer>> {
        many(
            self.db,
            "SELECT * FROM runtime_buffers WHERE runtime_id=? ORDER BY created_at ASC,chunk_seq ASC",
            [runtime],
        )
    }
    pub fn runtime_buffers_by_run(&self, run: &str) -> Result<Vec<RuntimeBuffer>> {
        many(
            self.db,
            "SELECT * FROM runtime_buffers WHERE run_id=? ORDER BY chunk_seq ASC",
            [run],
        )
    }
    pub fn runtime_buffers_tail_by_runtime(
        &self,
        runtime: &str,
        limit: usize,
    ) -> Result<Vec<RuntimeBuffer>> {
        let mut rows = many(
            self.db,
            "SELECT * FROM runtime_buffers WHERE runtime_id=? ORDER BY created_at DESC,chunk_seq DESC LIMIT ?",
            params![runtime, limit as i64],
        )?;
        rows.reverse();
        Ok(rows)
    }
    pub fn runtime_buffers_tail_by_run(
        &self,
        run: &str,
        limit: usize,
    ) -> Result<Vec<RuntimeBuffer>> {
        let mut rows = many(
            self.db,
            "SELECT * FROM runtime_buffers WHERE run_id=? ORDER BY chunk_seq DESC LIMIT ?",
            params![run, limit as i64],
        )?;
        rows.reverse();
        Ok(rows)
    }
    pub fn next_runtime_buffer_chunk_seq(&self, run: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT coalesce(max(chunk_seq),-1)+1 FROM runtime_buffers WHERE run_id=?",
            [run],
            |r| r.get(0),
        )?)
    }
}
impl WriteTx<'_> {
    pub fn create_local_bridge(&mut self, record: &LocalBridge) -> Result<LocalBridge> {
        insert(self.db, "local_bridges", record)?;
        required(
            self.read().bridge_by_id(&record.bridge_id)?,
            record.bridge_id.clone(),
        )
    }
    pub fn close_local_bridge(&mut self, id: &str, at: &str) -> Result<Option<LocalBridge>> {
        self.db.execute(
            "UPDATE local_bridges SET status='closed',closed_at=? WHERE bridge_id=?",
            params![at, id],
        )?;
        self.read().bridge_by_id(id)
    }
    pub fn append_runtime_buffer(&mut self, record: &RuntimeBuffer) -> Result<RuntimeBuffer> {
        insert(self.db, "runtime_buffers", record)?;
        required(
            one(
                self.db,
                "SELECT * FROM runtime_buffers WHERE runtime_id=? AND run_id=? AND chunk_seq=?",
                params![record.runtime_id, record.run_id, record.chunk_seq],
            )?,
            record.run_id.clone(),
        )
    }
    pub fn bind_surface(&mut self, r: &SurfaceBinding) -> Result<SurfaceBinding> {
        self.db.execute("INSERT INTO surface_bindings(surface_kind,surface_id,client_tty,host_session_id,runtime_id,generation,window_id,pane_id,bound_at,unbound_at,reason) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(surface_kind,surface_id) DO UPDATE SET client_tty=excluded.client_tty,host_session_id=excluded.host_session_id,runtime_id=excluded.runtime_id,generation=excluded.generation,window_id=excluded.window_id,pane_id=excluded.pane_id,bound_at=excluded.bound_at,unbound_at=NULL,reason=NULL",params![r.surface_kind,r.surface_id,r.client_tty,r.host_session_id,r.runtime_id,r.generation,r.window_id,r.pane_id,r.bound_at])?;
        required(
            self.read()
                .surface_binding(&r.surface_kind, &r.surface_id)?,
            r.surface_id.clone(),
        )
    }
    pub fn unbind_surface(
        &mut self,
        kind: &str,
        id: &str,
        at: &str,
        reason: Option<&str>,
    ) -> Result<Option<SurfaceBinding>> {
        self.db.execute("UPDATE surface_bindings SET unbound_at=?,reason=? WHERE surface_kind=? AND surface_id=?",params![at,reason,kind,id])?;
        self.read().surface_binding(kind, id)
    }
    pub fn unbind_other_ghostty_client_tty(
        &mut self,
        tty: &str,
        surface: &str,
        at: &str,
        reason: &str,
    ) -> Result<Vec<SurfaceBinding>> {
        let rows: Vec<SurfaceBinding> = many(
            self.db,
            "SELECT * FROM surface_bindings WHERE surface_kind='ghostty' AND client_tty=? AND surface_id<>? AND unbound_at IS NULL ORDER BY bound_at ASC,surface_id ASC",
            params![tty, surface],
        )?;
        let mut displaced = Vec::new();
        for row in rows {
            self.db.execute("UPDATE surface_bindings SET unbound_at=?,reason=? WHERE surface_kind=? AND surface_id=? AND unbound_at IS NULL",params![at,reason,row.surface_kind,row.surface_id])?;
            if let Some(updated) = self
                .read()
                .surface_binding(&row.surface_kind, &row.surface_id)?
            {
                displaced.push(updated)
            }
        }
        Ok(displaced)
    }
}
