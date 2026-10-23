//! Fixed scratch-only presentation scenarios; no owner, SQL or execution surface.
use hrc_domain::store::json::{self as json, Value};
use hrc_store::{PresentationSeatsRequest, ReadTx, Result, Store, StoreError};
const SINCE: &str = "2026-10-22T00:00:00.000Z";
fn scope(n: &str) -> String {
    format!("agent:present:project:hrc-runtime:task:{n}")
}
fn refs() -> Vec<String> {
    let mut refs: Vec<_> = (0..270)
        .map(|i| format!("{}/lane:main", scope(&format!("bulk{i}"))))
        .collect();
    for n in [
        "quiet", "recent", "boundary", "outside", "fallback", "active", "absent",
    ] {
        refs.push(format!("{}/lane:main", scope(n)));
    }
    refs.extend([
        format!("{}/lane:alt", scope("alternate")),
        format!("{}/lane:lane:alt", scope("alternate")),
        format!("{}/lane:main", scope("quiet")),
        format!(" {}/lane:main ", scope("quiet")),
    ]);
    refs
}
fn ids() -> Vec<String> {
    [
        "present-outside",
        "missing",
        "present-quiet",
        "present-quiet",
        "present-alternate",
        "present-recent",
    ]
    .iter()
    .map(|s| (*s).into())
    .collect()
}
fn value(tx: &ReadTx<'_>, refs: Vec<String>, ids: Vec<String>) -> Result<Value> {
    Ok(
        json::json!({"value":tx.presentation().read_seats(&PresentationSeatsRequest{session_refs:refs,runtime_ids:ids,since:SINCE.into()})?}),
    )
}
pub fn observe(store: &mut Store) -> Result<Value> {
    store.read_snapshot(|tx|{
        let p=tx.presentation();
        // Fixed explicitly keyed projection controls include unavailable runtimes;
        // full-list behavior remains a separate existing API, never a keyed substitute.
        let mut projected=Vec::new();
        for id in ["present-active","present-alternate","present-bulk0","present-fallback","present-fallback-second","present-outside","present-quiet","present-quiet-second","present-recent"] {
            let r=tx.runtime_by_id(id)?.ok_or_else(||StoreError::MissingRecord(id.into()))?;
            projected.push(p.project_runtime(&r)?);
        }
        let mut invalid=Vec::new();
        for body in [json::json!({}),json::json!({"sessionRefs":[""],"runtimeIds":[]}),json::json!({"sessionRefs":[17],"runtimeIds":[]}),json::json!({"sessionRefs":["no-lane"],"runtimeIds":[]}),json::json!({"sessionRefs":[" /lane: "],"runtimeIds":[]}),json::json!({"sessionRefs":[],"runtimeIds":[""]})] {
            let result=hrc_store::PresentationQueries::parse_request(&body,SINCE);
            match result {
                Err(StoreError::Invalid(message))=>invalid.push(json::json!({"error":{"code":"malformed_request","message":message}})),
                Err(e)=>return Err(e),
                Ok(_)=>return Err(StoreError::Invalid("negative request unexpectedly accepted".into())),
            }
        }
        Ok(json::json!({
            "full":value(tx,refs(),ids())?,
            "empty":value(tx,vec![],vec![])?,
            "runtimeOnly":value(tx,vec![],ids())?,
            "alias":value(tx,vec![format!("{}/lane:alt",scope("alternate")),format!("{}/lane:lane:alt",scope("alternate"))],vec![])?,
            "missing":value(tx,vec![format!("{}/lane:main",scope("absent"))],vec!["missing".into()])?,
            "projected":projected,"invalid":invalid
        }))
    })
}
/// Same snapshot, bounded calls, original input order; duplicate outputs replace in place.
/// Runtime IDs run after all session keys, matching the source Map construction.
pub fn chunks(store: &mut Store) -> Result<Value> {
    store.read_snapshot(|tx|{
        let mut all=hrc_store::PresentationSeats::default();
        fn merge<T>(target:&mut Vec<T>,values:Vec<T>,key:impl Fn(&T)->&str) {
            for v in values {if let Some(i)=target.iter().position(|old|key(old)==key(&v)){target[i]=v;}else{target.push(v);}}
        }
        let refs=refs();
        let requests=refs.chunks(128).map(|c|PresentationSeatsRequest{session_refs:c.to_vec(),runtime_ids:vec![],since:SINCE.into()})
            .chain(std::iter::once(PresentationSeatsRequest{session_refs:vec![],runtime_ids:ids(),since:SINCE.into()}));
        let mut inputs=Vec::new();
        for request in requests {
            inputs.push(json::json!({"sessionRefs":request.session_refs,"runtimeIds":request.runtime_ids,"since":request.since}));
            let rows=tx.presentation().read_seats(&request)?;
            merge(&mut all.sessions,rows.sessions,|s|&s.session.host_session_id);
            merge(&mut all.runtimes,rows.runtimes,|r|&r.runtime_id);
            merge(&mut all.events,rows.events,|e|&e.fields.host_session_id);
        }
        Ok(json::json!({"inputs":inputs,"value":all}))
    })
}
