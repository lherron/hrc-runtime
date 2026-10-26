use super::{
    Observation, Options,
    frame::Frames,
    stacked::Stacked,
    summary::Summary,
    terminal::Terminal,
    transport::{AsyncDaemon, filter},
};
use crate::{Error, Result, parse::Parsed, scope::Qualified};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, time::Duration};
use tokio::{
    signal::unix::{Signal, SignalKind, signal},
    sync::watch,
    time::{Instant, Sleep, sleep, sleep_until},
};
fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| Error::failure(e.to_string()))
}
pub(super) fn replay(handoff: &Value) -> Result<Vec<Value>> {
    runtime()?.block_on(async {
        let client = AsyncDaemon::new()?;
        let mut reader = client
            .open(
                filter(handoff, false),
                handoff["fromSeq"].as_i64().unwrap_or(1),
                false,
            )
            .await?;
        let mut events = Vec::new();
        while let Some(event) = reader.next().await? {
            events.push(event);
        }
        Ok(events)
    })
}
struct Timers {
    interrupt: Signal,
    stall: Pin<Box<Sleep>>,
    stall_armed: bool,
    wait: Pin<Box<Sleep>>,
    wait_armed: bool,
    catchup: Pin<Box<Sleep>>,
    catchup_armed: bool,
    catchup_fired: bool,
    last_seq: i64,
    through: Option<i64>,
    stacked_stall: Option<watch::Receiver<bool>>,
}
impl Timers {
    fn new(
        opts: &Options,
        obs: &Observation,
        stacked_stall: Option<watch::Receiver<bool>>,
    ) -> Result<Self> {
        let interrupt =
            signal(SignalKind::interrupt()).map_err(|e| Error::failure(e.to_string()))?;
        let forever = Instant::now() + Duration::from_secs(31_536_000);
        Ok(Self {
            interrupt,
            stall: Box::pin(sleep(timer_duration(opts.stall_ms))),
            stall_armed: obs.catch_up.is_none() && opts.window_ms.is_none(),
            wait: Box::pin(sleep_until(
                opts.deadline.map(Instant::from_std).unwrap_or(forever),
            )),
            wait_armed: opts.deadline.is_some(),
            catchup: Box::pin(sleep(Duration::from_secs(30))),
            catchup_armed: obs.catch_up.is_some(),
            catchup_fired: false,
            last_seq: obs.handoff["fromSeq"].as_i64().unwrap_or(0) - 1,
            through: obs.catch_up,
            stacked_stall,
        })
    }
    async fn next<T>(
        &mut self,
        args: &Parsed<'_>,
        opts: &Options,
        obs: &Observation,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        if self.catchup_fired {
            return Err(self.catchup_error(args));
        }
        let stacked_enabled = self.stacked_stall.is_some();
        tokio::select! {
         result=future=>result,
         _=self.interrupt.recv()=>Err(super::terminal_error(args,super::exit(130,"interrupted"))),
         _=&mut self.stall,if self.stall_armed=>Err(super::terminal_error(args,super::exit(1,"stall-after timeout reached"))),
         _=&mut self.wait,if self.wait_armed=>Err(super::wait_timeout(args,opts,json!({"runId":obs.handoff["runId"]}))),
         _=&mut self.catchup,if self.catchup_armed=>Err(self.catchup_error(args)),
         _=async{let signal=self.stacked_stall.as_mut().unwrap();while !*signal.borrow(){if signal.changed().await.is_err(){std::future::pending::<()>().await;}}},if stacked_enabled=>Err(super::terminal_error(args,super::exit(1,"stall-after timeout reached"))),
        }
    }
    fn catchup_error(&self, args: &Parsed<'_>) -> Error {
        super::terminal_error(
            args,
            super::exit(
                3,
                format!(
                    "turn: attach did not complete catch-up (received through seq {} of {})",
                    self.last_seq,
                    self.through.unwrap()
                ),
            ),
        )
    }
}
fn timer_duration(ms: f64) -> Duration {
    Duration::from_millis(ms.max(1.).min(u64::MAX as f64) as u64)
}
pub(super) fn watch(
    args: &Parsed<'_>,
    opts: &Options,
    scope: &Qualified,
    obs: Observation,
) -> Result<()> {
    runtime()?.block_on(async {
        let client = AsyncDaemon::new()?;
        let stacked = opts.window_ms.map(|_| {
            Stacked::new(
                opts,
                &obs,
                Summary::new(
                    client.clone(),
                    super::project(scope).unwrap_or_default(),
                    &scope.agent,
                    obs.handoff["runId"].as_str().unwrap_or_default(),
                ),
            )
        });
        let mut timers = Timers::new(opts, &obs, stacked.as_ref().map(Stacked::stalled))?;
        let result = observe(args, opts, &obs, &client, stacked.as_ref(), &mut timers).await;
        if let Some(stacked) = stacked {
            stacked.close().await;
            stacked.cleanup().await;
        }
        result
    })
}
async fn observe(
    args: &Parsed<'_>,
    opts: &Options,
    obs: &Observation,
    client: &AsyncDaemon,
    stacked: Option<&Stacked>,
    timers: &mut Timers,
) -> Result<()> {
    let terminal = opts.window_ms.is_none()
        && (args.flag("pretty")
            || matches!(args.value("format"), Some("tree" | "compact" | "terminal"))
            || args.value("format").is_none()
                && std::io::IsTerminal::is_terminal(&std::io::stdout()));
    let mut sink = terminal.then(|| Terminal::new(&opts.target, &opts.body, args.flag("pretty")));
    let mut frames = Frames::default();
    let mut phase: Option<String> = None;
    let mut pending = Vec::new();
    let mut completed = false;
    let mut reader = timers
        .next(
            args,
            opts,
            obs,
            client.open(
                filter(&obs.handoff, obs.follow_seat),
                obs.handoff["fromSeq"].as_i64().unwrap_or(0),
                true,
            ),
        )
        .await?;
    while let Some(event) = timers.next(args, opts, obs, reader.next()).await? {
        timers.last_seq = event["hrcSeq"].as_i64().unwrap_or(0);
        let kind = event["eventKind"].as_str().unwrap_or_default();
        if let Some(stacked) = stacked {
            phase = Some(
                match kind {
                    "permission_request" => "permission",
                    "turn.completed" => {
                        if event["payload"]["success"] == false {
                            "error"
                        } else {
                            "final"
                        }
                    }
                    "run_failed" | "turn.error" => "error",
                    "run_queued" => phase.as_deref().unwrap_or("queued"),
                    _ => match phase.as_deref() {
                        Some("permission") => "permission",
                        Some("error") => "error",
                        _ => "progress",
                    },
                }
                .into(),
            );
            stacked.receive(&event).await;
            if timers.catchup_armed && timers.catchup.deadline() <= Instant::now() {
                timers.catchup_fired = true;
            }
        } else {
            pending.push(event.clone());
            if !timers.catchup_armed || timers.through.is_some_and(|seq| timers.last_seq >= seq) {
                for ready in pending.drain(..) {
                    if let Some(frame) = frames.receive(&ready) {
                        phase = frame["phase"].as_str().map(str::to_owned);
                        if let Some(sink) = &mut sink {
                            sink.write(&frame);
                        } else {
                            super::line(&frame);
                        }
                    }
                }
            }
        }
        if timers.catchup_armed && timers.through.is_some_and(|seq| timers.last_seq >= seq) {
            timers.catchup_armed = false;
            if stacked.is_none() {
                timers.stall_armed = true;
                timers
                    .stall
                    .as_mut()
                    .reset(Instant::now() + timer_duration(opts.stall_ms));
            }
        }
        if matches!(kind, "turn.failed" | "first_turn_missing") {
            let code = event["payload"]["code"]
                .as_str()
                .or(event["errorCode"].as_str())
                .unwrap_or(kind);
            let message = event["payload"]["message"].as_str();
            let detail = format!(
                "{code}{}",
                message.map(|s| format!(": {s}")).unwrap_or_default()
            );
            if let Some(stacked) = stacked {
                stacked
                    .finish(
                        "error",
                        "error",
                        4,
                        "turn_error",
                        Some(json!({"message":detail})),
                    )
                    .await;
            } else if !terminal || opts.wait_ms.is_some() {
                let mut failure = json!({"result":"turn_failed"});
                for key in ["runId", "eventKind", "hrcSeq", "errorCode"] {
                    if let Some(value) = event.get(key) {
                        failure[key] = value.clone();
                    }
                }
                failure["code"] = code.into();
                if let Some(message) = message {
                    failure["message"] = message.into();
                }
                if kind == "first_turn_missing" {
                    failure["diagnosticsSeq"] = event["hrcSeq"].clone();
                    failure["retrieval"] = format!(
                        "hrc runtime diagnostics {}",
                        crate::js::member(&event, "hrcSeq")
                    )
                    .into();
                }
                super::line(&failure);
            }
            return Err(super::terminal_error(
                args,
                super::exit(4, format!("turn failed: {detail}")),
            ));
        }
        if matches!(kind, "turn_end" | "turn.completed") {
            completed = true;
            break;
        }
        if matches!(
            kind,
            "runtime_exited" | "runtime_crashed" | "runtime_killed"
        ) {
            if let Some(stacked) = stacked {
                stacked
                    .finish(
                        "error",
                        "error",
                        4,
                        "runtime_dead",
                        Some(json!({"message":"runtime exited before turn completed"})),
                    )
                    .await;
            }
            return Err(super::terminal_error(
                args,
                super::exit(4, "runtime exited before turn completed"),
            ));
        }
    }
    if timers.catchup_armed {
        return Err(timers.catchup_error(args));
    }
    match phase.as_deref() {
        Some("permission") => {
            if let Some(stacked) = stacked {
                stacked
                    .finish("permission", "permission", 5, "permission_blocked", None)
                    .await;
            }
            return Err(super::terminal_error(
                args,
                super::exit(
                    5,
                    "turn blocked on permission request (no interactive approval in MVP)",
                ),
            ));
        }
        Some("error") => {
            if let Some(stacked) = stacked {
                stacked
                    .finish(
                        "error",
                        "error",
                        4,
                        "turn_error",
                        Some(json!({"message":"turn ended with error"})),
                    )
                    .await;
            }
            return Err(super::terminal_error(
                args,
                super::exit(4, "turn ended with error"),
            ));
        }
        _ => {}
    }
    if completed && let Some(stacked) = stacked {
        stacked.finish("final", "final", 0, "success", None).await;
    }
    Ok(())
}
