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
    pub owner_waker: Option<OwnerWaker>,
}

fn complete(outcome: CommandOutcome) -> AdapterDispatchReport {
    AdapterDispatchReport {
        disposition: AdapterDisposition::Complete(outcome),
        changes: vec![],
        shutdown_persistence: None,
    }
}

impl DispatchAdapter for HrcAdapter {
    fn set_owner_waker(&mut self, waker: OwnerWaker) {
        self.owner_waker = Some(waker.clone());
        self.core.set_owner_waker(waker);
    }
    fn next_deadline(&self) -> Option<std::time::Instant> {
        self.core.next_deadline()
    }
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
        let waker = self.owner_waker.clone();
        self.runtime.spawn_blocking(move || {
            let _ = completion.send(WorkCompletion {
                work_id: work.work_id,
                command_id: work.command_id,
                result: run(),
            });
            if let Some(waker) = waker {
                waker.wake();
            }
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

    // Failure modes: the wrapper swallows CoreAdapter's waker (a completed
    // ingest waits for the 1 s safety tick), or its deadline (scheduled ingest
    // waits for that tick). No other request may substitute for the wake.
    struct GatedIngest(crossbeam_channel::Receiver<()>);
    impl cardo_runtime::core_adapter::WorkerCall for GatedIngest {
        fn call(
            &mut self,
            _: &str,
            _: serde_json::Value,
            _: Duration,
        ) -> Result<serde_json::Value, DispatchFailure> {
            self.0.recv().unwrap();
            Ok(json!({"cursor": 1, "edits": [], "more": false}))
        }
        fn shutdown(&mut self) {}
    }

    fn ingest_declarations() -> serde_json::Value {
        json!({
            "provider":"probe", "version":"1",
            "node_families":[{"name":"probe.fact","domain_attributes":{
                "kind":"object","fields":{"source":{"kind":"string","nonblank":true}},
                "required":["source"]}}],
            "node_types":[{
                "name":"probe.fact", "schema_version":1, "family":"probe.fact", "root":true,
                "validate":false, "natural_key":["key"], "observation":true,
                "payload":{"kind":"object","required":["key"],
                           "fields":{"key":{"kind":"string"}}}
            }], "operations":[{
                "name":"probe.read", "kind":"ingest", "writes":["probe.fact"],
                "input":{"kind":"object","fields":{}},
                "output":{"kind":"object","fields":{}}
            }]
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn embedded_adapter_forwards_ingest_deadline() {
        let mut adapter = HrcAdapter {
            core: cardo_runtime::core_adapter::CoreAdapter::new(
                || cardo_core::document::CoreDomain,
                |_| Err(cardo_core::Refusal::invalid("edit_rejected", "no edits")),
                Duration::from_secs(60),
            ),
            owner: Arc::new(Routed(AtomicUsize::new(0))),
            pending: Default::default(),
            runtime: tokio::runtime::Handle::current(),
            owner_waker: None,
        };
        let (release, gate) = crossbeam_channel::unbounded();
        release.send(()).unwrap();
        adapter
            .core
            .in_process_worker("probe", move || Box::new(GatedIngest(gate.clone())));
        for (operation, arguments) in [
            ("registry.enable", ingest_declarations()),
            (
                "document.open",
                json!({"document_id":"probe", "durability":{"mode":"explicit_save"}}),
            ),
            (
                "ingest.attach",
                json!({"document_id":"probe", "binding":"probe", "operation":"probe.read", "config":{}}),
            ),
        ] {
            adapter
                .dispatch(
                    uuid::Uuid::new_v4(),
                    KernelCommand {
                        operation: operation.into(),
                        arguments,
                        persistence: None,
                        cause: None,
                    },
                )
                .unwrap();
        }
        let started = std::time::Instant::now();
        while adapter.core.next_deadline().is_none() {
            adapter.poll_changes().unwrap();
            assert!(started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(1));
        }
        let deadline = adapter
            .core
            .next_deadline()
            .expect("settled binding has a safety deadline");
        assert_eq!(adapter.next_deadline(), Some(deadline));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ingest_completion_wakes_embedded_owner_before_safety_tick() {
        let mut core = cardo_runtime::core_adapter::CoreAdapter::new(
            || cardo_core::document::CoreDomain,
            |_| Err(cardo_core::Refusal::invalid("edit_rejected", "no edits")),
            Duration::from_secs(60),
        );
        let (release, gate) = crossbeam_channel::unbounded();
        core.in_process_worker("probe", move || Box::new(GatedIngest(gate.clone())));
        let runtime = RuntimeOwner::start(
            HrcAdapter {
                core,
                owner: Arc::new(Routed(AtomicUsize::new(0))),
                pending: Default::default(),
                runtime: tokio::runtime::Handle::current(),
                owner_waker: None,
            },
            Arc::new(cardo_host::NoWork),
            Box::new(cardo_host::Idle),
            RuntimeConfig::host_default(),
        );
        let client = runtime.client(ClientRole::Tui);
        let elapsed = tokio::task::spawn_blocking(move || {
            cardo_host::send(&client, "registry.enable", ingest_declarations()).unwrap();
            cardo_host::send(
                &client,
                "document.open",
                json!({
                    "document_id":"probe", "durability":{"mode":"explicit_save"}
                }),
            )
            .unwrap();
            cardo_host::send(
                &client,
                "ingest.attach",
                json!({
                    "document_id":"probe", "binding":"probe", "operation":"probe.read",
                    "config":{}, "interval_ms":60000
                }),
            )
            .unwrap();
            // ingest.attach starts the worker. Hold its answer until the
            // owner has parked, then release it without another command.
            std::thread::sleep(Duration::from_millis(50));
            let started = std::time::Instant::now();
            release.send(()).unwrap();
            loop {
                let status = cardo_host::send(
                    &client,
                    "ingest.status",
                    json!({
                        "document_id":"probe"
                    }),
                )
                .unwrap();
                if status["bindings"][0]["cursor"] == json!(1) {
                    break;
                }
                assert!(started.elapsed() < Duration::from_secs(3), "{status}");
                std::thread::sleep(Duration::from_millis(5));
            }
            started.elapsed()
        })
        .await
        .unwrap();
        cardo_runtime_tokio::join(runtime).await.unwrap();
        eprintln!(
            "embedded_ingest_commit_ms={:.3}",
            elapsed.as_secs_f64() * 1000.0
        );
        assert!(
            elapsed < Duration::from_millis(200),
            "ingest commit waited {elapsed:?}"
        );
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
                owner_waker: None,
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
