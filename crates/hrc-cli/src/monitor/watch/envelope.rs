//! Envelope selectors: an `EN-` id resolves to the runtime or run of its newest receipt.
use crate::monitor::reader::s;
use crate::{Error, Result};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn envelope_show(id: &str) -> std::result::Result<Value, String> {
    use std::io::{Read, Write};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let request = json!({"jsonrpc":"2.0","id":1,"method":"wrkq.envelope.show","params":{"envelope":id,"principalRef":"agent:hrc"}});
    let mut child = Command::new("wrkq")
        .args(["rpc", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{request}\n").as_bytes());
    }
    let deadline = Instant::now() + Duration::from_millis(10_000);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
            return Err("subprocess timed out after 10000ms: wrkq rpc --stdio".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let (mut out, mut err) = (String::new(), String::new());
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut out);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let Some(line) = out.split('\n').find(|l| !crate::js::trim(l).is_empty()) else {
        let err = crate::js::trim(&err);
        return Err(if err.is_empty() {
            "wrkq returned no response".into()
        } else {
            err.into()
        });
    };
    let frame: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if let Some(error) = frame.get("error") {
        return Err(s(error, "message")
            .unwrap_or("wrkq rejected the request")
            .into());
    }
    Ok(frame["result"].clone())
}

pub(super) fn is_envelope(raw: &str) -> bool {
    let t = crate::js::trim(raw);
    t.strip_prefix("EN-")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

pub(super) fn resolve_envelopes(selectors: &[String]) -> Result<Vec<String>> {
    selectors
        .iter()
        .map(|raw| {
            if !is_envelope(raw) {
                return Ok(raw.clone());
            }
            let id = crate::js::trim(raw);
            let envelope = envelope_show(id).map_err(|e| {
                Error::usage(format!("could not resolve {id} against the wrkq ledger: {e}"))
            })?;
            let mut receipts = envelope["presentedTo"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(Value::is_object)
                .collect::<Vec<_>>();
            if receipts.is_empty() {
                return Err(Error::usage(format!(
                    "{id} has not been presented yet, so it has no turn to watch. Its ledger state is `wrkc show {id}`."
                )));
            }
            let at = |v: &Value| v.get("presentedAt").filter(|x| !x.is_null()).map(crate::js::display).unwrap_or_default();
            receipts.sort_by(|a, b| crate::js::locale_cmp(&at(a), &at(b)));
            let newest = receipts.last().unwrap();
            if let Some(r) = s(newest, "runtimeId").filter(|r| !r.is_empty()) {
                return Ok(format!("runtime:{r}"));
            }
            if let Some(r) = s(newest, "runId").filter(|r| !r.is_empty()) {
                return Ok(format!("run:{r}"));
            }
            Err(Error::usage(format!(
                "{id} was presented, but its receipt names no runtime or run to watch."
            )))
        })
        .collect()
}
