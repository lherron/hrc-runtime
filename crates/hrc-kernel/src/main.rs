//! Read-only HRC cardo kernel. Loggia owns supervision; no resident is added.
use cardo_core::{Format, document::CoreDomain};
use cardo_runtime::{
    core_adapter::CoreAdapter,
    ingest::{LedgerIngest, forward_wake},
    service::*,
    wire,
};
use crossbeam_channel::Sender;
use hrc_domain::{api::HrcApi, ledger::HrcApiLedger, projector::SeatProjector};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    num::NonZeroUsize,
    path::PathBuf,
    sync::Arc,
    time::Duration,
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
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut root = std::env::var_os("HRC_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("HOME")).join("praesidium/var/run/hrc")
        });
    let mut hrc_socket = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runtime-root" => {
                root = PathBuf::from(args.next().ok_or("--runtime-root needs a path")?)
            }
            "--hrc-socket" => {
                hrc_socket = Some(PathBuf::from(
                    args.next().ok_or("--hrc-socket needs a path")?,
                ))
            }
            "--help" | "-h" => {
                println!(
                    "hrc-kernel [--runtime-root PATH] [--hrc-socket PATH]\nRead-only stage-1 kernel at <runtime-root>/hrc-kernel.sock"
                );
                return Ok(());
            }
            _ => return Err(format!("unknown argument {arg}").into()),
        }
    }
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
    let source = Arc::new(HrcApiLedger::new(api.clone()));
    let mut adapter = CoreAdapter::<CoreDomain>::new(
        || CoreDomain,
        hrc_domain::decode_edits,
        Duration::from_secs(60),
    )
    .with_format(Format::new("hrc", 1));
    let worker_source = source.clone();
    adapter.in_process_worker("hrc", move || {
        Box::new(LedgerIngest::new(
            "hrc.project",
            worker_source.clone(),
            SeatProjector { api: api.clone() },
        ))
    });
    adapter.attacher("hrc.seat", hrc_domain::attach::attach);
    forward_wake(
        source.as_ref(),
        adapter.ingest_waker(),
        ("hrc".into(), "hrc".into()),
    )?;
    let owner = RuntimeOwner::start(
        adapter,
        Arc::new(NoWork),
        Box::new(Lifecycle),
        RuntimeConfig {
            command_capacity: 64,
            subscription_capacity: 4096,
            terminal_tombstone_capacity: NonZeroUsize::new(64).unwrap(),
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
    let opened = call(
        &client,
        "document.open",
        json!({"document_id":"hrc","rebuildable":true,"ingest_only":true,"durability":{"mode":"none"}}),
    )?;
    call(
        &client,
        "ingest.attach",
        json!({"document_id":"hrc","binding":"hrc","operation":"hrc.project","config":{},"interval_ms":1000,"resync_every_ms":600000}),
    )?;
    let server = wire::bind(client, &socket)?;
    println!(
        "{}",
        json!({"status":"serving","socket":socket,"pid":std::process::id(),"document":"hrc","revision":opened["revision"]})
    );
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
