//! HRC owner operations compose around Cardo's protocol adapter. Each
//! admitted op runs on tokio's blocking pool and completes through the
//! adapter's completion channel (T-12067 §8.1 item 4).
use cardo_runtime::service::*;
use crossbeam_channel::Sender;
use hrc_domain::{
    annotation::{self, AnnotationAct, AnnotationDelete, AnnotationPut},
    owner::OwnerCall,
    restart::{self, Restart},
    send::{self, SeatSend},
    summon::{self, Summon},
};
use serde_json::json;
use std::{collections::BTreeSet, sync::Arc};

fn owner_operation(operation: &str) -> bool {
    matches!(
        operation,
        summon::OPERATION
            | restart::OPERATION
            | send::OPERATION
            | annotation::PUT
            | annotation::ACT
            | annotation::DELETE
    )
}

pub struct HrcAdapter {
    pub core: cardo_runtime::core_adapter::CoreAdapter<cardo_core::document::CoreDomain>,
    pub owner: Arc<dyn OwnerCall>,
    pub pending: BTreeSet<WorkId>,
    pub runtime: tokio::runtime::Handle,
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
        if owner_operation(&command.operation) {
            None
        } else {
            self.core.idempotency(command)
        }
    }
    fn cancelled_command_outcome(&self) -> CommandOutcome {
        // Cancellation cannot roll back an owner-API mutation.
        CommandOutcome::Unavailable { failure: DispatchFailure {
            code: "cancelled".into(), message: "Work suppressed; the HRC mutation may still complete. Read back the seat before acting; restart must not be retried blindly.".into(), details: json!({}),
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
        if !owner_operation(&command.operation) {
            return self.core.dispatch(id, command);
        }
        match command.operation.as_str() {
            restart::OPERATION => {
                Restart::parse(command.arguments.clone())?;
            }
            send::OPERATION => {
                SeatSend::parse(command.arguments.clone())?;
            }
            annotation::PUT => {
                AnnotationPut::parse(command.arguments.clone())?;
            }
            annotation::ACT => {
                AnnotationAct::parse(command.arguments.clone())?;
            }
            annotation::DELETE => {
                AnnotationDelete::parse(command.arguments.clone())?;
            }
            _ => {
                Summon::parse(command.arguments.clone())?;
            }
        }
        // A work ID shares the already unique command UUID, but no document lane.
        self.pending.insert(id);
        Ok(AdapterDispatchReport {
            disposition: AdapterDisposition::Pending(WorkRequest {
                work_id: id,
                command_id: id,
                kind: command.operation,
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
        if owner_operation(&command.operation) {
            return Err(summon::invalid(
                "seat owner operations accept no fence or document_id",
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
        if !owner_operation(&work.kind) {
            return self.core.start_work(work, completion, executor);
        }
        let owner = self.owner.clone();
        let refused = |e: DispatchFailure| ExecutorFailure {
            code: e.code,
            message: e.message,
        };
        let run: Box<dyn FnOnce() -> Result<serde_json::Value, DispatchFailure> + Send> =
            if work.kind == restart::OPERATION {
                let args = Restart::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            } else if work.kind == send::OPERATION {
                let args = SeatSend::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            } else if work.kind == annotation::PUT {
                let args = AnnotationPut::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            } else if work.kind == annotation::ACT {
                let args = AnnotationAct::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            } else if work.kind == annotation::DELETE {
                let args = AnnotationDelete::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            } else {
                let args = Summon::parse(work.input).map_err(refused)?;
                Box::new(move || args.run(owner.as_ref()))
            };
        self.runtime.spawn_blocking(move || {
            let _ = completion.send(WorkCompletion {
                work_id: work.work_id,
                command_id: work.command_id,
                result: run(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use cardo_host::HostDefault;
    use hrc_domain::{HrcError, owner::OwnerReply};
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    struct Routed(AtomicUsize);
    impl OwnerCall for Routed {
        fn call(
            &self,
            _: &str,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> Result<OwnerReply, HrcError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(HrcError::new("routing_probe", "owner reached"))
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn all_six_operations_reach_owner_without_core_worker() {
        let mut core = cardo_runtime::core_adapter::CoreAdapter::new(
            || cardo_core::document::CoreDomain,
            |_| Err(cardo_core::Refusal::invalid("edit_rejected", "no edits")),
            Duration::from_secs(60),
        );
        core.in_process_worker("hrc", || Box::new(super::super::AdapterRouted));
        let owner = Arc::new(Routed(AtomicUsize::new(0)));
        let runtime = RuntimeOwner::start(
            HrcAdapter {
                core,
                owner: owner.clone(),
                pending: Default::default(),
                runtime: tokio::runtime::Handle::current(),
            },
            Arc::new(cardo_host::NoWork),
            Box::new(cardo_host::Idle),
            RuntimeConfig::host_default(),
        );
        let client = runtime.client(ClientRole::Tui);
        tokio::task::spawn_blocking(move || {
            cardo_host::send(&client, "registry.enable", hrc_domain::declarations::declarations()).unwrap();
            let seat = "agent:probe:project:hrc-runtime:task:T-12360/lane:main";
            for (name, args) in [
                (summon::OPERATION, json!({"session_ref":seat,"request_id":"probe"})),
                (restart::OPERATION, json!({"host_session_id":"host","expected_generation":1})),
                (send::OPERATION, json!({"session_ref":seat,"host_session_id":"host","expected_generation":1,"text":"probe"})),
                (annotation::PUT, json!({"session_ref":seat,"subject":"seat","ns":"probe","kind":"card","id":"one","body":{}})),
                (annotation::ACT, json!({"session_ref":seat,"subject":"seat","ns":"probe","kind":"card","id":"one","action":"sent"})),
                (annotation::DELETE, json!({"session_ref":seat,"subject":"seat","ns":"probe","kind":"card","id":"one"})),
            ] {
                let reply = cardo_host::send(&client, name, args).expect_err("probe owner refuses");
                assert!(format!("{reply:?}").contains("routing_probe"), "{name}: {reply:?}");
            }
        }).await.unwrap();
        assert_eq!(owner.0.load(Ordering::SeqCst), 6);
        cardo_runtime_tokio::join(runtime).await.unwrap();
    }
}
