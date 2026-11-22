//! Every seat is on prae (P-01214): mail hints and the stop gate print prae forms only.
use serde_json::json;
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}

#[test]
fn stop_gate_prints_prae_forms() -> anyhow::Result<()> {
    let (_scratch, db) = fixture::ScratchStore::new()?;
    let scope = "agent:cody:project:p/lane:main";
    let blocking = [json!({
        "id":"EN-123", "roomKey":"p/inbox", "from":{"scopeRef":"mable@p:primary"}, "body":"Please\n reply."
    })];
    let result = db.mail_stop("rt-golden", scope, &blocking)?;
    assert_eq!(result["decision"], "block");
    assert_eq!(
        result["reason"],
        "Turn finish paused: 1 unanswered envelope remain (refusal 1/3).\n- p/inbox from mable@p:primary: Please reply.\nRun `prae room mail find --to me`, then read `prae room mail get <EN-id> --json` for the body, replyTo and etag. Reply (`prae room say <EN-id> --to <replyTo> - <<'EOF'`) or defer (`prae room mail defer <EN-id> --reason '<why>' --if-match <etag>`) every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate."
    );
    db.mail_stop("rt-golden", scope, &blocking)?;
    assert_eq!(
        db.mail_stop("rt-golden", scope, &blocking)?["reason"],
        "refusal_cap"
    );
    assert_eq!(db.mail_stop("rt-golden", scope, &[])?["reason"], "clear");
    Ok(())
}

#[test]
fn native_mail_hint_golden() {
    assert_eq!(
        hrc_store::mail_hint_text(1),
        "Mail hint from HRC: 1 envelope is waiting for this seat. Run `prae room mail find --to me` to see them and `prae room mail get EN-xxxxx` to read one. Replying with `prae room say <EN-id> --to <replyTo> - <<'EOF'` answers it now; anything unanswered presents at turn end."
    );
    assert_eq!(
        hrc_store::mail_hint_text(2),
        "Mail hint from HRC: 2 envelopes are waiting for this seat. Run `prae room mail find --to me` to see them and `prae room mail get EN-xxxxx` to read one. Replying with `prae room say <EN-id> --to <replyTo> - <<'EOF'` answers it now; anything unanswered presents at turn end."
    );
}
