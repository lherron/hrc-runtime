//! Kernel-scoped HRC operations compose around Cardo's document adapter.
use cardo_core::document::CoreDomain;
use cardo_runtime::{core_adapter::CoreAdapter, service::*};
use crossbeam_channel::Sender;
use hrc_domain::{
    api::HrcApi,
    summon::{self, Summon},
};
use serde_json::json;
use std::{collections::BTreeSet, sync::Arc};

pub struct HrcAdapter {
    pub core: CoreAdapter<CoreDomain>,
    pub api: HrcApi,
    pub pending: BTreeSet<WorkId>,
}

fn complete(outcome: CommandOutcome) -> AdapterDispatchReport {
    AdapterDispatchReport {
        disposition: AdapterDisposition::Complete(outcome),
        changes: vec![],
        shutdown_persistence: None,
    }
}

impl DispatchAdapter for HrcAdapter {
    fn configure(&mut self, config: &RuntimeConfig) {
        self.core.configure(config);
    }
    fn live_subscribers(&mut self, count: usize) {
        self.core.live_subscribers(count);
    }
    fn idempotency(&self, command: &KernelCommand) -> Option<IdempotencyKey> {
        // Do not cache a receipt in Cardo: HRC must decide replay/conflict.
        if command.operation == summon::OPERATION {
            None
        } else {
            self.core.idempotency(command)
        }
    }
    fn cancelled_command_outcome(&self) -> CommandOutcome {
        // Cancellation cannot roll back an owner-API mutation.
        CommandOutcome::Unavailable { failure: DispatchFailure {
            code: "cancelled".into(), message: "Work suppressed; an HRC summon may still complete. Retry with the same request_id.".into(), details: json!({}),
        }}
    }
    fn interrupt_handle(&self) -> Option<Arc<dyn Fn(CommandId) -> bool + Send + Sync>> {
        self.core.interrupt_handle()
    }
    fn apply_shutdown_policy(
        &mut self,
        id: CommandId,
        policy: ShutdownPolicy,
    ) -> Result<AdapterDispatchReport, DispatchFailure> {
        self.core.apply_shutdown_policy(id, policy)
    }
    fn dispatch(
        &mut self,
        id: CommandId,
        command: KernelCommand,
    ) -> Result<AdapterDispatchReport, DispatchFailure> {
        if command.operation != summon::OPERATION {
            return self.core.dispatch(id, command);
        }
        Summon::parse(command.arguments.clone())?;
        // A work ID shares the already unique command UUID, but no document lane.
        self.pending.insert(id);
        Ok(AdapterDispatchReport {
            disposition: AdapterDisposition::Pending(WorkRequest {
                work_id: id,
                command_id: id,
                kind: summon::OPERATION.into(),
                input: command.arguments,
                fence: None,
            }),
            changes: vec![],
            shutdown_persistence: None,
        })
    }
    fn dispatch_guarded(
        &mut self,
        id: CommandId,
        fence: TargetFence,
        command: KernelCommand,
    ) -> Result<AdapterDispatchReport, DispatchFailure> {
        if command.operation == summon::OPERATION {
            return Err(summon::invalid(
                "seat.summon accepts no fence or document_id",
            ));
        }
        self.core.dispatch_guarded(id, fence, command)
    }
    fn start_work(
        &mut self,
        work: WorkRequest,
        completion: Sender<WorkCompletion>,
        executor: &dyn WorkExecutor,
    ) -> Result<(), ExecutorFailure> {
        if work.kind != summon::OPERATION {
            return self.core.start_work(work, completion, executor);
        }
        let args = Summon::parse(work.input).map_err(|e| ExecutorFailure {
            code: e.code,
            message: e.message,
        })?;
        let api = self.api.clone();
        std::thread::spawn(move || {
            let _ = completion.send(WorkCompletion {
                work_id: work.work_id,
                command_id: work.command_id,
                result: args.run(&api),
            });
        });
        Ok(())
    }
    fn complete_work(
        &mut self,
        completion: WorkCompletion,
    ) -> Result<AdapterDispatchReport, DispatchFailure> {
        if !self.pending.remove(&completion.work_id) {
            return self.core.complete_work(completion);
        }
        Ok(complete(match completion.result {
            Ok(value) => CommandOutcome::Succeeded { value },
            Err(failure) => CommandOutcome::Refused { failure },
        }))
    }
    fn cancel_work(&mut self, work: WorkId) -> Result<AdapterCancelReport, DispatchFailure> {
        if !self.pending.remove(&work) {
            return self.core.cancel_work(work);
        }
        Ok(AdapterCancelReport {
            disposition: AdapterCancelDisposition::Suppressed,
            changes: vec![],
        })
    }
    fn poll_changes(&mut self) -> Result<AdapterPollReport, DispatchFailure> {
        self.core.poll_changes()
    }
    fn snapshot(&mut self) -> Result<AdapterSnapshot, DispatchFailure> {
        self.core.snapshot()
    }
    fn shutdown(&mut self) -> Result<Vec<AdapterChange>, DispatchFailure> {
        self.core.shutdown()
    }
}
