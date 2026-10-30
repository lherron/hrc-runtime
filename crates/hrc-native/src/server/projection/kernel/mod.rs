//! The HRC kernel inside rusthrc (T-12067 §8.1 items 4 and 5): cardo's wire on
//! `<runtimeRoot>/hrc-kernel.sock`, projecting from its own read-only
//! connection and entering owner routes through `call_local`. Owner only; a
//! kernel that fails to start is logged and HRC serves without it.
mod adapter;

use super::{Shared, call_local, stderr_json};
use anyhow::{Context, anyhow};
use cardo_host::{HostDefault, Idle, NoWork, SingleInstance, send};
use cardo_runtime::{service::*, wire};
use cardo_runtime_tokio::{WireTask, spawn_wire};
use hrc_domain::{
    HrcError,
    owner::{OwnerCall, OwnerReply},
    reader::HrcRead,
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;

/// User-Agent of every kernel request, so accounting meters it (T-11541).
// Historical client identity retained for accounting continuity across the fold.
pub(super) const CLIENT: &str = concat!("hrc-kernel/", env!("CARGO_PKG_VERSION"));
/// The ledger watch wakes ingest; the interval is only a backstop.
const INGEST_INTERVAL_MS: u64 = 10_000;
const RESYNC_EVERY_MS: u64 = 600_000;
/// An attach blocks the owner thread; it answers in about a millisecond.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);

/// The owner seam over `call_local`. Called off tokio's workers only: from
/// the cardo owner thread (attach) and from op tasks on the blocking pool.
struct LocalOwner {
    server: Shared,
    runtime: tokio::runtime::Handle,
}
impl OwnerCall for LocalOwner {
    fn call(
        &self,
        method: &str,
        route: &str,
        body: Option<&Value>,
    ) -> Result<OwnerReply, HrcError> {
        let call = call_local(&self.server, method, route, body);
        let reply = if route.starts_with("/v1/attach") {
            self.runtime
                .block_on(async { tokio::time::timeout(ATTACH_TIMEOUT, call).await })
                .unwrap_or_else(|_| Err(anyhow!("attach exceeded {ATTACH_TIMEOUT:?}")))
        } else {
            self.runtime.block_on(call)
        };
        reply
            .map(|(status, body)| OwnerReply { status, body })
            .map_err(|e| HrcError::new("hrc_unavailable", format!("{e:#}")))
    }
}

pub(super) struct Kernel {
    wire: WireTask,
    owner: RuntimeOwner,
    tasks: [JoinHandle<()>; 2],
    _lock: SingleInstance,
}
impl Kernel {
    /// After the HTTP listener stops: the wire, then the owner (§8.1 item 5).
    pub(super) async fn stop(self) -> anyhow::Result<()> {
        for task in &self.tasks {
            task.abort();
        }
        self.wire.stop().await.context("kernel wire")?;
        cardo_runtime_tokio::join(self.owner)
            .await
            .map_err(|failure| anyhow!("kernel owner: {}", failure.message))?;
        stderr_json("info", "kernel", "kernel.stopped", json!({}));
        Ok(())
    }
}

/// Starts the kernel, or logs `kernel.start_failed` and returns None: HRC
/// execution never depends on the kernel.
pub(super) async fn start(server: &Shared) -> Option<Kernel> {
    match try_start(server).await {
        Ok(kernel) => Some(kernel),
        Err(error) => {
            stderr_json(
                "error",
                "kernel",
                "kernel.start_failed",
                json!({"error":format!("{error:#}")}),
            );
            None
        }
    }
}
async fn try_start(server: &Shared) -> anyhow::Result<Kernel> {
    let started = Instant::now();
    let socket = server.runtime.join("hrc-kernel.sock");
    let lock = SingleInstance::acquire(&socket).map_err(|e| anyhow!("{e}"))?;
    let read = HrcRead::open(&server.state.join("state.sqlite"))?;
    let runtime = tokio::runtime::Handle::current();
    let owner_call: Arc<dyn OwnerCall> = Arc::new(LocalOwner {
        server: server.clone(),
        runtime: runtime.clone(),
    });
    let core = hrc_domain::document::core(read, owner_call.clone());
    let waker = core.ingest_waker();
    let owner = RuntimeOwner::start(
        adapter::HrcAdapter {
            core,
            owner: owner_call,
            pending: Default::default(),
            runtime,
        },
        Arc::new(NoWork),
        Box::new(Idle),
        RuntimeConfig {
            ring_events: 4096,
            ring_bytes: 32 * 1024 * 1024,
            ..RuntimeConfig::host_default()
        },
    );
    let client = owner.client(ClientRole::Tui);
    let setup = {
        let (client, socket) = (client.clone(), socket.clone());
        tokio::task::spawn_blocking(move || -> anyhow::Result<wire::WireServer> {
            for (operation, arguments) in [
                ("registry.enable", hrc_domain::declarations::declarations()),
                (
                    "document.open",
                    json!({"document_id":"hrc","rebuildable":true,"ingest_only":true,"durability":{"mode":"none"}}),
                ),
                (
                    "ingest.attach",
                    json!({"document_id":"hrc","binding":"hrc","operation":"hrc.project","config":{},
                        "interval_ms":INGEST_INTERVAL_MS,"resync_every_ms":RESYNC_EVERY_MS}),
                ),
            ] {
                send(&client, operation, arguments)
                    .map_err(|failed| anyhow!("{operation}: {failed:?}"))?;
            }
            Ok(wire::bind(client, &socket)?)
        })
        .await?
    };
    let wire = match setup {
        Ok(wire) => spawn_wire(wire),
        Err(error) => {
            let _ = cardo_runtime_tokio::join(owner).await;
            return Err(error);
        }
    };
    // Every committed ledger write bumps the watch; each change is a wake hint.
    let mut ledger = server.ledger.subscribe();
    let wake = tokio::spawn(async move {
        while ledger.changed().await.is_ok() {
            if !waker.wake("hrc", "hrc") {
                break;
            }
        }
    });
    let errors = tokio::spawn(watch_errors(client));
    stderr_json(
        "info",
        "kernel",
        "kernel.serving",
        json!({"socket":socket,"elapsedMs":started.elapsed().as_millis() as u64}),
    );
    Ok(Kernel {
        wire,
        owner,
        tasks: [wake, errors],
        _lock: lock,
    })
}

/// The hrc binding's last ingest error as `ingest.status` reports it, as
/// `code: message`; None while its runs settle cleanly.
fn binding_error(client: &KernelClient) -> Option<String> {
    let status = match send(client, "ingest.status", json!({"document_id":"hrc"})) {
        Ok(status) => status,
        Err(failed) => return Some(format!("ingest.status: {failed:?}")),
    };
    status["bindings"]
        .as_array()?
        .iter()
        .filter_map(|binding| binding.get("last_error").filter(|e| !e.is_null()))
        .map(|e| {
            format!(
                "{}: {}",
                e["code"].as_str().unwrap_or("error"),
                e["message"].as_str().unwrap_or_default()
            )
        })
        .next()
}
/// An ingest error is the reason the seat set is wrong: log each new one,
/// repeat a persisting one once a minute, and log the recovery.
async fn watch_errors(client: KernelClient) {
    let (mut current, mut logged) = (None, Instant::now());
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let probe = client.clone();
        let Ok(error) = tokio::task::spawn_blocking(move || binding_error(&probe)).await else {
            continue;
        };
        let repeat = error.is_some() && logged.elapsed() >= Duration::from_secs(60);
        if error != current || repeat {
            match &error {
                Some(e) => stderr_json(
                    "error",
                    "kernel",
                    "kernel.ingest.error",
                    json!({"error":e,"persisting":error == current}),
                ),
                None => stderr_json("info", "kernel", "kernel.ingest.recovered", json!({})),
            }
            logged = Instant::now();
            current = error;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::{binding, server};
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        time::{Duration, Instant},
    };

    /// The fixture's runtime root is under $TMPDIR, too long for a socket
    /// path (SUN_LEN); the kernel's socket goes under a short /tmp root.
    struct ShortRoot(std::path::PathBuf);
    impl Drop for ShortRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn short_root(server: &mut Shared) -> ShortRoot {
        let root = std::path::PathBuf::from(format!(
            "/tmp/hk-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&root).unwrap();
        Arc::get_mut(server).expect("unshared test server").runtime = root.clone();
        ShortRoot(root)
    }
    fn generation(server: &Shared) -> u64 {
        *server.ledger.borrow()
    }

    /// One cardo wire call on the kernel socket.
    fn wire(socket: &std::path::Path, op: &str, args: Value) -> Value {
        let stream = UnixStream::connect(socket).expect("kernel socket answers");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut writer = stream.try_clone().unwrap();
        writeln!(writer, "{}", json!({"id":op,"op":op,"args":args})).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn seat_refs(socket: &std::path::Path) -> Vec<String> {
        let reply = wire(
            socket,
            "document.query",
            json!({"document_id":"hrc","type":"hrc.seat","limit":1000}),
        );
        assert_eq!(reply["ok"], true, "{reply}");
        reply["result"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["payload"]["sessionRef"].as_str().unwrap_or("").to_owned())
            .collect()
    }

    // Failure cases: call_local entering dispatch_local (a read would bump the
    // ledger, a scope homed elsewhere would be created locally, accounting
    // would see nothing), or naming no client (metered as `unknown`).
    #[tokio::test(flavor = "multi_thread")]
    async fn call_local_is_the_listener_dispatch_as_the_kernel() -> anyhow::Result<()> {
        // Configured, so the local placement ledger names a scope's home.
        let (_scratch, server) = server("off", true)?;
        let before = generation(&server);
        let (status, page) =
            call_local(&server, "GET", "/v1/events/page?afterSeq=0&limit=1", None).await?;
        assert_eq!(status, 200, "{page}");
        assert!(page["ledgerIncarnationId"].is_string(), "{page}");
        assert_eq!(
            generation(&server),
            before,
            "a read does not wake the ledger"
        );

        let scope = "agent:kq:project:fold:task:local";
        let (status, created) = call_local(
            &server,
            "POST",
            "/v1/sessions/resolve",
            Some(&json!({"sessionRef":format!("{scope}/lane:main"),"create":true})),
        )
        .await?;
        assert_eq!(
            (status, &created["created"]),
            (200, &json!(true)),
            "{created}"
        );
        assert_eq!(
            generation(&server),
            before + 1,
            "a write wakes the ledger once"
        );

        let metered = server.accounting.queued();
        assert!(
            metered
                .iter()
                .any(|line| line.contains(&format!("\"client\":\"{CLIENT}\""))),
            "{metered:?}"
        );

        // A scope read homed on another node is forwarded, as over HTTP;
        // dispatch_local would answer it here with found:false.
        let remote = "agent:kq:project:fold:task:remote";
        binding(&server, remote, "other-node", false)?;
        let (status, forwarded) = call_local(
            &server,
            "POST",
            "/v1/sessions/resolve",
            Some(&json!({"sessionRef":format!("{remote}/lane:main"),"create":false})),
        )
        .await?;
        assert_eq!(
            (status, forwarded["error"]["code"].as_str()),
            (503, Some("session_home_unreachable")),
            "{forwarded}"
        );
        Ok(())
    }

    // Failure case: block_on from a plain thread (the cardo owner thread
    // attaching) must reach HRC; a refusal keeps its status.
    #[tokio::test(flavor = "multi_thread")]
    async fn local_owner_answers_from_a_plain_thread() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let owner = LocalOwner {
            server: server.clone(),
            runtime: tokio::runtime::Handle::current(),
        };
        let reply = std::thread::spawn(move || {
            owner
                .call("GET", "/v1/attach?runtimeId=rt-missing", None)
                .map(|r| (r.status, r.body))
        })
        .join()
        .unwrap()?;
        assert_eq!(reply.0, 404, "{}", reply.1);
        Ok(())
    }

    // Failure cases: no socket at <runtimeRoot>/hrc-kernel.sock, a seat
    // written after bootstrap waiting for the 10 s backstop instead of the
    // ledger wake, or a stop that leaves the socket answering.
    #[tokio::test(flavor = "multi_thread")]
    async fn kernel_serves_the_wire_wakes_on_commit_and_stops() -> anyhow::Result<()> {
        let (_scratch, mut server) = server("off", false)?;
        let _root = short_root(&mut server);
        let socket = server.runtime.join("hrc-kernel.sock");
        let kernel = start(&server).await.expect("kernel starts");
        let status = wire(&socket, "ingest.status", json!({"document_id":"hrc"}));
        assert_eq!(status["ok"], true, "{status}");
        let deadline = Instant::now() + Duration::from_secs(5);
        while wire(&socket, "ingest.status", json!({"document_id":"hrc"}))["result"]["bindings"][0]
            ["caught_up"]
            != true
        {
            assert!(Instant::now() < deadline, "bootstrap catches up");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let seat = "agent:kq:project:fold:task:woken/lane:main";
        let written = Instant::now();
        call_local(
            &server,
            "POST",
            "/v1/sessions/resolve",
            Some(&json!({"sessionRef":seat,"create":true})),
        )
        .await?;
        while !seat_refs(&socket).iter().any(|r| r == seat) {
            assert!(
                written.elapsed() < Duration::from_secs(3),
                "the ledger wake projects the seat before the 10 s backstop"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        kernel.stop().await?;
        assert!(
            UnixStream::connect(&socket).is_err(),
            "stopped kernel is gone"
        );
        Ok(())
    }

    // Failure case: a kernel that cannot start (another instance holds the
    // lock) fails the daemon instead of logging and serving without it.
    #[tokio::test(flavor = "multi_thread")]
    async fn kernel_start_failure_leaves_hrc_serving() -> anyhow::Result<()> {
        let (_scratch, mut server) = server("off", false)?;
        let _root = short_root(&mut server);
        let _held = SingleInstance::acquire(&server.runtime.join("hrc-kernel.sock"))
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        assert!(try_start(&server).await.is_err());
        assert!(start(&server).await.is_none());
        let (status, _) = call_local(&server, "GET", "/v1/status", None).await?;
        assert_eq!(status, 200);
        Ok(())
    }
}
