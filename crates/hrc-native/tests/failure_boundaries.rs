//! Explicit isolated source compositions. Seeded Store rows are test input, never native birth proof.
use hrc_native::{
    admission::TurnGate,
    authority::{AuthorityAcquire, AuthorityCoordinator, AuthorityPermit},
    config::{AgentScope, NativeConfig, NativePaths, NodeIdentity},
    credentials::CredentialStore,
    lifecycle::{
        CallerPresentation, EffectIdentity, GateProgress, LifecycleAuthority, LifecycleFence,
        LifecycleOperation, LifecycleRequest, LocalAuthorityContext, PeerAttestation,
    },
};
use hrc_store::*;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fs,
    future::Future,
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    rc::Rc,
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};
const PRIMARY: &str = "agent:mable:project:hrc-runtime:task:primary";
fn root() -> PathBuf {
    let p = PathBuf::from(std::env::var("HRC_P2_SCRATCH").expect("explicit isolated scratch"));
    assert!(p.is_absolute() && p.to_string_lossy().starts_with("/tmp/hrcp1-"));
    p
}
fn area(name: &str) -> PathBuf {
    let p = root().join(name);
    assert!(!p.exists(), "fresh case area required: {}", p.display());
    fs::create_dir(&p).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
    p
}
fn record(name: &str, value: Value) {
    let dir = PathBuf::from(std::env::var("HRC_P2_EVIDENCE").expect("explicit evidence DIRECTORY"));
    assert!(dir.is_absolute() && dir.is_dir());
    let p = dir.join(format!("{name}.json"));
    assert!(!p.exists(), "never overwrite an earlier receipt");
    fs::write(&p, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    fs::set_permissions(p, fs::Permissions::from_mode(0o600)).unwrap();
}
fn poll<F: Future + Unpin>(v: &mut F) -> Poll<F::Output> {
    std::pin::Pin::new(v).poll(&mut Context::from_waker(Waker::noop()))
}
fn refused<T>(v: hrc_native::error::Result<T>) -> Value {
    match v {
        Err(e) => e.envelope(),
        Ok(_) => panic!("expected refusal"),
    }
}
fn step(
    a: &AuthorityCoordinator,
    f: &mut AuthorityAcquire,
    label: &str,
    trace: &mut Vec<Value>,
) -> Option<AuthorityPermit> {
    match poll(f) {
        Poll::Pending => {
            trace.push(json!({"step":label,"poll":"pending","outstanding":a.outstanding()}));
            None
        }
        Poll::Ready(Ok(p)) => {
            trace.push(json!({"step":label,"poll":"ready","outstanding":a.outstanding()}));
            Some(p)
        }
        Poll::Ready(Err(e)) => panic!("unexpected {}: {}", label, e),
    }
}
struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
#[ignore = "child of abrupt_gate_recovery only"]
fn gate_child() {
    let mode = std::env::var("HRC_P2_CHILD_MODE").expect("parent-only child mode");
    let p = root().join("r01");
    let gate = TurnGate::load(&p);
    if mode == "close" {
        gate.close(
            "r01-killed",
            Some(PRIMARY.into()),
            None,
            Some("abrupt recovery composition".into()),
        )
        .unwrap();
        fs::write(p.join("child-ready.tmp"),serde_json::to_vec(&json!({"pid":std::process::id(),"snapshot":gate.snapshot(),"marker":fs::read_to_string(p.join("turn-admission.json")).unwrap()})).unwrap()).unwrap();
        fs::set_permissions(p.join("child-ready.tmp"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(p.join("child-ready.tmp"), p.join("child-ready.json")).unwrap();
        loop {
            std::thread::park();
        }
    }
    assert_eq!(mode, "reload");
    assert_eq!(gate.snapshot().state, "closed");
    let fresh = refused(gate.admit(false));
    assert_eq!(fresh["error"]["code"], "server_draining");
    let accepted = gate.admit(true).unwrap();
    let wrong = refused(gate.reopen(Some("different")));
    assert_eq!(wrong["error"]["code"], "stale_context");
    drop(accepted);
    let recovered = gate.snapshot();
    gate.reopen(Some("r01-killed")).unwrap();
    assert_eq!(TurnGate::load(&p).snapshot().state, "open");
    fs::write(p.join("reloaded.json"),serde_json::to_vec(&json!({"pid":std::process::id(),"closed":recovered,"fresh":fresh,"wrong":wrong,"open":gate.snapshot()})).unwrap()).unwrap();
    fs::set_permissions(p.join("reloaded.json"), fs::Permissions::from_mode(0o600)).unwrap();
}
#[test]
#[ignore = "requires explicit isolated scratch/evidence; kills only its own test child"]
fn abrupt_gate_recovery() {
    let p = area("r01");
    assert_eq!(TurnGate::load(&p).snapshot().state, "open");
    let exe = std::env::current_exe().unwrap();
    let launch = |mode: &str| {
        Command::new(&exe)
            .args(["--exact", "gate_child", "--ignored", "--nocapture"])
            .env("HRC_P2_CHILD_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut child = Guard(launch("close"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !p.join("child-ready.json").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "child exited before close receipt"
        );
        assert!(Instant::now() < deadline, "child close timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
    let ready: Value =
        serde_json::from_slice(&fs::read(p.join("child-ready.json")).unwrap()).unwrap();
    assert_eq!(ready["pid"], child.0.id());
    child.0.kill().unwrap();
    let killed = child.0.wait().unwrap();
    assert_eq!(killed.signal(), Some(9));
    let mut reload = Guard(launch("reload"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = reload.0.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "fresh reload child timed out");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(status.success());
    let after: Value = serde_json::from_slice(&fs::read(p.join("reloaded.json")).unwrap()).unwrap();
    assert!(!p.join("turn-admission.json").exists());
    record(
        "r01",
        json!({"executable":exe,"args":["--exact","gate_child","--ignored","--nocapture"],"ready":ready,"killedSignal":killed.signal(),"reloadExit":status.code(),"after":after}),
    );
}
#[test]
#[ignore = "explicit source ownership composition"]
fn ownership_cancellation() {
    let a = AuthorityCoordinator::default();
    let mut trace = vec![];
    let mut c1 = a.claim("mable", "hrc-runtime").unwrap();
    let p1 = step(&a, &mut c1, "claim-first-before-runtime", &mut trace).unwrap();
    let mut c2 = a.claim("mable", "hrc-runtime").unwrap();
    assert!(step(&a, &mut c2, "same-claim-blocked", &mut trace).is_none());
    let mut other = a.claim("mable", "other").unwrap();
    drop(step(&a, &mut other, "other-project", &mut trace).unwrap());
    drop(p1);
    drop(c2); // granted but never polled: must release registration
    let mut c3 = a.claim("mable", "hrc-runtime").unwrap();
    drop(step(&a, &mut c3, "after-unpolled-cancel", &mut trace).unwrap());
    let mut s1 = a.summon(PRIMARY).unwrap();
    let p = step(&a, &mut s1, "summon", &mut trace).unwrap();
    let mut writer = a.retire(PRIMARY).unwrap();
    assert!(step(&a, &mut writer, "retire-waits", &mut trace).is_none());
    let mut s2 = a.summon(PRIMARY).unwrap();
    assert!(step(&a, &mut s2, "later-reader-waits", &mut trace).is_none());
    drop(p);
    let w = step(&a, &mut writer, "retire-first", &mut trace).unwrap();
    assert!(step(&a, &mut s2, "reader-still-waits", &mut trace).is_none());
    drop(w);
    let p = step(&a, &mut s2, "reader-after-writer", &mut trace).unwrap();
    let mut cancelled = a.retire(PRIMARY).unwrap();
    assert!(step(&a, &mut cancelled, "queued-writer", &mut trace).is_none());
    let mut next = a.summon(PRIMARY).unwrap();
    assert!(step(&a, &mut next, "reader-behind-cancelled", &mut trace).is_none());
    drop(cancelled);
    drop(step(&a, &mut next, "reader-unwedged", &mut trace).unwrap());
    drop(p);
    let mut m = a.mint(PRIMARY, "main").unwrap();
    let mut pm = step(&a, &mut m, "mint-main", &mut trace).unwrap();
    let mut same = a.mint(PRIMARY, "main").unwrap();
    assert!(step(&a, &mut same, "mint-same-pending", &mut trace).is_none());
    let mut lane = a.mint(PRIMARY, "other").unwrap();
    drop(step(&a, &mut lane, "mint-other-lane", &mut trace).unwrap());
    a.close();
    let closed = match poll(&mut same) {
        Poll::Ready(Err(e)) => e.envelope(),
        _ => panic!("pending not refused on close"),
    };
    assert_eq!(closed["error"]["code"], "server_draining");
    let new = refused(a.summon(PRIMARY));
    pm.release();
    pm.release();
    assert_eq!(a.outstanding(), 0);
    trace.push(
        json!({"step":"closed","pendingError":closed,"newError":new,"outstanding":a.outstanding()}),
    );
    record(
        "r02",
        json!({"scope":PRIMARY,"claimKey":["mable","hrc-runtime"],"trace":trace}),
    );
}
fn open() -> Store {
    Store::open_existing(
        root().join("state.sqlite"),
        OpenOptions {
            mode: OpenMode::ReadWrite,
            ..Default::default()
        },
    )
    .unwrap()
}
// Direct validation of supplied attestation; this is NOT authenticated P5 ingress.
fn stage(a: &mut LifecycleAuthority, body: Value) -> hrc_native::error::Result<LifecycleOperation> {
    a.authorize_peer(
        LifecycleRequest::parse(&body)?,
        PeerAttestation {
            authenticated_node: "max3",
            origin_node: "max3",
            requested_by: PRIMARY,
            caller_kind: "mable-primary",
            request_id: "boundary-request",
        },
        &NodeIdentity {
            node_id: "max3".into(),
            declared: true,
        },
        true,
    )
}
#[test]
#[ignore = "requires fresh canonical seeded Store and evidence directory"]
fn lifecycle_cancellation() {
    let p = area("r06");
    let gate = TurnGate::load(&p);
    let mut store = open();
    let mut a = LifecycleAuthority::default();
    let now = Instant::now();
    let mut trace = vec![];
    let lease = gate.admit(false).unwrap();
    let body = json!({"action":"restart","reason":"composition","drain":true,"drainTimeoutMs":10});
    let mut old = stage(&mut a, body.clone()).unwrap();
    assert!(matches!(
        old.poll_gate(&mut store, &gate, now).unwrap(),
        GateProgress::Waiting { .. }
    ));
    trace.push(
        json!({"step":"drain-wait","gate":gate.snapshot(),"grantError":refused(old.grant())}),
    );
    let busy = refused(stage(&mut a, body.clone()));
    assert_eq!(busy["error"]["detail"]["refusal"], "lifecycle_in_progress");
    let marker = p.join("turn-admission.json");
    let bytes = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    fs::create_dir(&marker).unwrap();
    let cancel_error = refused(old.cancel());
    assert_eq!(gate.snapshot().state, "closed");
    assert_eq!(
        refused(stage(&mut a, body.clone()))["error"]["detail"]["refusal"],
        "lifecycle_in_progress"
    );
    trace.push(json!({"step":"cancel-remove-failure","error":cancel_error,"gate":gate.snapshot()}));
    fs::remove_dir(&marker).unwrap();
    fs::write(&marker, &bytes).unwrap();
    old.cancel().unwrap();
    old.cancel().unwrap();
    assert_eq!(gate.snapshot().state, "open");
    let mut next = stage(&mut a, body.clone()).unwrap();
    drop(old);
    assert_eq!(
        refused(stage(&mut a, body.clone()))["error"]["detail"]["refusal"],
        "lifecycle_in_progress"
    );
    assert!(matches!(
        next.poll_gate(&mut store, &gate, now).unwrap(),
        GateProgress::Waiting { .. }
    ));
    let result = next
        .poll_gate(&mut store, &gate, now + Duration::from_millis(10))
        .unwrap();
    assert!(matches!(result, GateProgress::Ready { .. }));
    assert_eq!(gate.snapshot().state, "closed");
    assert!(!next.may_execute(now + Duration::from_secs(1)));
    next.acknowledge(now).unwrap();
    next.acknowledge(now + Duration::from_millis(100)).unwrap();
    let at149 = next.may_execute(now + Duration::from_millis(149));
    let at150 = next.may_execute(now + Duration::from_millis(150));
    assert!(!at149);
    assert!(at150);
    let ack_cancel = refused(next.cancel());
    trace.push(json!({"step":"drain-deadline-staged","offsetMs":10,"progress":format!("{result:?}"),"grant":next.grant().unwrap(),"gate":gate.snapshot(),"ackCancel":ack_cancel,"mayExecute149":at149,"mayExecute150":at150}));
    drop(next);
    assert_eq!(TurnGate::load(&p).snapshot().state, "closed");
    drop(lease);
    record(
        "r06",
        json!({"stagedOnly":true,"executorInvocations":0,"busy":busy,"trace":trace,"afterDrop":TurnGate::load(&p).snapshot()}),
    );
    store.close().unwrap();
}
fn boundary(store: &mut Store, host: &str, scope: &str, lane: &str, runtime: &str) -> Value {
    store.read_snapshot(|tx|Ok(json!({"host":tx.sessions().get_by_host_session_id(host)?,"continuity":tx.continuities().get_by_key(scope,lane)?,"runtime":tx.runtime_by_id(runtime)?}))).unwrap()
}
#[test]
#[ignore = "requires fresh canonical seeded Store and evidence directory"]
fn effect_tuple_fences() {
    let mut store = open();
    let mut host = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))
        .unwrap()
        .unwrap();
    host.host_session_id = "boundary-host".into();
    host.status = "active".into();
    host.generation += 1;
    let mut runtime = store
        .read_snapshot(|tx| tx.runtime_by_id("p1-runtime"))
        .unwrap()
        .unwrap();
    runtime.runtime_id = "boundary-runtime".into();
    runtime.host_session_id = host.host_session_id.clone();
    runtime.scope_ref = host.scope_ref.clone();
    runtime.lane_ref = host.lane_ref.clone();
    runtime.generation = host.generation;
    runtime.status = "ready".into();
    runtime.active_run_id = None;
    runtime.active_operation_id = Some("boundary-op".into());
    runtime.active_invocation_id = Some("boundary-inv".into());
    store
        .write(|tx| {
            tx.insert_session(&host)?;
            tx.upsert_continuity(
                &host.scope_ref,
                &host.lane_ref,
                &host.host_session_id,
                &host.created_at,
            )?;
            tx.insert_runtime(&runtime)
        })
        .unwrap();
    let hints = Rc::new(RefCell::new(Vec::<String>::new()));
    let queue = hints.clone();
    store.observe(move |h| queue.borrow_mut().push(format!("{h:?}")));
    let fence = LifecycleFence::default();
    fence.begin_recovery().unwrap();
    fence.mark_serving().unwrap();
    let identity = EffectIdentity {
        scope_ref: host.scope_ref.clone(),
        lane_ref: host.lane_ref.clone(),
        host_session_id: host.host_session_id.clone(),
        generation: host.generation,
        runtime_id: Some(runtime.runtime_id.clone()),
        operation_id: runtime.active_operation_id.clone(),
        invocation_id: runtime.active_invocation_id.clone(),
    };
    let calls = Cell::new(0);
    let mut trace = vec![];
    let before = boundary(
        &mut store,
        &host.host_session_id,
        &host.scope_ref,
        &host.lane_ref,
        &runtime.runtime_id,
    );
    let rollback = fence
        .begin_effect(identity.clone())
        .unwrap()
        .apply(&mut store, |tx| {
            calls.set(calls.get() + 1);
            tx.update_runtime_status(&runtime.runtime_id, "busy", "2026-10-23T00:01:00.000Z")?;
            Err::<(), _>(StoreError::Invalid("boundary rollback".into()))
        });
    assert!(rollback.is_err());
    let after = boundary(
        &mut store,
        &host.host_session_id,
        &host.scope_ref,
        &host.lane_ref,
        &runtime.runtime_id,
    );
    assert_eq!(before, after);
    assert!(hints.borrow().is_empty());
    assert_eq!(calls.get(), 1);
    trace.push(json!({"step":"rollback","before":before,"after":after,"closureCalls":calls.get(),"hints":hints.borrow().clone()}));
    let committed = fence
        .begin_effect(identity.clone())
        .unwrap()
        .apply(&mut store, |tx| {
            calls.set(calls.get() + 1);
            tx.update_runtime_status(&runtime.runtime_id, "busy", "2026-10-23T00:02:00.000Z")
        })
        .unwrap();
    assert!(!committed.changes.is_empty());
    assert!(!hints.borrow().is_empty());
    trace.push(json!({"step":"commit","closureCalls":calls.get(),"changes":committed.changes,"after":boundary(&mut store,&host.host_session_id,&host.scope_ref,&host.lane_ref,&runtime.runtime_id),"hints":hints.borrow().clone()}));
    for kind in [
        "operation",
        "invocation",
        "generation",
        "terminal",
        "continuity",
    ] {
        let ticket = fence.begin_effect(identity.clone()).unwrap();
        store
            .write(|tx| {
                let patch = RuntimePatch {
                    active_operation_id: if kind == "operation" {
                        Patch::Set("other-op".into())
                    } else {
                        Patch::Set("boundary-op".into())
                    },
                    active_invocation_id: if kind == "invocation" {
                        Patch::Set("other-inv".into())
                    } else {
                        Patch::Set("boundary-inv".into())
                    },
                    generation: Patch::Set(if kind == "generation" {
                        host.generation + 1
                    } else {
                        host.generation
                    }),
                    status: Patch::Set(if kind == "terminal" {
                        "dead".into()
                    } else {
                        "ready".into()
                    }),
                    ..Default::default()
                };
                tx.update_runtime(&runtime.runtime_id, &patch)?;
                if kind == "continuity" {
                    tx.upsert_continuity(
                        &host.scope_ref,
                        &host.lane_ref,
                        "p1-host",
                        &host.created_at,
                    )?;
                }
                Ok(())
            })
            .unwrap();
        hints.borrow_mut().clear();
        let before = boundary(
            &mut store,
            &host.host_session_id,
            &host.scope_ref,
            &host.lane_ref,
            &runtime.runtime_id,
        );
        let count = calls.get();
        let error = refused(ticket.apply(&mut store, |tx| {
            calls.set(calls.get() + 1);
            tx.update_runtime_status(&runtime.runtime_id, "stopping", "2026-10-23T00:03:00.000Z")
        }));
        let after = boundary(
            &mut store,
            &host.host_session_id,
            &host.scope_ref,
            &host.lane_ref,
            &runtime.runtime_id,
        );
        assert_eq!(before, after);
        assert_eq!(count, calls.get());
        assert!(hints.borrow().is_empty());
        trace.push(json!({"step":kind,"identity":{"scope":identity.scope_ref,"lane":identity.lane_ref,"host":identity.host_session_id,"generation":identity.generation,"runtime":identity.runtime_id,"operation":identity.operation_id,"invocation":identity.invocation_id},"before":before,"after":after,"error":error,"closureCallsBefore":count,"closureCallsAfter":calls.get(),"hints":hints.borrow().clone()}));
    }
    store
        .write(|tx| {
            tx.upsert_continuity(
                &host.scope_ref,
                &host.lane_ref,
                &host.host_session_id,
                &host.created_at,
            )?;
            tx.update_runtime(
                &runtime.runtime_id,
                &RuntimePatch {
                    generation: Patch::Set(host.generation),
                    status: Patch::Set("ready".into()),
                    active_operation_id: Patch::Set("boundary-op".into()),
                    active_invocation_id: Patch::Set("boundary-inv".into()),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    hints.borrow_mut().clear();
    let stop_before = boundary(
        &mut store,
        &host.host_session_id,
        &host.scope_ref,
        &host.lane_ref,
        &runtime.runtime_id,
    );
    let late = fence.begin_effect(identity.clone()).unwrap();
    fence.begin_stop();
    fence.begin_stop();
    assert!(!fence.may_attest_stopped());
    let count = calls.get();
    let error = refused(late.apply(&mut store, |_| {
        calls.set(calls.get() + 1);
        Ok(())
    }));
    assert_eq!(count, calls.get());
    assert_eq!(fence.outstanding(), 0);
    assert!(fence.may_attest_stopped());
    let stop_after = boundary(
        &mut store,
        &host.host_session_id,
        &host.scope_ref,
        &host.lane_ref,
        &runtime.runtime_id,
    );
    assert_eq!(stop_before, stop_after);
    assert!(hints.borrow().is_empty());
    let stopped = refused(fence.begin_effect(identity));
    fence.mark_deadline_expired();
    assert!(!fence.may_attest_stopped());
    let incomplete = LifecycleFence::default();
    incomplete.begin_stop();
    incomplete.note_incomplete("owned effect cleanup failed");
    assert!(!incomplete.may_attest_stopped());
    trace.push(json!({"step":"stop","before":stop_before,"after":stop_after,"hints":hints.borrow().clone(),"lateError":error,"newError":stopped,"closureCalls":calls.get(),"outstanding":fence.outstanding(),"phase":format!("{:?}",fence.phase()),"deadlineAttest":fence.may_attest_stopped(),"incompleteAttest":incomplete.may_attest_stopped()}));
    record("r07", json!({"seededStateOnly":true,"trace":trace}));
    store.close().unwrap();
}
struct Fixture {
    store: Store,
    runtime: RuntimeRecord,
    credentials: CredentialStore,
    secret: String,
    node: NodeIdentity,
    peers: std::collections::BTreeSet<String>,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let p = area(label);
        let mut store = open();
        let mut runtime = store
            .read_snapshot(|tx| tx.runtime_by_id("p1-runtime"))
            .unwrap()
            .unwrap();
        runtime.runtime_id = format!("{label}-mable");
        runtime.scope_ref = PRIMARY.into();
        runtime.status = "ready".into();
        runtime.active_run_id = None;
        runtime.active_operation_id = None;
        runtime.active_invocation_id = None;
        let runtime = store.write(|tx| tx.insert_runtime(&runtime)).unwrap().value;
        let mut credentials = CredentialStore::new(&p);
        credentials.observe(&runtime).unwrap();
        let secret =
            fs::read_to_string(credentials.credential_path(&runtime.runtime_id).unwrap()).unwrap();
        Self {
            store,
            runtime,
            credentials,
            secret: secret.trim().into(),
            node: NodeIdentity {
                node_id: "max3".into(),
                declared: true,
            },
            peers: Default::default(),
        }
    }
    fn authorize(
        &mut self,
        a: &mut LifecycleAuthority,
        body: Value,
        caller: CallerPresentation<'_>,
        executor: bool,
    ) -> hrc_native::error::Result<LifecycleOperation> {
        a.authorize_local(
            LifecycleRequest::parse(&body)?,
            caller,
            LocalAuthorityContext {
                node: &self.node,
                peers: &self.peers,
                credentials: &self.credentials,
                store: &mut self.store,
                executor_available: executor,
            },
        )
    }
}
#[test]
#[ignore = "requires fresh canonical seeded Store and evidence directory"]
fn credential_incarnations() {
    let mut f = Fixture::new("r03");
    let id = &f.runtime.runtime_id;
    let path = f.credentials.credential_path(id).unwrap();
    let mut trace = vec![];
    let binding = f.credentials.verify(id, &f.secret).unwrap();
    let mut fresh = CredentialStore::new(path.parent().unwrap().parent().unwrap());
    assert!(fresh.verify(id, &f.secret).is_none()); // an orphan file grants nothing
    assert!(fresh.reconcile(std::slice::from_ref(&f.runtime)).is_empty());
    let new = fs::read_to_string(&path).unwrap();
    let new = new.trim();
    assert!(f.secret != new, "fresh incarnation reused its secret");
    assert!(fresh.verify(id, &f.secret).is_none());
    assert!(fresh.verify(id, new).is_some());
    trace.push(json!({"step":"fresh-incarnation","oldBinding":binding,"newBinding":fresh.verify(id,new),"oldAcceptedByFresh":false,"newEqualsOld":false,"held":fresh.held_count()}));
    f.store
        .write(|tx| {
            tx.update_runtime(
                id,
                &RuntimePatch {
                    generation: Patch::Set(f.runtime.generation + 1),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    let rebound = f
        .store
        .read_snapshot(|tx| tx.runtime_by_id(id))
        .unwrap()
        .unwrap();
    fresh.observe(&rebound).unwrap();
    let rebound_secret = fs::read_to_string(&path).unwrap();
    assert!(fresh.verify(id, new).is_none());
    assert!(fresh.verify(id, rebound_secret.trim()).is_some());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    f.store
        .write(|tx| {
            tx.update_runtime(
                id,
                &RuntimePatch {
                    generation: Patch::Set(rebound.generation + 1),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    let failed = f
        .store
        .read_snapshot(|tx| tx.runtime_by_id(id))
        .unwrap()
        .unwrap();
    let publication = refused(fresh.observe(&failed));
    assert_eq!(fresh.held_count(), 0);
    assert!(fresh.verify(id, rebound_secret.trim()).is_none());
    trace.push(json!({"step":"failed-rebind","runtime":rebound,"attemptedGeneration":failed.generation,"error":publication,"held":fresh.held_count()}));
    fs::remove_dir(&path).unwrap();
    assert!(!fresh.revoke(id).unwrap());
    assert!(!fresh.revoke(id).unwrap());
    record(
        "r03",
        json!({"trace":trace,"fileExistsAfterRevoke":path.exists()}),
    );
    f.store.close().unwrap();
}
#[test]
#[ignore = "requires fresh canonical seeded Store and evidence directory"]
fn local_authority_refusals() {
    let mut f = Fixture::new("r04");
    let mut a = LifecycleAuthority::default();
    let mut trace = vec![];
    let p = root().join("r04");
    let gate = TurnGate::load(&p);
    let original = f.runtime.clone();
    for (name, scope, node, declared, target, reason, expected) in [
        (
            "ordinary",
            "agent:cody:project:hrc-runtime:task:primary",
            "max3",
            true,
            None,
            Some("case"),
            "not_authorized",
        ),
        (
            "role",
            "agent:mable:project:hrc-runtime:task:primary:role:worker",
            "max3",
            true,
            None,
            Some("case"),
            "not_authorized",
        ),
        (
            "derived-local",
            "agent:mable:project:hrc-runtime:task:minisvc",
            "svc",
            false,
            None,
            Some("case"),
            "not_authorized",
        ),
        (
            "cross-node",
            "agent:mable:project:hrc-runtime:task:minisvc",
            "svc",
            true,
            Some("max3"),
            Some("case"),
            "node_local_cross_node",
        ),
        (
            "unknown-target",
            PRIMARY,
            "max3",
            true,
            Some("unknown"),
            Some("case"),
            "unknown_node",
        ),
        (
            "reason-before-peer",
            PRIMARY,
            "max3",
            true,
            Some("unknown"),
            None,
            "reason_required",
        ),
    ] {
        f.store
            .write(|tx| {
                tx.update_runtime(
                    &original.runtime_id,
                    &RuntimePatch {
                        scope_ref: Patch::Set(scope.into()),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
        f.runtime = f
            .store
            .read_snapshot(|tx| tx.runtime_by_id(&original.runtime_id))
            .unwrap()
            .unwrap();
        f.credentials.observe(&f.runtime).unwrap();
        let secret = fs::read_to_string(
            f.credentials
                .credential_path(&f.runtime.runtime_id)
                .unwrap(),
        )
        .unwrap();
        let session = format!("{scope}/lane:main");
        f.node = NodeIdentity {
            node_id: node.into(),
            declared,
        };
        for force in [false, true] {
            let body =
                json!({"action":"restart","targetNode":target,"reason":reason,"force":force});
            let row_before = f
                .store
                .read_snapshot(|tx| tx.runtime_by_id(&original.runtime_id))
                .unwrap();
            let error = refused(f.authorize(
                &mut a,
                body.clone(),
                CallerPresentation {
                    runtime_id: Some(&original.runtime_id),
                    credential: Some(secret.trim()),
                    session_ref: Some(&session),
                },
                true,
            ));
            let row_after = f
                .store
                .read_snapshot(|tx| tx.runtime_by_id(&original.runtime_id))
                .unwrap();
            assert_eq!(
                serde_json::to_value(&row_before).unwrap(),
                serde_json::to_value(&row_after).unwrap()
            );
            assert_eq!(error["error"]["detail"]["refusal"], expected);
            assert_eq!(gate.snapshot().state, "open");
            assert!(!p.join("turn-admission.json").exists());
            trace.push(json!({"case":name,"scope":scope,"node":node,"declared":declared,"request":body,"before":row_before,"after":row_after,"error":error,"gate":gate.snapshot()}));
        }
    }
    f.store
        .write(|tx| {
            tx.update_runtime(
                &original.runtime_id,
                &RuntimePatch {
                    scope_ref: Patch::Set(PRIMARY.into()),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    f.runtime = f
        .store
        .read_snapshot(|tx| tx.runtime_by_id(&original.runtime_id))
        .unwrap()
        .unwrap();
    f.credentials.observe(&f.runtime).unwrap();
    let secret =
        fs::read_to_string(f.credentials.credential_path(&original.runtime_id).unwrap()).unwrap();
    let session = format!("{PRIMARY}/lane:main");
    f.node = NodeIdentity {
        node_id: "max3".into(),
        declared: true,
    };
    for (name, rid, key, session_ref, executor, expected) in [
        ("missing", None, None, None, true, "credential_missing"),
        (
            "bad",
            Some(original.runtime_id.as_str()),
            Some("bad"),
            Some(session.as_str()),
            true,
            "credential_unknown",
        ),
        (
            "mismatch",
            Some(original.runtime_id.as_str()),
            Some(secret.trim()),
            Some("agent:cody/lane:main"),
            true,
            "credential_mismatch",
        ),
        (
            "executor",
            Some(original.runtime_id.as_str()),
            Some(secret.trim()),
            Some(session.as_str()),
            false,
            "executor_unavailable",
        ),
    ] {
        let error = refused(f.authorize(
            &mut a,
            json!({"action":"restart","reason":"case","force":true}),
            CallerPresentation {
                runtime_id: rid,
                credential: key,
                session_ref,
            },
            executor,
        ));
        assert_eq!(error["error"]["detail"]["refusal"], expected);
        trace.push(json!({"case":name,"error":error}));
    }
    let mut operation = f
        .authorize(
            &mut a,
            json!({"action":"restart","reason":"control"}),
            CallerPresentation {
                runtime_id: Some(&original.runtime_id),
                credential: Some(secret.trim()),
                session_ref: Some(&session),
            },
            true,
        )
        .unwrap();
    operation.cancel().unwrap();
    f.store
        .write(|tx| {
            tx.update_runtime_status(&original.runtime_id, "dead", "2026-10-23T00:05:00.000Z")
        })
        .unwrap();
    let revoked = refused(f.authorize(
        &mut a,
        json!({"action":"restart","reason":"case"}),
        CallerPresentation {
            runtime_id: Some(&original.runtime_id),
            credential: Some(secret.trim()),
            session_ref: Some(&session),
        },
        true,
    ));
    assert_eq!(revoked["error"]["detail"]["refusal"], "credential_revoked");
    trace.push(json!({"case":"revoked","error":revoked}));
    record(
        "r04",
        json!({"trace":trace,"executorInvocations":0,"gate":gate.snapshot()}),
    );
    f.store.close().unwrap();
}
#[test]
#[ignore = "direct attestation validation only; no transport authentication"]
fn peer_attestation_refusals() {
    let mut a = LifecycleAuthority::default();
    let node = NodeIdentity {
        node_id: "max3".into(),
        declared: true,
    };
    let mut trace = vec![];
    for (name, authenticated, origin, by, kind, id, target, reason, expected) in [
        (
            "origin",
            "svc",
            "max3",
            PRIMARY,
            "mable-primary",
            "id",
            None,
            Some("case"),
            "attestation_refused",
        ),
        (
            "role",
            "svc",
            "svc",
            "agent:mable:project:hrc-runtime:task:primary:role:worker",
            "mable-primary",
            "id",
            None,
            Some("case"),
            "attestation_refused",
        ),
        (
            "kind",
            "svc",
            "svc",
            PRIMARY,
            "mable-node-local",
            "id",
            None,
            Some("case"),
            "attestation_refused",
        ),
        (
            "target",
            "svc",
            "svc",
            PRIMARY,
            "mable-primary",
            "id",
            Some("svc"),
            Some("case"),
            "attestation_refused",
        ),
        (
            "reason",
            "svc",
            "svc",
            PRIMARY,
            "mable-primary",
            "id",
            None,
            None,
            "reason_required",
        ),
    ] {
        let request = LifecycleRequest::parse(
            &json!({"action":"restart","targetNode":target,"reason":reason}),
        )
        .unwrap();
        let error = refused(a.authorize_peer(
            request,
            PeerAttestation {
                authenticated_node: authenticated,
                origin_node: origin,
                requested_by: by,
                caller_kind: kind,
                request_id: id,
            },
            &node,
            true,
        ));
        assert_eq!(error["error"]["detail"]["refusal"], expected);
        trace.push(json!({"case":name,"authenticatedNodeInput":authenticated,"originNodeInput":origin,"requestedBy":by,"error":error}));
    }
    let request = LifecycleRequest::parse(&json!({"action":"restart","reason":"case"})).unwrap();
    let empty = refused(a.authorize_peer(
        request,
        PeerAttestation {
            authenticated_node: "svc",
            origin_node: "svc",
            requested_by: PRIMARY,
            caller_kind: "mable-primary",
            request_id: " ",
        },
        &node,
        true,
    ));
    assert_eq!(empty["error"]["code"], "malformed_request");
    let mut staged = stage(&mut a, json!({"action":"restart","reason":"control"})).unwrap();
    let busy = refused(stage(&mut a, json!({"action":"restart","reason":"case"})));
    assert_eq!(busy["error"]["detail"]["refusal"], "lifecycle_in_progress");
    staged.cancel().unwrap();
    record(
        "r05",
        json!({"transportAuthenticated":false,"executorInvocations":0,"trace":trace,"emptyId":empty,"concurrent":busy}),
    );
}
#[test]
#[ignore = "explicit pure config and wire-envelope checks"]
fn pure_config_errors() {
    let absent = root().join("r08-absent");
    assert!(!absent.exists());
    let mut config = NativeConfig {
        paths: NativePaths {
            runtime_root: absent.clone(),
            state_root: absent.join("state"),
            socket_path: root().join("r08.sock"),
            lock_path: absent.join("lock"),
            spool_dir: absent.join("spool"),
            db_path: absent.join("state.sqlite"),
            tmux_socket_path: root().join("tmux.sock"),
        },
        node: NodeIdentity {
            node_id: "max3".into(),
            declared: true,
        },
        sqlite_busy_timeout: Duration::from_millis(10),
        local_persona_allowlist: None,
        aspd_socket: None,
    };
    config.validate().unwrap();
    assert!(!absent.exists());
    let mut trace = vec![];
    config.paths.state_root = "relative".into();
    trace.push(refused(config.validate()));
    config.paths.state_root = absent.join("state");
    config.paths.socket_path = PathBuf::from(format!("/{}", "s".repeat(104)));
    trace.push(refused(config.validate()));
    config.paths.socket_path = root().join("r08.sock");
    config.aspd_socket = Some("relative".into());
    trace.push(refused(config.validate()));
    config.aspd_socket = None;
    config.node.node_id = "local".into();
    trace.push(refused(config.validate()));
    config.node.node_id = "max3".into();
    config.local_persona_allowlist = Some(Default::default());
    trace.push(refused(config.assert_persona(PRIMARY)));
    trace.push(refused(config.assert_persona("app:example")));
    config.local_persona_allowlist = Some(["mable".into()].into_iter().collect());
    config.assert_persona(PRIMARY).unwrap();
    assert!(AgentScope::parse("mable@hrc-runtime:primary").is_err());
    let wire = hrc_native::error::NativeError::new(
        409,
        "example",
        "wire detail",
        json!({"field":"value"}),
    );
    assert_eq!(
        wire.envelope(),
        json!({"ok":false,"error":{"code":"example","message":"wire detail","detail":{"field":"value"}}})
    );
    assert_eq!(
        serde_json::to_value(&wire).unwrap(),
        json!({"code":"example","message":"wire detail","detail":{"field":"value"}})
    );
    assert!(!absent.exists());
    record(
        "r08",
        json!({"directoryCreated":absent.exists(),"refusals":trace,"wire":wire.envelope()}),
    );
}
