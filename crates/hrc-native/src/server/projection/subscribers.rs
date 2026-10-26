//! Process-local delivery admission and fenced consumer receipts, matching Bun.
use super::{ApiError, parse_body};
use axum::http::StatusCode;
use hrc_store::timestamp;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Default)]
pub struct Registry {
    active: Vec<Admission>,
    closed: Vec<Admission>,
}
struct Admission {
    entry: Value,
    token: Option<String>,
}
impl Registry {
    pub fn snapshot(&self) -> Value {
        json!({"active":self.active.iter().map(|a|&a.entry).collect::<Vec<_>>(),"recentlyClosed":self.closed.iter().map(|a|&a.entry).collect::<Vec<_>>()})
    }
    pub fn open(
        &mut self,
        route: &str,
        selector: Value,
        name: Option<&str>,
        receipt: &str,
    ) -> Value {
        let id = format!("sub-{}", Uuid::new_v4());
        let token = (receipt == "consumer-ack-v1").then(|| format!("receipt-{}", Uuid::new_v4()));
        let mut entry = json!({"subscriberId":id,"route":route,"selector":selector,"openedAt":timestamp(),"lastEnqueuedSeq":null,"lastStreamAcceptedSeq":null,"enqueuedCount":0,"streamAcceptedCount":0,"pendingCount":0,"desiredSize":null,"pendingSince":null,"lastStreamAcceptedAt":null,"keepaliveOnlySince":null,"receiptMode":receipt,"receiptState":if token.is_some(){"awaiting-first-ack"}else{"not-requested"},"lastConsumerAcknowledgedSeq":null,"lastConsumerAcknowledgedAt":null,"consumerReceiptBehindSince":null,"consumerReceiptAckCount":0,"closedAt":null});
        if let Some(name) = name {
            let mut ordered = json!({"subscriberId":id,"name":name});
            entry.as_object_mut().unwrap().shift_remove("subscriberId");
            ordered
                .as_object_mut()
                .unwrap()
                .extend(entry.as_object().unwrap().clone());
            entry = ordered;
        }
        let mut response = json!({"subscriberId":id});
        if let Some(name) = name {
            response["name"] = name.into();
        }
        response["route"] = route.into();
        response["receiptMode"] = receipt.into();
        if let Some(token) = &token {
            response["receiptToken"] = token.clone().into();
        }
        self.active.push(Admission { entry, token });
        response
    }
    pub fn declare(&mut self, body: &[u8]) -> Result<Value, ApiError> {
        let input = parse_body(body).map_err(|mut e| {
            e.detail = Some(json!({}));
            e
        })?;
        if !input.is_object() && !input.is_array() {
            return Err(ApiError::bad(
                "request body must be an object",
                Some(json!({})),
            ));
        }
        let name = input["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.encode_utf16().count() > 128 {
            return Err(ApiError::bad(
                "name must be a non-empty string of at most 128 characters",
                Some(json!({"field":"name"})),
            ));
        }
        let route = input
            .get("route")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!("broker-events"));
        if route != "events" && route != "broker-events" {
            return Err(ApiError::bad(
                "route must be \"events\" or \"broker-events\"",
                Some(json!({"field":"route"})),
            ));
        }
        let receipt = input
            .get("receiptMode")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!("none"));
        if receipt != "none" && receipt != "consumer-ack-v1" {
            return Err(ApiError::bad(
                "receiptMode must be \"none\" or \"consumer-ack-v1\"",
                Some(json!({"field":"receiptMode"})),
            ));
        }
        if let Some(a) = self
            .active
            .iter()
            .rev()
            .find(|a| a.entry["name"] == name)
            .filter(|a| a.entry["route"] == route)
        {
            let mut v = json!({"subscriberId":a.entry["subscriberId"],"name":name,"route":route,"receiptMode":a.entry["receiptMode"]});
            if let Some(t) = &a.token {
                v["receiptToken"] = t.clone().into();
            }
            return Ok(v);
        }
        Ok(self.open(
            route.as_str().unwrap(),
            json!({"subscriberName":name}),
            Some(name),
            receipt.as_str().unwrap(),
        ))
    }
    pub fn named_broker(&self, name: &str) -> Option<String> {
        // Bun byName points at the last declaration even if another route used
        // the same name. The old admission remains visible in its snapshot.
        self.active
            .iter()
            .rev()
            .find(|a| a.entry["name"] == name)
            .filter(|a| a.entry["route"] == "broker-events")
            .and_then(|a| a.entry["subscriberId"].as_str().map(str::to_owned))
    }
    pub fn enqueued(&mut self, id: &str, seq: i64) {
        if let Some(a) = self
            .active
            .iter_mut()
            .find(|a| a.entry["subscriberId"] == id)
        {
            let e = &mut a.entry;
            e["lastEnqueuedSeq"] = seq.max(e["lastEnqueuedSeq"].as_i64().unwrap_or(seq)).into();
            e["enqueuedCount"] = (e["enqueuedCount"].as_i64().unwrap() + 1).into();
            e["pendingCount"] = (e["enqueuedCount"].as_i64().unwrap()
                - e["streamAcceptedCount"].as_i64().unwrap())
            .into();
            if e["pendingCount"] == 1 {
                e["pendingSince"] = timestamp().into();
            }
        }
    }
    pub fn accepted(&mut self, id: &str, seq: i64, desired: Option<i64>) {
        if let Some(a) = self
            .active
            .iter_mut()
            .find(|a| a.entry["subscriberId"] == id)
        {
            let e = &mut a.entry;
            if e["streamAcceptedCount"].as_i64() >= e["enqueuedCount"].as_i64() {
                return;
            }
            e["lastStreamAcceptedSeq"] = seq
                .max(e["lastStreamAcceptedSeq"].as_i64().unwrap_or(seq))
                .into();
            e["streamAcceptedCount"] = (e["streamAcceptedCount"].as_i64().unwrap() + 1).into();
            e["pendingCount"] = (e["enqueuedCount"].as_i64().unwrap()
                - e["streamAcceptedCount"].as_i64().unwrap())
            .into();
            e["desiredSize"] = json!(desired);
            let now = timestamp();
            e["lastStreamAcceptedAt"] = now.clone().into();
            e["keepaliveOnlySince"] = Value::Null;
            if e["pendingCount"] == 0 {
                e["pendingSince"] = Value::Null
            }
            if a.token.is_some() {
                let ack = e["lastConsumerAcknowledgedSeq"].as_i64();
                if ack.is_none() {
                    e["receiptState"] = "awaiting-first-ack".into();
                    if e["consumerReceiptBehindSince"].is_null() {
                        e["consumerReceiptBehindSince"] = now.into();
                    }
                } else if ack < e["lastStreamAcceptedSeq"].as_i64() {
                    e["receiptState"] = "behind".into();
                    if e["consumerReceiptBehindSince"].is_null() {
                        e["consumerReceiptBehindSince"] = now.into();
                    }
                } else {
                    e["receiptState"] = "caught-up".into();
                    e["consumerReceiptBehindSince"] = Value::Null;
                }
            }
        }
    }
    pub fn keepalive(&mut self, id: &str, desired: Option<i64>) {
        if let Some(a) = self
            .active
            .iter_mut()
            .find(|a| a.entry["subscriberId"] == id)
        {
            a.entry["desiredSize"] = json!(desired);
            if a.entry["keepaliveOnlySince"].is_null() {
                a.entry["keepaliveOnlySince"] = timestamp().into();
            }
        }
    }
    pub fn close(&mut self, id: &str) {
        if let Some(i) = self
            .active
            .iter()
            .position(|a| a.entry["subscriberId"] == id)
        {
            let mut a = self.active.remove(i);
            a.entry["closedAt"] = timestamp().into();
            self.closed.push(a);
            if self.closed.len() > 32 {
                self.closed.remove(0);
            }
        }
    }
    pub fn acknowledge(&mut self, body: &[u8]) -> Result<Value, ApiError> {
        let input = parse_body(body).map_err(|mut e| {
            e.detail = Some(json!({}));
            e
        })?;
        if !input.is_object() && !input.is_array() {
            return Err(ApiError::bad(
                "subscriber receipt ACK body must be an object",
                Some(json!({})),
            ));
        }
        let id = input["subscriberId"].as_str().unwrap_or("").trim();
        let token = input["receiptToken"].as_str().unwrap_or("").trim();
        if id.is_empty() || token.is_empty() {
            return Err(ApiError::bad(
                "subscriberId and receiptToken are required",
                Some(json!({})),
            ));
        }
        let invalid = |code, message, detail| {
            ApiError::domain(StatusCode::BAD_REQUEST, code, message, Some(detail))
        };
        let a = self
            .active
            .iter_mut()
            .chain(self.closed.iter_mut())
            .find(|a| a.entry["subscriberId"] == id)
            .ok_or_else(|| {
                invalid(
                    "invalid_selector",
                    "subscriberId is unknown or expired",
                    json!({"subscriberId":id}),
                )
            })?;
        if a.token.as_deref() != Some(token) {
            return Err(invalid(
                "invalid_fence",
                "receipt token does not match the subscriber",
                json!({"subscriberId":id}),
            ));
        }
        let seq = input["seq"]
            .as_f64()
            .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 1.0 && *v <= 9007199254740991.0)
            .map(|v| v as i64);
        let seq=seq.ok_or_else(||invalid("malformed_request","receipt seq must be a positive safe integer",json!({"subscriberId":id,"seq":input.get("seq").filter(|v|v.is_number()).unwrap_or(&Value::Null)})))?;
        let e = &mut a.entry;
        let accepted = e["lastStreamAcceptedSeq"].as_i64();
        if accepted.is_none() || Some(seq) > accepted {
            return Err(invalid(
                "invalid_fence",
                "receipt seq is ahead of the stream-admission head",
                json!({"subscriberId":id,"seq":seq,"lastStreamAcceptedSeq":accepted}),
            ));
        }
        let previous = e["lastConsumerAcknowledgedSeq"].as_i64();
        let disposition = if previous == Some(seq) {
            "duplicate"
        } else if previous.is_some_and(|v| seq < v) {
            "stale"
        } else {
            "advanced"
        };
        if disposition == "advanced" {
            let now = timestamp();
            e["lastConsumerAcknowledgedSeq"] = seq.into();
            e["lastConsumerAcknowledgedAt"] = now.clone().into();
            e["consumerReceiptAckCount"] =
                (e["consumerReceiptAckCount"].as_i64().unwrap() + 1).into();
            if Some(seq) == accepted {
                e["receiptState"] = "caught-up".into();
                e["consumerReceiptBehindSince"] = Value::Null;
            } else {
                e["receiptState"] = "behind".into();
                if e["consumerReceiptBehindSince"].is_null() {
                    e["consumerReceiptBehindSince"] = now.into();
                }
            }
        }
        Ok(
            json!({"ok":true,"subscriberId":id,"seq":seq,"disposition":disposition,"lastConsumerAcknowledgedSeq":e["lastConsumerAcknowledgedSeq"],"lastStreamAcceptedSeq":accepted}),
        )
    }
}
