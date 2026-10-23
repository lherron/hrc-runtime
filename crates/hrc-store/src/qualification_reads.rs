//! Private scratch-driver scenarios. No SQL handle, dispatcher, migration, or runtime authority.
use hrc_domain::store::json::{self as json, Value};
use hrc_store::{
    LifecycleFilters, Patch, Result, RunFilters, RunPatch, RuntimePatch, Store, StoreError,
};
const SCOPE: &str = "agent:tabularasa:project:hrc-runtime:task:finite_%";
const LATER: &str = "2026-10-23T01:00:00.000Z";
const ACTIVITY: &str = "2026-10-23T02:00:00.000Z";

fn fence<T>(value: Result<T>) -> Value {
    match value {
        Err(StoreError::CursorInvalid { expected, actual }) => {
            json::json!({"rejected":true,"expected":expected,"actual":actual})
        }
        Err(e) => json::json!({"rejected":true,"unexpectedCode":e.code(),"message":e.to_string()}),
        Ok(_) => json::json!({"rejected":false}),
    }
}

fn bounded_refusal<T>(value: Result<T>) -> Value {
    match value {
        Err(error) => json::json!({"rejected":true,"code":error.code()}),
        Ok(_) => json::json!({"rejected":false}),
    }
}

pub fn observe(store: &mut Store) -> Result<Value> {
    store.read_snapshot(|tx| {
        let e = tx.lifecycle_events();
        let id = e.ledger_incarnation_id()?;
        let scoped = LifecycleFilters {scope_ref:Some(SCOPE.into()),..Default::default()};
        let generation = LifecycleFilters {generation:Some(2),..Default::default()};
        let replay = |budget: usize| -> Result<Value> {
            let mut visited = Vec::new();
            let mut accepted = Vec::new();
            let mut bytes = 0;
            let (incarnation, head, complete) = e.scan_replay_newest_first(0,&id,&scoped,|event|{
                visited.push(event.clone());
                // Canonical native JSON uses the same JS serialization as stored payloads.
                let size = json::to_string(event).expect("serializable event").len();
                if bytes + size > budget { return false; }
                bytes += size;
                accepted.push(event.clone());
                true
            })?;
            Ok(json::json!({"visited":visited,"accepted":accepted,"bytes":bytes,"ledgerIncarnationId":incarnation,"headHrcSeq":head,"complete":complete}))
        };
        let mut repository_pages = Vec::new();
        let mut repository_tails = Vec::new();
        for limit in [0_i64, -1, -2, 10001] {
            repository_pages.push(json::json!({"limit":limit,"value":e.repository_page(0,limit,None)?}));
            repository_tails.push(json::json!({"limit":limit,"value":e.repository_tail(&scoped,limit,None,None)?}));
        }
        Ok(json::json!({
            "lifecycle":{
                "repositoryPages":repository_pages,
                "repositoryTails":repository_tails,
                "repositoryAfterNegative":e.repository_page(-1,2,None)?,
                "repositoryTailNegativeBefore":e.repository_tail(&scoped,-2,Some(7),None)?,
                "repositoryStale":fence(e.repository_page(0,0,Some("finite-original"))),
                "incarnation":id,"allocated":e.allocated_hrc_seq()?,"max":e.max_hrc_seq()?,
                "page1":e.page(0,1,None)?,"page2":e.page(1,2,None)?,"pageShort":e.page(0,100,None)?,"pageAhead":e.page(999,2,None)?,
                "tail":e.tail(&scoped,2,None,None)?,"tailBefore":e.tail(&scoped,2,Some(7),None)?,
                "tailWrong":e.tail(&LifecycleFilters{scope_ref:Some("absent".into()),..Default::default()},2,None,None)?,
                "tailGeneration":e.tail(&LifecycleFilters{host_session_id:Some("finite-host".into()),generation:Some(2),..Default::default()},2,None,None)?,
                "local":e.list_from_hrc_seq(1,&LifecycleFilters{source_ref:Some(None),..Default::default()})?,
                "imported":e.list_from_hrc_seq(1,&LifecycleFilters{source_ref:Some(Some("peer:finite".into())),..Default::default()})?,
                "emptySource":e.list_from_hrc_seq(1,&LifecycleFilters{source_ref:Some(Some("".into())),..Default::default()})?,
                "all":e.list_from_hrc_seq(1,&LifecycleFilters::default())?,
                "from":e.list_from_hrc_seq(4,&scoped)?,"stream":e.list_from_stream_seq(4,&scoped)?,
                "zero":e.list_from_hrc_seq(1,&LifecycleFilters{limit:Some(0),..Default::default()})?,
                "byRun":e.list_by_run("finite-a",&LifecycleFilters{generation:Some(1),..Default::default()})?,
                "byLaunch":e.list_by_launch("finite-launch",&generation)?,
                "byKind":e.list_by_kind("turn.completed",&LifecycleFilters::default())?,
                "byScope":e.list_by_scope(SCOPE,&LifecycleFilters{lane_ref:Some("main".into()),..Default::default()})?,
                "latestKind":e.find_latest_by_kind("turn.message",&generation)?,
                "latestSession":e.find_latest_by_session("finite-host",2)?,
                "latestWrong":e.find_latest_by_session("finite-host",99)?,
                "latestLocal":e.find_latest_local_in_scope(SCOPE,None,None)?,
                "latestLocalBefore":e.find_latest_local_in_scope(SCOPE,Some(6),Some("turn.message"))?,
                "latestGroups":e.list_latest_per_session(&scoped)?,
                "replay":replay(1000000)?,"replayBytes":replay(700)?,
                "originalFence":fence(e.page(0,2,Some("finite-original"))),
                "pageMismatch":fence(e.page(0,2,Some("wrong"))),
                "tailMismatch":fence(e.tail(&LifecycleFilters::default(),2,None,Some("wrong"))),
                "replayMismatch":fence(e.scan_replay_newest_first(0,"wrong",&LifecycleFilters::default(),|_|true))
            },
            "nativeBoundedRefusals":{
                "pageZero":bounded_refusal(e.page(0,0,None)),
                "pageLarge":bounded_refusal(e.page(0,10001,None)),
                "pageNegativeAfter":bounded_refusal(e.page(-1,2,None)),
                "tailZero":bounded_refusal(e.tail(&scoped,0,None,None)),
                "tailLarge":bounded_refusal(e.tail(&scoped,10001,None,None))
            },
            "runtime":{
                "count":tx.runtime_count()?,"one":tx.runtime_by_id("finite-a")?,"missing":tx.runtime_by_id("absent")?,
                "latest":tx.latest_runtime_by_host("finite-host")?,"host":tx.runtimes_by_host("finite-host")?,"wrongHost":tx.runtimes_by_host("absent")?,
                "scope":tx.runtimes_by_scope(SCOPE)?,"all":tx.all_runtimes()?,"available":tx.available_runtimes()?,
                "statuses":tx.runtimes_by_status(&["busy".into(),"ready".into()])?,"emptyStatuses":tx.runtimes_by_status(&[])?,
                "live":tx.live_session_refs()?,"liveRows":tx.live_session_ref_rows()?
            },
            "run":{
                "one":tx.run_by_id("finite-a")?,"missing":tx.run_by_id("absent")?,
                "dispatch":tx.run_by_dispatch_idempotency_key("finite-host","key-finite-b")?,
                "wrongDispatch":tx.run_by_dispatch_idempotency_key("finite-other","key-finite-b")?,
                "input":tx.run_by_dispatched_input_id("input-finite-c")?,"submission":tx.run_by_broker_submission_id("submission-finite-d")?,
                "turn":tx.run_by_turn_key("turn-finite-e")?,"runtime":tx.runs_by_runtime("finite-a")?,
                "correlated":tx.correlated_runs_by_invocation("finite-invocation")?,"queue":tx.queued_runs_by_host("finite-host")?,"wrongQueue":tx.queued_runs_by_host("finite-other")?,
                "all":tx.list_runs(&RunFilters::default())?,
                "selectors":[
                    tx.list_runs(&RunFilters{run_id:Some("finite-c".into()),..Default::default()})?,
                    tx.list_runs(&RunFilters{runtime_id:Some("finite-a".into()),..Default::default()})?,
                    tx.list_runs(&RunFilters{scope_ref:Some(SCOPE.into()),lane_ref:Some("main".into()),statuses:vec!["completed".into()],..Default::default()})?,
                    tx.list_runs(&RunFilters{scope_ref:Some("".into()),..Default::default()})?,
                    tx.list_runs(&RunFilters{lane_ref:Some("".into()),..Default::default()})?,
                    tx.list_runs(&RunFilters{host_session_id:Some("".into()),..Default::default()})?,
                    tx.list_runs(&RunFilters{generation:Some(0),..Default::default()})?
                ],
                "filtered":tx.list_runs(&RunFilters{host_session_id:Some("finite-host".into()),generation:Some(2),statuses:vec!["queued".into()],..Default::default()})?,
                "zero":tx.list_runs(&RunFilters{limit:Some(0),..Default::default()})?,"emptyStatuses":tx.list_runs(&RunFilters{statuses:vec![],..Default::default()})?,
                "latest":tx.latest_run_for_session("finite-host",None)?,"latestGeneration":tx.latest_run_for_session("finite-host",Some(2))?,
                "wrongGeneration":tx.latest_run_for_session("finite-host",Some(99))?
            }
        }))
    })
}

pub fn mutate(store: &mut Store) -> Result<Value> {
    let mut out = json::Map::new();
    out.insert("before".into(),store.read_snapshot(|tx|Ok(json::json!({"runtime":tx.runtime_by_id("finite-a")?,"run":tx.run_by_id("finite-d")?})))?);
    macro_rules! step {
        ($name:literal, $tx:ident, $call:expr) => {
            out.insert(
                $name.into(),
                json::to_value(store.write(|$tx| $call)?.value)?,
            );
        };
    }
    step!(
        "empty",
        tx,
        tx.update_runtime("finite-a", &RuntimePatch::default())
    );
    step!(
        "patch",
        tx,
        tx.update_runtime(
            "finite-a",
            &RuntimePatch {
                presentation: Patch::Set(json::json!({"label":"finite"})),
                runtime_state_json: Patch::Set(json::json!({"stage":1})),
                updated_at: Patch::Set(LATER.into()),
                ..Default::default()
            }
        )
    );
    step!(
        "sameStatus",
        tx,
        tx.update_runtime_status("finite-a", "ready", LATER)
    );
    step!(
        "status",
        tx,
        tx.update_runtime_status("finite-a", "busy", LATER)
    );
    step!(
        "activity",
        tx,
        tx.update_runtime_activity("finite-a", ACTIVITY, LATER)
    );
    step!(
        "clear",
        tx,
        tx.update_runtime(
            "finite-a",
            &RuntimePatch {
                presentation: Patch::Set(Value::Null),
                runtime_state_json: Patch::Set(Value::Null),
                updated_at: Patch::Set(LATER.into()),
                ..Default::default()
            }
        )
    );
    step!(
        "runId",
        tx,
        tx.update_runtime_run_id("finite-a", Some("finite-a"), LATER)
    );
    step!(
        "clearRunId",
        tx,
        tx.update_runtime_run_id("finite-a", None, LATER)
    );
    step!(
        "absent",
        tx,
        tx.update_runtime_activity("absent", ACTIVITY, LATER)
    );
    let refusal =
        match store.write(|tx| tx.update_runtime_run_id("finite-a", Some("finite-app"), LATER)) {
            Ok(_) => json::json!({"rejected":false}),
            Err(error) => json::json!({"rejected":true,"code":error.code()}),
        };
    out.insert("ownership".into(), refusal);
    out.insert(
        "ownershipAfter".into(),
        json::to_value(store.read_snapshot(|tx| tx.runtime_by_id("finite-a"))?)?,
    );
    step!(
        "runEmpty",
        tx,
        tx.update_run("finite-d", &RunPatch::default())
    );
    step!(
        "runMonotonic",
        tx,
        tx.update_run(
            "finite-d",
            &RunPatch {
                status: Patch::Set("running".into()),
                started_at: Patch::Set(LATER.into()),
                accepted_at: Patch::Set(LATER.into()),
                updated_at: Patch::Set(LATER.into()),
                ..Default::default()
            }
        )
    );
    step!(
        "runResurrect",
        tx,
        tx.update_run(
            "finite-d",
            &RunPatch {
                status: Patch::Set("running".into()),
                completed_at: Patch::Clear,
                error_code: Patch::Set("finite-error".into()),
                updated_at: Patch::Set(LATER.into()),
                ..Default::default()
            }
        )
    );
    step!(
        "runStatus",
        tx,
        tx.update_run_status("finite-d", "failed", LATER)
    );
    step!(
        "runClear",
        tx,
        tx.update_run(
            "finite-d",
            &RunPatch {
                error_code: Patch::Clear,
                error_message: Patch::Clear,
                updated_at: Patch::Set(LATER.into()),
                ..Default::default()
            }
        )
    );
    step!(
        "runAbsent",
        tx,
        tx.update_run_status("absent", "failed", LATER)
    );
    out.insert("after".into(),store.read_snapshot(|tx|Ok(json::json!({"runtime":tx.runtime_by_id("finite-a")?,"run":tx.run_by_id("finite-d")?})))?);
    Ok(Value::Object(out))
}
