//! Owner-process reservation authority. Staged with SQLite transactions, never a cross-owner lock.
use crate::{Result, Store, StoreError, WriteTx};
use hrc_domain::store::{Patch, RunPatch, RunReservationOutcome, RunWriter};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;
#[derive(Clone)]
struct Reservation {
    token: String,
    writer: RunWriter,
}
#[derive(Clone, Default)]
pub(crate) struct Ownership {
    reservations: BTreeMap<String, Reservation>,
    tokens: BTreeMap<String, String>,
}
fn conflict(run: &str, reason: &str) -> StoreError {
    StoreError::Conflict {
        code: "run_mismatch",
        identity: format!("{run}: {reason}"),
    }
}
#[derive(Clone)]
struct Tuple {
    scope: String,
    writer: RunWriter,
}
fn tuple(db: &Connection, run: &str) -> Result<Option<Tuple>> {
    Ok(db.query_row("SELECT scope_ref,host_session_id,generation,runtime_id,operation_id FROM runs WHERE run_id=?",[run],|r|Ok(Tuple{scope:r.get(0)?,writer:RunWriter{host_session_id:r.get(1)?,generation:r.get(2)?,runtime_id:r.get(3)?,operation_id:r.get(4)?}})).optional()?)
}
fn handles(db: &Connection, run: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE run_id=?) OR EXISTS(SELECT 1 FROM runtimes WHERE active_run_id=?) OR EXISTS(SELECT 1 FROM steer_contributions WHERE active_run_id=?)",params![run,run,run],|r|r.get(0))?)
}
impl Ownership {
    fn reserve(
        &mut self,
        db: &Connection,
        run: &str,
        token: &str,
        host: &str,
        generation: i64,
    ) -> Result<RunReservationOutcome> {
        if let Some(held) = self.reservations.get(run) {
            return Ok(if held.token == token {
                RunReservationOutcome::Reserved
            } else {
                RunReservationOutcome::ReservedByOther
            });
        }
        if handles(db, run)? {
            return Ok(RunReservationOutcome::Exists);
        }
        self.reservations.insert(
            run.into(),
            Reservation {
                token: token.into(),
                writer: RunWriter {
                    host_session_id: host.into(),
                    generation,
                    ..Default::default()
                },
            },
        );
        Ok(RunReservationOutcome::Reserved)
    }
    fn token(&self, run: &str, reader: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        self.tokens.get(run).cloned().or_else(|| reader(run))
    }
    fn bind(&mut self, run: &str, writer: &RunWriter, token: Option<&str>) -> Result<()> {
        let Some(reserved) = self.reservations.get_mut(run) else {
            return Err(conflict(run, "unbound-without-reservation"));
        };
        if token != Some(reserved.token.as_str()) {
            return Err(conflict(run, "run-id-reserved/no-token"));
        }
        if reserved.writer.host_session_id != writer.host_session_id {
            return Err(conflict(run, "host-session-mismatch"));
        }
        if reserved.writer.generation != writer.generation {
            return Err(conflict(run, "generation-mismatch"));
        }
        if reserved.writer.runtime_id.is_some() && reserved.writer.runtime_id != writer.runtime_id {
            return Err(conflict(run, "runtime-mismatch"));
        }
        if reserved.writer.operation_id.is_some()
            && reserved.writer.operation_id != writer.operation_id
        {
            return Err(conflict(run, "operation-mismatch"));
        }
        if reserved.writer.runtime_id.is_none() {
            reserved.writer.runtime_id = writer.runtime_id.clone()
        }
        if reserved.writer.operation_id.is_none() {
            reserved.writer.operation_id = writer.operation_id.clone()
        }
        Ok(())
    }
    fn assert_handle(
        &mut self,
        db: &Connection,
        run: &str,
        writer: &RunWriter,
        token: Option<&str>,
    ) -> Result<()> {
        let row = tuple(db, run)?;
        let reserved = self.reservations.contains_key(run);
        if !reserved && row.as_ref().is_none_or(|r| !r.scope.starts_with("app:")) {
            return Ok(());
        }
        if let Some(row) = row
            && row.writer.runtime_id.is_some()
        {
            if row.writer.runtime_id != writer.runtime_id {
                return Err(conflict(run, "runtime-mismatch"));
            }
            if row.writer.host_session_id != writer.host_session_id {
                return Err(conflict(run, "host-session-mismatch"));
            }
            if row.writer.generation != writer.generation {
                return Err(conflict(run, "generation-mismatch"));
            }
            if row.writer.operation_id.is_some() && row.writer.operation_id != writer.operation_id {
                return Err(conflict(run, "operation-mismatch"));
            }
            Ok(())
        } else {
            self.bind(run, writer, token)
        }
    }
}
impl Store {
    pub fn reserve_run_id(
        &mut self,
        run: &str,
        token: &str,
        host: &str,
        generation: i64,
    ) -> Result<RunReservationOutcome> {
        self.ownership
            .reserve(&self.db, run, token, host, generation)
    }
    pub fn release_run_id(&mut self, run: &str, token: &str) {
        if self
            .ownership
            .reservations
            .get(run)
            .is_some_and(|r| r.token == token)
        {
            self.ownership.reservations.remove(run);
        }
    }
    pub fn run_reservation_for(&self, run: &str) -> Option<&str> {
        self.ownership
            .reservations
            .get(run)
            .map(|r| r.token.as_str())
    }
    pub fn run_id_is_named(&self, run: &str) -> Result<bool> {
        Ok(self.ownership.reservations.contains_key(run) || handles(&self.db, run)?)
    }
    pub fn set_reservation_token_reader(
        &mut self,
        reader: impl Fn(&str) -> Option<String> + 'static,
    ) {
        self.token_reader = Box::new(reader);
    }
}
impl WriteTx<'_> {
    pub fn with_run_token<T>(
        &mut self,
        run: &str,
        token: &str,
        write: impl FnOnce(&mut WriteTx<'_>) -> Result<T>,
    ) -> Result<T> {
        let old = self.ownership.tokens.insert(run.into(), token.into());
        let result = write(self);
        if let Some(old) = old {
            self.ownership.tokens.insert(run.into(), old);
        } else {
            self.ownership.tokens.remove(run);
        }
        result
    }
    pub fn assert_can_create_run(&mut self, run: &str, writer: &RunWriter) -> Result<()> {
        if self.ownership.reservations.contains_key(run) {
            let token = self.ownership.token(run, self.token_reader);
            self.ownership.bind(run, writer, token.as_deref())?
        }
        Ok(())
    }
    pub fn assert_can_name_active_run(
        &mut self,
        run: Option<&str>,
        writer: &RunWriter,
    ) -> Result<()> {
        if let Some(run) = run {
            let token = self.ownership.token(run, self.token_reader);
            self.ownership
                .assert_handle(self.db, run, writer, token.as_deref())?
        }
        Ok(())
    }
    pub fn assert_contribution_may_name_run(&self, run: &str) -> Result<()> {
        if self.ownership.reservations.contains_key(run) {
            return Err(conflict(run, "run-id-reserved"));
        }
        if tuple(self.db, run)?.is_some_and(|r| r.scope.starts_with("app:")) {
            return Err(conflict(run, "contribution-cannot-name-app-run"));
        }
        Ok(())
    }
    pub fn may_name_active_run(&mut self, run: &str, writer: &RunWriter) -> Result<bool> {
        match self.ownership.assert_handle(self.db, run, writer, None) {
            Ok(()) => Ok(true),
            Err(StoreError::Conflict { .. }) => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub fn assert_run_binding_update(
        &mut self,
        run: &str,
        runtime: &Patch<String>,
        operation: &Patch<String>,
        host: &Patch<String>,
        generation: &Patch<i64>,
    ) -> Result<()> {
        if matches!(
            (runtime, operation, host, generation),
            (
                Patch::Unchanged,
                Patch::Unchanged,
                Patch::Unchanged,
                Patch::Unchanged
            )
        ) {
            return Ok(());
        }
        let Some(row) = tuple(self.db, run)? else {
            return Ok(());
        };
        if !self.ownership.reservations.contains_key(run) && !row.scope.starts_with("app:") {
            return Ok(());
        }
        if let Patch::Set(host) = host
            && *host != row.writer.host_session_id
        {
            return Err(conflict(run, "host-session-immutable"));
        }
        if let Patch::Set(generation) = generation
            && *generation != row.writer.generation
        {
            return Err(conflict(run, "generation-immutable"));
        }
        if let Patch::Set(op) = operation
            && row
                .writer
                .operation_id
                .as_ref()
                .is_some_and(|old| old != op)
        {
            return Err(conflict(run, "operation-immutable"));
        }
        if let Patch::Set(rt) = runtime
            && row.writer.runtime_id.as_ref().is_some_and(|old| old != rt)
        {
            return Err(conflict(run, "runtime-immutable"));
        }
        if matches!(runtime, Patch::Clear) && row.writer.runtime_id.is_some()
            || matches!(operation, Patch::Clear) && row.writer.operation_id.is_some()
        {
            return Err(conflict(run, "binding-immutable"));
        }
        let fill = (matches!(runtime, Patch::Set(_)) && row.writer.runtime_id.is_none())
            || (matches!(operation, Patch::Set(_)) && row.writer.operation_id.is_none());
        if !fill {
            return Ok(());
        }
        let writer = RunWriter {
            runtime_id: match runtime {
                Patch::Set(v) => Some(v.clone()),
                _ => row.writer.runtime_id,
            },
            operation_id: match operation {
                Patch::Set(v) => Some(v.clone()),
                _ => row.writer.operation_id,
            },
            host_session_id: row.writer.host_session_id,
            generation: row.writer.generation,
        };
        let token = self.ownership.token(run, self.token_reader);
        self.ownership.bind(run, &writer, token.as_deref())
    }
    pub(crate) fn assert_run_patch(&mut self, id: &str, patch: &RunPatch) -> Result<()> {
        self.assert_run_binding_update(
            id,
            &patch.runtime_id,
            &patch.operation_id,
            &patch.host_session_id,
            &patch.generation,
        )
    }
}
