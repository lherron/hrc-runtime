//! HRC's protocol 3 kernel is a side surface: startup failure never stops HTTP.
mod handlers;

use super::{Shared, call_local, stderr_json};
use anyhow::{Context, anyhow};
use cardo_app::parts::{self, Args, Health, Lock, Paths, Record, Setup, Start, StartedBy};
use hrc_domain::{
    HrcError,
    owner::{OwnerCall, OwnerReply},
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Instant};

pub(super) const CLIENT: &str = concat!("hrc-kernel/", env!("CARGO_PKG_VERSION"));
pub(super) const PRINCIPAL: &str = "system:hrc-kernel";

/// Called from cardo's connection threads, outside tokio's workers.
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
        self.runtime
            .block_on(call_local(&self.server, method, route, body))
            .map(|(status, body)| OwnerReply { status, body })
            .map_err(|e| HrcError::new("hrc_unavailable", format!("{e:#}")))
    }
}

pub(super) struct Kernel {
    wire: parts::Wire,
    owner: parts::Kernel,
    paths: Paths,
    _lock: Lock,
}
impl Kernel {
    /// HTTP stops first, then the wire and owner; only then release discovery and lock.
    pub(super) async fn stop(self) -> anyhow::Result<()> {
        tokio::task::spawn_blocking(move || {
            self.wire.stop();
            let wire = self.wire.join();
            let owner = self.owner.shutdown();
            wire?;
            owner?;
            std::fs::remove_file(&self.paths.record)?;
            stderr_json("info", "kernel", "kernel.stopped", json!({}));
            Ok(())
        })
        .await?
    }
}

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

fn paths(runtime: &Path) -> anyhow::Result<Paths> {
    let root = runtime
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "run"))
        .and_then(Path::parent)
        .filter(|_| runtime.file_name().is_some_and(|n| n == "hrc"))
        .ok_or_else(|| {
            anyhow!(
                "kernel runtime root must be <root>/run/hrc: {}",
                runtime.display()
            )
        })?;
    Ok(Paths::new(
        "hrc",
        &Args {
            root: Some(root.to_path_buf()),
            ..Args::default()
        },
    ))
}

async fn try_start(server: &Shared) -> anyhow::Result<Kernel> {
    let started = Instant::now();
    let paths = paths(&server.runtime)?;
    let owner: Arc<dyn OwnerCall> = Arc::new(LocalOwner {
        server: server.clone(),
        runtime: tokio::runtime::Handle::current(),
    });
    tokio::task::spawn_blocking(move || {
        let start = Start {
            by: StartedBy::Foreground,
            argv: std::env::args().collect(),
            cwd: std::env::current_dir().context("kernel start directory")?,
        };
        // Only the lock holder may create or replace a registry record.
        let lock = Lock::acquire(&paths.socket).map_err(|e| anyhow!("{e}"))?;
        let mut record = Record::new("hrc", None, paths.socket.clone(), vec![], vec![], start);
        let result = (|| -> anyhow::Result<_> {
            record.write(&paths.record)?;
            let openings = handlers::openings(owner)?;
            let kernel = parts::Kernel::start(
                openings,
                Setup {
                    mount: "hrc".into(),
                    owner: "hrc".into(),
                    graphs: paths.graphs.clone(),
                    socket: Some(paths.socket.clone()),
                },
                Health::default(),
            )?;
            let wire = match kernel.bind(&paths.socket) {
                Ok(wire) => wire,
                Err(error) => {
                    kernel.shutdown()?;
                    return Err(error.into());
                }
            };
            let serving = (|| -> anyhow::Result<()> {
                let incarnation = kernel
                    .client()
                    .context("HRC kernel has no default owner")?
                    .host_incarnation();
                record = record.clone().serving(incarnation);
                kernel.set_status(record.to_json());
                record.write(&paths.record)?;
                Ok(())
            })();
            if let Err(error) = serving {
                wire.stop();
                let _ = wire.join();
                let _ = kernel.shutdown();
                return Err(error);
            }
            Ok((kernel, wire))
        })();
        match result {
            Ok((owner, wire)) => {
                stderr_json(
                    "info",
                    "kernel",
                    "kernel.serving",
                    json!({"socket":paths.socket,"elapsedMs":started.elapsed().as_millis() as u64}),
                );
                Ok(Kernel {
                    wire,
                    owner,
                    paths,
                    _lock: lock,
                })
            }
            Err(error) => {
                let failure = error
                    .downcast_ref::<parts::Failure>()
                    .cloned()
                    .unwrap_or_else(|| {
                        parts::Failure::new(
                            "kernel_start_failed",
                            format!("{error:#}"),
                            "check the kernel socket directory and rusthrc log",
                        )
                    });
                record = record.failed(
                    &failure,
                    paths.root.join("logs/hrc-runtime/rusthrc-owner.log"),
                );
                record
                    .write(&paths.record)
                    .context(format!("record failed kernel start: {error:#}"))?;
                Err(error)
            }
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::{binding, server};
    use hrc_domain::annotation;
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
        path::PathBuf,
        time::Duration,
    };

    /// The fixture's runtime root is under $TMPDIR, too long for a socket
    /// path (SUN_LEN); the kernel's socket goes under a short /tmp root.
    struct ShortRoot(PathBuf);
    impl Drop for ShortRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn short_root(server: &mut Shared) -> ShortRoot {
        let root = PathBuf::from(format!(
            "/tmp/hk-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        std::fs::create_dir_all(&root).unwrap();
        Arc::get_mut(server).expect("unshared test server").runtime = root.join("run/hrc");
        ShortRoot(root)
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn ops_only_provider() -> anyhow::Result<()> {
        let (_scratch, mut server) = server("off", false)?;
        let _root = short_root(&mut server);
        let kernel = try_start(&server).await?;
        let socket = server.runtime.join("kernel.sock");
        let discovery = wire(&socket, "registry.discover", json!({}));
        let result = &discovery["result"];
        let ops: std::collections::BTreeSet<_> = result["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["provider"] == "seat")
            .map(|o| o["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            ops,
            [
                "seat.summon",
                "seat.restart",
                "seat.send",
                "seat.annotation.put",
                "seat.annotation.act",
                "seat.annotation.delete"
            ]
            .into_iter()
            .collect()
        );
        assert!(
            result["node_types"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["provider"] == "cardo")
        );
        assert_eq!(discovery["ok"], true, "{discovery}");
        let docs = wire(&socket, "resync", json!({}));
        eprintln!("OPS_ONLY_DOCUMENTS={docs}");
        assert_eq!(docs["ok"], true, "{docs}");
        assert_eq!(docs["result"]["graphs"], json!({}), "{docs}");
        let unknown = wire(&socket, "seat.unknown", json!({}));
        assert_eq!(unknown["ok"], false, "{unknown}");
        assert_eq!(unknown["error"]["code"], "unknown_operation", "{unknown}");
        kernel.stop().await?;
        Ok(())
    }

    fn generation(server: &Shared) -> u64 {
        *server.ledger.borrow()
    }

    /// One cardo wire call on the kernel socket.
    fn wire(socket: &Path, op: &str, args: Value) -> Value {
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

    /// A wire call off the test's tokio worker: an owner op's work blocks
    /// on the server's runtime until HRC answers.
    async fn op(socket: &Path, name: &'static str, args: Value) -> Value {
        let socket = socket.to_owned();
        tokio::task::spawn_blocking(move || wire(&socket, name, args))
            .await
            .unwrap()
    }
    fn ledger(server: &Shared, scope: &str, kind: &str) -> Vec<(i64, Value)> {
        let db = rusqlite::Connection::open(server.state.join("state.sqlite")).unwrap();
        let mut rows = db
            .prepare("SELECT hrc_seq, payload_json FROM hrc_events WHERE scope_ref=? AND event_kind=? ORDER BY hrc_seq")
            .unwrap();
        rows.query_map(rusqlite::params![scope, kind], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap()
        .map(|r| {
            let (seq, payload) = r.unwrap();
            (seq, serde_json::from_str(&payload).unwrap())
        })
        .collect()
    }

    // Failure cases (T-12188): the ops unregistered with the kernel (unknown
    // operation) or rejected by registry.enable; a store refusal answered as
    // hrc_refused or a success; a write attributed `unknown`; a put that
    // appends no session.annotation.changed or an act no
    // session.annotation.action;
    // (T-12194) a delete not reaching the route, attributed unknown, or
    // leaving the owner annotation behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn annotation_ops_dispatch_in_process_to_the_store() -> anyhow::Result<()> {
        let (_scratch, mut server) = server("off", false)?;
        let _root = short_root(&mut server);
        let socket = server.runtime.join("kernel.sock");
        let kernel = start(&server).await.expect("kernel starts");
        let scope = "agent:kq:project:fold:task:annotated";
        let seat = format!("{scope}/lane:main");
        let (status, _) = call_local(
            &server,
            "POST",
            "/v1/sessions/resolve",
            Some(&json!({"sessionRef":seat,"create":true})),
        )
        .await?;
        assert_eq!(status, 200);
        let key = json!({"session_ref":seat,"subject":"seat","ns":"c2","kind":"card","id":"k1"});
        let with = |extra: Value| {
            let mut args = key.clone();
            args.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            args
        };

        let put = op(
            &socket,
            annotation::PUT,
            with(json!({"body":{"v":1},"expect":{"updatedAt":null}})),
        )
        .await;
        assert_eq!(
            (&put["ok"], &put["result"]["created"]),
            (&json!(true), &json!(true)),
            "{put}"
        );
        let u1 = put["result"]["updated_at"].as_str().unwrap().to_owned();
        let again = op(
            &socket,
            annotation::PUT,
            with(json!({"body":{"v":2},"expect":{"updatedAt":u1}})),
        )
        .await;
        assert_eq!(again["result"]["created"], false, "{again}");
        for (args, code) in [
            (
                with(json!({"body":{"v":3},"expect":{"updatedAt":u1}})),
                "stale_annotation",
            ),
            // No turn has lit the seat: any attentionAt is stale.
            (
                with(json!({"body":{"v":3},"expect":{"attentionAt":"2026-10-31T00:00:00.000Z"}})),
                "stale_attention",
            ),
        ] {
            let reply = op(&socket, annotation::PUT, args).await;
            assert_eq!(
                (&reply["ok"], &reply["error"]["code"]),
                (&json!(false), &json!(code)),
                "{reply}"
            );
        }
        let unknown = op(
            &socket,
            annotation::ACT,
            json!({"session_ref":seat,"subject":"seat","ns":"c2",
            "kind":"card","id":"absent","action":"sent"}),
        )
        .await;
        assert_eq!(unknown["error"]["code"], "unknown_annotation", "{unknown}");
        let acted = op(
            &socket,
            annotation::ACT,
            with(json!({"action":"sent","attributes":{"ok":true}})),
        )
        .await;
        assert_eq!(acted["ok"], true, "{acted}");

        let changed = ledger(&server, scope, "session.annotation.changed");
        assert_eq!(
            changed.len(),
            2,
            "two admitted puts, refusals append nothing: {changed:?}"
        );
        assert!(
            changed
                .iter()
                .all(|(_, p)| p["op"] == "put" && p["updatedBy"] == PRINCIPAL)
        );
        let actions = ledger(&server, scope, "session.annotation.action");
        assert_eq!(actions.len(), 1, "{actions:?}");
        assert_eq!(acted["result"]["hrc_seq"], actions[0].0);
        assert_eq!(
            (&actions[0].1["action"], &actions[0].1["attributes"]),
            (&json!("sent"), &json!({"ok":true}))
        );

        // T-12194: seat.annotation.delete. A superseded updatedAt keeps the
        // store's stale_annotation and appends nothing; the current one
        // deletes, appends the op=delete row and removes the node.
        let stale = op(
            &socket,
            annotation::DELETE,
            with(json!({"expect":{"updatedAt":u1}})),
        )
        .await;
        assert_eq!(
            (&stale["ok"], &stale["error"]["code"]),
            (&json!(false), &json!("stale_annotation")),
            "{stale}"
        );
        let u2 = again["result"]["updated_at"].as_str().unwrap();
        let deleted = op(
            &socket,
            annotation::DELETE,
            with(json!({"expect":{"updatedAt":u2}})),
        )
        .await;
        assert_eq!(deleted["result"], json!({"deleted":true}), "{deleted}");
        let changed = ledger(&server, scope, "session.annotation.changed");
        assert_eq!(
            changed.len(),
            3,
            "the refused delete appends nothing: {changed:?}"
        );
        assert!(changed[2].0 > actions[0].0, "{changed:?}");
        assert_eq!(
            (
                &changed[2].1["op"],
                &changed[2].1["id"],
                &changed[2].1["updatedBy"]
            ),
            (&json!("delete"), &json!("k1"), &json!(PRINCIPAL))
        );
        kernel.stop().await?;
        Ok(())
    }

    // Failure case: a kernel that cannot start (another instance holds the
    // lock) fails the daemon instead of logging and serving without it.
    #[tokio::test(flavor = "multi_thread")]
    async fn kernel_start_failure_leaves_hrc_serving() -> anyhow::Result<()> {
        let (_scratch, mut server) = server("off", false)?;
        let _root = short_root(&mut server);
        let _held = Lock::acquire(&server.runtime.join("kernel.sock"))
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        assert!(try_start(&server).await.is_err());
        assert!(start(&server).await.is_none());
        let (status, _) = call_local(&server, "GET", "/v1/status", None).await?;
        assert_eq!(status, 200);
        Ok(())
    }
}
