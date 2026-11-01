//! Submission doors on the active broker (bc-submission.ts, bc-rpc.ts withActive).
use super::{active, broker_answers, delete_active, log, mark_closing, seat};
use crate::server::{
    Shared,
    projection::{db, observe},
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTIVE_RPC_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct BrokerError {
    pub code: String,
    pub message: String,
    pub detail: Value,
}
impl BrokerError {
    pub fn not_active(runtime: &str) -> Self {
        Self {
            code: "broker_runtime_not_active".into(),
            message: format!("no active broker client for runtime {runtime}"),
            detail: json!({}),
        }
    }
}

/// A submission RPC that timed out while its broker still answers: that
/// submission fails, the binding stays (T-12228).
pub const SUBMISSION_TIMEOUT: &str = "submission_timeout";

/// One RPC on the active binding. With `retire_on_timeout`, a timeout retires
/// the binding only on positive death evidence: the broker fails the liveness
/// probe (`broker_answers`) or its transport is closed.
pub async fn with_active(
    server: &Shared,
    runtime: &str,
    method: &str,
    params: impl FnOnce(&str) -> Value,
    codes: (&str, &str),
    retire_on_timeout: bool,
) -> Result<(String, Value), BrokerError> {
    with_active_within(
        server,
        runtime,
        method,
        params,
        codes,
        retire_on_timeout,
        ACTIVE_RPC_TIMEOUT,
    )
    .await
}

async fn with_active_within(
    server: &Shared,
    runtime: &str,
    method: &str,
    params: impl FnOnce(&str) -> Value,
    codes: (&str, &str),
    retire_on_timeout: bool,
    timeout: Duration,
) -> Result<(String, Value), BrokerError> {
    let Some((invocation, client)) = active(server, runtime) else {
        return Err(BrokerError::not_active(runtime));
    };
    match tokio::time::timeout(
        timeout,
        client.request_within(
            method,
            params(&invocation),
            timeout + Duration::from_secs(1),
        ),
    )
    .await
    {
        Ok(Ok(v)) => Ok((invocation, v)),
        Ok(Err(e)) => {
            let text = e.to_string();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let message = parsed["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or(text);
            let mut detail = json!({"name":"BrokerRpcError"});
            if let Some(code) = parsed.get("code") {
                detail["brokerRpcCode"] = code.clone();
            }
            if let Value::Object(data) = &parsed["data"] {
                for (k, v) in data {
                    detail[k] = v.clone();
                }
            }
            Err(BrokerError {
                code: codes.0.into(),
                message,
                detail,
            })
        }
        Err(_) => {
            let timeout_ms = timeout.as_millis() as u64;
            if retire_on_timeout && broker_answers(&client, &invocation).await {
                log(
                    "warn",
                    "broker submission timed out; binding kept",
                    json!({"runtimeId":runtime,"invocationId":invocation,"method":method,"reason":codes.1,"timeoutMs":timeout_ms}),
                );
                return Err(BrokerError {
                    code: SUBMISSION_TIMEOUT.into(),
                    message: format!(
                        "broker {method} unanswered after {timeout_ms}ms for {runtime}; the broker answers its liveness probe, so the binding is kept"
                    ),
                    detail: json!({"runtimeId":runtime,"invocationId":invocation,"timeoutMs":timeout_ms,"bindingRetained":true}),
                });
            }
            if retire_on_timeout {
                mark_closing(server, runtime, codes.1);
                delete_active(server, runtime);
                log(
                    "warn",
                    "broker active binding retired after timeout",
                    json!({"runtimeId":runtime,"reason":codes.1}),
                );
            }
            Err(BrokerError {
                code: codes.1.into(),
                message: format!("broker {} after {timeout_ms}ms for {runtime}", codes.1),
                detail: json!({"runtimeId":runtime,"timeoutMs":timeout_ms}),
            })
        }
    }
}

pub struct Submit<'a> {
    pub runtime_id: &'a str,
    pub run_id: Option<&'a str>,
    /// The HRC submission door recorded on milestones (steer|enqueue|invoke|preempt).
    pub door: &'a str,
    pub body: &'a str,
    pub origin: &'a Value,
    pub response_format: Option<&'a Value>,
    pub fresh_context: Option<bool>,
    pub ttl_ms: Option<i64>,
    pub turn_policy: Option<&'a str>,
}

fn classes(server: &Shared, invocation: &str) -> Option<Vec<String>> {
    let db = server.store.lock().unwrap();
    let inv = db::invocation(&db.sqlite, invocation).ok().flatten()?;
    let caps: Value = serde_json::from_str(&inv.capabilities_json).ok()?;
    caps["admission"]["classes"].as_array().map(|a| {
        a.iter()
            .filter_map(|c| c.as_str().map(str::to_owned))
            .collect()
    })
}

/// steer/enqueue/invoke/preempt through the active broker.
pub async fn submit(server: &Shared, s: Submit<'_>) -> Result<Value, BrokerError> {
    let mut class = match s.door {
        "steer" => "steer",
        "enqueue" => "queue",
        "preempt" => "preempt",
        _ => "exclusive",
    };
    let mut method = match s.door {
        "steer" => "submission.steer",
        "enqueue" => "submission.enqueue",
        "preempt" => "submission.preempt",
        _ => "submission.invoke",
    };
    let invocation = active(server, s.runtime_id).map(|(i, _)| i);
    if s.door == "invoke"
        && let Some(i) = &invocation
        && !classes(server, i).is_some_and(|c| c.iter().any(|x| x == "exclusive"))
    {
        // A multi-origin seat cannot offer the exclusive class: admit the
        // invoke through the queue class.
        class = "queue";
        method = "submission.enqueue";
    }
    if s.door == "preempt"
        && let Some(i) = &invocation
        && classes(server, i).is_some_and(|c| !c.iter().any(|x| x == "preempt"))
    {
        log(
            "warn",
            "broker.preempt.unsupported",
            json!({"runtimeId":s.runtime_id,"invocationId":i,"principalRef":s.origin["principalRef"]}),
        );
        return Ok(
            json!({"submissionId":format!("hrc-rejected-{}",uuid::Uuid::new_v4()),"admission":"rejected","reason":"unsupported:preempt"}),
        );
    }
    let codes = match s.door {
        "steer" => ("broker_steer_failed", "broker_steer_timeout"),
        "enqueue" => ("broker_enqueue_failed", "broker_enqueue_timeout"),
        "preempt" => ("broker_preempt_failed", "broker_preempt_timeout"),
        _ => ("broker_invoke_failed", "broker_invoke_timeout"),
    };
    let queued = method == "submission.enqueue" || method == "submission.preempt";
    let (invocation, response) = with_active(
        server,
        s.runtime_id,
        method,
        |invocation| {
            let mut p = json!({"invocationId":invocation,"origin":s.origin,"body":s.body});
            if let Some(f) = s.response_format {
                p["responseFormat"] = f.clone();
            }
            if let Some(f) = s.fresh_context {
                p["freshContext"] = f.into();
            }
            if queued && let Some(t) = s.ttl_ms {
                p["ttlMs"] = t.into();
            }
            if s.door != "steer"
                && let Some(t) = s.turn_policy
            {
                p["turnPolicy"] = t.into();
            }
            p
        },
        codes,
        true,
    )
    .await?;
    if response["admission"] == "admitted" {
        let observed = hrc_store::timestamp();
        let result = {
            let db = server.store.lock().unwrap();
            let submission = response["submissionId"].as_str().unwrap_or("");
            observe::update_submission(
                &db.sqlite,
                &observe::Submission {
                    runtime_id: s.runtime_id,
                    invocation_id: &invocation,
                    submission_id: submission,
                    run_id: s.run_id,
                    door: s.door,
                    admission_class: Some(class),
                    observed_at: &observed,
                },
                |_| json!({"admissionClass":class,"acceptedAt":observed,"lastMilestone":"accepted"}),
            )
        };
        match result {
            Ok(()) => server.ledger_committed(),
            Err(error) => log(
                "warn",
                "broker.dispatch_observability.failed",
                json!({"runtimeId":s.runtime_id,"cause":"submission-accepted","error":error.to_string()}),
            ),
        }
        seat::probe_in_background(
            server,
            s.runtime_id,
            &format!("submission-{}-admitted", s.door),
        );
    }
    Ok(response)
}

/// submission.withdraw (no retire on timeout).
#[allow(dead_code)] // N3 registers the withdraw door (EN-35922)
pub async fn withdraw(
    server: &Shared,
    runtime: &str,
    target: Value,
    reason: &str,
) -> Result<Value, BrokerError> {
    with_active(
        server,
        runtime,
        "submission.withdraw",
        |_| {
            let mut p = target.clone();
            p["reason"] = reason.into();
            p
        },
        ("broker_withdraw_failed", "broker_withdraw_timeout"),
        false,
    )
    .await
    .map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    //! T-12228. Ways a slow submission could go wrong: a live seat's binding
    //! retired on a slow RPC (the defect); a dead broker kept bound forever
    //! because the probe treats a hung or closed transport as an answer; a
    //! broker that answers health but whose invocation has exited kept bound;
    //! the probe blocked behind the stalled request on the same connection.
    use super::*;
    use crate::server::{controller, rpc::JsonRpc, turns::admission::tests::server};
    use std::sync::Arc;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
    };

    /// A broker that never answers `submission.steer`. `health` answers
    /// broker.health; `state` is what invocation.status reports.
    async fn broker(path: &std::path::Path, health: bool, state: &'static str) {
        let listener = UnixListener::bind(path).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut lines = BufReader::new(read).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let frame: Value = serde_json::from_str(&line).unwrap();
                        let result = match frame["method"].as_str() {
                            Some("broker.health") if health => json!({"status":"ok"}),
                            Some("invocation.status") if health => {
                                json!({"invocationId":frame["params"]["invocationId"],"state":state})
                            }
                            _ => continue,
                        };
                        let reply = json!({"jsonrpc":"2.0","id":frame["id"],"result":result});
                        let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
                    }
                });
            }
        });
    }

    async fn bound(health: bool, state: &'static str) -> (impl Drop, Shared, tempdir::Dir) {
        let (scratch, server) = server("off", false).unwrap();
        let dir = tempdir::Dir::new();
        let socket = dir.0.join("b.sock");
        broker(&socket, health, state).await;
        let (client, _events) = JsonRpc::connect_broker(
            &socket,
            Duration::from_secs(5),
            controller::permission_handler(Arc::downgrade(&server)),
        )
        .await
        .unwrap();
        controller::set_active(&server, "rt", "inv", client);
        (scratch, server, dir)
    }

    async fn steer(server: &Shared) -> Result<(String, Value), BrokerError> {
        with_active_within(
            server,
            "rt",
            "submission.steer",
            |i| json!({"invocationId":i,"body":"slow"}),
            ("broker_steer_failed", "broker_steer_timeout"),
            true,
            Duration::from_millis(300),
        )
        .await
    }

    #[tokio::test]
    async fn timeout_with_an_answering_broker_fails_the_submission_and_keeps_the_binding() {
        let (_scratch, server, _dir) = bound(true, "turn_active").await;
        let error = steer(&server).await.unwrap_err();
        assert_eq!(error.code, SUBMISSION_TIMEOUT);
        assert_eq!(error.detail["bindingRetained"], true);
        assert!(active(&server, "rt").is_some());
        assert_eq!(controller::intentional_close_reason(&server, "rt"), None);
    }

    #[tokio::test]
    async fn timeout_with_a_hung_broker_retires_the_binding() {
        let (_scratch, server, _dir) = bound(false, "turn_active").await;
        let error = steer(&server).await.unwrap_err();
        assert_eq!(error.code, "broker_steer_timeout");
        assert!(active(&server, "rt").is_none());
        assert_eq!(
            controller::intentional_close_reason(&server, "rt").as_deref(),
            Some("broker_steer_timeout")
        );
    }

    #[tokio::test]
    async fn timeout_with_an_exited_invocation_retires_the_binding() {
        let (_scratch, server, _dir) = bound(true, "exited").await;
        let error = steer(&server).await.unwrap_err();
        assert_eq!(error.code, "broker_steer_timeout");
        assert!(active(&server, "rt").is_none());
    }

    mod tempdir {
        /// A short socket directory (unix socket paths stay < 104 bytes).
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::path::PathBuf::from(format!(
                    "/tmp/t12228-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4().simple()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
