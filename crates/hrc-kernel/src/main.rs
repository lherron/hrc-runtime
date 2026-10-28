//! HRC observation and owner-API facade kernel. Loggia owns supervision; no resident is added.
mod adapter;

use cardo_core::{Format, document::CoreDomain};
use cardo_runtime::{
    core_adapter::CoreAdapter,
    ingest::{LedgerIngest, forward_wake},
    service::*,
    wire,
};
use crossbeam_channel::Sender;
use hrc_domain::{api::HrcApi, ledger::HrcLedger, native::NativeRead, projector::SeatProjector};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    num::NonZeroUsize,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

struct NoWork;
impl WorkExecutor for NoWork {
    fn start(&self, _: WorkRequest, _: Sender<WorkCompletion>) -> Result<(), ExecutorFailure> {
        Err(ExecutorFailure {
            code: "unsupported".into(),
            message: "stage 1 has no async product operations".into(),
        })
    }
    fn cancel(&self, _: WorkId) -> Result<ExecutionCancel, ExecutorFailure> {
        Ok(ExecutionCancel::Unsupported)
    }
}
struct Lifecycle;
impl LifecycleParticipant for Lifecycle {
    fn request(
        &mut self,
        r: LifecycleRequest,
        completion: Sender<Result<LifecycleCompletion, LifecycleFailure>>,
    ) -> Result<(), LifecycleFailure> {
        let result = match r {
            LifecycleRequest::Stop { .. } => LifecycleCompletion::Stopped(ParticipantStopped {
                retired_generation: 1,
                settled: vec![],
                cancelled: vec![],
                uncertain: vec![],
            }),
            LifecycleRequest::ResetActor => LifecycleCompletion::Reset(ActorResetReport {
                retired_generation: 1,
                active_generation: 2,
                settled: vec![],
                cancelled: vec![],
                uncertain: vec![],
            }),
        };
        let _ = completion.send(Ok(result));
        Ok(())
    }
    fn join(self: Box<Self>) -> Result<(), LifecycleFailure> {
        Ok(())
    }
}
fn call(client: &KernelClient, operation: &str, arguments: Value) -> Result<Value, String> {
    let receipt = client
        .request(Request::Command(CommandRequest::Unguarded(KernelCommand {
            operation: operation.into(),
            arguments,
            persistence: None,
            cause: None,
        })))
        .map_err(|e| e.message)?;
    let reply = receipt.reply.recv().map_err(|e| e.to_string())?;
    match reply.outcome {
        RequestOutcome::Command(CommandOutcome::Succeeded { value }) => Ok(value),
        other => Err(format!("{operation}: {other:?}")),
    }
}
/// The hrc binding's last ingest error as `ingest.status` reports it, as
/// `code: message`; None while its runs settle cleanly.
fn binding_error(client: &KernelClient) -> Option<String> {
    let status = match call(client, "ingest.status", json!({"document_id":"hrc"})) {
        Ok(status) => status,
        Err(e) => return Some(format!("ingest.status: {e}")),
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
fn seat_count(client: &KernelClient) -> Result<usize, String> {
    let mut count = 0;
    let mut args = json!({"document_id":"hrc","type":"hrc.seat","limit":1000});
    loop {
        let reply = wire::document_query(client, json!("seats"), &args);
        if reply["ok"] != true {
            return Err(format!("document.query: {}", reply["error"]));
        }
        count += reply["result"]["rows"].as_array().map_or(0, Vec::len);
        match reply["result"].get("next").filter(|next| !next.is_null()) {
            Some(next) => args["cursor"] = next.clone(),
            None => return Ok(count),
        }
    }
}
/// After serving starts, an ingest error is still the reason the seat set is
/// wrong: log each new one, repeat a persisting one once a minute, and log the
/// recovery. Stdout carries each change as `{"error": ...}` for the supervisor.
fn watch_errors(client: KernelClient, mut current: Option<String>) {
    let mut logged = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let error = binding_error(&client);
        if error != current {
            match &error {
                Some(e) => eprintln!("hrc-kernel: ingest error: {e}"),
                None => eprintln!("hrc-kernel: ingest recovered"),
            }
            println!("{}", json!({"error": error}));
            logged = Instant::now();
            current = error;
        } else if let Some(e) = &current
            && logged.elapsed() >= Duration::from_secs(60)
        {
            eprintln!("hrc-kernel: ingest error persists: {e}");
            logged = Instant::now();
        }
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut root = None;
    let mut hrc_socket = None;
    let mut ledger_path = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runtime-root" => {
                root = Some(PathBuf::from(
                    args.next().ok_or("--runtime-root needs a path")?,
                ))
            }
            "--ledger-path" => {
                ledger_path = Some(PathBuf::from(
                    args.next().ok_or("--ledger-path needs a path")?,
                ));
            }
            "--hrc-socket" => {
                hrc_socket = Some(PathBuf::from(
                    args.next().ok_or("--hrc-socket needs a path")?,
                ))
            }
            "--help" | "-h" => {
                println!(
                    "hrc-kernel [--runtime-root PATH] [--hrc-socket PATH] [--ledger-path PATH]\nHRC kernel at <runtime-root>/hrc-kernel.sock"
                );
                return Ok(());
            }
            _ => return Err(format!("unknown argument {arg}").into()),
        }
    }
    let root = match root.or_else(|| std::env::var_os("HRC_RUNTIME_DIR").map(PathBuf::from)) {
        Some(root) => root,
        None => PathBuf::from(
            std::env::var_os("HOME")
                .ok_or("HOME is unset; pass --runtime-root or HRC_RUNTIME_DIR")?,
        )
        .join("praesidium/var/run/hrc"),
    };
    std::fs::create_dir_all(&root)?;
    let lock: File = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("hrc-kernel.lock"))?;
    lock.try_lock()
        .map_err(|e| format!("kernel already owns {}: {e}", root.display()))?;
    let socket = root.join("hrc-kernel.sock");
    if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
        return Err(format!("a server is already listening on {}", socket.display()).into());
    }

    let api = HrcApi::new(&hrc_socket.unwrap_or_else(|| root.join("hrc.sock")))?;
    let ledger_path = ledger_path
        .or_else(|| {
            std::env::var_os("HRC_STATE_DIR").map(|p| PathBuf::from(p).join("state.sqlite"))
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join("praesidium/var/state/hrc/state.sqlite"))
        })
        .ok_or("set --ledger-path or HRC_STATE_DIR when HOME is unset")?;
    let native = NativeRead::new(&ledger_path);
    let source = Arc::new(HrcLedger::new(native.clone()));
    let mut adapter = CoreAdapter::<CoreDomain>::new(
        || CoreDomain,
        hrc_domain::decode_edits,
        Duration::from_secs(60),
    )
    .with_format(Format::new("hrc", 1));
    let owner_api = api.clone();
    let worker_source = source.clone();
    adapter.in_process_worker("hrc", move || {
        Box::new(LedgerIngest::new(
            "hrc.project",
            worker_source.clone(),
            SeatProjector {
                api: native.clone(),
            },
        ))
    });
    adapter.attacher("hrc.seat", hrc_domain::attach::attach);
    forward_wake(
        source.as_ref(),
        adapter.ingest_waker(),
        ("hrc".into(), "hrc".into()),
    )?;
    let owner = RuntimeOwner::start(
        adapter::HrcAdapter {
            core: adapter,
            api: owner_api,
            pending: Default::default(),
        },
        Arc::new(NoWork),
        Box::new(Lifecycle),
        RuntimeConfig {
            command_capacity: 64,
            subscription_capacity: 4096,
            terminal_tombstone_capacity: NonZeroUsize::try_from(64_usize)?,
            control_poll_millis: 10,
            ring_events: 4096,
            ring_bytes: 33_554_432,
        },
    );
    let client = owner.client(ClientRole::Tui);
    call(
        &client,
        "registry.enable",
        hrc_domain::declarations::declarations(),
    )?;
    call(
        &client,
        "document.open",
        json!({"document_id":"hrc","rebuildable":true,"ingest_only":true,"durability":{"mode":"none"}}),
    )?;
    call(
        &client,
        "ingest.attach",
        json!({"document_id":"hrc","binding":"hrc","operation":"hrc.project","config":{},"interval_ms":1000,"resync_every_ms":600000}),
    )?;
    // Ready means caught up: a client's first read must be HRC's seat set, not
    // revision 0's empty one. Under Loggia's 30 s ready window, an HRC still not
    // caught up is served anyway; `bootstrapping` stays true on every read, and
    // the ready line names the ingest error that holds it there. The install
    // gate (scripts/lib/kernel-bootstrap-gate.ts) reads this line.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(20);
    let (revision, bootstrapping) = loop {
        let snapshot = client.snapshot().map_err(|e| e.message)?;
        let document = snapshot
            .documents
            .get("hrc")
            .ok_or("document hrc is not open")?;
        let bootstrapping = match &document.authored {
            Ok(authored) => authored.get("bootstrapping") != Some(&Value::Bool(false)),
            Err(failure) => return Err(failure.message.clone().into()),
        };
        if !bootstrapping {
            break (document.revision, false);
        }
        if Instant::now() >= deadline {
            break (document.revision, true);
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let caught_up_ms = (!bootstrapping).then(|| started.elapsed().as_millis() as u64);
    let error = binding_error(&client);
    let seats = seat_count(&client);
    if bootstrapping {
        eprintln!(
            "hrc-kernel: HRC not caught up within 20 s; serving while bootstrapping: {}",
            error.as_deref().unwrap_or("no ingest error reported")
        );
    } else if let Some(e) = &error {
        eprintln!("hrc-kernel: ingest error: {e}");
    }
    let (seats, error) = match seats {
        Ok(seats) => (Some(seats), error),
        Err(e) => {
            eprintln!("hrc-kernel: {e}");
            (None, error.or(Some(e)))
        }
    };
    let watch = client.clone();
    let server = wire::bind(client, &socket)?;
    println!(
        "{}",
        json!({"status":"serving","socket":socket,"pid":std::process::id(),"document":"hrc","revision":revision,
            "bootstrapping":bootstrapping,"caughtUpMs":caught_up_ms,"seats":seats,"error":error})
    );
    std::thread::spawn(move || watch_errors(watch, error));
    server.run()?;
    drop(owner);
    drop(lock);
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("hrc-kernel: {e}");
        std::process::exit(1);
    }
}
