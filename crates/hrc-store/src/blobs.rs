use crate::{ReadTx, Result, StoreError, WriteTx};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub struct ToolResultBlobs<'a> {
    db: &'a Connection,
}
impl ReadTx<'_> {
    pub fn tool_result_blobs(&self) -> ToolResultBlobs<'_> {
        ToolResultBlobs { db: self.db }
    }
}
fn map_blob(r: &rusqlite::Row<'_>) -> rusqlite::Result<ToolResultBlob> {
    let kind: String = r.get("kind")?;
    Ok(ToolResultBlob {
        rowid: r.get("rowid")?,
        blob_id: r.get("blob_id")?,
        runtime_id: r.get("runtime_id")?,
        kind: if kind == "broker_raw" {
            BlobKind::BrokerRaw
        } else {
            BlobKind::LifecycleCanonical
        },
        bytes: r.get("bytes")?,
        complete: r.get::<_, i64>("complete")? != 0,
        result_json: r.get("result_json")?,
        created_at: r.get("created_at")?,
    })
}
impl ToolResultBlobs<'_> {
    pub fn get(&self, id: &str) -> Result<Option<ToolResultBlob>> {
        Ok(self
            .db
            .query_row(
                "SELECT rowid,* FROM tool_result_blobs WHERE blob_id=?",
                [id],
                map_blob,
            )
            .optional()?)
    }
    pub fn list_local_from_rowid(&self, after: i64, limit: usize) -> Result<Vec<ToolResultBlob>> {
        let id: String = self.db.query_row(
            "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        Ok(self.db.prepare("SELECT rowid,* FROM tool_result_blobs AS blob WHERE blob.rowid>? AND blob.complete=1 AND ((blob.kind='lifecycle_canonical' AND blob.blob_id LIKE ('lc:' || ? || ':%') AND EXISTS (SELECT 1 FROM hrc_events AS event WHERE event.hrc_seq=CAST(substr(blob.blob_id,length('lc:' || ? || ':')+1) AS INTEGER) AND event.source_ref IS NULL)) OR (blob.kind='broker_raw' AND EXISTS(SELECT 1 FROM broker_invocation_events AS event WHERE event.runtime_id=blob.runtime_id AND event.source_ref IS NULL))) ORDER BY blob.rowid ASC LIMIT ?")?.query_map(params![after,id,id,limit as i64],map_blob)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    fn complete(&self, descriptor: &SpillDescriptor) -> Result<Option<ToolResultBlob>> {
        let blob = self.get(&descriptor.blob_id)?.filter(|b| b.complete);
        if blob.is_none() {
            eprintln!(
                "hrc-store: ledger.blob_miss blobId={} kind={}",
                descriptor.blob_id,
                descriptor.kind.as_str()
            );
        }
        Ok(blob)
    }
    pub fn hydrate_lifecycle_payload(&self, payload: &Value) -> Result<Value> {
        let Some(spill) = payload.get("result").and_then(read_spill) else {
            return Ok(payload.clone());
        };
        let Some(blob) = self.complete(&spill)? else {
            return Ok(payload.clone());
        };
        let result: Value = serde_json::from_str(&blob.result_json)?;
        let result = if blob.kind == BlobKind::BrokerRaw {
            canonical_result(&result)
        } else {
            result
        };
        let mut value = payload.clone();
        value["result"] = result;
        Ok(value)
    }
    pub fn hydrate_broker_event_json(&self, raw: &str) -> Result<String> {
        let Ok(mut payload) = serde_json::from_str::<Value>(raw) else {
            return Ok(raw.into());
        };
        let Some(spill) = payload.get("result").and_then(read_spill) else {
            return Ok(raw.into());
        };
        let Some(blob) = self.complete(&spill)? else {
            return Ok(raw.into());
        };
        payload["result"] = serde_json::from_str(&blob.result_json)?;
        Ok(serde_json::to_string(&payload)?)
    }
}
impl WriteTx<'_> {
    pub fn insert_tool_result_blob(
        &mut self,
        id: &str,
        runtime: &str,
        kind: BlobKind,
        bytes: i64,
        result_json: &str,
        created_at: Option<&str>,
    ) -> Result<ToolResultBlob> {
        self.db.execute("INSERT OR IGNORE INTO tool_result_blobs(blob_id,runtime_id,kind,bytes,complete,result_json,created_at) VALUES (?,?,?,?,1,?,coalesce(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')))",params![id,runtime,kind.as_str(),bytes,result_json,created_at])?;
        self.read()
            .tool_result_blobs()
            .get(id)?
            .ok_or_else(|| StoreError::MissingRecord(format!("blob {id}")))
    }
    pub fn ingest_blob_part(&mut self, input: &BlobPart) -> Result<BlobPartOutcome> {
        self.savepoint(|tx|{
            if tx.read().tool_result_blobs().get(&input.blob_id)?.is_some(){return Ok(BlobPartOutcome{completed:true,duplicate:true})}
            let inserted=tx.db.execute("INSERT OR IGNORE INTO tool_result_blob_parts(blob_id,part,parts,runtime_id,kind,bytes,chunk) VALUES (?,?,?,?,?,?,?)",params![input.blob_id,input.part,input.parts,input.runtime_id,input.kind.as_str(),input.bytes,input.chunk])?;
            let count:i64=tx.db.query_row("SELECT count(*) FROM tool_result_blob_parts WHERE blob_id=?",[&input.blob_id],|r|r.get(0))?;
            if count!=input.parts{return Ok(BlobPartOutcome{completed:false,duplicate:inserted==0})}
            let assembled:String=tx.db.query_row("SELECT group_concat(chunk,'') FROM (SELECT chunk FROM tool_result_blob_parts WHERE blob_id=? ORDER BY part ASC)",[&input.blob_id],|r|r.get(0))?;
            let valid:i64=tx.db.query_row("SELECT json_valid(?)",[&assembled],|r|r.get(0))?;
            if assembled.len() as i64!=input.bytes||valid!=1{return Err(StoreError::Invalid(format!("invalid assembled blob {}",input.blob_id)))}
            tx.insert_tool_result_blob(&input.blob_id,&input.runtime_id,input.kind.clone(),input.bytes,&assembled,None)?;
            tx.db.execute("DELETE FROM tool_result_blob_parts WHERE blob_id=?",[&input.blob_id])?;
            Ok(BlobPartOutcome{completed:true,duplicate:inserted==0})
        })
    }
    pub(crate) fn spill_lifecycle(&mut self, seq: i64, event: &LifecycleFields) -> Result<()> {
        if event.event_kind != "turn.tool_result" {
            return Ok(());
        }
        let Some(payload) = &event.payload else {
            return Ok(());
        };
        let Some(result) = payload.get("result") else {
            return Ok(());
        };
        if read_spill(result).is_some() {
            return Ok(());
        }
        let raw = serde_json::to_string(result)?;
        if raw.len() <= 32768 {
            return Ok(());
        }
        let runtime = event
            .runtime_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .ok_or_else(|| {
                StoreError::Invalid("large turn.tool_result requires runtimeId".into())
            })?;
        let broker = if let Some(tool) = payload
            .get("toolUseId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.read()
                .tool_result_blobs()
                .get(&format!("tc:{runtime}:{tool}"))?
        } else {
            None
        };
        let descriptor = if let Some(b) = broker {
            SpillDescriptor {
                blob_id: b.blob_id,
                bytes: b.bytes,
                kind: BlobKind::BrokerRaw,
            }
        } else {
            let id = self.read().lifecycle_events().ledger_incarnation_id()?;
            let blob_id = format!("lc:{id}:{seq}");
            self.insert_tool_result_blob(
                &blob_id,
                runtime,
                BlobKind::LifecycleCanonical,
                raw.len() as i64,
                &raw,
                Some(&event.ts),
            )?;
            SpillDescriptor {
                blob_id,
                bytes: raw.len() as i64,
                kind: BlobKind::LifecycleCanonical,
            }
        };
        let mut stored = payload.clone();
        stored["result"] = spill_stub(result, &descriptor);
        self.db.execute(
            "UPDATE hrc_events SET payload_json=? WHERE hrc_seq=?",
            params![serde_json::to_string(&stored)?, seq],
        )?;
        Ok(())
    }
}
pub(crate) fn read_spill(value: &Value) -> Option<SpillDescriptor> {
    let d = value.get("details")?.get("spill")?;
    let result: SpillDescriptor = serde_json::from_value(d.clone()).ok()?;
    (result.bytes >= 0 && result.bytes <= 9_007_199_254_740_991).then_some(result)
}
fn result_body(value: &Value) -> JsString {
    if let Some(s) = value.as_js_string() {
        return s.clone();
    }
    if let Some(s) = value.get("output").and_then(Value::as_js_string) {
        return s.clone();
    }
    if let Some(content) = value.get("content").and_then(Value::as_array) {
        return JsString::concat(
            &content
                .iter()
                .filter_map(|v| v.get("text").and_then(Value::as_js_string))
                .cloned()
                .collect::<Vec<_>>(),
        );
    }
    value.to_string().into()
}
fn truncate_utf8(s: &JsString, max: usize) -> JsString {
    let mut units = Vec::new();
    let mut bytes = 0;
    for c in char::decode_utf16(s.utf16().iter().copied()) {
        let n = match c {
            Ok(c) => c.len_utf8(),
            Err(_) => 3,
        };
        if bytes + n > max {
            break;
        }
        bytes += n;
        match c {
            Ok(c) => units.extend(c.encode_utf16(&mut [0; 2]).iter().copied()),
            Err(e) => units.push(e.unpaired_surrogate()),
        }
    }
    JsString::from_utf16(units)
}
pub(crate) fn spill_stub(result: &Value, descriptor: &SpillDescriptor) -> Value {
    let body = result_body(result);
    let units = body.utf16().len();
    let head = body.slice(0, 4096);
    let tail = body.slice(units.saturating_sub(1024), 1024);
    let mut details = serde_json::Map::new();
    for key in [
        "exitCode",
        "status",
        "interrupted",
        "duration",
        "durationMs",
    ] {
        let Some(value) = result
            .get(key)
            .or_else(|| result.get("details").and_then(|v| v.get(key)))
        else {
            continue;
        };
        if !value.is_object() && !value.is_array() {
            let mut value = value.clone();
            if let Some(s) = value.as_js_string() {
                value = Value::String(truncate_utf8(s, 256));
            }
            details.insert(key.into(), value);
        }
    }
    details.insert("spill".into(), json!(descriptor));
    json!({"content":[{"type":"text","text":JsString::concat(&[head,format!("\n…[{} bytes spilled → {}]…\n",descriptor.bytes,descriptor.blob_id).into(),tail])}],"details":details})
}
pub(crate) fn canonical_result(value: &Value) -> Value {
    if value
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|c| {
            c.iter()
                .all(|x| x.is_object() && x.get("type").is_some_and(Value::is_string))
        })
    {
        return value.clone();
    }
    let text = if value.is_null() {
        JsString::default()
    } else {
        value
            .as_js_string()
            .cloned()
            .or_else(|| value.get("output").and_then(Value::as_js_string).cloned())
            .unwrap_or_else(|| value.to_string().into())
    };
    let mut result = json!({"content":[{"type":"text","text":text}]});
    if value.is_object() {
        result["details"] = value.clone()
    }
    result
}
