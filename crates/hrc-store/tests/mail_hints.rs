//! Legacy bytes are fixed before changing the per-recipient rendering.
use serde_json::json;
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}
#[test]
fn legacy_stop_reason_golden() -> anyhow::Result<()> {
    let (_scratch, db) = fixture::ScratchStore::new()?;
    let result = db.mail_stop("rt-golden", "agent:cody:project:p/lane:main", &[json!({
        "id":"EN-123", "roomKey":"p/inbox", "from":{"scopeRef":"mable@p:primary"}, "body":"Please\n reply."
    })])?;
    assert_eq!(
        result["reason"],
        "Turn finish paused: 1 unanswered envelope remain (refusal 1/3).\n- p/inbox from mable@p:primary: Please reply.\nRun `wrkc inbox`, then reply (`wrkc say <room> --to <sender> - <<'EOF'`) or `wrkc defer` every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate."
    );
    Ok(())
}

#[test]
fn resolved_recipient_and_failed_reads() -> anyhow::Result<()> {
    let (_scratch, mut db) = fixture::ScratchStore::new()?;
    let scope = "agent:faber:project:p";
    db.create_session(scope, "main")?;
    db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at,active_operation_id) SELECT 'rt-prae',host_session_id,scope_ref,lane_ref,1,'tmux','busy',1,created_at,updated_at,'op-prae' FROM sessions WHERE scope_ref=?", [scope])?;
    db.sqlite.execute("INSERT INTO runtime_operations(operation_id,runtime_id,host_session_id,generation,operation_kind,controller,startup_method,status,route_decision_json,created_at,updated_at,preparation_json) SELECT 'op-prae',runtime_id,host_session_id,1,'broker_invocation','harness-broker','broker.startInvocationFromRequest','running','{}',created_at,updated_at,'{}' FROM runtimes WHERE runtime_id='rt-prae'", [])?;
    assert!(!db.mail_uses_prae("missing"));
    for (raw, expected) in [
        ("not json", false),
        ("{}", false),
        (
            r#"{"response":{"plan":{"resolvedBundle":{"spaces":[{"resolvedKey":"prae-tools-smoke@dev"}]}}}}"#,
            false,
        ),
        (
            r#"{"response":{"plan":{"resolvedBundle":{"spaces":[{"resolvedKey":"defaults@dev"}]}}}}"#,
            false,
        ),
        (
            r#"{"response":{"plan":{"resolvedBundle":{"spaces":[{"resolvedKey":"prae-tools@dev"}]}}}}"#,
            true,
        ),
        (
            r#"{"response":{"plan":{"resolvedBundle":{"spaces":[{"resolvedKey":"prae-tools@1.2.3"}]}}}}"#,
            true,
        ),
    ] {
        db.sqlite.execute(
            "UPDATE runtime_operations SET preparation_json=? WHERE operation_id='op-prae'",
            [raw],
        )?;
        assert_eq!(db.mail_uses_prae("rt-prae"), expected, "{raw}");
    }
    let blocking =
        [json!({"id":"EN-124","roomKey":"p","from":{"principalRef":"agent:mable"},"body":"reply"})];
    let result = db.mail_stop("rt-prae", scope, &blocking)?;
    assert_eq!(result["decision"], "block");
    assert_eq!(
        result["reason"],
        "Turn finish paused: 1 unanswered envelope remain (refusal 1/3).\n- p from agent:mable: reply\nRun `prae room mail find --to me`, then read `prae room mail get <EN-id> --json` for the body, replyTo and etag. Reply (`prae room say <EN-id> --to <replyTo> - <<'EOF'`) or defer (`prae room mail defer <EN-id> --reason '<why>' --if-match <etag>`) every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate."
    );
    db.mail_stop("rt-prae", scope, &blocking)?;
    assert_eq!(
        db.mail_stop("rt-prae", scope, &blocking)?["reason"],
        "refusal_cap"
    );
    assert_eq!(db.mail_stop("rt-prae", scope, &[])?["reason"], "clear");
    Ok(())
}

#[test]
fn native_mail_hint_golden() {
    assert_eq!(
        hrc_store::mail_hint_text(1, false),
        "Mail hint from HRC: 1 envelope is waiting for this seat. Run `wrkc inbox` to see them and `wrkc show EN-xxxxx` to read one. Replying with `wrkc say <room> --to <sender> - <<'EOF'` answers it now; anything unanswered presents at turn end."
    );
    assert_eq!(
        hrc_store::mail_hint_text(2, true),
        "Mail hint from HRC: 2 envelopes are waiting for this seat. Run `prae room mail find --to me` to see them and `prae room mail get EN-xxxxx` to read one. Replying with `prae room say <EN-id> --to <replyTo> - <<'EOF'` answers it now; anything unanswered presents at turn end."
    );
}
