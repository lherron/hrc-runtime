//! JSON-lines screen consumer. A close ends this invocation; no reconnect.
use super::*;
use hrc_common::seat_stream::{self, Frame, Kind, Open};
use std::{io::Write, time::Duration};

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let qualified = crate::scope::Qualified::parse(&args.positionals[0], false)?;
    let lane = args.value("lane").unwrap_or(&qualified.lane);
    let lane = hrc_common::scope::normalize_lane_ref(Some(lane))
        .map_err(|e| Error::usage(e.to_string()))?;
    let query = [
        ("scopeRef", qualified.scope.as_str()),
        ("laneRef", lane.as_str()),
        ("kind", "screen"),
        ("styled", if args.flag("styled") { "true" } else { "false" }),
    ];
    let caller = hrc_common::caller::resolve(Some("seat-screen"));
    let open = seat_stream::open(
        &crate::client::runtime_root().join("hrc.sock"),
        &query,
        &caller,
        Duration::from_secs(10),
    )
    .map_err(|e| Error::failure(e.to_string()))?;
    let Open::Upgraded {
        mut reader,
        stream: _stream,
        ..
    } = open
    else {
        let Open::Refused {
            status,
            code,
            message,
        } = open
        else {
            unreachable!()
        };
        return Err(Error::usage(format!(
            "{} (HTTP {status}): {message}",
            code.as_deref().unwrap_or("stream_refused")
        )));
    };
    let mut stdout = std::io::stdout().lock();
    while let Some(frame) = Frame::read(&mut reader).map_err(|e| Error::failure(e.to_string()))? {
        match frame.kind() {
            Kind::Data => {
                let value: Value = serde_json::from_slice(frame.payload())
                    .map_err(|e| Error::failure(e.to_string()))?;
                let line = serde_json::to_string(&value).unwrap();
                if let Err(e) = writeln!(stdout, "{line}").and_then(|_| stdout.flush()) {
                    if e.kind() == std::io::ErrorKind::BrokenPipe {
                        return Ok(());
                    }
                    return Err(Error::failure(e.to_string()));
                }
            }
            Kind::Close => return Ok(()),
            Kind::Control => return Err(Error::failure("unexpected screen control frame")),
        }
    }
    Ok(())
}
