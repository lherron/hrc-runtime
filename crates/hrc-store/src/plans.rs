use crate::{
    ReadTx, Result, WriteTx,
    execution_mapping::*,
    typed_sql::{insert, insert_on_conflict_do_nothing, many, one, required, update_columns},
};
use hrc_domain::store::*;

impl ReadTx<'_> {
    pub fn lifecycle_policy_by_hash(&self, hash: &str) -> Result<Option<LifecyclePolicy>> {
        one(
            self.db,
            "SELECT * FROM lifecycle_policies WHERE lifecycle_policy_hash=?",
            [hash],
        )
    }
    pub fn compiled_plan_by_hash(&self, hash: &str) -> Result<Option<CompiledRuntimePlan>> {
        one(
            self.db,
            "SELECT * FROM compiled_runtime_plans WHERE plan_hash=?",
            [hash],
        )
    }
    pub fn compiled_plans_by_compile(&self, id: &str) -> Result<Vec<CompiledRuntimePlan>> {
        many(
            self.db,
            "SELECT * FROM compiled_runtime_plans WHERE compile_id=? ORDER BY created_at ASC,plan_hash ASC",
            [id],
        )
    }
    pub fn runtime_operation(&self, id: &str) -> Result<Option<RuntimeOperation>> {
        let raw: Option<rows::RuntimeOperationsRow> = one(
            self.db,
            "SELECT * FROM runtime_operations WHERE operation_id=?",
            [id],
        )?;
        raw.map(|r| operation_from_row(self.db, r)).transpose()
    }
    pub fn prepared_operations_by_host(&self, host: &str) -> Result<Vec<RuntimeOperation>> {
        self.operation_rows("SELECT * FROM runtime_operations WHERE host_session_id=? AND status='prepared' AND preparation_json IS NOT NULL ORDER BY created_at DESC,operation_id DESC",[host])
    }
    pub fn runtime_operations_by_runtime(&self, runtime: &str) -> Result<Vec<RuntimeOperation>> {
        self.operation_rows("SELECT * FROM runtime_operations WHERE runtime_id=? ORDER BY created_at ASC,operation_id ASC",[runtime])
    }
    fn operation_rows(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<RuntimeOperation>> {
        let raw: Vec<rows::RuntimeOperationsRow> = many(self.db, sql, params)?;
        raw.into_iter()
            .map(|r| operation_from_row(self.db, r))
            .collect()
    }
    pub fn broker_invocation(&self, id: &str) -> Result<Option<BrokerInvocation>> {
        let raw: Option<rows::BrokerInvocationsRow> = one(
            self.db,
            "SELECT * FROM broker_invocations WHERE invocation_id=?",
            [id],
        )?;
        raw.map(|r| invocation_from_row(self.db, r)).transpose()
    }
    pub fn broker_invocations_by_runtime(&self, id: &str) -> Result<Vec<BrokerInvocation>> {
        let raw: Vec<rows::BrokerInvocationsRow> = many(
            self.db,
            "SELECT * FROM broker_invocations WHERE runtime_id=? ORDER BY created_at ASC,invocation_id ASC",
            [id],
        )?;
        raw.into_iter()
            .map(|r| invocation_from_row(self.db, r))
            .collect()
    }
    /// Retained projection ownership is ANY non-null marker, including zero and inactive invocations.
    pub fn has_retained_projection(&self, runtime: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocations WHERE runtime_id=? AND retained_projected_through_seq IS NOT NULL)",[runtime],|r|r.get(0))?)
    }
}
impl WriteTx<'_> {
    pub fn insert_lifecycle_policy(&mut self, r: &LifecyclePolicy) -> Result<LifecyclePolicy> {
        insert_on_conflict_do_nothing(self.db, "lifecycle_policies", "lifecycle_policy_hash", r)?;
        required(
            self.read()
                .lifecycle_policy_by_hash(&r.lifecycle_policy_hash)?,
            r.lifecycle_policy_hash.clone(),
        )
    }
    pub fn insert_compiled_plan(&mut self, r: &CompiledRuntimePlan) -> Result<CompiledRuntimePlan> {
        insert_on_conflict_do_nothing(self.db, "compiled_runtime_plans", "plan_hash", r)?;
        required(
            self.read().compiled_plan_by_hash(&r.plan_hash)?,
            r.plan_hash.clone(),
        )
    }
    pub fn insert_runtime_operation(&mut self, r: &RuntimeOperation) -> Result<RuntimeOperation> {
        insert(self.db, "runtime_operations", &operation_to_row(r)?)?;
        required(
            self.read().runtime_operation(&r.operation_id)?,
            r.operation_id.clone(),
        )
    }
    pub fn update_runtime_operation(
        &mut self,
        id: &str,
        p: &RuntimeOperationPatch,
    ) -> Result<Option<RuntimeOperation>> {
        update_columns(
            self.db,
            "runtime_operations",
            "operation_id",
            id,
            operation_patch_entries(p)?,
        )?;
        self.read().runtime_operation(id)
    }
    pub fn insert_broker_invocation(&mut self, r: &BrokerInvocation) -> Result<BrokerInvocation> {
        let mut row = invocation_to_row(r)?;
        row.retained_projected_through_seq = None;
        insert(self.db, "broker_invocations", &row)?;
        required(
            self.read().broker_invocation(&r.invocation_id)?,
            r.invocation_id.clone(),
        )
    }
    pub fn update_broker_invocation(
        &mut self,
        id: &str,
        p: &BrokerInvocationPatch,
    ) -> Result<Option<BrokerInvocation>> {
        update_columns(
            self.db,
            "broker_invocations",
            "invocation_id",
            id,
            invocation_patch_entries(p)?,
        )?;
        self.read().broker_invocation(id)
    }
}
