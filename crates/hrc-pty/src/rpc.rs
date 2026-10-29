//! JSON-RPC 2.0 over NDJSON, the framing rusthrc already speaks on `b.sock`.
use serde_json::{Value, json};
use std::io::{BufRead, Write};

pub(crate) fn write_frame(out: &mut impl Write, frame: &Value) -> std::io::Result<()> {
    let mut raw = serde_json::to_vec(frame)?;
    raw.push(b'\n');
    out.write_all(&raw)?;
    out.flush()
}

pub(crate) fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// An error whose message starts with a stable code (`terminfo_missing`,
/// `child_alive`, ...); `data.code` carries the same code for callers.
pub(crate) fn error(id: &Value, code: &str, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": format!("{code}: {message}"), "data": {"code": code}}})
}

pub(crate) fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

/// A blocking client for one control connection.
pub(crate) struct Client<R: BufRead, W: Write> {
    reader: R,
    writer: W,
    next_id: u64,
}

impl<R: BufRead, W: Write> Client<R, W> {
    pub(crate) fn new(reader: R, writer: W) -> Self {
        Client {
            reader,
            writer,
            next_id: 1,
        }
    }

    pub(crate) fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(
            &mut self.writer,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )?;
        loop {
            let mut line = String::new();
            anyhow::ensure!(
                self.reader.read_line(&mut line)? > 0,
                "hrc-pty closed the control connection"
            );
            let frame: Value = serde_json::from_str(&line)?;
            if frame["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = frame.get("error") {
                anyhow::bail!("{method}: {}", error["message"].as_str().unwrap_or("error"));
            }
            return Ok(frame["result"].clone());
        }
    }

    /// Send without waiting for the reply (resize from a signal thread).
    pub(crate) fn notify_call(&mut self, method: &str, params: Value) -> std::io::Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(
            &mut self.writer,
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
        )
    }
}
