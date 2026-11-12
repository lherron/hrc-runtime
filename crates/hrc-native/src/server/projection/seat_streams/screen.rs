//! Passive snapshots: an ops connection only, never a supervisor attach.
use super::*;

async fn consumer_closed(reader: &mut (impl AsyncRead + Unpin)) -> Result<()> {
    if let Some(frame) = read_frame(reader).await? {
        anyhow::ensure!(
            frame.kind() == Kind::Close,
            "screen consumer may only close"
        );
        let value: Value = serde_json::from_slice(frame.payload())?;
        anyhow::ensure!(
            value["code"].is_string() && value["reason"].is_string(),
            "invalid close"
        );
    }
    Ok(())
}

async fn capture(ops: &hrcpty::Ops, styled: bool) -> Result<Value> {
    let captured = ops.call("capture", json!({"styled":styled})).await?;
    // Capture has supervisor-only diagnostics too (e.g. kittyPlacements).
    // The stream contract is precisely these five fields.
    Ok(json!({"text":captured["text"],"cursor":captured["cursor"],
        "cols":captured["cols"],"rows":captured["rows"],"screen":captured["screen"]}))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn relay(
    server: &Shared,
    scope: &str,
    lane: &str,
    rt: &db::Rt,
    ops: hrcpty::Ops,
    consumer: &mut (impl AsyncRead + AsyncWrite + Unpin),
    styled: bool,
) -> Result<()> {
    let opened = json!({"op":"opened","node":server.federation.node_id(),
        "runtimeId":rt.runtime_id,"generation":rt.generation,"kind":"screen","mode":"read-only"});
    super::super::stderr_json(
        "debug",
        "seat-stream",
        "seat_stream.screen_opened",
        json!({"runtimeId":rt.runtime_id,"styled":styled}),
    );
    let mut captures = 0_u64;
    let result: Result<&str> = async {
        send(consumer, Kind::Control, serde_json::to_vec(&opened)?).await?;
        let (mut read, mut write) = tokio::io::split(&mut *consumer);
        let code = {
            let input = consumer_closed(&mut read);
            tokio::pin!(input);
            let monitor = async {
                let mut tick = tokio::time::interval(Duration::from_millis(200));
                let mut checked = tokio::time::Instant::now();
                loop {
                    tick.tick().await;
                    if server.controller.shutting_down.load(Ordering::SeqCst) {
                        return "daemon_stopping";
                    }
                    if checked.elapsed() >= Duration::from_secs(1) {
                        checked = tokio::time::Instant::now();
                        if let Some(code) = close_code(server, scope, lane, rt) {
                            return code;
                        }
                    }
                }
            };
            tokio::pin!(monitor);
            let mut previous = None;
            let mut next_poll = tokio::time::Instant::now();
            loop {
                let poll = async {
                    tokio::time::sleep_until(next_poll).await;
                    captures += 1;
                    capture(&ops, styled).await
                };
                let snapshot = tokio::select! {
                    biased;
                    _ = &mut input => break "consumer_closed",
                    code = &mut monitor => break code,
                    result = poll => match result {
                        Ok(snapshot) => snapshot,
                        Err(_) => break close_code(server, scope, lane, rt).unwrap_or("runtime_ended"),
                    }
                };
                if previous.as_ref() != Some(&snapshot) {
                    // Finish each bounded write before sending a close frame:
                    // cancellation halfway through a data frame would corrupt it.
                    send(&mut write, Kind::Data, serde_json::to_vec(&snapshot)?).await?;
                    previous = Some(snapshot);
                }
                // No accumulated interval ticks or bursts after backpressure.
                next_poll = tokio::time::Instant::now() + Duration::from_millis(500);
            }
        };
        Ok(code)
    }
    .await;
    // The poll future is gone before the ops connection is dropped. The
    // close record therefore observes the end of this stream's capture work.
    drop(ops);
    let code = result.as_ref().copied().unwrap_or("consumer_closed");
    super::super::stderr_json(
        "debug",
        "seat-stream",
        "seat_stream.screen_closed",
        json!({"runtimeId":rt.runtime_id,"code":code,"captures":captures}),
    );
    result?;
    send(
        consumer,
        Kind::Close,
        serde_json::to_vec(&json!({"code":code,"reason":code}))?,
    )
    .await?;
    consumer.shutdown().await?;
    Ok(())
}
