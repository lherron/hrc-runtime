use super::*;
use crate::server::turns::admission::tests::server;
use anyhow::Result;

const AT: &str = "2026-01-01T00:00:00.000Z";
const SCOPE: &str = "agent:test:project:fixture";

fn seed(server: &Shared, transport: &str, active: bool) -> Result<()> {
    let mut store = server.store.lock().unwrap();
    let session = store.create_session(SCOPE, "main")?.0;
    let host = session["hostSessionId"].as_str().unwrap();
    let db = &store.sqlite;
    db.execute(
        "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,active_invocation_id,active_run_id,created_at,updated_at) VALUES('rt',?,?,'main',1,?,'ready',1,'harness-broker','inv',?,?,?)",
        params![host, SCOPE, transport, active.then_some("run"), AT, AT],
    )?;
    db.execute(
        "INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv','op','rt','harness-broker/0.2','claude-code-tmux','ready','{}','h','h','h','{}',?,?)",
        params![AT, AT],
    )?;
    db.execute(
        "INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at,operation_id,invocation_id,dispatched_input_id,broker_submission_id) VALUES('run',?,'rt',?,'main',1,?,'accepted',?,?,'op','inv','sub','sub')",
        params![host, SCOPE, transport, AT, AT],
    )?;
    db.execute(
        "INSERT INTO submission_admissions(submission_id,run_id,runtime_id,invocation_id,door,admitted_at) VALUES('sub','run','rt','inv','steer',?)",
        [AT],
    )?;
    Ok(())
}

fn envelope(seq: i64, kind: &str, payload: Value) -> Value {
    json!({"invocationId":"inv","seq":seq,"type":kind,"time":AT,"payload":payload})
}

async fn project(server: &Shared, event: &Value) -> Result<()> {
    controller::project_live(server, "rt", event).await
}

fn run(server: &Shared) -> Result<db::Run> {
    Ok(db::run(&server.store.lock().unwrap().sqlite, "run")?.unwrap())
}

#[tokio::test]
async fn non_landed_terminals_complete_the_submission_run() -> Result<()> {
    let cases = [
        ("rejected", "unsupported", "failed", None),
        (
            "withdrawn",
            "operator requested",
            "cancelled",
            Some("submission_withdrawn"),
        ),
        (
            "withdrawn",
            "accepted_run_never_started",
            "failed",
            Some("accepted_run_never_started"),
        ),
        ("expired", "deadline elapsed", "failed", None),
        ("cancelled", "teardown", "cancelled", None),
        ("lost", "teardown", "failed", Some("submission_lost")),
    ];
    for (disposition, reason, status, code) in cases {
        let (_scratch, server) = server("off", false)?;
        seed(&server, "headless", true)?;
        if disposition == "withdrawn" {
            project(
                &server,
                &envelope(
                    1,
                    "queue.withdrawn",
                    json!({"submissionId":"sub","reason":reason,"position":0}),
                ),
            )
            .await?;
            assert!(run(&server)?.completed_at.is_none());
        }
        project(
            &server,
            &envelope(
                if disposition == "withdrawn" { 2 } else { 1 },
                &format!("submission.{disposition}"),
                json!({"submissionId":"sub","reason":reason}),
            ),
        )
        .await?;
        let row = run(&server)?;
        assert_eq!(row.status, status, "{disposition} ({reason})");
        assert_eq!(row.error_code.as_deref(), code, "{disposition} ({reason})");
        assert!(row.completed_at.is_some(), "{disposition} ({reason})");
        let store = server.store.lock().unwrap();
        let actual: String = store.sqlite.query_row(
            "SELECT disposition FROM submission_admissions WHERE submission_id='sub'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(actual, disposition);
    }
    Ok(())
}

#[tokio::test]
async fn teardown_lost_survives_invocation_exit() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    seed(&server, "headless", true)?;
    project(
        &server,
        &envelope(
            1,
            "submission.lost",
            json!({"submissionId":"sub","reason":"teardown"}),
        ),
    )
    .await?;
    let lost = run(&server)?;
    assert_eq!(lost.error_code.as_deref(), Some("submission_lost"));
    project(
        &server,
        &envelope(2, "invocation.exited", json!({"exitCode":1})),
    )
    .await?;
    let exited = run(&server)?;
    assert_eq!(exited.status, lost.status);
    assert_eq!(exited.error_code, lost.error_code);
    assert_eq!(exited.completed_at, lost.completed_at);
    let store = server.store.lock().unwrap();
    let rt = db::runtime(&store.sqlite, "rt")?.unwrap();
    assert_eq!(rt.status, "crashed");
    assert!(rt.active_run_id.is_none());
    Ok(())
}

#[tokio::test]
async fn reconcile_leaves_claude_submission_open_after_uncorrelated_turn() -> Result<()> {
    for active in [true, false] {
        let (_scratch, server) = server("off", false)?;
        seed(&server, "sdk", active)?;
        project(
            &server,
            &envelope(1, "input.accepted", json!({"inputId":"sub"})),
        )
        .await?;
        let mut unrelated = envelope(
            2,
            "turn.completed",
            json!({"turnId":"other","success":true}),
        );
        unrelated["turnId"] = "other".into();
        project(&server, &unrelated).await?;
        assert!(run(&server)?.completed_at.is_none());
        super::super::reconcile::once(&server, 0, false, 0)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        assert_eq!(run(&server)?.status, "accepted", "active owner: {active}");
        project(
            &server,
            &envelope(
                3,
                "submission.lost",
                json!({"submissionId":"sub","reason":"teardown"}),
            ),
        )
        .await?;
        assert_eq!(run(&server)?.error_code.as_deref(), Some("submission_lost"));
    }
    Ok(())
}

#[tokio::test]
async fn zombie_sweep_skips_pending_permission_until_it_closes() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    seed(&server, "headless", true)?;
    let mut request = envelope(
        1,
        "permission.requested",
        json!({"permissionRequestId":"p","kind":"shell","subjectDisplay":"test"}),
    );
    request["inputId"] = "sub".into();
    project(&server, &request).await?;
    let eligible = || -> Result<bool> {
        let store = server.store.lock().unwrap();
        Ok(!candidates(&store.sqlite, i64::MAX)?.is_empty())
    };
    assert!(!eligible()?);
    project(
        &server,
        &envelope(
            2,
            "permission.resolved",
            json!({"permissionRequestId":"other","decision":"allow"}),
        ),
    )
    .await?;
    assert!(!eligible()?);
    project(
        &server,
        &envelope(
            3,
            "permission.cancelled",
            json!({"permissionRequestId":"p","reason":"turn-failed"}),
        ),
    )
    .await?;
    assert!(eligible()?);
    Ok(())
}

#[tokio::test]
async fn zombie_withdraw_uses_admission_disposition_and_write_boundary() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    seed(&server, "headless", false)?;
    let eligible = || -> Result<bool> {
        let store = server.store.lock().unwrap();
        let run = db::run(&store.sqlite, "run")?.unwrap();
        Ok(unwritten_submission(&store.sqlite, &run)?.is_some())
    };
    assert!(eligible()?);
    project(
        &server,
        &envelope(1, "input.accepted", json!({"inputId":"sub"})),
    )
    .await?;
    assert!(!eligible()?);
    {
        let store = server.store.lock().unwrap();
        store.sqlite.execute(
            "DELETE FROM broker_invocation_events WHERE type='input.accepted'",
            [],
        )?;
        store.sqlite.execute(
            "UPDATE submission_admissions SET disposition='withdrawn' WHERE submission_id='sub'",
            [],
        )?;
    }
    assert!(!eligible()?);
    Ok(())
}

#[tokio::test]
async fn launch_carried_terminal_requires_its_admission() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    seed(&server, "headless", true)?;
    {
        let store = server.store.lock().unwrap();
        store.sqlite.execute(
            "UPDATE runs SET broker_submission_id=NULL, dispatched_input_id=NULL, correlation_json=? WHERE run_id='run'",
            [json!({"kind":"launch_carried_invoke_turn"}).to_string()],
        )?;
        store
            .sqlite
            .execute("UPDATE broker_invocations SET run_id='run'", [])?;
    }
    project(
        &server,
        &envelope(
            1,
            "submission.withdrawn",
            json!({"submissionId":"unrelated","reason":"operator"}),
        ),
    )
    .await?;
    assert!(run(&server)?.completed_at.is_none());
    project(
        &server,
        &envelope(2, "admission.requested", json!({"submissionId":"native","class":"exclusive","origin":{"principalRef":"legacy:invocation.input"}})),
    )
    .await?;
    project(
        &server,
        &envelope(
            3,
            "submission.rejected",
            json!({"submissionId":"native","reason":"unsupported"}),
        ),
    )
    .await?;
    assert_eq!(run(&server)?.status, "failed");
    Ok(())
}

/// Reconcile finds dead broker runtimes on its own WAL reader, then settles
/// them under the store lock. The off-lock scan must still reach the write.
#[tokio::test]
async fn reconcile_settles_dead_broker_admission_found_off_lock() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    seed(&server, "headless", true)?;
    project(
        &server,
        &envelope(
            1,
            "admission.requested",
            json!({"submissionId":"sub","class":"steer"}),
        ),
    )
    .await?;
    let mut exited = std::process::Command::new("true").spawn()?;
    let dead = exited.id();
    exited.wait()?;
    let disposition = |server: &Shared| -> Result<Option<String>> {
        let store = server.store.lock().unwrap();
        Ok(store.sqlite.query_row(
            "SELECT disposition FROM submission_admissions WHERE submission_id='sub'",
            [],
            |r| r.get(0),
        )?)
    };
    {
        let store = server.store.lock().unwrap();
        store.sqlite.execute(
            "UPDATE broker_invocations SET execution_format='format1', broker_pid=? WHERE invocation_id='inv'",
            [dead],
        )?;
        store.sqlite.execute(
            "UPDATE runtimes SET status='crashed' WHERE runtime_id='rt'",
            [],
        )?;
    }
    assert_eq!(disposition(&server)?, None);
    super::super::reconcile::once(&server, 0, false, 0)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    assert_eq!(disposition(&server)?.as_deref(), Some("submission.lost"));
    Ok(())
}
