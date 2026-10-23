//! Explicit canonical-scratch composition; ignored by ordinary workspace tests.
use hrc_native::{
    admission::TurnGate,
    authority::AuthorityCoordinator,
    config::NodeIdentity,
    credentials::CredentialStore,
    lifecycle::{
        CallerPresentation, EffectIdentity, LifecycleAuthority, LifecycleFence, LifecycleRequest,
        LocalAuthorityContext,
    },
};
use hrc_store::*;
use std::{
    cell::RefCell,
    fs,
    future::Future,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    rc::Rc,
    task::{Context, Poll, Waker},
};
fn poll<F: Future + Unpin>(value: &mut F) -> Poll<F::Output> {
    std::pin::Pin::new(value).poll(&mut Context::from_waker(Waker::noop()))
}
#[test]
#[ignore = "requires explicit canonical Bun scratch and durable evidence destination"]
fn real_foundation_composition() {
    let root = PathBuf::from(std::env::var("HRC_P2_SCRATCH").expect("explicit scratch"));
    assert!(root.to_string_lossy().starts_with("/tmp/hrcp1-"));
    let out = PathBuf::from(std::env::var("HRC_P2_EVIDENCE").expect("explicit evidence"));
    let runtime = root.join("foundation-runtime");
    fs::create_dir_all(&runtime).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    for raw in [
        r#"{"action":"restart","waitTimeoutMs":1.0}"#,
        r#"{"action":"restart","waitTimeoutMs":1e3}"#,
    ] {
        assert!(LifecycleRequest::parse(&serde_json::from_str(raw).unwrap()).is_ok());
    }
    for raw in [
        r#"{"action":"restart","waitTimeoutMs":0}"#,
        r#"{"action":"restart","waitTimeoutMs":1.5}"#,
        r#"{"action":"restart","waitTimeoutMs":9007199254740992}"#,
    ] {
        assert!(LifecycleRequest::parse(&serde_json::from_str(raw).unwrap()).is_err());
    }
    let fault_root = runtime.join("fault");
    fs::create_dir(&fault_root).unwrap();
    fs::set_permissions(&fault_root, fs::Permissions::from_mode(0o700)).unwrap();
    let fault_gate = TurnGate::load(&fault_root);
    let marker = fault_root.join("turn-admission.json");
    fs::create_dir(&marker).unwrap();
    assert!(fault_gate.close("fault", None, None, None).is_err());
    assert_eq!(fault_gate.snapshot().state, "open");
    fs::remove_dir(&marker).unwrap();
    fault_gate.close("fault", None, None, None).unwrap();
    fs::remove_file(&marker).unwrap();
    fs::create_dir(&marker).unwrap();
    assert!(fault_gate.reopen(Some("fault")).is_err());
    assert_eq!(fault_gate.snapshot().state, "closed");
    fs::remove_dir(&marker).unwrap();
    let gate = TurnGate::load(&runtime);
    let mut lease = gate.admit(false).unwrap();
    let before = gate.snapshot();
    gate.close(
        "foundation",
        Some("fixture".into()),
        None,
        Some("real composition".into()),
    )
    .unwrap();
    assert!(gate.admit(false).is_err());
    let mut accepted = gate.admit(true).unwrap();
    let mut idle = gate.wait_until_idle();
    assert!(poll(&mut idle).is_pending());
    lease.release();
    lease.release();
    assert!(poll(&mut idle).is_pending());
    accepted.release();
    assert!(poll(&mut idle).is_ready());
    assert_eq!(TurnGate::load(&runtime).snapshot().state, "closed");
    assert!(gate.reopen(Some("wrong")).is_err());
    let closed = gate.snapshot();
    assert_eq!(
        fs::metadata(runtime.join("turn-admission.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    gate.reopen(Some("foundation")).unwrap();
    fs::write(runtime.join("turn-admission.json"), "{").unwrap();
    assert_eq!(TurnGate::load(&runtime).snapshot().state, "closed");
    fs::remove_file(runtime.join("turn-admission.json")).unwrap();
    let authority = AuthorityCoordinator::default();
    let scope = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let mut one = authority.summon(scope).unwrap();
    let permit = poll(&mut one).map(|r| r.unwrap());
    let permit = match permit {
        Poll::Ready(p) => p,
        _ => panic!("first summon blocked"),
    };
    let mut retiring = authority.retire(scope).unwrap();
    assert!(poll(&mut retiring).is_pending());
    let mut second = authority.summon(scope).unwrap();
    assert!(poll(&mut second).is_pending());
    drop(permit);
    let retirement = match poll(&mut retiring) {
        Poll::Ready(Ok(p)) => p,
        _ => panic!("retirement not fair"),
    };
    assert!(poll(&mut second).is_pending());
    drop(retirement);
    drop(second);
    assert_eq!(authority.outstanding(), 0);
    let mut store = Store::open_existing(
        root.join("state.sqlite"),
        OpenOptions {
            mode: OpenMode::ReadWrite,
            ..Default::default()
        },
    )
    .unwrap();
    let session = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))
        .unwrap()
        .unwrap();
    let hints = Rc::new(RefCell::new(Vec::new()));
    let queue = hints.clone();
    store.observe(move |hint| queue.borrow_mut().push(format!("{hint:?}")));
    let mut successor = session.clone();
    successor.host_session_id = "foundation-successor".into();
    successor.generation += 1;
    let claim = RosterClaim {
        idempotency_key: "foundation-claim".into(),
        request_hash: "fixture".into(),
        base_scope: session.scope_ref.clone(),
        claimed_scope: session.scope_ref.clone(),
        successor_host_session_id: successor.host_session_id.clone(),
        created_at: session.created_at.clone(),
    };
    let event = LifecycleFields {
        ts: session.created_at.clone(),
        host_session_id: successor.host_session_id.clone(),
        scope_ref: successor.scope_ref.clone(),
        lane_ref: successor.lane_ref.clone(),
        generation: successor.generation,
        event_kind: "session.created".into(),
        category: "session".into(),
        runtime_id: None,
        run_id: None,
        launch_id: None,
        app_id: None,
        app_session_key: None,
        transport: None,
        error_code: None,
        replayed: false,
        evidence_origin: None,
        payload: None,
    };
    let boundary = |tx: &ReadTx<'_>| -> hrc_store::Result<serde_json::Value> {
        Ok(
            serde_json::json!({"host":tx.sessions().get_by_host_session_id("foundation-successor")?,"continuity":tx.continuities().get_by_key(&session.scope_ref,&session.lane_ref)?,"claim":tx.roster_claim("foundation-claim")?,"page":tx.lifecycle_events().page(0,100,None)?}),
        )
    };
    let before_transaction = store.read_snapshot(boundary).unwrap();
    let mut within = None;
    let abort = store.write::<()>(|tx| {
        tx.insert_session(&successor)?;
        tx.upsert_continuity(
            &successor.scope_ref,
            &successor.lane_ref,
            &successor.host_session_id,
            &successor.created_at,
        )?;
        tx.insert_roster_claim(&claim)?;
        tx.append_lifecycle(&event)?;
        within = Some(boundary(&tx.read())?);
        Err(StoreError::Invalid("deliberate coupled rollback".into()))
    });
    assert!(
        abort.is_err()
            && within.as_ref().is_some_and(|v| !v["claim"].is_null())
            && hints.borrow().is_empty()
    );
    let after_rollback = store.read_snapshot(boundary).unwrap();
    assert_eq!(before_transaction, after_rollback);
    let rolled = store
        .read_snapshot(|tx| {
            Ok((
                tx.sessions()
                    .get_by_host_session_id(&successor.host_session_id)?,
                tx.roster_claim(&claim.idempotency_key)?,
            ))
        })
        .unwrap();
    assert!(rolled.0.is_none() && rolled.1.is_none());
    let committed = store
        .write(|tx| {
            tx.insert_session(&successor)?;
            tx.upsert_continuity(
                &successor.scope_ref,
                &successor.lane_ref,
                &successor.host_session_id,
                &successor.created_at,
            )?;
            tx.insert_roster_claim(&claim)?;
            tx.append_lifecycle(&event)
        })
        .unwrap();
    assert!(!committed.changes.is_empty() && !hints.borrow().is_empty());
    let after_commit = store.read_snapshot(boundary).unwrap();
    let mut r = store
        .read_snapshot(|tx| tx.runtime_by_id("p1-runtime"))
        .unwrap()
        .unwrap();
    r.runtime_id = "foundation-mable".into();
    r.scope_ref = "agent:mable:project:hrc-runtime:task:primary".into();
    r.status = "ready".into();
    store.write(|tx| tx.insert_runtime(&r)).unwrap();
    let failed_root = runtime.join("credential-failure");
    fs::create_dir(&failed_root).unwrap();
    fs::set_permissions(&failed_root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut failed_credentials = CredentialStore::new(&failed_root);
    let failed_path = failed_credentials.credential_path(&r.runtime_id).unwrap();
    fs::create_dir_all(failed_path.parent().unwrap()).unwrap();
    fs::set_permissions(
        failed_path.parent().unwrap(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::create_dir(&failed_path).unwrap();
    assert!(failed_credentials.observe(&r).is_err());
    assert_eq!(failed_credentials.held_count(), 0);
    let mut credentials = CredentialStore::new(&runtime);
    credentials.observe(&r).unwrap();
    let path = credentials.credential_path(&r.runtime_id).unwrap();
    let secret = fs::read_to_string(&path).unwrap();
    let secret = secret.trim();
    assert_eq!(secret.len(), 64);
    assert!(secret.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(!format!("{credentials:?}").contains(secret));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(credentials.verify(&r.runtime_id, secret).is_some());
    assert!(credentials.verify(&r.runtime_id, &"0".repeat(64)).is_none());
    let request =
        LifecycleRequest::parse(&serde_json::json!({"action":"restart","reason":"foundation"}))
            .unwrap();
    let node = NodeIdentity {
        node_id: "max3".into(),
        declared: true,
    };
    let mut local = LifecycleAuthority::default();
    let session_ref = format!("{}/lane:main", r.scope_ref);
    let caller = || CallerPresentation {
        runtime_id: Some(&r.runtime_id),
        credential: Some(secret),
        session_ref: Some(&session_ref),
    };
    let mut operation = local
        .authorize_local(
            request.clone(),
            caller(),
            LocalAuthorityContext {
                node: &node,
                peers: &Default::default(),
                credentials: &credentials,
                store: &mut store,
                executor_available: true,
            },
        )
        .unwrap();
    operation.cancel().unwrap();
    store
        .write(|tx| tx.update_runtime_status(&r.runtime_id, "dead", "2026-10-23T01:00:00.000Z"))
        .unwrap();
    assert!(
        local
            .authorize_local(
                request,
                caller(),
                LocalAuthorityContext {
                    node: &node,
                    peers: &Default::default(),
                    credentials: &credentials,
                    store: &mut store,
                    executor_available: true
                }
            )
            .is_err()
    );
    let fence = LifecycleFence::default();
    fence.begin_recovery().unwrap();
    fence.mark_serving().unwrap();
    let identity = EffectIdentity {
        scope_ref: session.scope_ref.clone(),
        lane_ref: session.lane_ref.clone(),
        host_session_id: session.host_session_id.clone(),
        generation: session.generation,
        runtime_id: None,
        operation_id: None,
        invocation_id: None,
    };
    let stale = fence.begin_effect(identity.clone()).unwrap();
    assert!(
        stale
            .apply(&mut store, |tx| tx.update_session_status(
                "p1-host",
                "active",
                "2026-10-23T01:00:00.000Z"
            ))
            .is_err()
    );
    let late = fence.begin_effect(identity).unwrap();
    fence.begin_stop();
    assert!(
        late.apply(&mut store, |tx| tx.update_session_status(
            "p1-host",
            "active",
            "2026-10-23T01:00:00.000Z"
        ))
        .is_err()
    );
    assert!(fence.may_attest_stopped());
    store.close().unwrap();
    let report = serde_json::json!({"scope":"P2_FOUNDATION_SOURCE_SUBSET","admissionBefore":before,"admissionClosed":closed,"authorityCancelledAndFair":true,"transactionBefore":before_transaction,"transactionWithinRollback":within,"transactionAfterRollback":after_rollback,"transactionAfterCommit":after_commit,"rollbackRows":rolled,"commitChanges":committed.changes,"orderedHints":hints.borrow().clone(),"credentialModes":[448,384],"realStoreRevocationRefused":true,"staleAndStoppedEffectsRefused":true});
    fs::write(&out, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    fs::set_permissions(out, fs::Permissions::from_mode(0o600)).unwrap();
}
