use hrc_domain::store::json as serde_json;
// Explicit scratch/test driver; does not start a daemon or launch Bun.
use hrc_store::{BlobKind, BlobPart, OpenMode, OpenOptions, Store, StoreError};
use std::path::PathBuf;
fn run() -> Result<serde_json::Value, StoreError> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args
        .first()
        .ok_or_else(|| StoreError::Invalid("inspect|page --db PATH required".into()))?;
    let value = |key: &str| {
        args.iter()
            .position(|x| x == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let path = PathBuf::from(
        value("--db").ok_or_else(|| StoreError::Invalid("explicit --db required".into()))?,
    );
    admit_scratch_path(&path)?;
    if let Some(registry) = value("--registry") {
        admit_scratch_path(std::path::Path::new(&registry))?;
    }
    let mut store = Store::open_existing(
        &path,
        OpenOptions {
            mode: if command == "atomic-contract"
                || command == "session-contract"
                || command == "repository-contract"
                || command == "transcript-contract"
                || command == "execution-contract"
                || command == "legacy-mail-create-ack-contract"
                || command == "legacy-mail-origin-create-contract"
                || command == "legacy-mail-origin-missing-receipt-contract"
                || command == "legacy-mail-body-contract"
                || command == "legacy-mail-origin-body-contract"
                || matches!(
                    command.as_str(),
                    "consumer-history-contract"
                        | "consumer-placement-active"
                        | "consumer-placement-conflict"
                        | "consumer-archive-history"
                        | "consumer-append-control"
                )
                || command == "input-contract"
                || command == "broker-contract"
                || command == "recovery-contract"
                || command == "grants-contract"
                || command == "participants-contract"
                || command == "messages-contract"
                || command == "authority-contract"
                || command == "reconciliation-cas-contract"
                || command == "ledgers-contract"
                || command == "edges-contract"
                || command == "crash-contract"
                || command == "prune-minimal-contract"
                || command == "prune-full-contract"
                || command.starts_with("prune-return-")
                || command == "active-delivery-contract"
                || command == "placement-absent-contract"
                || command == "placement-registry-contract"
                || command == "index-contract"
                || command == "serialization-contract"
                || command == "replication-contract"
                || command == "outbox-contract"
                || command == "collective-contract"
                || command == "append-boundary-contract"
                || command.starts_with("continuation-maintenance-")
                || command == "title-reappend-contract"
                || command == "legacy-mail-transition-contract"
                || command == "legacy-mail-origin-contract"
                || command == "legacy-mail-present-caught-contract"
                || command == "mail-accounting-contract"
                || command == "mail-delivery-contract"
            {
                OpenMode::ReadWrite
            } else {
                OpenMode::ReadOnly
            },
            ..Default::default()
        },
    )?;
    match command.as_str(){
        "atomic-contract"=>atomic_contract(store,&path),
        "session-contract"=>session_contract(store),
        "repository-contract"=>repository_contract(store),
        "transcript-contract"=>transcript_contract(store),
        "execution-contract"=>execution_contract(store),
        "legacy-mail-origin-create-contract"=>legacy_mail_origin_create_contract(store,false),
        "legacy-mail-origin-missing-receipt-contract"=>legacy_mail_origin_create_contract(store,true),
        "legacy-mail-create-ack-contract"=>legacy_mail_create_ack_contract(store),
        "legacy-mail-body-contract"=>legacy_mail_body_contract(store,false),
        "legacy-mail-origin-body-contract"=>legacy_mail_body_contract(store,true),
        "legacy-mail-origin-body-read-contract"=>legacy_mail_origin_body_read_contract(store),
        "legacy-mail-body-read-contract"=>{let envelopes=store.read_snapshot(|tx|tx.legacy_mail_inbox(&hrc_store::LegacyMailActor::Operator{principal:"fixture".into()},"agent:tabularasa:project:hrc-runtime:task:p1-store"))?;store.close()?;Ok(serde_json::json!({"envelopes":envelopes}))},
        "consumer-history-contract"=>consumer_history_contract(store,&path),
        "consumer-history-read"=>consumer_history_read(store),
        "consumer-maintenance-read"=>{let value=store.read_snapshot(|tx|{let mut cases=serde_json::Map::new();for name in ["consumer-maint-shared","consumer-maint-different","consumer-restub-valid","consumer-restub-missing","consumer-restub-incomplete","consumer-restub-mismatch","consumer-restub-invalid","consumer-strip-payload","consumer-strip-null","consumer-strip-stripped","consumer-buffer-old","consumer-buffer-recent","consumer-buffer-live-run","consumer-buffer-live-runtime","consumer-buffer-active-run"]{cases.insert(name.into(),serde_json::json!({"brokerEvents":tx.broker_events_by_invocation(name)?,"lifecycle":tx.lifecycle_events().list(&hrc_store::LifecycleFilters{runtime_id:Some(name.into()),..Default::default()},false)?,"buffers":tx.runtime_buffers_by_runtime(name)?}));}Ok(serde_json::Value::Object(cases))})?;store.close()?;Ok(value)},
        "consumer-placement-active"|"consumer-placement-conflict"=>consumer_placement_active(store,command.ends_with("-conflict")),
        "consumer-archive-history"=>consumer_archive_history(store),
        "consumer-archive-read"=>{let value=store.read_snapshot(|tx|Ok(serde_json::json!({"events":tx.legacy_events_from_seq(0,&hrc_store::LegacyEventFilters::default())?,"streamHighWater":tx.allocated_event_stream_seq()?})))?;store.close()?;Ok(value)},
        "consumer-append-control"=>consumer_append_control(store),
        "consumer-registry-read"=>{let mut registry=hrc_store::BindingRegistry::open_existing(value("--registry").ok_or_else(||StoreError::Invalid("explicit --registry required".into()))?,OpenOptions{mode:OpenMode::ReadOnly,..Default::default()})?;let rows=registry.read_snapshot(|tx|tx.list())?;registry.close()?;store.close()?;Ok(serde_json::json!({"bindings":rows}))},
        "consumer-reload"=>{let value=store.read_snapshot(|tx|Ok(serde_json::json!({"run":tx.run_by_id("p1-app")?,"correlationJson":tx.run_correlation_json("p1-app")?})))?;store.close()?;Ok(value)},
        "input-contract"=>input_contract(store),
        "broker-contract"=>broker_contract(store),
        "recovery-contract"=>recovery_contract(store),
        "grants-contract"=>grants_contract(store),
        "participants-contract"=>participants_contract(store),
        "messages-contract"=>messages_contract(store),
        "reconciliation-query-contract"=>reconciliation_query_contract(store),
        "reconciliation-cas-contract"=>reconciliation_cas_contract(store),
        "authority-contract"=>authority_contract(store),
        "ledgers-contract"=>ledgers_contract(store),
        "edges-contract"=>edges_contract(store),
        "serialization-contract"=>serialization_contract(store),
        "replication-contract"=>replication_contract(store),
        "outbox-contract"=>outbox_contract(store),
        "collective-contract"=>collective_contract(store),
        "title-reappend-contract"=>{let title=store.read_snapshot(|tx|tx.session_title("p1-host"))?.expect("existing title");let value=store.write(|tx|tx.upsert_session_title(&title))?.value;store.close()?;Ok(serde_json::to_value(value)?)},
        "title-read-contract"=>store.read_snapshot(|tx|Ok(serde_json::json!({"one":tx.session_title("p1-host")?,"all":tx.list_session_titles()?,"missing":tx.session_title("absent")?}))),
        "legacy-mail-read-contract"=>legacy_mail_read_contract(store),
        "legacy-mail-transition-contract"=>legacy_mail_transition_contract(store),
        "legacy-mail-origin-contract"=>legacy_mail_origin_contract(store),
        "legacy-mail-present-caught-contract"=>{let before=store.read_snapshot(|tx|tx.require_legacy_mail_envelope("legacy-envelope-2"))?;let rejected=store.write(|tx|Ok(tx.present_pending_legacy_mail("agent:tabularasa:project:hrc-runtime:task:p1-store",100,"2026-10-23T00:00:00.000Z").is_err()))?.value;let after=store.read_snapshot(|tx|tx.require_legacy_mail_envelope("legacy-envelope-2"))?;store.close()?;Ok(serde_json::json!({"rejected":rejected,"before":before,"after":after}))},
        "append-boundary-contract"=>append_boundary_contract(store),
        "continuation-maintenance-seed"=>continuation_maintenance_seed(store),
        "continuation-maintenance-contract"=>continuation_maintenance_contract(store),
        "continuation-maintenance-repair-only"=>{let repaired=store.write(|tx|tx.repair_continuation_history())?.value;let repeat=store.write(|tx|tx.repair_continuation_history())?.value;store.close()?;Ok(serde_json::json!({"repaired":repaired,"repeated":repeat}))},
        "snapshot-contract"=>snapshot_contract(store,&path),
        "mail-accounting-contract"=>mail_accounting_contract(store),
        "mail-delivery-contract"=>mail_delivery_contract(store),
        "serialization-observe"=>{let page=store.read_snapshot(|tx|tx.lifecycle_events().page(0,100,None))?;if hrc_domain::api::EventPage::try_from(page.clone()).is_ok(){return Err(StoreError::Invalid("UTF-16 API bridge silently accepted unrepresentable page".into()))}let seq=page.head;let hydrated=store.read_snapshot(|tx|tx.lifecycle_events().get(seq))?;let events=store.read_snapshot(|tx|tx.broker_events_by_invocation("p1-json"))?;store.close()?;Ok(serde_json::json!({"page":page,"hydrated":hydrated,"events":events}))},
        "index-contract"=>index_contract(store),
        "placement-absent-contract"=>placement_absent_contract(store,&path),
        "placement-registry-contract"=>placement_registry_contract(store,&PathBuf::from(value("--registry").ok_or_else(||StoreError::Invalid("explicit --registry required".into()))?)),
        "active-delivery-contract"=>active_delivery_contract(store),
        "prune-minimal-contract"=>prune_contract(store,false),
        "prune-full-contract"=>prune_contract(store,true),
        "prune-return-full-batch"|"prune-return-full-single"|"prune-return-minimal-batch"|"prune-return-minimal-single"=>{
            let ids=value("--ids").ok_or_else(||StoreError::Invalid("explicit --ids required".into()))?.split(',').map(str::to_owned).collect::<Vec<_>>();
            prune_return_contract(store,&ids,command.contains("-full-"),command.ends_with("-single"))
        },
        "crash-contract"=>crash_contract(store,value("--phase").as_deref().unwrap_or("")),
        "inspect"=>store.read_snapshot(|tx|Ok(serde_json::json!({"ledgerIncarnationId":tx.lifecycle_events().ledger_incarnation_id()?,"head":tx.lifecycle_events().allocated_hrc_seq()?}))),
        "page"=>{
            let after=value("--after").unwrap_or("0".into()).parse().map_err(|_|StoreError::Invalid("after".into()))?;
            let limit=value("--limit").unwrap_or("100".into()).parse().map_err(|_|StoreError::Invalid("limit".into()))?;
            let incarnation=value("--incarnation");
            store.read_snapshot(|tx|Ok(serde_json::to_value(tx.lifecycle_events().page(after,limit,incarnation.as_deref())?)?))
        },
        _=>Err(StoreError::Invalid("unknown scenario".into()))
    }
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("mail-schema-values") {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            let input = serde_json::parse(&line.expect("input line")).expect("valid JSON input");
            let schema = input.get("schema").expect("schema input");
            let response = input.get("response").expect("response input");
            match hrc_store::CompiledMailReplySchema::compile(schema)
                .and_then(|compiled| compiled.validate(response))
            {
                Ok(result) => println!("{}", serde_json::json!({"result":result})),
                Err(error) => println!("{}", serde_json::json!({"error":error})),
            }
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("mail-json-values") {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            let value = serde_json::parse(&line.expect("input line")).expect("valid JSON input");
            println!(
                "{}",
                serde_json::json!({"canonical":hrc_store::canonical_mail_json(&value),"fingerprint":hrc_store::fingerprint_mail_json(&value)})
            );
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("json-compat-values") {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            match serde_json::parse(&line.expect("input line")) {
                Ok(v) => println!("{}", v.stringify()),
                Err(_) => println!("INVALID_JSON"),
            }
        }
        return;
    }

    match run() {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("{error}");
            println!(
                "{}",
                serde_json::json!({"error":{"code":error.code(),"message":error.to_string()}})
            );
            std::process::exit(1)
        }
    }
}

fn atomic_contract(
    mut store: Store,
    path: &std::path::Path,
) -> Result<serde_json::Value, StoreError> {
    use std::{cell::RefCell, rc::Rc};
    let initial = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    let bridged = hrc_domain::api::EventPage::try_from(initial.clone())?;
    if bridged.head != initial.head
        || bridged.scanned_through != initial.scanned_through
        || bridged.rows.len() != initial.rows.len()
    {
        return Err(StoreError::Invalid(
            "API page bridge changed coverage".into(),
        ));
    }

    let fields = initial
        .rows
        .first()
        .ok_or_else(|| StoreError::MissingRecord("nonempty fixture required".into()))?
        .fields
        .clone();
    let hints = Rc::new(RefCell::new(Vec::new()));
    let observed = hints.clone();
    store.observe(move |change| {
        observed
            .borrow_mut()
            .push(serde_json::to_value(change).expect("typed change serializes"))
    });
    let rollback = store.write::<()>(|tx| {
        tx.append_lifecycle(&fields)?;
        Err(StoreError::Invalid("deliberate outer rollback".into()))
    });
    if rollback.is_ok() || !hints.borrow().is_empty() {
        return Err(StoreError::Invalid("rollback leaked hint".into()));
    }
    let after = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    if after != initial {
        return Err(StoreError::Invalid("outer rollback changed ledger".into()));
    }
    let mut large = fields.clone();
    large.event_kind = "turn.tool_result".into();
    large.runtime_id = Some("p1-blob-runtime".into());
    let result = serde_json::json!({"content":[{"type":"text","text":"🫠".repeat(20000)}],"details":{"status":"ok"}});
    large.payload = Some(serde_json::json!({"result":result}));
    let committed = store.write(|tx| {
        let inner = tx.savepoint::<()>(|nested| {
            nested.append_lifecycle(&fields)?;
            Err(StoreError::Invalid("deliberate savepoint rollback".into()))
        });
        if inner.is_ok() {
            return Err(StoreError::Invalid("savepoint expected refusal".into()));
        }
        tx.append_lifecycle(&large)
    })?;
    if committed.changes.len() != 1 || hints.borrow().len() != 1 {
        return Err(StoreError::Invalid("savepoint hints leaked".into()));
    }
    let page = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    let written = page
        .rows
        .last()
        .ok_or_else(|| StoreError::MissingRecord("native committed row".into()))?;
    if page.rows.len() != initial.rows.len() + 1
        || written
            .fields
            .payload
            .as_ref()
            .and_then(|v| v.get("result"))
            .and_then(|v| v.get("details"))
            .and_then(|v| v.get("spill"))
            .is_none()
    {
        return Err(StoreError::Invalid("spill stub missing".into()));
    }
    let hydrated = store
        .read_snapshot(|tx| tx.lifecycle_events().get(written.hrc_seq))?
        .ok_or_else(|| StoreError::MissingRecord("hydrated event".into()))?;
    if hydrated.fields.payload != large.payload {
        return Err(StoreError::Invalid("hydration differs".into()));
    }
    let first = BlobPart {
        blob_id: "p1-part".into(),
        runtime_id: "p1-blob-runtime".into(),
        kind: BlobKind::BrokerRaw,
        bytes: 7,
        part: 0,
        parts: 2,
        chunk: "{\"a\":".into(),
    };
    let outcome = store.write(|tx| tx.ingest_blob_part(&first))?;
    if outcome.value.completed {
        return Err(StoreError::Invalid("partial blob completed".into()));
    }
    let mut last = first.clone();
    last.part = 1;
    last.chunk = "1}".into();
    last.bytes = 8;
    if store.write(|tx| tx.ingest_blob_part(&last)).is_ok() {
        return Err(StoreError::Invalid("invalid bytes accepted".into()));
    }
    last.bytes = 7;
    let complete = store.write(|tx| tx.ingest_blob_part(&last))?;
    if !complete.value.completed {
        return Err(StoreError::Invalid("blob assembly incomplete".into()));
    }
    let blob = store
        .read_snapshot(|tx| tx.tool_result_blobs().get("p1-part"))?
        .ok_or_else(|| StoreError::MissingRecord("assembled blob".into()))?;
    if blob.result_json != "{\"a\":1}" {
        return Err(StoreError::Invalid("blob assembly changed".into()));
    }
    store.observe(|_| panic!("deliberate observer failure control"));
    let success = store.write(|tx| tx.append_lifecycle(&fields))?;
    if success.changes.len() != 1 {
        return Err(StoreError::Invalid("commit hint missing".into()));
    }
    store.close()?;
    let mut reader = Store::open_existing(path, OpenOptions::default())?;
    if reader.write(|tx| tx.append_lifecycle(&fields)).is_ok() {
        return Err(StoreError::Invalid("read-only write accepted".into()));
    }
    Ok(
        serde_json::json!({"outerRollback":true,"savepointRollback":true,"commitHintsOnly":true,"observerFailureIsolated":true,"spillHydration":true,"blobPartsValidated":true,"readOnlyRefusal":true,"nativeCommittedSeq":success.value.hrc_seq,"hydratedUtf8Bytes":serde_json::to_string(&large.payload)?.len()}),
    )
}

fn session_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::{MetadataSource, MetadataWrite, SessionTitle};
    let first = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle host".into()))?;
    let mut next = first.clone();
    next.host_session_id = "p1-host-next".into();
    next.generation = 2;
    next.prior_host_session_id = Some(first.host_session_id.clone());
    let continuity = store
        .write(|tx| {
            tx.insert_session(&next)?;
            tx.upsert_continuity(
                &first.scope_ref,
                &first.lane_ref,
                &next.host_session_id,
                &first.updated_at,
            )
        })?
        .value;
    if continuity.prior_host_session_ids != vec![first.host_session_id.clone()] {
        return Err(StoreError::Invalid("lineage differs".into()));
    }
    store.write(|tx| {
        tx.set_continuation_reuse_disabled(&next.host_session_id, true, &next.updated_at)?;
        if !tx
            .read()
            .sessions()
            .is_continuation_reuse_disabled(&next.host_session_id)?
        {
            return Err(StoreError::Invalid("reuse flag absent".into()));
        }
        tx.update_session_continuation(
            &next.host_session_id,
            &serde_json::json!({"nativeId":"p1-session"}),
            &next.updated_at,
        )
    })?;
    if store.read_snapshot(|tx| {
        tx.sessions()
            .is_continuation_reuse_disabled(&next.host_session_id)
    })? {
        return Err(StoreError::Invalid("reuse flag not reset".into()));
    }
    let metadata = MetadataWrite {
        scope_ref: first.scope_ref.clone(),
        lane_ref: first.lane_ref.clone(),
        source: MetadataSource::Hrc,
        set: serde_json::json!({"title":"fallback","appearance":{"color":"#112233"}}),
        clear: vec![],
        replace: false,
        updated_by: "p1-native".into(),
        updated_at: first.updated_at.clone(),
    };
    store.write(|tx| tx.write_session_metadata(&metadata))?;
    let title = SessionTitle {
        host_session_id: first.host_session_id.clone(),
        title: "native title".into(),
        source: "manual".into(),
        model: None,
        created_at: first.created_at.clone(),
        updated_at: first.updated_at.clone(),
    };
    store.write(|tx| tx.upsert_session_title(&title))?;
    let resolved =
        store.read_snapshot(|tx| tx.session_metadata(&first.scope_ref, &first.lane_ref))?;
    if resolved.metadata["title"] != "native title"
        || resolved.metadata_sources["title"].shadowed.len() != 1
    {
        return Err(StoreError::Invalid("metadata precedence differs".into()));
    }
    let same = store
        .read_snapshot(|tx| tx.session_title(&next.host_session_id))?
        .ok_or_else(|| StoreError::MissingRecord("successor title".into()))?;
    if same.title != "native title".into() {
        return Err(StoreError::Invalid("title not continuity scoped".into()));
    }
    store.write(|tx| tx.delete_session_title(&first.host_session_id, &first.updated_at))?;
    if store
        .read_snapshot(|tx| tx.session_title(&next.host_session_id))?
        .map(|t| t.title)
        != Some("fallback".into())
    {
        return Err(StoreError::Invalid(
            "clear hides lower metadata layer".into(),
        ));
    }
    let head = store.read_snapshot(|tx| tx.lifecycle_events().allocated_hrc_seq())?;
    let mut bad = metadata.clone();
    bad.source = MetadataSource::Api;
    bad.set = serde_json::json!({"title":"","valid":true});
    if store.write(|tx| tx.write_session_metadata(&bad)).is_ok() {
        return Err(StoreError::Invalid("bad api metadata accepted".into()));
    }
    if store.read_snapshot(|tx| tx.lifecycle_events().allocated_hrc_seq())? != head {
        return Err(StoreError::Invalid(
            "bad metadata leaked lifecycle event".into(),
        ));
    }
    store.write(|tx| tx.advance_wrkq_cursor("p1-native", 9, &first.updated_at))?;
    let high = store
        .write(|tx| tx.advance_wrkq_cursor("p1-native", 4, &first.updated_at))?
        .value;
    if high != 9 {
        return Err(StoreError::Invalid("cursor rewound".into()));
    }
    Ok(
        serde_json::json!({"lineage":true,"continuationReuseReset":true,"metadataPrecedence":true,"titleContinuityFacade":true,"metadataRollback":true,"cursorMonotonic":true,"head":head}),
    )
}

fn repository_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let scope = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let claim = RosterClaim {
        idempotency_key: "p1-claim".into(),
        request_hash: "hash".into(),
        base_scope: scope.into(),
        claimed_scope: format!("{scope}-suffix"),
        successor_host_session_id: "p1-host".into(),
        created_at: at.into(),
    };
    store.write(|tx| tx.insert_roster_claim(&claim))?;
    if store
        .read_snapshot(|tx| tx.roster_claims_by_base_scope(scope))?
        .len()
        != 1
    {
        return Err(StoreError::Invalid("roster not persisted".into()));
    }
    let acceptance = FederationAcceptedRequest {
        request_message_id: "p1-message".into(),
        accepted_by_node_id: "p1-node".into(),
        accepted_epoch: 1,
        accepted_at: at.into(),
    };
    if store
        .write(|tx| tx.record_federation_acceptance(&acceptance))?
        .value
        .outcome
        != RecordOutcome::Recorded
    {
        return Err(StoreError::Invalid("ACK not recorded".into()));
    }
    if store
        .write(|tx| tx.record_federation_acceptance(&acceptance))?
        .value
        .outcome
        != RecordOutcome::Duplicate
    {
        return Err(StoreError::Invalid("ACK not duplicate".into()));
    }
    let mut conflict = acceptance.clone();
    conflict.accepted_epoch = 2;
    if store
        .write(|tx| tx.record_federation_acceptance(&conflict))
        .is_ok()
    {
        return Err(StoreError::Invalid("divergent ACK accepted".into()));
    }
    let peer = FederationPeerAcceptance {
        message_id: "p1-peer".into(),
        accepted_by_node_id: "p1-node".into(),
        phase: "request".into(),
        request_epoch: Some(1),
        ack_outcome: Some("accepted".into()),
        accepted_at: at.into(),
    };
    store.write(|tx| tx.record_federation_peer_acceptance(&peer))?;
    let artifact = RuntimeArtifact {
        artifact_id: "p1-artifact".into(),
        operation_id: "p1-operation".into(),
        artifact_kind: "provider-transcript".into(),
        media_type: "application/json".into(),
        storage_kind: "inline-json".into(),
        content_hash: "fixture-hash".into(),
        artifact_json: Some("{}".into()),
        artifact_path: None,
        created_at: at.into(),
    };
    store.write(|tx| tx.insert_runtime_artifact_idempotent(&artifact))?;
    store.write(|tx| tx.insert_runtime_artifact_idempotent(&artifact))?;
    let mut artifact_conflict = artifact.clone();
    artifact_conflict.content_hash = "different".into();
    if store
        .write(|tx| tx.insert_runtime_artifact_idempotent(&artifact_conflict))
        .is_ok()
    {
        return Err(StoreError::Invalid("artifact conflict accepted".into()));
    }
    let key = permission_identity_key("p1-invocation", Some(1), None, "p1-permission");
    let permission = PermissionDecision {
        permission_identity_key: key.clone(),
        permission_request_id: "p1-permission".into(),
        invocation_id: "p1-invocation".into(),
        harness_generation: Some(1),
        turn_attempt: None,
        runtime_id: "p1-runtime".into(),
        run_id: Some("p1-run".into()),
        kind: "tool".into(),
        subject_display_json: "{}".into(),
        default_decision: "deny".into(),
        decision: "allow".into(),
        decided_by: "user".into(),
        policy_json: "{}".into(),
        requested_at: at.into(),
        decided_at: at.into(),
    };
    store.write(|tx| tx.insert_permission_decision(&permission))?;
    if store
        .read_snapshot(|tx| tx.permissions_by_invocation("p1-invocation"))?
        .first()
        .map(|p| p.permission_identity_key.as_str())
        != Some(key.as_str())
    {
        return Err(StoreError::Invalid("permission identity lost".into()));
    }
    let mut outcome = RetainedOutcome {
        outcome_id: 0,
        runtime_id: "p1-runtime".into(),
        invocation_id: "p1-invocation".into(),
        recorded_at: at.into(),
        outcome: "first".into(),
        outcome_class: "incomplete".into(),
        trigger: "operator".into(),
        attempts: 1,
        detail: serde_json::json!({"fixtureOnly":true}),
    };
    store.write(|tx| tx.append_retained_outcome(&outcome))?;
    outcome.outcome = "second".into();
    store.write(|tx| tx.append_retained_outcome(&outcome))?;
    if store
        .read_snapshot(|tx| tx.retained_by_runtime("p1-runtime"))?
        .len()
        != 2
        || store
            .read_snapshot(|tx| tx.retained_latest_by_runtime("p1-runtime"))?
            .len()
            != 1
    {
        return Err(StoreError::Invalid("retained audit lost".into()));
    }
    if !store
        .write(|tx| tx.claim_emission("p1-event", scope, "changed", at))?
        .value
        || store
            .write(|tx| tx.claim_emission("p1-event", scope, "changed", at))?
            .value
        || store.read_snapshot(|tx| tx.emission_count_since(scope, "changed", at))? != 1
    {
        return Err(StoreError::Invalid("emission duplicate".into()));
    }
    for n in [2, 0, 1] {
        store.write(|tx| {
            tx.append_runtime_buffer(&RuntimeBuffer {
                runtime_id: "p1-runtime".into(),
                run_id: "p1-run".into(),
                chunk_seq: n,
                text: format!("{n}"),
                created_at: at.into(),
            })
        })?;
    }
    let tail = store.read_snapshot(|tx| tx.runtime_buffers_tail_by_run("p1-run", 2))?;
    if tail.iter().map(|r| r.chunk_seq).collect::<Vec<_>>() != vec![1, 2] {
        return Err(StoreError::Invalid("buffer tail order".into()));
    }
    let mut binding = SurfaceBinding {
        surface_kind: "ghostty".into(),
        surface_id: "p1-surface".into(),
        client_tty: Some("p1-tty".into()),
        host_session_id: "p1-host".into(),
        runtime_id: "p1-runtime".into(),
        generation: 1,
        window_id: None,
        pane_id: None,
        bound_at: at.into(),
        unbound_at: None,
        reason: None,
    };
    store.write(|tx| tx.bind_surface(&binding))?;
    binding.surface_id = "p1-successor".into();
    store.write(|tx| {
        let displaced =
            tx.unbind_other_ghostty_client_tty("p1-tty", &binding.surface_id, at, "replaced")?;
        if displaced.len() != 1 {
            return Err(StoreError::Invalid("surface displace count".into()));
        }
        tx.bind_surface(&binding)
    })?;
    let bridge = LocalBridge {
        bridge_id: "p1-bridge".into(),
        host_session_id: "p1-host".into(),
        runtime_id: Some("p1-runtime".into()),
        transport: "discord".into(),
        target: "p1-target".into(),
        expected_host_session_id: None,
        expected_generation: None,
        status: "active".into(),
        created_at: at.into(),
        closed_at: None,
    };
    store.write(|tx| tx.create_local_bridge(&bridge))?;
    store.write(|tx| tx.close_local_bridge(&bridge.bridge_id, at))?;
    if !store.read_snapshot(|tx| tx.active_bridges())?.is_empty() {
        return Err(StoreError::Invalid("closed bridge active".into()));
    }
    Ok(
        serde_json::json!({"rosterAtomic":true,"acceptanceIdempotency":true,"acceptanceConflict":true,"permissionIdentity":true,"artifactIdempotency":true,"retainedAppendOnly":true,"emissionClaimDedup":true,"bufferOrdering":true,"surfaceReplacement":true,"bridgeClose":true}),
    )
}

fn transcript_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let options = TranscriptSearchOptions {
        limit: 10,
        ..Default::default()
    };
    let filters = TranscriptSearchFilters::default();
    let mut turn = TranscriptTurn {
        turn_rowid: None,
        invocation_id: "p1-fts-a".into(),
        runtime_id: "p1-runtime-a".into(),
        agent: Some("tabularasa".into()),
        project: Some("hrc-runtime".into()),
        task: None,
        scope_ref: Some("p1-fts-scope".into()),
        generation: Some(1),
        seq_from: 1,
        seq_to: 2,
        started_at: "2026-10-23T00:00:00Z".into(),
        completed_at: "2026-10-23T00:00:01Z".into(),
        terminal_status: "completed".into(),
        message_count: 2,
        truncated: false,
        user_text: "café".into(),
        final_text: "alpha".into(),
        mid_text: "".into(),
    };
    store.write(|tx| tx.upsert_transcript_turn(&turn))?;
    if store
        .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &options))?
        .len()
        != 1
    {
        return Err(StoreError::Invalid("unicode tokenizer differs".into()));
    }
    let rollback = store.write::<()>(|tx| {
        tx.delete_transcript_turns_for_invocation(&turn.invocation_id)?;
        Err(StoreError::Invalid("FTS rollback control".into()))
    });
    if rollback.is_ok()
        || store
            .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &options))?
            .len()
            != 1
    {
        return Err(StoreError::Invalid("FTS rollback lost match".into()));
    }
    turn.user_text = "newword".into();
    store.write(|tx| tx.upsert_transcript_turn(&turn))?;
    if !store
        .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &options))?
        .is_empty()
    {
        return Err(StoreError::Invalid("FTS old text survived update".into()));
    }
    turn.user_text = "café".into();
    store.write(|tx| tx.upsert_transcript_turn(&turn))?;
    turn.seq_from = 3;
    turn.seq_to = 4;
    store.write(|tx| tx.upsert_transcript_turn(&turn))?;
    turn.invocation_id = "p1-fts-b".into();
    turn.runtime_id = "p1-runtime-b".into();
    turn.seq_from = 1;
    turn.seq_to = 2;
    store.write(|tx| tx.upsert_transcript_turn(&turn))?;
    let cap = TranscriptSearchOptions {
        limit: 10,
        per_runtime_cap: Some(1),
        weights: [1.0; 3],
    };
    if store
        .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &cap))?
        .len()
        != 2
    {
        return Err(StoreError::Invalid("runtime cap differs".into()));
    }
    let invalid = TranscriptSearchOptions {
        weights: [-1.0, 1.0, 1.0],
        ..Default::default()
    };
    if store
        .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &invalid))
        .is_ok()
    {
        return Err(StoreError::Invalid("negative BM25 accepted".into()));
    }
    store.write(|tx| tx.delete_transcript_turns_for_invocation("p1-fts-b"))?;
    if store
        .read_snapshot(|tx| tx.search_transcript("cafe", &filters, &options))?
        .len()
        != 2
    {
        return Err(StoreError::Invalid("FTS delete count differs".into()));
    }
    store.write(|tx| {
        tx.set_transcript_cursor(7, "now")?;
        tx.set_transcript_invocation_mark(&TranscriptInvocationMark {
            invocation_id: "p1-fts-a".into(),
            runtime_id: "p1-runtime-a".into(),
            last_terminal_seq: 4,
            updated_at: "now".into(),
        })
    })?;
    if store
        .read_snapshot(|tx| tx.transcript_stats())?
        .last_event_id
        != 7
        || store
            .read_snapshot(|tx| tx.transcript_invocation_mark("p1-fts-a"))?
            .map(|m| m.last_terminal_seq)
            != Some(4)
    {
        return Err(StoreError::Invalid("index cursor/mark differs".into()));
    }
    Ok(
        serde_json::json!({"ftsInsertUpdateDelete":true,"ftsRollback":true,"unicodeTokenizer":true,"perRuntimeCap":true,"invalidWeights":true,"cursorAndMark":true}),
    )
}

fn execution_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let existing = store
        .read_snapshot(|tx| tx.run_by_id("p1-run"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle run".into()))?;
    if store.reserve_run_id("p1-app", "secret", "p1-host", 1)? != RunReservationOutcome::Reserved {
        return Err(StoreError::Invalid("reserve failed".into()));
    }
    let writer = RunWriter {
        runtime_id: Some("p1-runtime".into()),
        operation_id: Some("p1-op".into()),
        host_session_id: "p1-host".into(),
        generation: 1,
    };
    if store
        .write(|tx| tx.assert_can_create_run("p1-app", &writer))
        .is_ok()
    {
        return Err(StoreError::Invalid("reservation token bypassed".into()));
    }
    let attempt = store.write::<()>(|tx| {
        tx.with_run_token("p1-app", "secret", |tx| {
            tx.assert_can_create_run(
                "p1-app",
                &RunWriter {
                    runtime_id: Some("rolled-back-runtime".into()),
                    ..writer.clone()
                },
            )?;
            Err(StoreError::Invalid("rollback reserved binding".into()))
        })
    });
    if attempt.is_ok() {
        return Err(StoreError::Invalid(
            "reservation rollback control did not fail".into(),
        ));
    }
    let mut app = existing.clone();
    app.run_id = "p1-app".into();
    app.scope_ref = "app:p1-fixture".into();
    app.operation_id = writer.operation_id.clone();
    store.write(|tx| tx.with_run_token("p1-app", "secret", |tx| tx.insert_run(&app)))?;
    if store
        .write(|tx| {
            tx.assert_can_name_active_run(
                Some("p1-app"),
                &RunWriter {
                    generation: 2,
                    ..writer.clone()
                },
            )
        })
        .is_ok()
    {
        return Err(StoreError::Invalid(
            "sealed tuple generation bypassed".into(),
        ));
    }
    if store
        .write(|tx| tx.assert_contribution_may_name_run("p1-app"))
        .is_ok()
    {
        return Err(StoreError::Invalid("contribution app run bypassed".into()));
    }
    let updated = store
        .write(|tx| {
            tx.update_run(
                "p1-run",
                &RunPatch {
                    status: Patch::Set("running".into()),
                    started_at: Patch::Set("late".into()),
                    ..Default::default()
                },
            )
        })?
        .value
        .ok_or_else(|| StoreError::MissingRecord("run".into()))?;
    if updated.status != "completed" || updated.started_at.is_some() {
        return Err(StoreError::Invalid(
            "terminal run resurrected implicitly".into(),
        ));
    }
    let resurrected = store
        .write(|tx| {
            tx.update_run(
                "p1-run",
                &RunPatch {
                    status: Patch::Set("running".into()),
                    completed_at: Patch::Clear,
                    ..Default::default()
                },
            )
        })?
        .value
        .ok_or_else(|| StoreError::MissingRecord("run".into()))?;
    if resurrected.status != "running" || resurrected.completed_at.is_some() {
        return Err(StoreError::Invalid("explicit resurrection refused".into()));
    }
    store.write(|tx| tx.update_runtime_status("p1-runtime", "ready", "2026-10-23T01:00:00Z"))?;
    let unchanged = store
        .write(|tx| tx.update_runtime_status("p1-runtime", "ready", "2026-10-23T02:00:00Z"))?
        .value
        .ok_or_else(|| StoreError::MissingRecord("runtime".into()))?;
    if unchanged.status_changed_at != "2026-10-23T01:00:00Z" {
        return Err(StoreError::Invalid(
            "status timestamp moved on no-op".into(),
        ));
    }
    for n in 0..3 {
        let mut run = existing.clone();
        run.run_id = format!("p1-queued-{n}");
        run.status = "queued".into();
        run.completed_at = None;
        run.runtime_id = None;
        run.queued_input_seq = Some(n);
        store.write(|tx| tx.insert_run(&run))?;
    }
    let snapshot = store
        .write(|tx| tx.snapshot_queued_by_host("p1-host", "p1-snapshot", "now"))?
        .value;
    if snapshot.len() != 3
        || snapshot
            .iter()
            .map(|r| r.queue_snapshot_position.unwrap_or(-1))
            .collect::<Vec<_>>()
            != vec![0, 1, 2]
    {
        return Err(StoreError::Invalid(
            "queue snapshot ordering differs".into(),
        ));
    }
    if !store
        .write(|tx| {
            tx.claim_queued_run(
                "p1-queued-0",
                Some("p1-runtime"),
                None,
                None,
                Some("p1-input"),
                "now",
            )
        })?
        .value
        || store
            .write(|tx| {
                tx.claim_queued_run("p1-queued-0", Some("p1-runtime"), None, None, None, "now")
            })?
            .value
    {
        return Err(StoreError::Invalid("queue claim not atomic".into()));
    }
    store.write(|tx| tx.mark_queued_coalesced("p1-queued-1", "p1-queued-0", 1, "now", "now"))?;
    store.write(|tx| tx.set_run_correlation_json("p1-run", Some("{\"attemptRef\":\"one\"}")))?;
    store.write(|tx| tx.set_run_correlation_json("p1-run", Some("{\"attemptRef\":\"two\"}")))?;
    if store.read_snapshot(|tx| tx.run_correlation_json("p1-run"))?
        != Some("{\"attemptRef\":\"two\"}".into())
    {
        return Err(StoreError::Invalid("correlation not whole document".into()));
    }
    let mut bad = existing.clone();
    bad.run_id = "p1-fk-bad".into();
    bad.runtime_id = Some("no-such-runtime".into());
    let before = store
        .read_snapshot(|tx| {
            tx.list_runs(&RunFilters {
                limit: Some(100),
                ..Default::default()
            })
        })?
        .len();
    if store.write(|tx| tx.insert_run(&bad)).is_ok()
        || store
            .read_snapshot(|tx| {
                tx.list_runs(&RunFilters {
                    limit: Some(100),
                    ..Default::default()
                })
            })?
            .len()
            != before
    {
        return Err(StoreError::Invalid("foreign key partial effect".into()));
    }
    Ok(
        serde_json::json!({"reservationTuple":true,"reservationRollback":true,"terminalMonotonicity":true,"explicitResurrection":true,"runtimeStatusTimestamp":true,"queueSnapshotClaim":true,"correlationWholeDocument":true,"foreignKeyRollback":true}),
    )
}

fn input_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00Z";
    let input = InputRecord {
        input_id: "p1-input".into(),
        admission_host_session_id: "p1-host".into(),
        idempotency_key: "p1-input-key".into(),
        request_hash: "p1-hash".into(),
        host_session_id: Some("p1-host".into()),
        runtime_id: Some("p1-runtime".into()),
        operation_id: Some("p1-operation".into()),
        invocation_id: Some("p1-invocation".into()),
        status: "accepted".into(),
        cleanup_protection: "protected".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    store.write(|tx| tx.insert_input(&input))?;
    store.write(|tx| tx.bind_input_broker_submission(&input.input_id, "submission-one", at))?;
    store.write(|tx| tx.bind_input_broker_submission(&input.input_id, "submission-one", at))?;
    if store
        .write(|tx| tx.bind_input_broker_submission(&input.input_id, "submission-two", at))
        .is_ok()
    {
        return Err(StoreError::Invalid("input carrier overwritten".into()));
    }
    let landing = InputLanding {
        input_id: input.input_id.clone(),
        kind: "initiating".into(),
        carrier_run_id: "p1-carrier".into(),
        turn_id: "p1-turn".into(),
        run_started_hrc_seq: 1,
        landed_at: at.into(),
    };
    if store.write(|tx| tx.record_input_landing(&landing)).is_ok() {
        return Err(StoreError::Invalid("imagined carrier accepted".into()));
    }
    let mut run = store
        .read_snapshot(|tx| tx.run_by_id("p1-run"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle run".into()))?;
    run.run_id = "p1-carrier".into();
    run.status = "running".into();
    run.completed_at = None;
    run.execution_format = Some("format2".into());
    run.native_turn_id = Some(landing.turn_id.clone());
    run.operation_id = input.operation_id.clone();
    run.invocation_id = input.invocation_id.clone();
    run.observed_start_hrc_seq = Some(1);
    store.write(|tx| {
        tx.insert_run(&run)?;
        tx.record_input_landing(&landing)
    })?;
    let landed = store
        .read_snapshot(|tx| tx.input_by_id(&input.input_id))?
        .ok_or_else(|| StoreError::MissingRecord(input.input_id.clone()))?;
    if landed.cleanup_protection != "carrier-run"
        || landed.carrier_run_id.as_deref() != Some("p1-carrier")
    {
        return Err(StoreError::Invalid("exact carrier landing lost".into()));
    }
    let mut held = input.clone();
    held.input_id = "p1-held".into();
    held.idempotency_key = "p1-held-key".into();
    store.write(|tx| tx.insert_input(&held))?;
    store.write(|tx| {
        tx.record_input_correlation(&InputCorrelation {
            input_id: held.input_id.clone(),
            fact: "lost".into(),
            observed_at: at.into(),
        })
    })?;
    if store
        .read_snapshot(|tx| tx.protected_inputs_by_runtime("p1-runtime"))?
        .len()
        != 1
    {
        return Err(StoreError::Invalid("correlation released input".into()));
    }
    store.write(|tx| {
        tx.record_input_terminal(&InputTerminal {
            input_id: held.input_id.clone(),
            terminal: "withdrawn".into(),
            terminal_at: at.into(),
            error_code: None,
            error_message: None,
        })
    })?;
    if !store
        .read_snapshot(|tx| tx.protected_inputs_by_invocation("p1-invocation"))?
        .is_empty()
    {
        return Err(StoreError::Invalid("terminal did not release".into()));
    }
    store.write(|tx| tx.record_submission_disposition("p1-submission", "executed", at, false))?;
    store.write(|tx| {
        tx.upsert_submission_admission(&SubmissionAdmission {
            submission_id: "p1-submission".into(),
            run_id: Some(run.run_id.clone()),
            door: Some("invoke".into()),
            admitted_at: Some(at.into()),
            ..Default::default()
        })
    })?;
    store.write(|tx| tx.record_submission_disposition("p1-submission", "lost", at, true))?;
    let receipt = store
        .read_snapshot(|tx| tx.submission_admission("p1-submission"))?
        .ok_or_else(|| StoreError::MissingRecord("submission".into()))?;
    if receipt.disposition.as_deref() != Some("executed")
        || receipt.door.as_deref() != Some("invoke")
    {
        return Err(StoreError::Invalid("submission ordering/fence lost".into()));
    }
    Ok(
        serde_json::json!({"brokerBindOnce":true,"imaginedCarrierRefused":true,"exactCarrierLanding":true,"correlationKeepsProtection":true,"terminalReleaseOnly":true,"submissionOrdering":true,"retainedDispositionFence":true,"landed":landed,"submission":receipt}),
    )
}

fn broker_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let at = "2026-10-23T00:00:00.000Z";
    let policy = LifecyclePolicy {
        policy_id: "p1-policy".into(),
        lifecycle_policy_hash: "p1-policy-hash".into(),
        canonical_policy_json: "{}".into(),
        schema_version: "1".into(),
        created_at: at.into(),
    };
    let plan = CompiledRuntimePlan {
        plan_hash: "p1-plan-hash".into(),
        compile_id: "p1-compile".into(),
        schema_version: "1".into(),
        compiler_name: "p1".into(),
        compiler_version: "1".into(),
        plan_projection_json: "{}".into(),
        created_at: at.into(),
    };
    let op = RuntimeOperation {
        operation_id: "p1-operation".into(),
        runtime_id: "p1-runtime".into(),
        host_session_id: "p1-host".into(),
        generation: 1,
        operation_kind: "start".into(),
        controller: "broker".into(),
        startup_method: "spawn".into(),
        status: "prepared".into(),
        route_decision_json: "{}".into(),
        preparation_json: Some("{}".into()),
        plan_hash: Some(plan.plan_hash.clone()),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let invocation = BrokerInvocation {
        invocation_id: "p1-invocation".into(),
        operation_id: op.operation_id.clone(),
        runtime_id: "p1-runtime".into(),
        broker_protocol: "1".into(),
        broker_driver: "claude".into(),
        invocation_state: "stopped".into(),
        capabilities_json: "{}".into(),
        spec_hash: "p1-spec".into(),
        start_request_hash: "p1-request".into(),
        selected_profile_hash: "p1-profile".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    store.write(|tx| {
        tx.insert_lifecycle_policy(&policy)?;
        tx.insert_compiled_plan(&plan)?;
        tx.insert_runtime_operation(&op)?;
        tx.insert_broker_invocation(&invocation)?;
        Ok(())
    })?;
    let mut conflicting = plan.clone();
    conflicting.plan_projection_json = "{\"different\":true}".into();
    let kept = store
        .write(|tx| tx.insert_compiled_plan(&conflicting))?
        .value;
    if kept != plan {
        return Err(StoreError::Invalid(
            "content addressed plan replaced".into(),
        ));
    }
    if store
        .read_snapshot(|tx| tx.prepared_operations_by_host("p1-host"))?
        .len()
        != 1
    {
        return Err(StoreError::Invalid("prepared operation absent".into()));
    }
    store.write(|tx| {
        tx.update_broker_invocation(
            "p1-invocation",
            &BrokerInvocationPatch {
                retained_projected_through_seq: Patch::Set(0),
                ..Default::default()
            },
        )
    })?;
    if !store.read_snapshot(|tx| tx.has_retained_projection("p1-runtime"))? {
        return Err(StoreError::Invalid("zero marker ignored".into()));
    }
    let mut run = store
        .read_snapshot(|tx| tx.run_by_id("p1-run"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle run".into()))?;
    run.run_id = "p1-repair".into();
    run.status = "running".into();
    run.completed_at = None;
    store.write(|tx| {
        tx.insert_run(&run)?;
        tx.set_run_correlation_json(
            &run.run_id,
            Some("{\"kind\":\"json_repair\",\"repairRunId\":\"p1-repair\"}"),
        )
    })?;
    let event = BrokerEventAppend {
        invocation_id: invocation.invocation_id.clone(),
        seq: 1,
        time: at.into(),
        r#type: "input.accepted".into(),
        runtime_id: "p1-runtime".into(),
        run_id: Some(run.run_id.clone()),
        payload: json!({"inputId":"p1-input","turnId":"p1-turn"}),
        envelope_json: Some("{\"turnId\":\"p1-turn\"}".into()),
        ..Default::default()
    };
    let first = store.write(|tx| tx.append_broker_event(&event))?.value;
    let duplicate = store.write(|tx| tx.append_broker_event(&event))?.value;
    let mut bad = event.clone();
    bad.turn_attempt = Some(2);
    let conflict = store
        .write(|tx| tx.append_broker_event(&bad))
        .err()
        .ok_or_else(|| StoreError::Invalid("divergent identity accepted".into()))?;
    if !duplicate.1 || first.1 {
        return Err(StoreError::Invalid("raw append idempotency".into()));
    }
    let envelope: serde_json::Value =
        serde_json::from_str(first.0.broker_envelope_json.as_deref().unwrap_or("null"))?;
    if envelope["correlation"]["kind"] != "json_repair" || envelope["payload"] != event.payload {
        return Err(StoreError::Invalid("repair envelope absent".into()));
    }
    let disposition = |seq| ProjectionDisposition {
        invocation_id: invocation.invocation_id.clone(),
        seq,
        envelope_hash: format!("p1-hash-{seq}"),
        disposition: "applied".into(),
        created_at: at.into(),
    };
    let gap = store
        .write(|tx| {
            tx.record_projection_disposition(&disposition(2))?;
            tx.advance_contiguous_projection_cursor(&invocation.invocation_id, at)
        })?
        .value;
    let contiguous = store
        .write(|tx| {
            tx.record_projection_disposition(&disposition(1))?;
            tx.advance_contiguous_projection_cursor(&invocation.invocation_id, at)
        })?
        .value;
    if gap != 0 || contiguous != 2 {
        return Err(StoreError::Invalid("cursor crossed disposition gap".into()));
    }
    let fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    let head = store.read_snapshot(|tx| tx.lifecycle_events().allocated_hrc_seq())?;
    let rollback = store.write::<()>(|tx| {
        let mut next = event.clone();
        next.seq = 3;
        tx.append_broker_event(&next)?;
        tx.append_lifecycle(&fields)?;
        tx.record_projection_disposition(&disposition(3))?;
        tx.advance_contiguous_projection_cursor(&invocation.invocation_id, at)?;
        Err(StoreError::Invalid("deliberate projection rollback".into()))
    });
    let after = store.read_snapshot(|tx| {
        Ok((
            tx.broker_event(&invocation.invocation_id, 3)?,
            tx.projection_disposition(&invocation.invocation_id, 3)?,
            tx.broker_invocation(&invocation.invocation_id)?,
            tx.lifecycle_events().allocated_hrc_seq()?,
        ))
    })?;
    if rollback.is_ok()
        || after.0.is_some()
        || after.1.is_some()
        || after.2.as_ref().is_none_or(|i| i.last_projected_seq != 2)
        || after.3 != head
    {
        return Err(StoreError::Invalid("projection rollback leaked".into()));
    }
    let mut retained = event.clone();
    retained.seq = 4;
    retained.payload = json!({"inputId":"retained-input"});
    retained.evidence_origin = Some("retained".into());
    store.write(|tx| tx.append_broker_event(&retained))?;
    let fence = store.read_snapshot(|tx| {
        Ok((
            tx.has_input_accepted("p1-runtime", "retained-input", false)?,
            tx.has_input_accepted("p1-runtime", "retained-input", true)?,
        ))
    })?;
    if fence != (false, true) {
        return Err(StoreError::Invalid("retained fence absent".into()));
    }
    let mut imported = first.0.clone();
    imported.invocation_id = "p1-imported".into();
    imported.seq = 1;
    let imported_first = store
        .write(|tx| tx.import_broker_event("p1-peer", 10, &imported))?
        .value;
    let imported_repeat = store
        .write(|tx| tx.import_broker_event("p1-peer", 10, &imported))?
        .value;
    let mut divergent = imported.clone();
    divergent.time = "different".into();
    let import_conflict = store
        .write(|tx| tx.import_broker_event("p1-peer", 10, &divergent))
        .err()
        .ok_or_else(|| StoreError::Invalid("import divergence accepted".into()))?;
    if imported_first.1 || !imported_repeat.1 {
        return Err(StoreError::Invalid("import idempotency differs".into()));
    }
    let bounded = store.read_snapshot(|tx| {
        tx.broker_events_by_types(&BrokerEventTypesQuery {
            invocation_id: invocation.invocation_id.clone(),
            types: vec![event.r#type.clone()],
            through_seq: Some(1),
            runtime_id: Some(event.runtime_id.clone()),
            turn_id: Some("p1-turn".into()),
            ..Default::default()
        })
    })?;
    if bounded.len() != 1 {
        return Err(StoreError::Invalid("bounded turn ownership differs".into()));
    }
    let rows =
        store.read_snapshot(|tx| tx.broker_events_by_invocation(&invocation.invocation_id))?;
    store.close()?;
    Ok(
        json!({"contentAddressedPlan":true,"preparedOperation":true,"retainedZeroMarker":true,"rawIdempotencyConflict":true,"contiguousCursor":true,"projectionRollback":true,"importOriginConflict":true,"envelopeRepair":true,"retainedFence":true,"observations":{"plan":kept,"operation":op,"invocation":after.2,"rows":rows,"dispositionGapCursor":gap,"contiguousCursor":contiguous,"rollbackHeadBefore":head,"rollbackHeadAfter":after.3,"boundedTurnRows":bounded,"imported":imported_first.0,"identityConflict":{"code":conflict.code(),"message":conflict.to_string()},"importConflict":{"code":import_conflict.code(),"message":import_conflict.to_string()},"retainedExcluded":fence.0,"retainedIncluded":fence.1}}),
    )
}
fn recovery_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let at = "2026-10-23T00:00:00.000Z";
    let late = "2026-10-23T00:03:00.000Z";
    let arm = ArmFirstTurnWatch {
        runtime_id: "p1-runtime".into(),
        generation: 1,
        host_session_id: "p1-host".into(),
        scope_ref: "agent:tabularasa:project:hrc-runtime:task:p1-store".into(),
        lane_ref: "main".into(),
        run_id: Some("p1-run".into()),
        invocation_id: None,
        transport: Some("tmux".into()),
        priming_dispatched_at: at.into(),
        first_turn_deadline_at: "2026-10-23T00:01:00.000Z".into(),
    };
    let armed = store.write(|tx| tx.arm_first_turn_watch(&arm))?.value;
    let mut repeated = arm.clone();
    repeated.first_turn_deadline_at = late.into();
    let arm_repeat = store.write(|tx| tx.arm_first_turn_watch(&repeated))?.value;
    let mut disarmed = arm.clone();
    disarmed.generation = 2;
    disarmed.run_id = None;
    store.write(|tx| {
        tx.arm_first_turn_watch(&disarmed)?;
        tx.disarm_first_turn_watch("p1-runtime", 2, "process_exited", at)
    })?;
    let due = store.read_snapshot(|tx| tx.armed_first_turn_watches_due(late, 100))?;
    let fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    let refused = store.write::<()>(|tx| {
        tx.mark_first_turn_missing("p1-runtime", 1, at, 3)?;
        tx.append_lifecycle(&fields)?;
        Err(StoreError::Invalid("deliberate watch trip rollback".into()))
    });
    if refused.is_ok()
        || store
            .read_snapshot(|tx| tx.first_turn_watch("p1-runtime", 1))?
            .is_none_or(|r| r.trip_event_seq.is_some())
    {
        return Err(StoreError::Invalid("watch rollback leaked".into()));
    }
    store.write(|tx| tx.mark_first_turn_missing("p1-runtime", 1, at, 3))?;
    let trip_repeat = store
        .write(|tx| tx.mark_first_turn_missing("p1-runtime", 1, late, 4))?
        .value;
    let first = store
        .write(|tx| tx.mark_first_turn("p1-runtime", 1, late))?
        .value;
    store.write(|tx| {
        tx.record_first_turn_diagnostics("p1-runtime", 1, "/scratch/opaque-pointer", 5, late)
    })?;
    let trip = store.read_snapshot(|tx| tx.first_turn_watch_by_trip(3))?;
    store.write(|tx| tx.clear_first_turn_bundle("p1-runtime", 1, late))?;
    let cleared = store.read_snapshot(|tx| tx.first_turn_watch_by_run("p1-run"))?;
    let contribution = AttemptContribution {
        contribution_id: "p1-contribution".into(),
        host_session_id: "p1-host".into(),
        idempotency_key: Some("p1-key".into()),
        runtime_id: "p1-runtime".into(),
        invocation_id: "p1-invocation".into(),
        active_run_id: "p1-run".into(),
        input_id: "p1-input".into(),
        now: at.into(),
    };
    store.write(|tx| tx.insert_attempting_contribution(&contribution))?;
    store.write(|tx| {
        tx.update_attempting_contribution_pointer(
            &contribution.contribution_id,
            "p1-rerouted",
            "p1-runtime",
            "p1-invocation",
            late,
        )
    })?;
    let orphans_before = store.read_snapshot(|tx| tx.attempting_steer_contributions())?;
    let count = store
        .write(|tx| tx.seal_orphaned_contributions(late))?
        .value;
    let pointer_changed = store
        .write(|tx| {
            tx.update_attempting_contribution_pointer(
                &contribution.contribution_id,
                "p1-overwrite",
                "p1-runtime",
                "p1-invocation",
                late,
            )
        })?
        .value;
    let sealed = store.read_snapshot(|tx| tx.steer_contribution_by_key("p1-host", "p1-key"))?;
    let orphans_after = store.read_snapshot(|tx| tx.attempting_steer_contributions())?;
    store.close()?;
    Ok(
        json!({"armed":armed,"armRepeat":arm_repeat,"due":due,"tripRepeat":trip_repeat,"lateFirstTurn":first,"trip":trip,"cleared":cleared,"orphansBefore":orphans_before,"orphanCount":count,"orphansAfter":orphans_after,"sealed":sealed,"sealedPointerChanged":pointer_changed}),
    )
}
fn grants_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let at = "2026-10-23T00:00:00.000Z";
    let expired = "2026-10-23T01:00:00.000Z";
    let grant = ExternalRegistrationGrant {
        registration_id: "p1-grant".into(),
        class_id: "p1-class".into(),
        derived_scope: "external:p1".into(),
        socket_path: "/scratch/not-started.sock".into(),
        credential_hash: "p1-opaque".into(),
        expires_at: "2026-10-23T00:05:00.000Z".into(),
        turns_allowed: true,
        provisioner: serde_json::from_value(json!({"fixture":true}))?,
        created_at: at.into(),
        ..Default::default()
    };
    let issued = store
        .write(|tx| tx.issue_registration_grant(&grant, 1, at))?
        .value;
    let occupied_before =
        store.read_snapshot(|tx| tx.registration_capacity_occupants(&grant.class_id, at))?;
    let mut next = grant.clone();
    next.registration_id = "p1-grant-next".into();
    next.derived_scope = "external:p1-next".into();
    let denied = store
        .write(|tx| tx.issue_registration_grant(&next, 1, at))?
        .value;
    let mint = ExternalRegistrationMint {
        host_session_id: "p1-host".into(),
        runtime_id: "p1-runtime".into(),
        operation_id: "p1-operation".into(),
        invocation_id: "p1-invocation".into(),
        attach_token_ref: "opaque".into(),
        controller_instance_id: "p1-controller".into(),
        capabilities: serde_json::Map::new(),
        participant_info: serde_json::Map::new(),
    };
    let failed = store.write::<()>(|tx| {
        tx.consume_registration_grant(&grant.registration_id, at)?;
        tx.record_registration_mint(&grant.registration_id, &mint)?;
        Err(StoreError::Invalid("deliberate mint rollback".into()))
    });
    if failed.is_ok() {
        return Err(StoreError::Invalid("mint rollback accepted".into()));
    }
    let rollback = store.read_snapshot(|tx| tx.registration_grant(&grant.registration_id))?;
    store.write(|tx| {
        if !tx.consume_registration_grant(&grant.registration_id, at)? {
            return Err(StoreError::Invalid("fresh consume refused".into()));
        }
        tx.record_registration_mint(&grant.registration_id, &mint)
    })?;
    let consume_repeat = store
        .write(|tx| tx.consume_registration_grant(&grant.registration_id, at))?
        .value;
    let mint_repeat = store.write(|tx| tx.record_registration_mint(&grant.registration_id, &mint));
    if mint_repeat.is_ok() {
        return Err(StoreError::Invalid("mint replay changed identity".into()));
    }
    let pending = store.read_snapshot(|tx| tx.grant_rendezvous_candidates(expired))?;
    let occupied_expired =
        store.read_snapshot(|tx| tx.registration_capacity_occupants(&grant.class_id, expired))?;
    if !store
        .write(|tx| tx.establish_registration_grant(&grant.registration_id, at))?
        .value
    {
        return Err(StoreError::Invalid("pending establishment refused".into()));
    }
    let establish_repeat = store
        .write(|tx| tx.establish_registration_grant(&grant.registration_id, expired))?
        .value;
    let established = store.read_snapshot(|tx| tx.established_registration_grants())?;
    let controller = store
        .write(|tx| {
            tx.update_registration_controller(&grant.registration_id, "p1-controller-next")
        })?
        .value;
    store.write(|tx| tx.retire_registration_grant(&grant.registration_id, expired))?;
    let retire_repeat = store
        .write(|tx| tx.retire_registration_grant(&grant.registration_id, expired))?
        .value;
    let occupied_retired =
        store.read_snapshot(|tx| tx.registration_capacity_occupants(&grant.class_id, expired))?;
    let minted = store.read_snapshot(|tx| tx.minted_registration_grants())?;
    let rendezvous = store.read_snapshot(|tx| tx.grant_rendezvous_candidates(expired))?;
    let retired = store.read_snapshot(|tx| tx.registration_grant(&grant.registration_id))?;
    let next_issue = store
        .write(|tx| tx.issue_registration_grant(&next, 1, expired))?
        .value;
    store.close()?;
    Ok(
        json!({"issued":issued,"occupiedBefore":occupied_before,"denied":denied,"rollback":rollback,"consumeRepeat":consume_repeat,"pendingAfterExpiry":pending,"occupiedExpiredConsumed":occupied_expired,"establishRepeat":establish_repeat,"established":established,"controllerUpdated":controller,"retireRepeat":retire_repeat,"occupiedRetired":occupied_retired,"minted":minted,"retired":retired,"rendezvousAfterRetire":rendezvous,"nextIssue":next_issue}),
    )
}
fn participants_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let at = "2026-10-23T00:00:00.000Z";
    let registration = ParticipantRegistration {
        registration_id: "p1-registration".into(),
        class_id: Some("p1-class".into()),
        join: "participant-served".into(),
        participant_key: Some("p1-permanent-key".into()),
        scope_ref: "agent:tabularasa:project:hrc-runtime:task:p1-participant".into(),
        lane_ref: "main".into(),
        host_session_id: "p1-host".into(),
        generation: 1,
        host_incarnation_id: Some("p1-incarnation".into()),
        policy: Some(ParticipantRegistrationPolicy {
            address_policy: "selected-scope".into(),
            continuity_policy: "host-incarnation".into(),
            lifecycle_owner: "externally-owned".into(),
            replay_semantics: "full-source-replay".into(),
        }),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let reservation = ParticipantReservation {
        reservation_id: "p1-reservation".into(),
        scope_ref: registration.scope_ref.clone(),
        lane_ref: "main".into(),
        home_node_id: "p1-node".into(),
        state: "held".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let binding = ParticipantBinding {
        binding_id: "p1-binding".into(),
        reservation_id: reservation.reservation_id.clone(),
        registration_id: registration.registration_id.clone(),
        host_incarnation_id: "p1-incarnation".into(),
        host_session_id: "p1-host".into(),
        generation: 1,
        runtime_id: "p1-runtime".into(),
        state: "BINDING".into(),
        admitted_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let attempt = ParticipantAttempt {
        attempt_id: "p1-attempt".into(),
        registration_id: registration.registration_id.clone(),
        attach_epoch: 1,
        request_id: "p1-request".into(),
        operation_id: "p1-operation".into(),
        invocation_id: "p1-invocation".into(),
        runtime_id: "p1-runtime".into(),
        host_binding_id: Some(binding.binding_id.clone()),
        state: "REGISTERED".into(),
        recovery_disposition: "unresolved".into(),
        establishment_work_state: "pending".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    store.write(|tx| {
        tx.insert_participant_registration(&registration)?;
        tx.insert_participant_reservation(&reservation)?;
        tx.insert_participant_binding(&binding)?;
        tx.insert_participant_attempt(&attempt)?;
        Ok(())
    })?;
    let illegal = store
        .write(|tx| {
            tx.transition_participant_attempt(
                &attempt.attempt_id,
                &["REGISTERED".into()],
                "ACTIVE",
                at,
                None,
            )
        })?
        .value;
    store.write(|tx| {
        tx.transition_participant_attempt(
            &attempt.attempt_id,
            &["REGISTERED".into()],
            "IDENTITY_MINTED",
            at,
            None,
        )
    })?;
    let non_runnable = store.read_snapshot(|tx| tx.participant_establishment_work())?;
    let selection = ParticipantContinuationSelection {
        carried: false,
        reason: "participant_fresh".into(),
        selected_json: None,
    };
    let selection_first = store
        .write(|tx| {
            tx.record_participant_continuation_if_absent(
                &attempt.attempt_id,
                &selection,
                "not_requested",
                at,
            )
        })?
        .value;
    let selection_repeat = store
        .write(|tx| {
            tx.record_participant_continuation_if_absent(
                &attempt.attempt_id,
                &selection,
                "requested",
                at,
            )
        })?
        .value;
    let prepare = PrepareParticipantDescriptor {
        attempt_id: attempt.attempt_id.clone(),
        attach_epoch: 1,
        prepared_descriptor_json: "{\"kind\":\"participant-broker-descriptor/v1\"}".into(),
        adapter_dispatch_env_json: "{}".into(),
        attach_socket_path: Some("/scratch/opaque.sock".into()),
        resume_state: None,
        resume_reason: None,
        updated_at: at.into(),
    };
    let first = store
        .write(|tx| tx.attach_participant_prepared_descriptor(&prepare))?
        .value;
    let repeat = store
        .write(|tx| tx.attach_participant_prepared_descriptor(&prepare))?
        .value;
    let snapshot_first = store
        .write(|tx| {
            tx.set_participant_snapshot_if_absent(
                &attempt.attempt_id,
                ParticipantSnapshot::HostingIntent,
                "{}",
                at,
            )
        })?
        .value;
    let snapshot_repeat = store
        .write(|tx| {
            tx.set_participant_snapshot_if_absent(
                &attempt.attempt_id,
                ParticipantSnapshot::HostingIntent,
                "{\"different\":true}",
                at,
            )
        })?
        .value;
    for (from, to) in [
        ("PREPARED", "HOSTING_INTENT_PERSISTED"),
        ("HOSTING_INTENT_PERSISTED", "REALIZED"),
        ("REALIZED", "DISPATCH_FROZEN"),
        ("DISPATCH_FROZEN", "INSTALL_CONFIRMED"),
        ("INSTALL_CONFIRMED", "INVOCATION_READY"),
        ("INVOCATION_READY", "ATTACH_CONFIRMED"),
    ] {
        if !store
            .write(|tx| {
                tx.transition_participant_attempt(&attempt.attempt_id, &[from.into()], to, at, None)
            })?
            .value
        {
            return Err(StoreError::Invalid(format!(
                "legal participant transition {from} to {to} refused"
            )));
        }
    }
    let activated = store
        .write(|tx| tx.confirm_participant_initial_activation(&attempt.attempt_id, at))?
        .value;
    let activation_repeat = store
        .write(|tx| tx.confirm_participant_initial_activation(&attempt.attempt_id, at))?
        .value;
    store.write(|tx| tx.complete_participant_establishment(&attempt.attempt_id, 1, at))?;
    let reconnect_first = store
        .write(|tx| tx.arm_participant_reconnect(&attempt.attempt_id, at))?
        .value;
    let reconnect_repeat = store
        .write(|tx| tx.arm_participant_reconnect(&attempt.attempt_id, at))?
        .value;
    store.write(|tx| {
        tx.transition_participant_attempt(
            &attempt.attempt_id,
            &["ACTIVE".into()],
            "DETACHED",
            at,
            None,
        )
    })?;
    let mut replacement_store = vec![];
    for intent in ["{}", "{}", "{\"other\":true}"] {
        replacement_store.push(
            store
                .write(|tx| {
                    tx.store_participant_replacement_intent(&attempt.attempt_id, 1, intent, at)
                })?
                .value,
        );
    }
    let failure = ParticipantEstablishmentFailure {
        attempt_id: attempt.attempt_id.clone(),
        attach_epoch: 1,
        failed_at: at.into(),
        next_attempt_at: at.into(),
        error: "controlled unreachable endpoint; no dial performed".into(),
        max_attempts: 2,
    };
    store.write(|tx| tx.record_participant_establishment_failure(&failure))?;
    let exhausted = store
        .write(|tx| tx.record_participant_establishment_failure(&failure))?
        .value;
    let renew_empty = store
        .write(|tx| tx.renew_exhausted_participant_replacement(&attempt.attempt_id, "  ", at))?
        .value;
    let renew_valid = store
        .write(|tx| {
            tx.renew_exhausted_participant_replacement(
                &attempt.attempt_id,
                "operator scratch recovery",
                at,
            )
        })?
        .value;
    let bound = ParticipantBindingTransition {
        binding_id: binding.binding_id.clone(),
        from: vec!["BINDING".into()],
        to: "BOUND".into(),
        now: at.into(),
        retirement_receipt_json: None,
        disposition_reason: None,
    };
    store.write(|tx| tx.transition_participant_binding(&bound))?;
    let mut retire = bound.clone();
    retire.from = vec!["BOUND".into()];
    retire.to = "RETIRING".into();
    let retire_without = store
        .write(|tx| tx.transition_participant_binding(&retire))?
        .value;
    retire.retirement_receipt_json = Some("{\"evidence\":\"opaque-scratch-only\"}".into());
    let retire_with = store
        .write(|tx| tx.transition_participant_binding(&retire))?
        .value;
    let held =
        store.read_snapshot(|tx| tx.has_held_participant_reservation(&registration.scope_ref))?;
    let release_first = store
        .write(|tx| {
            tx.release_participant_reservation(
                &reservation.reservation_id,
                "operator",
                "explicit scratch release",
                at,
            )
        })?
        .value;
    let release_repeat = store
        .write(|tx| {
            tx.release_participant_reservation(
                &reservation.reservation_id,
                "operator",
                "explicit scratch release",
                at,
            )
        })?
        .value;
    let final_attempt = store.read_snapshot(|tx| tx.participant_attempt(&attempt.attempt_id))?;
    let final_binding = store.read_snapshot(|tx| tx.participant_binding(&binding.binding_id))?;
    let final_registration =
        store.read_snapshot(|tx| tx.participant_registration(&registration.registration_id))?;
    store.close()?;
    Ok(
        json!({"illegalJump":illegal,"nonRunnable":non_runnable,"prepareFirst":first,"prepareRepeat":repeat,"snapshotFirst":snapshot_first,"snapshotRepeat":snapshot_repeat,"selectionFirst":selection_first,"selectionRepeat":selection_repeat,"initialActivation":activated,"activationRepeat":activation_repeat,"reconnectFirst":reconnect_first,"reconnectRepeat":reconnect_repeat,"replacementStore":replacement_store,"exhausted":exhausted,"renewEmpty":renew_empty,"renewValid":renew_valid,"retireWithoutReceipt":retire_without,"retireWithReceipt":retire_with,"reservationStillHeld":held,"releaseFirst":release_first,"releaseRepeat":release_repeat,"attempt":final_attempt,"binding":final_binding,"registration":final_registration}),
    )
}
fn messages_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    use std::{cell::RefCell, rc::Rc};
    let hints = Rc::new(RefCell::new(Vec::new()));
    let observed = hints.clone();
    let subscription = store.observe(move |c| {
        observed
            .borrow_mut()
            .push(serde_json::to_value(c).expect("typed hint"))
    });
    let request = MessageInsert {
        message_id: "p1-message".into(),
        kind: "handoff".into(),
        phase: "request".into(),
        from: MessageAddress::Entity {
            entity: "human".into(),
        },
        to: MessageAddress::Session {
            session_ref: "p1-session".into(),
        },
        body: "request body".into(),
        reply_to_message_id: None,
        root_message_id: None,
        execution: Some(MessageExecution {
            state: "started".into(),
            run_id: Some("p1-run".into()),
            runtime_id: Some("p1-runtime".into()),
            ..Default::default()
        }),
        metadata_json: Some(serde_json::from_value(
            json!({"ingress":"preserved","turnResponseFinalizer":true}),
        )?),
    };
    store.write(|tx| tx.insert_message(&request))?;
    let mut divergent = request.clone();
    divergent.body = "different ignored duplicate".into();
    let duplicate = store
        .write(|tx| tx.insert_message_idempotent(&divergent))?
        .value;
    let patch = serde_json::from_value(json!({"answer":"retained"}))?;
    store.write(|tx| tx.update_message_metadata(&request.message_id, &patch))?;
    let response = MessageInsert {
        message_id: "p1-response".into(),
        kind: "handoff".into(),
        phase: "response".into(),
        from: request.to.clone(),
        to: request.from.clone(),
        body: "actual response".into(),
        reply_to_message_id: Some(request.message_id.clone()),
        root_message_id: Some(request.message_id.clone()),
        execution: None,
        metadata_json: None,
    };
    let terminal = MessageExecutionPatch {
        state: Patch::Set("completed".into()),
        ..Default::default()
    };
    let failed = store.write::<()>(|tx| {
        tx.insert_message(&response)?;
        tx.update_message_execution(&request.message_id, &terminal)?;
        Err(StoreError::Invalid("deliberate finalizer rollback".into()))
    });
    if failed.is_ok() {
        return Err(StoreError::Invalid("finalizer control did not fail".into()));
    }
    let rollback_responses = store.read_snapshot(|tx| {
        tx.correlated_message_responses(&request.message_id, &request.message_id, 0)
    })?;
    let rollback_execution = store.read_snapshot(|tx| tx.message_by_id(&request.message_id))?;
    store.write(|tx| {
        let current = required_message(tx.read().message_by_id(&request.message_id)?)?;
        if current.execution.state != "started"
            || tx.read().has_message_response(&request.message_id)?
        {
            return Err(StoreError::Invalid("finalizer eligibility changed".into()));
        }
        tx.insert_message(&response)?;
        tx.update_message_execution(&request.message_id, &terminal)
    })?;
    let unsubscribe = store.unobserve(subscription);
    store.write(|tx| tx.update_message_metadata(&request.message_id, &patch))?;
    let final_request = store.read_snapshot(|tx| tx.latest_request_by_run("p1-run"))?;
    let responses = store.read_snapshot(|tx| {
        tx.correlated_message_responses(&request.message_id, &request.message_id, 0)
    })?;
    let filtered = store.read_snapshot(|tx| {
        tx.messages(&MessageFilter {
            participant: Some(request.from.clone()),
            descending: true,
            limit: Some(2),
            ..Default::default()
        })
    })?;
    store.close()?;
    Ok(
        json!({"duplicate":duplicate.0,"duplicateInserted":duplicate.1,"rollbackResponses":rollback_responses,"rollbackExecution":rollback_execution,"request":final_request,"responses":responses,"filtered":filtered,"hints":hints.borrow().clone(),"unsubscribeWorked":unsubscribe}),
    )
}
fn required_message(
    r: Option<hrc_store::MessageRecord>,
) -> Result<hrc_store::MessageRecord, StoreError> {
    r.ok_or_else(|| StoreError::MissingRecord("scratch request".into()))
}
fn authority_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let at = "2026-10-23T00:00:00.000Z";
    let mut run = store
        .read_snapshot(|tx| tx.run_by_id("p1-run"))?
        .ok_or_else(|| StoreError::MissingRecord("scratch run".into()))?;
    run.run_id = "p1-accepted".into();
    run.status = "accepted".into();
    run.completed_at = None;
    run.started_at = None;
    run.dispatched_input_id = Some("p1-input".into());
    run.broker_submission_id = Some("p1-submission".into());
    run.invocation_id = Some("p1-invocation".into());
    store.write(|tx| tx.insert_run(&run))?;
    let mut cold = run.clone();
    cold.run_id = "p1-cold".into();
    cold.transport = "headless".into();
    cold.dispatched_input_id = None;
    cold.broker_submission_id = None;
    store.write(|tx| tx.insert_run(&cold))?;
    let input = BrokerEventAppend {
        invocation_id: "p1-invocation".into(),
        seq: 1,
        time: at.into(),
        r#type: "input.accepted".into(),
        runtime_id: "p1-runtime".into(),
        run_id: Some(run.run_id.clone()),
        payload: json!({"inputId":"p1-input"}),
        harness_generation: Some(1),
        turn_attempt: Some(1),
        ..Default::default()
    };
    store.write(|tx| tx.append_broker_event(&input))?;
    let first_input =
        store.read_snapshot(|tx| tx.latest_unfenced_accepted_broker_input("p1-invocation", 1))?;
    let mut started = input.clone();
    started.seq = 2;
    started.r#type = "turn.started".into();
    started.payload = json!({"turnId":"p1-turn"});
    store.write(|tx| tx.append_broker_event(&started))?;
    let mut ask = started.clone();
    ask.seq = 3;
    ask.r#type = "tool.call.started".into();
    ask.payload = json!({"name":"AskUserQuestion","toolCallId":"p1-tool"});
    store.write(|tx| tx.append_broker_event(&ask))?;
    let names = vec!["AskUserQuestion".into()];
    let before = store
        .read_snapshot(|tx| tx.open_ask_brackets("p1-invocation", Some(&run.run_id), &names))?;
    let mut closed = ask.clone();
    closed.seq = 4;
    closed.r#type = "tool.call.completed".into();
    closed.harness_generation = Some(2);
    store.write(|tx| tx.append_broker_event(&closed))?;
    let wrong = store
        .read_snapshot(|tx| tx.open_ask_brackets("p1-invocation", Some(&run.run_id), &names))?;
    closed.seq = 5;
    closed.harness_generation = Some(1);
    store.write(|tx| tx.append_broker_event(&closed))?;
    let after = store
        .read_snapshot(|tx| tx.open_ask_brackets("p1-invocation", Some(&run.run_id), &names))?;
    let inclusive = store.read_snapshot(|tx| tx.open_broker_turn_count("p1-invocation", 2))?;
    let mut terminal = started.clone();
    terminal.seq = 6;
    terminal.r#type = "turn.completed".into();
    store.write(|tx| tx.append_broker_event(&terminal))?;
    let terminal_count = store.read_snapshot(|tx| tx.open_broker_turn_count("p1-invocation", 6))?;
    store.write(|tx| tx.fence_broker_input(&run.run_id, at, "source accepted carrier recovery"))?;
    let unfenced =
        store.read_snapshot(|tx| tx.latest_unfenced_accepted_broker_input("p1-invocation", 6))?;
    let fenced =
        store.read_snapshot(|tx| tx.latest_fenced_accepted_broker_input("p1-invocation", 6))?;
    let mut failure = FailAcceptedCarrier {
        run_id: run.run_id.clone(),
        runtime_id: "p1-runtime".into(),
        invocation_id: "p1-invocation".into(),
        dispatched_input_id: "wrong-input".into(),
        broker_submission_id: "p1-submission".into(),
        at: at.into(),
        error_code: "runtime_unavailable".into(),
        error_message: "controlled recovery".into(),
    };
    let recover_wrong = store.write(|tx| tx.fail_accepted_carrier(&failure))?.value;
    failure.dispatched_input_id = "p1-input".into();
    let recover_exact = store.write(|tx| tx.fail_accepted_carrier(&failure))?.value;
    let final_run = store.read_snapshot(|tx| tx.run_by_id(&run.run_id))?;
    let cold_candidates = store.read_snapshot(|tx| tx.cold_boot_accepted_runs())?;
    let mut fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    fields.runtime_id = Some("p1-runtime".into());
    fields.event_kind = "turn.started".into();
    fields.category = "turn".into();
    let boundary = store.write(|tx| tx.append_lifecycle(&fields))?.value;
    fields.event_kind = "turn.completed".into();
    let cut = store.write(|tx| tx.append_lifecycle(&fields))?.value;
    let prior = store.read_snapshot(|tx| {
        tx.latest_local_turn_boundary_before(
            "p1-runtime",
            cut.hrc_seq,
            &["turn.started".into(), "turn.completed".into()],
        )
    })?;
    if prior.as_ref().map(|e| e.hrc_seq) != Some(boundary.hrc_seq) {
        return Err(StoreError::Invalid(
            "prior publication boundary differs".into(),
        ));
    }
    let raw = store.read_snapshot(|tx| tx.broker_events_by_invocation("p1-invocation"))?;
    store.close()?;
    Ok(
        json!({"openBeforeCloser":before.len(),"openAfterWrongIdentity":wrong.len(),"openAfterCloser":after.len(),"askBefore":before,"askWrongIdentity":wrong,"startedAtInclusive":inclusive,"startedAfterTerminal":terminal_count,"firstInput":first_input,"inputAfterFence":unfenced,"fenced":fenced,"recoverWrongCarrier":recover_wrong,"recoverExactCarrier":recover_exact,"terminal":final_run,"coldCandidates":cold_candidates,"priorBoundary":prior,"boundaryCut":cut.hrc_seq,"rawBrokerEvents":raw}),
    )
}
fn ledgers_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let initial = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .clone();
    let raw = LegacyEventFields {
        ts: initial.fields.ts.clone(),
        host_session_id: initial.fields.host_session_id.clone(),
        scope_ref: initial.fields.scope_ref.clone(),
        lane_ref: "main".into(),
        generation: 1,
        run_id: None,
        runtime_id: Some("p1-runtime".into()),
        source: "broker".into(),
        event_kind: "broker.turn.started".into(),
        event_json: Some(json!({"type":"turn.started"})),
    };
    let written_raw = store.write(|tx| tx.append_legacy_event(&raw))?.value;
    let written_lifecycle = store
        .write(|tx| tx.append_lifecycle(&initial.fields))?
        .value;
    store.write(|tx| tx.import_lifecycle_event("p1-peer", 50, &initial))?;
    let import_repeat = store
        .write(|tx| tx.import_lifecycle_event("p1-peer", 50, &initial))?
        .value
        .1;
    let mut changed = initial.clone();
    changed.fields.payload = Some(json!({"different":true}));
    let conflict = store
        .write(|tx| tx.import_lifecycle_event("p1-peer", 50, &changed))
        .err()
        .ok_or_else(|| StoreError::Invalid("imported lifecycle divergence accepted".into()))?;
    let mut session = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle host".into()))?;
    for (id, scope, kind, payload) in [
        (
            "p1-task-host",
            "agent:tabularasa:project:hrc-runtime:task:T-11528",
            "turn.tool_call",
            json!({"toolName":"Bash","command":"git commit"}),
        ),
        (
            "p1-subtask-host",
            "agent:tabularasa:project:hrc-runtime:task:T-11528.child",
            "turn.started",
            json!({}),
        ),
    ] {
        session.host_session_id = id.into();
        session.scope_ref = scope.into();
        session.generation = 1;
        session.prior_host_session_id = None;
        let mut fields = initial.fields.clone();
        fields.host_session_id = id.into();
        fields.scope_ref = scope.into();
        fields.event_kind = kind.into();
        fields.payload = Some(payload);
        store.write(|tx| {
            tx.insert_session(&session)?;
            tx.upsert_continuity(scope, "main", id, &fields.ts)?;
            tx.append_lifecycle(&fields)
        })?;
    }
    let task_filter = LifecycleMonitorFilters {
        task_ids: vec!["T-11528".into()],
        ..Default::default()
    };
    let task_with_children = store.read_snapshot(|tx| {
        tx.lifecycle_events()
            .list_from_hrc_seq_filtered(1, &task_filter)
    })?;
    let exact = store.read_snapshot(|tx| {
        tx.lifecycle_events().list_from_hrc_seq_filtered(
            1,
            &LifecycleMonitorFilters {
                exact_task_ids: vec!["T-11528".into()],
                ..Default::default()
            },
        )
    })?;
    let tool = store.read_snapshot(|tx| {
        tx.lifecycle_events().list_from_hrc_seq_filtered(
            1,
            &LifecycleMonitorFilters {
                tool_names: vec!["Bash".into()],
                ..task_filter.clone()
            },
        )
    })?;
    let milestones = store.read_snapshot(|tx| {
        tx.lifecycle_events().list_from_hrc_seq_filtered(
            1,
            &LifecycleMonitorFilters {
                milestone: true,
                event_kinds: vec!["ignored".into()],
                ..task_filter.clone()
            },
        )
    })?;
    let mut admission = initial.fields.clone();
    admission.runtime_id = Some("p1-runtime".into());
    admission.event_kind = "input.admitted".into();
    admission.payload = Some(
        json!({"inputId":"p1-invalid-admission","invocationId":"p1-invocation","afterSeq":"string"}),
    );
    store.write(|tx| tx.append_lifecycle(&admission))?;
    let malformed = store.read_snapshot(|tx| {
        tx.lifecycle_events().find_input_admission_after_seq(
            "p1-invalid-admission",
            "p1-runtime",
            "p1-invocation",
        )
    })?;
    admission.payload = Some(
        json!({"inputId":"p1-duplicate-admission","invocationId":"p1-invocation","afterSeq":1}),
    );
    store.write(|tx| {
        tx.append_lifecycle(&admission)?;
        tx.append_lifecycle(&admission)
    })?;
    let duplicate = store.read_snapshot(|tx| {
        tx.lifecycle_events().find_input_admission_after_seq(
            "p1-duplicate-admission",
            "p1-runtime",
            "p1-invocation",
        )
    })?;
    let legacy =
        store.read_snapshot(|tx| tx.legacy_events_from_seq(1, &LegacyEventFilters::default()))?;
    let count = store.read_snapshot(|tx| tx.legacy_event_count(&LegacyEventFilters::default()))?;
    store.close()?;
    Ok(
        json!({"raw":written_raw,"lifecycle":written_lifecycle,"importRepeat":import_repeat,"importConflict":conflict.code(),"legacyCount":count,"legacy":legacy,"monitorTool":tool,"milestones":milestones,"taskWithChildren":task_with_children,"exactTask":exact,"malformedAdmission":malformed,"duplicateAdmission":duplicate}),
    )
}

fn edges_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use serde_json::json;
    let original = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle session".into()))?;
    let mut ids = vec![];
    for len in [64, 65] {
        let mut s = original.clone();
        s.host_session_id = format!("p1-identity-{len}");
        s.scope_ref = format!("agent:{}", "a".repeat(len));
        let c = store
            .write(|tx| {
                tx.insert_session(&s)?;
                tx.upsert_continuity(&s.scope_ref, "main", &s.host_session_id, &s.updated_at)
            })?
            .value;
        ids.push(c.identity);
    }
    let mut fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    fields.lane_ref = "lane:bad:colon".into();
    let invalid_lane = store.write(|tx| tx.append_lifecycle(&fields));
    let invalid_session = store
        .write(|tx| tx.update_session_status("p1-host", "made-up-status", &original.updated_at));
    let invalid_run = store.write(|tx| {
        tx.update_run(
            "p1-run",
            &RunPatch {
                status: Patch::Set("made-up-status".into()),
                completed_at: Patch::Clear,
                ..Default::default()
            },
        )
    });
    let invalid_runtime = store
        .write(|tx| tx.update_runtime_status("p1-runtime", "made-up-status", &original.updated_at));
    Ok(
        json!({"identity64":ids[0],"identity65":ids[1],"invalidLaneAccepted":invalid_lane.is_ok(),"invalidSessionStatusAccepted":invalid_session.is_ok(),"invalidRunStatusAccepted":invalid_run.is_ok(),"invalidRuntimeStatusAccepted":invalid_runtime.is_ok()}),
    )
}

fn crash_contract(mut store: Store, phase: &str) -> Result<serde_json::Value, StoreError> {
    if !matches!(phase, "before" | "after") {
        return Err(StoreError::Invalid(
            "explicit crash phase before|after required".into(),
        ));
    }
    let fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    let committed = store.write(|tx| {
        let row = tx.append_lifecycle(&fields)?;
        if phase == "before" {
            std::process::exit(70)
        }
        Ok(row)
    })?;
    println!(
        "{}",
        serde_json::json!({"committed":committed.value,"phase":phase})
    );
    std::process::exit(71)
}

fn prune_contract(
    mut store: Store,
    include_ledgers: bool,
) -> Result<serde_json::Value, StoreError> {
    let ids = vec!["p1-runtime".into()];
    let before = store.read_snapshot(|tx| tx.count_runtime_prune_rows(&ids, include_ledgers))?;
    let removed = store
        .write(|tx| tx.prune_runtimes(&ids, include_ledgers))?
        .value;
    store.close()?;
    Ok(serde_json::json!({"beforeCounts":before,"removed":removed}))
}

fn prune_return_contract(
    mut store: Store,
    ids: &[String],
    ledgers: bool,
    singular: bool,
) -> Result<serde_json::Value, StoreError> {
    let before = store.read_snapshot(|tx| tx.count_runtime_prune_rows(ids, ledgers))?;
    let result = if singular {
        if ids.len() != 1 {
            return Err(StoreError::Invalid("singular case needs one id".into()));
        }
        serde_json::json!(store.write(|tx| tx.prune_runtime(&ids[0], ledgers))?.value)
    } else {
        serde_json::json!(store.write(|tx| tx.prune_runtimes(ids, ledgers))?.value)
    };
    let remaining = store.read_snapshot(|tx| tx.runtime_count())?;
    store.close()?;
    Ok(serde_json::json!({"beforeCounts":before,"result":result,"afterCount":remaining}))
}

fn active_delivery_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let request = ActiveContributionRequest {
        input_attempt_id: "p1-attempt".into(),
        input_application_id: "p1-application".into(),
        prompt: "fixture only".into(),
        idempotency_key: Some("p1-key".into()),
        ..Default::default()
    };
    let pending = store
        .write(|tx| {
            tx.create_pending_input_delivery(&request, &ActiveDeliveryContext::default(), at)
        })?
        .value;
    if pending.request.current().is_none() {
        return Err(StoreError::Invalid(
            "current delivery lost typed projection".into(),
        ));
    }
    let mut response = ActiveContributionResponse {
        status: "accepted".into(),
        input_application_id: request.input_application_id.clone(),
        host_session_id: Some("p1-host".into()),
        generation: Some(1),
        runtime_id: Some("p1-runtime".into()),
        run_id: Some("p1-run".into()),
        ..Default::default()
    };
    let accepted = store
        .write(|tx| tx.mark_input_delivery_accepted(&request.input_application_id, &response, at))?
        .value;
    let ambiguous = store
        .write(|tx| {
            tx.mark_input_delivery_ambiguous(
                &request.input_application_id,
                "uncertain",
                "source outcome is unknown",
                at,
            )
        })?
        .value;
    let failed = store
        .write(|tx| {
            tx.mark_input_delivery_failed(
                &request.input_application_id,
                "controlled-failure",
                "known non-acceptance",
                at,
            )
        })?
        .value;
    response.status = "rejected".into();
    response.run_id = None;
    response.host_session_id = None;
    response.runtime_id = None;
    response.generation = None;
    let rejected = store
        .write(|tx| tx.mark_input_delivery_rejected(&request.input_application_id, &response, at))?
        .value;
    store.close()?;
    Ok(
        serde_json::json!({"pending":pending,"accepted":accepted,"ambiguous":ambiguous,"failed":failed,"rejected":rejected}),
    )
}

fn placement_absent_contract(
    mut store: Store,
    path: &std::path::Path,
) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let rows = store.read_snapshot(|tx| tx.placements())?;
    let refused = store
        .write(|tx| {
            tx.install_active_placement(&InstallPlacement {
                scope_ref: "agent:tabularasa".into(),
                home_node_id: "p1-node".into(),
                created_at: None,
                updated_at: "fixture".into(),
            })
        })
        .is_err();
    let missing = BindingRegistry::open_existing(
        path.with_file_name("missing-registry.sqlite"),
        OpenOptions {
            mode: OpenMode::ReadWrite,
            ..Default::default()
        },
    )
    .is_err();
    store.close()?;
    Ok(serde_json::json!({"rows":rows,"writeRefused":refused,"missingRegistryRefused":missing}))
}
fn placement_registry_contract(
    mut store: Store,
    path: &std::path::Path,
) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let scope = "agent:tabularasa:project:hrc-runtime:task:T-11528-placement";
    let install = InstallPlacement {
        scope_ref: scope.into(),
        home_node_id: "p1-node-a".into(),
        created_at: None,
        updated_at: at.into(),
    };
    store.write(|tx| tx.install_active_placement(&install))?;
    let retire_wrong = store
        .write(|tx| tx.retire_placement(scope, "p1-node-b", "fixture retirement", at))?
        .value;
    let retired = store
        .write(|tx| tx.retire_placement(scope, "p1-node-a", "fixture retirement", at))?
        .value;
    let retire_repeat = store
        .write(|tx| tx.retire_placement(scope, "p1-node-a", "fixture retirement", at))?
        .value;
    let install_retired = store
        .write(|tx| tx.install_active_placement(&install))
        .is_err();
    let placement = store.read_snapshot(|tx| tx.placements())?;
    store.close()?;
    let mut registry = BindingRegistry::open_existing(
        path,
        OpenOptions {
            mode: OpenMode::ReadWrite,
            ..Default::default()
        },
    )?;
    let designation = RecordBirthDesignation {
        scope_ref: scope.into(),
        home_node_id: "p1-node-a".into(),
        provenance: "default_home_node(sender)".into(),
        birth_envelope_id: "p1-birth".into(),
        sender_scope_ref: "agent:sender".into(),
        now: at.into(),
    };
    registry.write(|tx| tx.record_designation(&designation))?;
    let mismatch = registry.write(|tx| {
        tx.establish(
            scope,
            "p1-node-b",
            Some(&BirthEstablishmentDecision::EnforceDesignatedHome),
            at,
        )
    })?;
    let created = registry.write(|tx| {
        tx.establish(
            scope,
            "p1-node-b",
            Some(&BirthEstablishmentDecision::Supersede {
                by: "explicit_local".into(),
            }),
            at,
        )
    })?;
    let repeated = registry.write(|tx| tx.establish(scope, "p1-node-c", None, at))?;
    let deleted = registry.write(|tx| tx.delete_binding(scope, "p1-node-b", at))?;
    let delete_repeat = registry.write(|tx| tx.delete_binding(scope, "p1-node-b", at))?;
    registry.write(|tx| tx.record_designation(&designation))?;
    registry.write(|tx| {
        tx.insert_rebuilt(&PlacementBinding {
            scope_ref: "agent:tabularasa:project:hrc-runtime:task:T-11528-rebuilt".into(),
            home_node_id: "p1-node-a".into(),
            created_at: at.into(),
            updated_at: at.into(),
        })
    })?;
    let records = registry.read_snapshot(|tx| tx.list())?;
    let history = registry.read_snapshot(|tx| tx.designation_history(scope))?;
    let latest = registry.read_snapshot(|tx| tx.latest_designation(scope))?;
    let retired_home = registry.read_snapshot(|tx| tx.retired_home(scope))?;
    registry.close()?;
    Ok(
        serde_json::json!({"retireWrong":retire_wrong,"retired":retired,"retireRepeat":retire_repeat,"installRetiredRefused":install_retired,"placement":placement,"designationMismatch":mismatch,"created":created,"repeat":repeated,"deleted":deleted,"deleteRepeat":delete_repeat,"retiredHome":retired_home,"records":records,"history":history,"latest":latest}),
    )
}

fn index_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let original = store
        .read_snapshot(|tx| tx.sessions().get_by_host_session_id("p1-host"))?
        .ok_or_else(|| StoreError::MissingRecord("oracle host".into()))?;
    for (id, scope, status) in [
        (
            "p1-index-a",
            "agent:tabularasa:project:under_score:task:T-11528",
            "inactive",
        ),
        (
            "p1-index-b",
            "agent:other:project:underXscore:task:T-11528",
            "active",
        ),
        ("p1-index-app", "app:p1-synthetic", "inactive"),
    ] {
        let mut s = original.clone();
        s.host_session_id = id.into();
        s.scope_ref = scope.into();
        s.status = status.into();
        s.prior_host_session_id = None;
        store.write(|tx| {
            tx.insert_session(&s)?;
            tx.upsert_continuity(scope, "main", id, &s.updated_at)
        })?;
    }
    let mut event = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 10, None))?
        .rows[0]
        .fields
        .clone();
    event.host_session_id = "p1-index-a".into();
    event.scope_ref = "agent:tabularasa:project:under_score:task:T-11528".into();
    event.ts = "2026-10-23T05:00:00.000Z".into();
    store.write(|tx| tx.append_lifecycle(&event))?;
    let before = store
        .read_snapshot(|tx| {
            tx.session_index_page(
                &SessionIndexFilters {
                    q: Some("under_".into()),
                    ..Default::default()
                },
                None,
                10,
            )
        })?
        .items[0]
        .fields
        .last_activity_at
        .clone();
    store.write(|tx| {
        tx.update_session_status("p1-index-a", "archived", "2099-01-01T00:00:00.000Z")
    })?;
    let filters = SessionIndexFilters::default();
    let all = store.read_snapshot(|tx| tx.session_index_page(&filters, None, 100))?;
    let first = store.read_snapshot(|tx| tx.session_index_page(&filters, None, 1))?;
    let cursor = SessionIndexCursor {
        last_activity_at: first.items[0].fields.last_activity_at.clone(),
        host_session_id: first.items[0].fields.host_session_id.clone(),
    };
    let second = store.read_snapshot(|tx| tx.session_index_page(&filters, Some(&cursor), 10))?;
    let escaped = store.read_snapshot(|tx| {
        tx.session_index_page(
            &SessionIndexFilters {
                q: Some("under_".into()),
                ..Default::default()
            },
            None,
            10,
        )
    })?;
    let after = escaped.items[0].fields.last_activity_at.clone();
    let facets = store.read_snapshot(|tx| tx.session_index_facets(&filters))?;
    let filtered = store.read_snapshot(|tx| {
        tx.session_index_facets(&SessionIndexFilters {
            agent_id: Some("tabularasa".into()),
            ..Default::default()
        })
    })?;
    let recent =
        store.read_snapshot(|tx| tx.recent_selector_sessions("2026-10-23T04:00:00.000Z", None))?;
    let archive =
        store.read_snapshot(|tx| tx.inactive_archive_candidates("2026-10-23T04:00:00.000Z"))?;
    let backfill = store.read_snapshot(|tx| tx.session_index_backfill_evidence())?;
    store.close()?;
    Ok(
        serde_json::json!({"all":all,"first":first,"second":second,"facets":facets,"filteredFacets":filtered,"escaped":escaped,"beforeArchiveRecency":before,"afterArchiveRecency":after,"recent":recent,"archiveCandidates":archive,"backfill":backfill}),
    )
}

fn serialization_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let raw = r#"{"2":"two","1":"one","normal":1.0,"tiny":1e-7,"huge":1e21,"negativeZero":-0.0,"large":9007199254740993}"#;
    let payload = serde_json::from_str(raw)?;
    let input = BrokerEventAppend {
        invocation_id: "p1-json".into(),
        seq: 1,
        time: "2026-10-23T00:00:00.000Z".into(),
        r#type: "input.accepted".into(),
        runtime_id: "p1-runtime".into(),
        payload,
        ..Default::default()
    };
    let numeric = store.write(|tx| tx.append_broker_event(&input))?.value;
    let mut spill = input.clone();
    spill.seq = 2;
    spill.r#type = "tool.call.completed".into();
    spill.payload =
        serde_json::json!({"toolCallId":"p1-tool","result":format!("X{}","🫠".repeat(20000))});
    store.write(|tx| tx.append_broker_event(&spill))?;
    let mut escaped = input.clone();
    escaped.seq = 3;
    escaped.payload =
        serde_json::from_str(r#"{"2":2,"1":1,"\ud800":"\udfff","x":1,"x":2,"01":3}"#)?;
    store.write(|tx| tx.append_broker_event(&escaped))?;
    let same = store.write(|tx| tx.append_broker_event(&escaped))?.value.1;
    let mut conflict = escaped.clone();
    conflict.payload = serde_json::from_str(r#"{"1":1,"2":2,"x":2,"\ud800":"\udfff","01":3}"#)?;
    let conflict_code = store
        .write(|tx| tx.append_broker_event(&conflict))
        .err()
        .expect("reordered normal keys conflict")
        .code();
    let mut diagnostic = spill.clone();
    diagnostic.seq = 4;
    diagnostic.payload = serde_json::json!({"toolCallId":"p1-diagnostic","result":{"output":format!("X{}","🫠".repeat(20000)),"status":JsString::from_utf16([vec![0xd800],vec![0x4e2d;100]].concat()),"details":{"durationMs":1.0,"interrupted":true}}});
    store.write(|tx| tx.append_broker_event(&diagnostic))?;
    if !same || conflict_code != "broker_invocation_event_conflict" {
        return Err(StoreError::Invalid("JSON idempotency/conflict".into()));
    }
    store.close()?;
    Ok(serde_json::json!({"numeric":numeric.0,"rawInput":raw}))
}

fn mail_accounting_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let target = "agent:tabularasa";
    let runtime = "p1-runtime";
    let blocking = (0..25)
        .map(|i| MailStopEnvelopeSummary {
            envelope_id: format!("EN-{i}"),
            from: "fixture".into(),
            room_key: "fixture-room".into(),
            body: "fixture only".into(),
        })
        .collect::<Vec<_>>();
    let mut first_three = Vec::new();
    for _ in 0..3 {
        first_three.push(
            store
                .write(|tx| tx.evaluate_mail_stop(runtime, target, &blocking, 10, 0))?
                .value,
        )
    }
    let older = store
        .write(|tx| tx.evaluate_mail_stop(runtime, target, &blocking, 9, 99))?
        .value;
    let newer = store
        .write(|tx| tx.evaluate_mail_stop(runtime, target, &blocking, 11, 8))?
        .value;
    let mut hard = newer.clone();
    for seq in 12..=56 {
        hard = store
            .write(|tx| tx.evaluate_mail_stop(runtime, target, &blocking, seq, 8))?
            .value;
    }
    let before = store.read_snapshot(|tx| tx.mail_stop_refusal(runtime))?;
    let empty = store
        .write(|tx| tx.evaluate_mail_stop(runtime, target, &[], 999, 8))?
        .value;
    let record = store.read_snapshot(|tx| tx.mail_stop_refusal(runtime))?;
    let mut strikes = Vec::new();
    for r in [runtime, runtime, "other-runtime"] {
        strikes.push(
            store
                .write(|tx| tx.record_mail_nonlanding_strike("EN-counter", r))?
                .value,
        )
    }
    store.write(|tx| tx.clear_mail_nonlanding_strikes("EN-counter"))?;
    strikes.push(store.read_snapshot(|tx| tx.mail_nonlanding_strikes("EN-counter", runtime))?);
    let mut windows = Vec::new();
    for at in ["first", "second"] {
        windows.push(
            store
                .write(|tx| tx.open_mail_refusal_window("EN-counter", runtime, Some(at)))?
                .value,
        );
    }
    store.write(|tx| tx.close_mail_refusal_window("EN-counter", runtime))?;
    windows.push(
        store
            .write(|tx| tx.open_mail_refusal_window("EN-counter", runtime, Some("next")))?
            .value,
    );
    store.write(|tx| tx.record_mail_birth_refusal(target, target, "fixture reason"))?;
    let r1 = store
        .write(|tx| tx.resolve_mail_birth_refusal(target, "resolved"))?
        .value;
    let r2 = store
        .write(|tx| tx.resolve_mail_birth_refusal(target, "duplicate"))?
        .value;
    let birth = store.read_snapshot(|tx| tx.mail_birth_refusal(target))?;
    let n1 = store
        .write(|tx| tx.record_mail_failure_notice("EN-notice", target, "first"))?
        .value;
    let n2 = store
        .write(|tx| tx.record_mail_failure_notice("EN-notice", target, "divergent duplicate"))?
        .value;
    store.write(|tx| tx.mark_mail_failure_notices_delivered(target, &["EN-notice".into()]))?;
    let notices = store.read_snapshot(|tx| tx.mail_failure_notices_for_envelope("EN-notice"))?;
    let undelivered = store.read_snapshot(|tx| tx.mail_undelivered_failure_notices(target))?;
    store.close()?;
    Ok(
        serde_json::json!({"firstThree":first_three,"older":older,"newer":newer,"hard":hard,"empty":empty,"emptyRecordUnchanged":before==record,"record":record,"strikes":strikes,"windows":windows,"resolved":[r1,r2],"birth":birth,"noticeInserted":[n1,n2],"notices":notices,"undelivered":undelivered}),
    )
}

fn mail_delivery_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let target = "agent:tabularasa";
    let runtime = "p1-runtime";
    let envelope = "EN-delivery";
    let open = OpenMailIntent {
        envelope_id: envelope.into(),
        target_session_ref: format!("  {target}  "),
        door: "launch".into(),
        form: "full".into(),
        presentation_id: "p1-presentation".into(),
        runtime_id: Some(runtime.into()),
        submitted_hrc_seq: 4,
        ..Default::default()
    };
    store.write(|tx| tx.open_mail_intent(&open))?;
    let duplicate = store.write(|tx| tx.open_mail_intent(&open))?.value;
    store.write(|tx| {
        tx.attach_mail_admission(
            envelope,
            &MailAdmissionPatch {
                submission_id: Some("p1-mail-sub".into()),
                ..Default::default()
            },
        )
    })?;
    let u1 = store
        .write(|tx| tx.mark_mail_intent_uncertain(envelope, "one", Some("fact")))?
        .value
        .unwrap();
    let u2 = store
        .write(|tx| tx.mark_mail_intent_uncertain(envelope, "two", None))?
        .value
        .unwrap();
    store.write(|tx| tx.mark_mail_intent_terminal(envelope, "fixture terminal"))?;
    store.write(|tx| tx.record_mail_terminal_cleanup(envelope, "first"))?;
    let intent = store
        .write(|tx| tx.record_mail_terminal_cleanup(envelope, "second"))?
        .value
        .unwrap();
    let active = store.read_snapshot(|tx| tx.mail_active_open_intents(None))?;
    let mut presentation = RecordMailPresentation {
        envelope_id: envelope.into(),
        runtime_id: runtime.into(),
        target_session_ref: target.into(),
        generation: Some(1),
        presentation_id: "p1-presentation".into(),
        input_id: None,
        delivery_outcome: "enqueued".into(),
        landing_hrc_seq: 10,
    };
    store.write(|tx| tx.record_mail_presentation(&presentation))?;
    let before = store.read_snapshot(|tx| tx.mail_undisposed_for_runtime(runtime))?;
    let arm_before = store
        .write(|tx| {
            tx.arm_mail_reminder(
                envelope,
                runtime,
                "2026-10-23T00:00:00Z",
                "2026-10-23T00:02:00Z",
            )
        })?
        .value;
    let committed = store
        .write(|tx| tx.mark_mail_receipt_committed(envelope, runtime))?
        .value;
    let arm = store
        .write(|tx| {
            tx.arm_mail_reminder(
                envelope,
                runtime,
                "2026-10-23T00:00:00Z",
                "2026-10-23T00:02:00Z",
            )
        })?
        .value;
    let arm_repeat = store
        .write(|tx| tx.arm_mail_reminder(envelope, runtime, "other", "other"))?
        .value;
    let due = store.read_snapshot(|tx| tx.mail_due_reminders(target, "2026-10-23T00:02:00Z"))?;
    let landed1 = store
        .write(|tx| tx.record_mail_reminder_landing(envelope, runtime, 15))?
        .value;
    let landed2 = store
        .write(|tx| tx.record_mail_reminder_landing(envelope, runtime, 16))?
        .value;
    let disposition1 = store
        .write(|tx| tx.record_mail_disposition(envelope, runtime, "ignored"))?
        .value;
    let disposition2 = store
        .write(|tx| tx.record_mail_disposition(envelope, runtime, "duplicate"))?
        .value;
    let replay = store
        .write(|tx| tx.record_mail_presentation(&presentation))?
        .value;
    presentation.landing_hrc_seq = 11;
    let latest = store
        .write(|tx| tx.record_mail_presentation(&presentation))?
        .value;
    let at = chrono::DateTime::parse_from_rfc3339("2026-10-23T00:00:00Z")
        .unwrap()
        .to_utc();
    let mut hints = vec![
        store
            .write(|tx| tx.evaluate_mail_seat_hint(target, runtime, at))?
            .value,
    ];
    let admission = SubmissionAdmission {
        submission_id: "p1-mail-one".into(),
        runtime_id: Some(runtime.into()),
        door: Some("enqueue".into()),
        envelope_id: Some(envelope.into()),
        admitted_at: Some("fixture".into()),
        ..Default::default()
    };
    store.write(|tx| tx.upsert_submission_admission(&admission))?;
    for delta in [0, 119, 120] {
        hints.push(
            store
                .write(|tx| {
                    tx.evaluate_mail_seat_hint(
                        target,
                        runtime,
                        at + chrono::Duration::seconds(delta),
                    )
                })?
                .value,
        )
    }
    let mut second = admission.clone();
    second.submission_id = "p1-mail-two".into();
    store.write(|tx| tx.upsert_submission_admission(&second))?;
    hints.push(
        store
            .write(|tx| {
                tx.evaluate_mail_seat_hint(target, runtime, at + chrono::Duration::seconds(121))
            })?
            .value,
    );
    for id in [&admission.submission_id, &second.submission_id] {
        store.write(|tx| tx.record_submission_disposition(id, "landed", "fixture", true))?;
    }
    hints.push(
        store
            .write(|tx| {
                tx.evaluate_mail_seat_hint(target, runtime, at + chrono::Duration::seconds(122))
            })?
            .value,
    );
    store.close()?;
    Ok(
        serde_json::json!({"duplicateIntent":duplicate,"uncertainFirst":u1.uncertain_at,"uncertainRepeat":u2.uncertain_at,"cleanup":intent.cleanup_outcome,"intent":intent,"terminalActive":active,"beforeReceipt":before,"armBeforeReceipt":arm_before,"receiptCommitted":committed,"armAfterReceipt":arm,"armRepeat":arm_repeat,"due":due,"reminderLanding":[landed1,landed2],"disposition":[disposition1,disposition2],"replay":replay,"latest":latest,"hints":hints}),
    )
}

fn replication_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let record = MessageRecord {
        message_seq: 12,
        message_id: "p1-replicated".into(),
        created_at: at.into(),
        kind: "handoff".into(),
        phase: "request".into(),
        from: MessageAddress::Entity {
            entity: "fixture".into(),
        },
        to: MessageAddress::Session {
            session_ref: "agent:tabularasa".into(),
        },
        reply_to_message_id: None,
        root_message_id: "p1-replicated".into(),
        body: "fixture only".into(),
        body_format: "text".into(),
        execution: MessageExecution {
            state: "stored".into(),
            ..Default::default()
        },
        metadata_json: Some(serde_json::from_str(
            r#"{"2":2,"1":1,"\ud800":"\udfff","numeric":1.0}"#,
        )?),
    };
    let mut input = CollectiveObservationInput {
        source_node_id: "p1-node".into(),
        source_role: "origin".into(),
        origin_node_id: "p1-node".into(),
        accepted_destination_node_id: None,
        observed_at: None,
        record,
    };
    store.write(|tx| tx.enqueue_collective_replication(&input, at))?;
    let first = store.read_snapshot(|tx| tx.collective_replications_due(at, 100))?;
    let old = first[0].fingerprint.clone();
    let retry = store
        .write(|tx| {
            tx.retry_collective_replication(&CollectiveReplicationRetry {
                message_id: input.record.message_id.clone(),
                fingerprint: old.clone(),
                now: at.into(),
                next_attempt_at: at.into(),
                error_code: "fixture-retry".into(),
                error_message: "fixture".into(),
            })
        })?
        .value;
    let retried = store.read_snapshot(|tx| tx.collective_replications_due(at, 100))?;
    store.write(|tx| tx.enqueue_collective_replication(&input, at))?;
    let duplicate = store.read_snapshot(|tx| tx.collective_replications_due(at, 100))?;
    input.record.body = "changed record".into();
    store.write(|tx| tx.enqueue_collective_replication(&input, at))?;
    let reset = store.read_snapshot(|tx| tx.collective_replications_due(at, 100))?;
    let stale = store
        .write(|tx| tx.mark_collective_replication_delivered(&input.record.message_id, &old, at))?
        .value;
    let delivered = store
        .write(|tx| {
            tx.mark_collective_replication_delivered(
                &input.record.message_id,
                &reset[0].fingerprint,
                at,
            )
        })?
        .value;
    let pending = store.read_snapshot(|tx| tx.collective_replication_pending_count())?;
    let due = store.read_snapshot(|tx| tx.collective_replications_due(at, 100))?;
    store.close()?;
    Ok(
        serde_json::json!({"first":first,"retry":retry,"retried":retried,"afterDuplicate":duplicate,"reset":reset,"staleDelivered":stale,"delivered":delivered,"pending":pending,"due":due}),
    )
}

fn outbox_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let mut envelope = FederationEnvelope {
        message_id: "p1-outbox-message".into(),
        kind: "handoff".into(),
        phase: "request".into(),
        from: MessageAddress::Entity {
            entity: "fixture".into(),
        },
        to: MessageAddress::Session {
            session_ref: "agent:tabularasa".into(),
        },
        body: "fixture only".into(),
        root_message_id: "p1-outbox-message".into(),
        reply_to_message_id: None,
        expected: None,
        delivery: None,
        semantic_turn_signal: None,
        interactive_signal: None,
        mail: None,
        extra: Default::default(),
    };
    store.write(|tx| {
        tx.insert_message(&MessageInsert {
            message_id: envelope.message_id.clone(),
            kind: envelope.kind.clone(),
            phase: envelope.phase.clone(),
            from: envelope.from.clone(),
            to: envelope.to.clone(),
            body: envelope.body.clone(),
            reply_to_message_id: None,
            root_message_id: None,
            execution: None,
            metadata_json: None,
        })
    })?;
    let input = EnqueueOutbox {
        delivery_id: "p1-outbox".into(),
        message_id: envelope.message_id.clone(),
        peer_node_id: "fixture-peer".into(),
        payload: OutboxPayload::Establishing {
            establish: FederationEstablishRequest {
                scope_ref: "agent:tabularasa".into(),
                intent: "implicit".into(),
                correlation_id: "fixture".into(),
            },
            envelope: envelope.clone(),
            last_error: None,
        },
        now: at.into(),
    };
    let initial = store.write(|tx| tx.enqueue_outbox(&input))?.value;
    envelope.expected = Some(FederationExpectedPlacement {
        home_node_id: "fixture-home".into(),
    });
    let advanced = store
        .write(|tx| tx.advance_outbox_to_delivery("p1-outbox", "fixture-home", &envelope, at))?
        .value;
    let failure = OutboxAttemptFailure {
        delivery_id: "p1-outbox".into(),
        attempted_at: at.into(),
        error_code: "fixture".into(),
        error_message: "fixture retry".into(),
        retryable: Some(true),
        ..Default::default()
    };
    let retry = store
        .write(|tx| tx.schedule_outbox_retry(&failure, "retry_scheduled", at))?
        .value;
    let dead = store
        .write(|tx| {
            tx.mark_outbox_dead_letter(&OutboxAttemptFailure {
                retryable: None,
                ..failure.clone()
            })
        })?
        .value;
    let replay = store.write(|tx| tx.replay_outbox("p1-outbox", at))?.value;
    let cancelled = store.write(|tx| tx.cancel_outbox("p1-outbox", at))?.value;
    let dropped = store
        .write(|tx| tx.drop_outbox_dead_letter("p1-outbox"))?
        .value;
    let after = store.read_snapshot(|tx| tx.outbox_delivery("p1-outbox"))?;
    let mut second = input.clone();
    second.delivery_id = "p1-outbox-delivered".into();
    second.payload = OutboxPayload::Delivering {
        envelope: envelope.clone(),
        last_error: None,
    };
    store.write(|tx| tx.enqueue_outbox(&second))?;
    let delivered = store
        .write(|tx| tx.mark_outbox_delivered(&second.delivery_id, at))?
        .value;
    let refused = store
        .write(|tx| tx.mark_outbox_delivered(&second.delivery_id, at))
        .is_err();
    let due = store.read_snapshot(|tx| tx.outbox_due(at, 100))?;
    store.close()?;
    Ok(
        serde_json::json!({"initial":initial,"advanced":advanced,"retry":retry,"dead":dead,"replay":replay,"cancelled":cancelled,"dropped":dropped,"afterDrop":after,"delivered":delivered,"terminalRefused":refused,"due":due}),
    )
}

fn collective_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let record = MessageRecord {
        message_seq: 1,
        message_id: "p1-canonical".into(),
        created_at: "2026-10-23T00:00:30.000Z".into(),
        kind: "handoff".into(),
        phase: "request".into(),
        from: MessageAddress::Entity {
            entity: "fixture".into(),
        },
        to: MessageAddress::Session {
            session_ref: "agent:tabularasa".into(),
        },
        reply_to_message_id: None,
        root_message_id: "p1-canonical".into(),
        body: "uppercase destination".into(),
        body_format: "text/plain".into(),
        execution: MessageExecution {
            state: "accepted".into(),
            ..Default::default()
        },
        metadata_json: None,
    };
    let mut input = CollectiveObservationInput {
        source_node_id: "A".into(),
        source_role: "destination".into(),
        origin_node_id: "source".into(),
        accepted_destination_node_id: Some("A".into()),
        observed_at: Some(at.into()),
        record,
    };
    let mut inputs = vec![input.clone()];
    store.write(|tx| tx.record_collective_observation(&input))?;
    input.source_node_id = "a".into();
    input.accepted_destination_node_id = Some("a".into());
    input.record.body = "lowercase destination".into();
    inputs.push(input.clone());
    let canonical = store
        .write(|tx| tx.record_collective_observation(&input))?
        .value;
    input.source_node_id = "source".into();
    input.source_role = "origin".into();
    input.record.body = "origin authoritative".into();
    inputs.push(input.clone());
    let origin = store
        .write(|tx| tx.record_collective_observation(&input))?
        .value;
    let mut conflict = input.clone();
    conflict.source_node_id = "other-origin".into();
    inputs.push(conflict.clone());
    let conflict_refused = store
        .write(|tx| tx.record_collective_observation(&conflict))
        .is_err();
    for (id, parent, time, phase) in [
        ("p1-parent", None, "2026-10-23T00:00:10.000Z", "request"),
        ("p1-child", Some("p1-parent"), at, "response"),
        (
            "p1-cycle-a",
            Some("p1-cycle-b"),
            "2026-10-23T00:00:40.000Z",
            "request",
        ),
        (
            "p1-cycle-b",
            Some("p1-cycle-a"),
            "2026-10-23T00:00:40.000Z",
            "request",
        ),
    ] {
        input.record.message_seq += 1;
        input.record.message_id = id.into();
        input.record.reply_to_message_id = parent.map(str::to_owned);
        input.record.root_message_id = parent.unwrap_or(id).into();
        input.record.created_at = time.into();
        input.record.phase = phase.into();
        inputs.push(input.clone());
        store.write(|tx| tx.record_collective_observation(&input))?;
    }
    let all = store.read_snapshot(|tx| tx.collective_history(&MessageFilter::default(), "svc"))?;
    let page = store.read_snapshot(|tx| {
        tx.collective_history(
            &MessageFilter {
                limit: Some(1),
                ..Default::default()
            },
            "svc",
        )
    })?;
    let reverse = store.read_snapshot(|tx| {
        tx.collective_history(
            &MessageFilter {
                limit: Some(2),
                descending: true,
                ..Default::default()
            },
            "svc",
        )
    })?;
    let filtered = store.read_snapshot(|tx| {
        tx.collective_history(
            &MessageFilter {
                phases: vec!["response".into()],
                ..Default::default()
            },
            "svc",
        )
    })?;
    let count = store.read_snapshot(|tx| tx.collective_history_count())?;
    store.close()?;
    Ok(
        serde_json::json!({"canonical":canonical,"origin":origin,"originConflict":conflict_refused,"count":count,"all":all,"page":page,"reverse":reverse,"filtered":filtered,"inputs":inputs}),
    )
}

fn snapshot_contract(
    mut store: Store,
    path: &std::path::Path,
) -> Result<serde_json::Value, StoreError> {
    let read = store.read_snapshot(|tx| {
        let before = tx.lifecycle_events().page(0, 100, None)?;
        std::fs::write(
            path.with_file_name("snapshot-pinned"),
            "read transaction pinned",
        )
        .map_err(|e| StoreError::Invalid(e.to_string()))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
        while !path.with_file_name("snapshot-continue").is_file() {
            if std::time::Instant::now() >= deadline {
                return Err(StoreError::Invalid(
                    "scratch writer barrier timed out".into(),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let during = tx.lifecycle_events().page(0, 100, None)?;
        Ok((before, during))
    })?;
    let after = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    store.close()?;
    Ok(serde_json::json!({"before":read.0,"during":read.1,"after":after}))
}

/// Test-driver admission only. The library always uses its caller's explicit path.
/// Metadata checks precede every SQLite open, including an existing file symlink.
fn admit_scratch_path(path: &std::path::Path) -> Result<(), StoreError> {
    let resolved = if path.exists() {
        path.canonicalize()
    } else {
        path.parent()
            .unwrap_or_else(|| std::path::Path::new("/"))
            .canonicalize()
            .map(|p| p.join(path.file_name().unwrap_or_default()))
    }
    .map_err(|e| StoreError::Invalid(format!("scratch admission: {e}")))?;
    let relative = resolved
        .strip_prefix("/private/tmp")
        .or_else(|_| resolved.strip_prefix("/tmp"));
    let admitted = relative
        .ok()
        .and_then(|p| p.components().next())
        .and_then(|c| c.as_os_str().to_str())
        .is_some_and(|name| name.starts_with("hrcp1-"));
    if admitted {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "scratch admission requires explicit /tmp/hrcp1-* isolated state".into(),
        ))
    }
}

fn append_boundary_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    let before = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    let mut bad = before.rows[0].fields.clone();
    bad.event_kind = "turn.tool_result".into();
    bad.runtime_id = None;
    bad.payload = Some(serde_json::json!({"result":"X".repeat(40000)}));
    let mut good = bad.clone();
    good.event_kind = "turn.message".into();
    good.payload = Some(serde_json::json!({"text":"after caught repository error"}));
    let outcome = store
        .write(|tx| {
            let rejected = tx.append_lifecycle(&bad).is_err();
            let caught = tx.read().lifecycle_events().page(0, 100, None)?;
            tx.append_lifecycle(&good)?;
            Ok((rejected, caught))
        })?
        .value;
    let after = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    let mut within_caught = None;
    let rolled_back = store
        .write::<()>(|tx| {
            let rejected = tx
                .append_lifecycle_within_existing_transaction(&bad)
                .is_err();
            if !rejected {
                return Err(StoreError::Invalid(
                    "raw append should reject missing runtime".into(),
                ));
            }
            within_caught = Some(tx.read().lifecycle_events().page(0, 100, None)?);
            Err(StoreError::Invalid(
                "caller aborts encompassing transaction".into(),
            ))
        })
        .is_err();
    let after_rollback = store.read_snapshot(|tx| tx.lifecycle_events().page(0, 100, None))?;
    store.close()?;
    Ok(
        serde_json::json!({"before":before,"rejected":outcome.0,"afterCaught":outcome.1,"afterCommit":after,"withinCaught":within_caught,"callerRolledBack":rolled_back,"afterRollback":after_rollback}),
    )
}

fn continuation_maintenance_seed(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let op = RuntimeOperation {
        operation_id: "p1-history-operation".into(),
        runtime_id: "p1-runtime".into(),
        host_session_id: "p1-host".into(),
        generation: 1,
        operation_kind: "start".into(),
        controller: "broker".into(),
        startup_method: "spawn".into(),
        status: "prepared".into(),
        route_decision_json: "{}".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let invocation = BrokerInvocation {
        invocation_id: "p1-history".into(),
        operation_id: op.operation_id.clone(),
        runtime_id: "p1-runtime".into(),
        broker_protocol: "1".into(),
        broker_driver: "claude".into(),
        invocation_state: "stopped".into(),
        capabilities_json: "{}".into(),
        spec_hash: "fixture".into(),
        start_request_hash: "fixture".into(),
        selected_profile_hash: "fixture".into(),
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    store.write(|tx| {
        tx.insert_runtime_operation(&op)?;
        tx.insert_broker_invocation(&invocation)?;
        for (seq, key) in [(1,"old-provider"),(2,"newest-provider")] {
            tx.append_broker_event(&BrokerEventAppend { invocation_id: invocation.invocation_id.clone(), seq, time: at.into(), r#type: "continuation.updated".into(), runtime_id: "p1-runtime".into(), payload: serde_json::json!({"key":key,"provider":"fixture"}), ..Default::default() })?;
        }
        for seq in [3,4] {
            tx.append_legacy_event(&LegacyEventFields { ts: at.into(), host_session_id: "p1-host".into(), scope_ref: "agent:tabularasa:project:hrc-runtime:task:p1-store".into(), lane_ref: "main".into(), generation: 1, run_id: None, runtime_id: Some("p1-runtime".into()), source: "broker".into(), event_kind: "broker.continuation.cleared".into(), event_json: Some(serde_json::json!({"invocationId":"p1-history","seq":seq,"time":at,"payload":{"reason":"fixture-clear"}})) })?;
        }
        Ok(())
    })?;
    store.close()?;
    Ok(serde_json::json!({"seeded":true}))
}
fn continuation_maintenance_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    let backfilled = store
        .write(|tx| tx.backfill_legacy_continuation_clear_barriers())?
        .value;
    let repeat_backfill = store
        .write(|tx| tx.backfill_legacy_continuation_clear_barriers())?
        .value;
    let repaired = store.write(|tx| tx.repair_continuation_history())?.value;
    let repeat_repair = store.write(|tx| tx.repair_continuation_history())?.value;
    let result = store.read_snapshot(|tx|Ok(serde_json::json!({"backfilled":backfilled,"repeatBackfill":repeat_backfill,"repaired":repaired,"repeatRepair":repeat_repair,"session":tx.sessions().get_by_host_session_id("p1-host")?,"reuseDisabled":tx.sessions().is_continuation_reuse_disabled("p1-host")?,"hasBarrier":tx.host_has_continuation_clear("p1-host")?,"events":tx.broker_events_by_invocation("p1-history")?})))?;
    store.close()?;
    Ok(result)
}

fn legacy_mail_read_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let target = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let value=store.read_snapshot(|tx|{
        let actor=LegacyMailActor::Operator{principal:"fixture".into()};
        if tx.legacy_mail_envelope("absent")?.is_some() || tx.legacy_mail_origin_by_ingress("absent")?.is_some() || tx.legacy_mail_ingress_receipt("absent")?.is_some(){return Err(StoreError::Invalid("missing record read synthesized data".into()))}
        for (actual,expected) in [(tx.require_legacy_mail_envelope("absent").unwrap_err().code(),"unknown_envelope"),(tx.legacy_mail_inbox(&LegacyMailActor::Scope{session_ref:"other".into()},target).unwrap_err().code(),"target_mismatch"),(tx.legacy_mail_inbox(&actor," ").unwrap_err().code(),"invalid_transition")]{if actual!=expected{return Err(StoreError::Invalid("legacy mail read error mismatch".into()))}}
        Ok(serde_json::json!({"all":tx.list_legacy_mail_envelopes(&LegacyMailList::default())?,"inbox":tx.legacy_mail_inbox(&actor,&format!(" {target} "))?,"limited":tx.list_legacy_mail_envelopes(&LegacyMailList{limit:Some(1),..Default::default()})?,"pending":tx.list_legacy_mail_envelopes(&LegacyMailList{state:Some("pending".into()),target_session_ref:Some(target.into()),..Default::default()})?,"dead":tx.list_legacy_mail_envelopes(&LegacyMailList{dead:true,..Default::default()})?,"one":tx.require_legacy_mail_envelope("legacy-envelope-0")?,"receipt":tx.legacy_mail_ingress_receipt("legacy-ingress-0")?,"origin":tx.legacy_mail_origin_by_ingress("legacy-origin-ingress")?,"originEnvelope":tx.legacy_mail_origin_by_envelope("legacy-origin-envelope")?,"originRequest":tx.legacy_mail_origin_by_request("legacy-request")?}))
    })?;
    store.close()?;
    Ok(value)
}

fn legacy_mail_transition_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let target = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let at = "2026-10-23T00:00:00.000Z";
    let actor = LegacyMailActor::Operator {
        principal: "fixture".into(),
    };
    let mut failures = vec![];
    failures.push(
        store
            .write(|tx| tx.mark_legacy_mail_dead("legacy-envelope-3", at))
            .err()
            .expect("expected transition refusal")
            .code(),
    );
    let mut input = LegacyMailDefer {
        actor: actor.clone(),
        envelope_id: "legacy-envelope-2".into(),
        reason: "why".into(),
        retry_after_ms: Some(-1),
    };
    failures.push(
        store
            .write(|tx| tx.defer_legacy_mail(&input, at))
            .err()
            .expect("expected transition refusal")
            .code(),
    );
    let presented = store
        .write(|tx| tx.present_pending_legacy_mail(&format!(" {target} "), 1, at))?
        .value;
    input.actor = LegacyMailActor::Scope {
        session_ref: "other".into(),
    };
    input.retry_after_ms = None;
    failures.push(
        store
            .write(|tx| tx.defer_legacy_mail(&input, at))
            .err()
            .expect("expected transition refusal")
            .code(),
    );
    input.actor = actor;
    input.reason = "  why  ".into();
    input.retry_after_ms = Some(1000);
    let deferred = store.write(|tx| tx.defer_legacy_mail(&input, at))?.value;
    input.reason = "why".into();
    let repeated = store.write(|tx| tx.defer_legacy_mail(&input, at))?.value;
    input.reason = "different".into();
    failures.push(
        store
            .write(|tx| tx.defer_legacy_mail(&input, at))
            .err()
            .expect("expected transition refusal")
            .code(),
    );
    let not_due = store
        .write(|tx| tx.requeue_deferred_legacy_mail_due("2000-01-01T00:00:00.000Z"))?
        .value;
    let due = store
        .write(|tx| tx.requeue_deferred_legacy_mail_due("2050-01-01T00:00:00.000Z"))?
        .value;
    let represented = store
        .write(|tx| tx.present_pending_legacy_mail(target, 1, at))?
        .value;
    let dead = store
        .write(|tx| tx.mark_legacy_mail_dead("legacy-envelope-2", at))?
        .value;
    let repeat_dead = store
        .write(|tx| tx.mark_legacy_mail_dead("legacy-envelope-2", at))?
        .value;
    let all =
        store.read_snapshot(|tx| tx.list_legacy_mail_envelopes(&LegacyMailList::default()))?;
    store.close()?;
    Ok(
        serde_json::json!({"failures":failures,"presented":presented,"deferred":deferred,"repeated":repeated,"notDue":not_due,"due":due,"represented":represented,"dead":dead,"repeatDead":repeat_dead,"all":all}),
    )
}

fn legacy_mail_origin_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let origin = store
        .read_snapshot(|tx| tx.legacy_mail_origin_by_request("legacy-request"))?
        .expect("seeded origin");
    let mut incoming = origin.envelope.current().expect("current fixture").clone();
    incoming.state = "acked".into();
    incoming.round_count = 3;
    incoming.response = Some(serde_json::parse(r#"{"\ud800":"\udfff","ok":true}"#)?);
    incoming.presented_at = Some("2026-10-23T01:00:00.000Z".into());
    incoming.acked_at = Some("2026-10-23T01:00:01.000Z".into());
    incoming.updated_at = "2026-10-23T01:00:02.000Z".into();
    incoming.terminal_actor = Some(LegacyMailActor::Operator {
        principal: "remote".into(),
    });
    let mut failures = vec![];
    let mut bad = incoming.clone();
    bad.state = "dead".into();
    failures.push(
        store
            .write(|tx| {
                tx.apply_legacy_mail_federated_disposition("legacy-request", "disposition-1", &bad)
            })
            .err()
            .expect("dead refusal")
            .code(),
    );
    failures.push(
        store
            .write(|tx| {
                tx.apply_legacy_mail_federated_disposition("absent", "disposition-1", &incoming)
            })
            .err()
            .expect("missing refusal")
            .code(),
    );
    bad = incoming.clone();
    bad.payload.body = "wrong".into();
    failures.push(
        store
            .write(|tx| {
                tx.apply_legacy_mail_federated_disposition("legacy-request", "disposition-1", &bad)
            })
            .err()
            .expect("request refusal")
            .code(),
    );
    let applied = store
        .write(|tx| {
            tx.apply_legacy_mail_federated_disposition("legacy-request", "disposition-1", &incoming)
        })?
        .value;
    bad = incoming.clone();
    bad.updated_at = "2099-01-01T00:00:00.000Z".into();
    let repeated = store
        .write(|tx| {
            tx.apply_legacy_mail_federated_disposition("legacy-request", "disposition-1", &bad)
        })?
        .value;
    failures.push(
        store
            .write(|tx| {
                tx.apply_legacy_mail_federated_disposition(
                    "legacy-request",
                    "other-disposition",
                    &incoming,
                )
            })
            .err()
            .expect("disposition refusal")
            .code(),
    );
    bad = incoming.clone();
    bad.response = Some(serde_json::Value::Null);
    failures.push(
        store
            .write(|tx| {
                tx.apply_legacy_mail_federated_disposition("legacy-request", "disposition-1", &bad)
            })
            .err()
            .expect("response refusal")
            .code(),
    );
    let origin = store.read_snapshot(|tx| tx.legacy_mail_origin_by_request("legacy-request"))?;
    store.close()?;
    Ok(
        serde_json::json!({"failures":failures,"applied":applied,"repeated":repeated,"origin":origin}),
    )
}

fn consumer_placement_active(
    mut store: Store,
    conflicting: bool,
) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let home = if conflicting {
        "consumer-node-b"
    } else {
        "consumer-node-a"
    };
    let rows = store
        .write(|tx| {
            tx.install_active_placement(&InstallPlacement {
                scope_ref: "agent:consumer:project:hrc-runtime:task:p1-active".into(),
                home_node_id: home.into(),
                created_at: None,
                updated_at: at.into(),
            })?;
            tx.install_active_placement(&InstallPlacement {
                scope_ref: "agent:consumer:project:hrc-runtime:task:p1-retired".into(),
                home_node_id: home.into(),
                created_at: None,
                updated_at: at.into(),
            })?;
            tx.retire_placement(
                "agent:consumer:project:hrc-runtime:task:p1-retired",
                home,
                "consumer retired control",
                at,
            )?;
            tx.read().placements()
        })?
        .value;
    store.close()?;
    Ok(serde_json::json!({"placements":rows,"homeNodeId":home}))
}
fn consumer_history_read(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let value=store.read_snapshot(|tx|Ok(serde_json::json!({
        "run":tx.run_by_id("consumer-run")?,"runtime":tx.runtime_by_id("consumer-runtime")?,
        "session":tx.sessions().get_by_host_session_id("consumer-host")?,
        "brokerEvents":tx.broker_events_by_invocation("consumer-invocation")?,
        "lifecycle":tx.lifecycle_events().list_by_run("consumer-run",&LifecycleFilters::default())?,
        "artifacts":tx.runtime_artifacts_by_operation("consumer-operation")?,
        "head":tx.lifecycle_events().allocated_hrc_seq()?
    })))?;
    store.close()?;
    Ok(value)
}
fn consumer_history_contract(
    mut store: Store,
    path: &std::path::Path,
) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    use sha2::{Digest, Sha256};
    let at = "2026-10-23T00:00:00.000Z";
    let scope = "agent:consumer:project:hrc-runtime:task:p1-consumers";
    let (mut session, mut runtime, mut run, mut fields) = store.read_snapshot(|tx| {
        Ok((
            tx.sessions()
                .get_by_host_session_id("p1-host")?
                .ok_or_else(|| StoreError::MissingRecord("oracle session".into()))?,
            tx.runtime_by_id("p1-runtime")?
                .ok_or_else(|| StoreError::MissingRecord("oracle runtime".into()))?,
            tx.run_by_id("p1-run")?
                .ok_or_else(|| StoreError::MissingRecord("oracle run".into()))?,
            tx.lifecycle_events()
                .page(0, 100, None)?
                .rows
                .into_iter()
                .next()
                .ok_or_else(|| StoreError::MissingRecord("oracle lifecycle".into()))?
                .fields,
        ))
    })?;
    session.host_session_id = "consumer-host".into();
    session.scope_ref = scope.into();
    session.identity = None;
    session.status = "inactive".into();
    runtime.runtime_id = "consumer-runtime".into();
    runtime.host_session_id = session.host_session_id.clone();
    runtime.scope_ref = scope.into();
    runtime.transport = "headless".into();
    runtime.harness = Some("codex-cli".into());
    runtime.provider = Some("openai".into());
    runtime.controller_kind = Some("harness-broker".into());
    runtime.status = "dead".into();
    runtime.identity = None;
    runtime.active_run_id = None;
    runtime.active_operation_id = None;
    runtime.active_invocation_id = None;
    run.run_id = "consumer-run".into();
    run.host_session_id = session.host_session_id.clone();
    run.runtime_id = Some(runtime.runtime_id.clone());
    run.scope_ref = scope.into();
    run.transport = "headless".into();
    run.status = "completed".into();
    run.operation_id = Some("consumer-operation".into());
    run.invocation_id = Some("consumer-invocation".into());
    let op = RuntimeOperation {
        operation_id: "consumer-operation".into(),
        runtime_id: runtime.runtime_id.clone(),
        run_id: Some(run.run_id.clone()),
        host_session_id: session.host_session_id.clone(),
        generation: 1,
        operation_kind: "start".into(),
        controller: "broker".into(),
        startup_method: "spawn".into(),
        status: "completed".into(),
        route_decision_json: "{}".into(),
        created_at: at.into(),
        completed_at: Some(at.into()),
        updated_at: at.into(),
        ..Default::default()
    };
    let invocation = BrokerInvocation {
        invocation_id: "consumer-invocation".into(),
        operation_id: op.operation_id.clone(),
        runtime_id: runtime.runtime_id.clone(),
        run_id: Some(run.run_id.clone()),
        broker_protocol: "harness-broker/0.2".into(),
        broker_driver: "codex-app-server".into(),
        invocation_state: "stopped".into(),
        capabilities_json: "{}".into(),
        spec_hash: "sha256:consumer-spec".into(),
        start_request_hash: "sha256:consumer-request".into(),
        selected_profile_hash: "sha256:consumer-profile".into(),
        current_harness_generation: Some(1),
        current_turn_attempt: Some(1),
        last_projected_seq: 3,
        created_at: at.into(),
        updated_at: at.into(),
        ..Default::default()
    };
    let transcript=serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"consumer final answer"}]}}).stringify()+"\n";
    let artifact_path = path
        .parent()
        .ok_or_else(|| StoreError::Invalid("scratch parent".into()))?
        .join("consumer-provider.jsonl");
    admit_scratch_path(&artifact_path)?;
    std::fs::write(&artifact_path, transcript.as_bytes())
        .map_err(|e| StoreError::Invalid(e.to_string()))?;
    let artifact = RuntimeArtifact {
        artifact_id: "consumer-artifact".into(),
        operation_id: op.operation_id.clone(),
        artifact_kind: "provider-transcript-jsonl".into(),
        media_type: "application/x-ndjson".into(),
        storage_kind: "file-path".into(),
        content_hash: format!("sha256:{:x}", Sha256::digest(transcript.as_bytes())),
        artifact_json: None,
        artifact_path: Some(artifact_path.display().to_string()),
        created_at: at.into(),
    };
    fields.host_session_id = session.host_session_id.clone();
    fields.scope_ref = scope.into();
    fields.runtime_id = Some(runtime.runtime_id.clone());
    fields.run_id = Some(run.run_id.clone());
    fields.transport = Some("headless".into());
    let expected=store.write(|tx|{
        tx.insert_session(&session)?;tx.upsert_continuity(scope,"main",&session.host_session_id,at)?;tx.insert_runtime(&runtime)?;tx.insert_run(&run)?;tx.insert_runtime_operation(&op)?;tx.insert_broker_invocation(&invocation)?;tx.insert_runtime_artifact(&artifact)?;
        let mut expected=vec![];
        for (index,(kind,lifecycle,payload)) in [
            ("user.message","turn.user_prompt",serde_json::json!({"content":"consumer prompt"})),
            ("assistant.message.completed","turn.message",serde_json::json!({"content":"consumer final answer"})),
            ("turn.completed","turn.completed",serde_json::json!({"status":"completed"}))
        ].into_iter().enumerate(){
            let seq=index as i64+1;
            let mirror=tx.append_legacy_event(&LegacyEventFields{ts:at.into(),host_session_id:session.host_session_id.clone(),scope_ref:scope.into(),lane_ref:"main".into(),generation:1,run_id:Some(run.run_id.clone()),runtime_id:Some(runtime.runtime_id.clone()),source:"broker".into(),event_kind:format!("broker.{kind}"),event_json:Some(serde_json::json!({"invocationId":invocation.invocation_id,"seq":seq,"type":kind,"time":at,"payload":payload}))})?;
            tx.append_broker_event(&BrokerEventAppend{invocation_id:invocation.invocation_id.clone(),seq,time:at.into(),r#type:kind.into(),runtime_id:runtime.runtime_id.clone(),run_id:Some(run.run_id.clone()),harness_generation:Some(1),turn_attempt:Some(1),payload:payload.clone(),hrc_event_seq:Some(mirror.seq),projection_status:Some("applied".into()),..Default::default()})?;
            fields.event_kind=lifecycle.into();fields.payload=Some(payload.clone());let row=tx.append_lifecycle(&fields)?;
            expected.push(serde_json::json!({"eventKind":lifecycle,"payload":payload,"hrcSeq":row.hrc_seq}));
        }
        let mut unrelated=fields.clone();unrelated.host_session_id="p1-host".into();unrelated.scope_ref="agent:tabularasa:project:hrc-runtime:task:p1-store".into();unrelated.runtime_id=Some("p1-runtime".into());unrelated.run_id=Some("p1-run".into());unrelated.payload=Some(serde_json::json!({"text":"unrelated global head"}));tx.append_lifecycle(&unrelated)?;
        Ok(expected)
    })?.value;
    let readback=store.read_snapshot(|tx|Ok(serde_json::json!({"run":tx.run_by_id("consumer-run")?,"brokerEvents":tx.broker_events_by_invocation("consumer-invocation")?,"lifecycle":tx.lifecycle_events().list_by_run("consumer-run",&LifecycleFilters::default())?,"artifacts":tx.runtime_artifacts_by_operation("consumer-operation")?})))?;
    store.close()?;
    Ok(
        serde_json::json!({"runId":"consumer-run","runtimeId":"consumer-runtime","hostSessionId":"consumer-host","invocationId":"consumer-invocation","scopeRef":scope,"artifactPath":artifact_path.display().to_string(),"expectedLifecycle":expected,"readback":readback}),
    )
}
fn consumer_archive_history(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let rows = store
        .write(|tx| {
            let mut rows = vec![];
            for (i, source) in ["legacy-claude", "broker", "legacy-codex", "tmux"]
                .into_iter()
                .enumerate()
            {
                rows.push(tx.append_legacy_event(&LegacyEventFields {
                    ts: "2026-10-23T00:00:00.000Z".into(),
                    host_session_id: "p1-host".into(),
                    scope_ref: "agent:tabularasa:project:hrc-runtime:task:p1-store".into(),
                    lane_ref: "main".into(),
                    generation: 1,
                    run_id: Some("p1-run".into()),
                    runtime_id: Some("p1-runtime".into()),
                    source: source.into(),
                    event_kind: "legacy.consumer.control".into(),
                    event_json: Some(
                        serde_json::json!({"index":i,"text":"archive byte-value control"}),
                    ),
                })?);
            }
            Ok(rows)
        })?
        .value;
    store.close()?;
    Ok(serde_json::json!({"rows":rows}))
}
fn consumer_append_control(mut store: Store) -> Result<serde_json::Value, StoreError> {
    let mut fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 1, None))?
        .rows
        .into_iter()
        .next()
        .ok_or_else(|| StoreError::MissingRecord("oracle lifecycle".into()))?
        .fields;
    fields.event_kind = "turn.message".into();
    fields.payload = Some(serde_json::json!({"text":"consumer concurrent append"}));
    let row = store.write(|tx| tx.append_lifecycle(&fields))?.value;
    store.close()?;
    Ok(serde_json::json!({"row":row}))
}

fn legacy_mail_observation<T: serde::Serialize>(
    name: &str,
    result: Result<T, StoreError>,
) -> serde_json::Value {
    match result {
        Ok(value) => serde_json::json!({"name":name,"value":value}),
        Err(StoreError::Mail {
            code,
            message,
            detail,
        }) => {
            serde_json::json!({"name":name,"error":{"name":"HrcMailRepositoryError","code":code,"message":message,"detail":detail}})
        }
        Err(StoreError::ReplySchema(error)) => {
            serde_json::json!({"name":name,"error":{"name":error.name,"message":error.message}})
        }
        Err(error) => {
            serde_json::json!({"name":name,"error":{"name":"StoreError","code":error.code(),"message":error.to_string()}})
        }
    }
}
fn legacy_mail_create_ack_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T00:00:00.000Z";
    let target = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let actor = LegacyMailActor::Operator {
        principal: "fixture".into(),
    };
    let base: LegacyMailSend = serde_json::from_value(
        serde_json::json!({"ingressId":"create-ingress","from":actor,"targetSessionRef":format!(" {target} "),"payload":{"kind":"request","body":" preserved body ","metadata":{"b":2,"a":1}}}),
    )?;
    let ids = vec!["create-envelope".into()];
    let schema_ids = vec!["schema-envelope".into()];
    let mut results = vec![];
    macro_rules! observe {
        ($name:literal,$action:expr) => {
            results.push(legacy_mail_observation(
                $name,
                $action.map(|committed| committed.value),
            ));
        };
    }
    observe!(
        "create",
        store.write(|tx| tx.create_legacy_mail(&base, Some("create-envelope"), at))
    );
    let mut changed = base.clone();
    changed.materialization_intent = Some(serde_json::json!({"first":true}));
    observe!(
        "repeat",
        store.write(|tx| tx.create_legacy_mail(&changed, Some("ignored-id"), at))
    );
    changed.materialization_intent = Some(serde_json::json!({"second":true}));
    observe!(
        "repeatHint",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    changed = base.clone();
    changed.payload.body = "different".into();
    observe!(
        "conflict",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    changed = base.clone();
    changed.target_session_ref = target.into();
    observe!(
        "trimFingerprintConflict",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    observe!(
        "pendingAck",
        store.write(|tx| tx.ack_legacy_mail(&actor, &ids, None, at))
    );
    observe!(
        "present",
        store.write(|tx| tx.present_pending_legacy_mail(target, 1000, at))
    );
    observe!(
        "wrongActor",
        store.write(|tx| tx.ack_legacy_mail(
            &LegacyMailActor::Scope {
                session_ref: "wrong".into()
            },
            &ids,
            None,
            at
        ))
    );
    observe!(
        "ack",
        store.write(|tx| tx.ack_legacy_mail(
            &actor,
            &ids,
            Some(&serde_json::json!({"b":2,"a":1})),
            at
        ))
    );
    observe!(
        "ackRepeat",
        store.write(|tx| tx.ack_legacy_mail(
            &actor,
            &["create-envelope".into(), "create-envelope".into()],
            Some(&serde_json::json!({"a":1,"b":2})),
            at
        ))
    );
    observe!(
        "ackConflict",
        store.write(|tx| tx.ack_legacy_mail(&actor, &ids, Some(&serde_json::Value::Null), at))
    );
    changed = base.clone();
    changed.ingress_id = "schema-ingress".into();
    changed.reply_schema = Some(
        serde_json::json!({"type":"object","additionalProperties":false,"required":["status"],"properties":{"status":{"const":"ok"}}}),
    );
    observe!(
        "schemaCreate",
        store.write(|tx| tx.create_legacy_mail(&changed, Some("schema-envelope"), at))
    );
    observe!(
        "schemaPresent",
        store.write(|tx| tx.present_pending_legacy_mail(target, 1000, at))
    );
    observe!(
        "schemaMissing",
        store.write(|tx| tx.ack_legacy_mail(&actor, &schema_ids, None, at))
    );
    observe!(
        "schemaWrong",
        store.write(|tx| tx.ack_legacy_mail(
            &actor,
            &schema_ids,
            Some(&serde_json::json!({"status":"bad","extra":1})),
            at
        ))
    );
    observe!(
        "batchSchema",
        store.write(|tx| tx.ack_legacy_mail(
            &actor,
            &["schema-envelope".into(), "create-envelope".into()],
            Some(&serde_json::json!({"status":"ok"})),
            at
        ))
    );
    observe!(
        "schemaAck",
        store.write(|tx| tx.ack_legacy_mail(
            &actor,
            &schema_ids,
            Some(&serde_json::json!({"status":"ok"})),
            at
        ))
    );
    observe!(
        "emptyAck",
        store.write(|tx| tx.ack_legacy_mail(&actor, &[], None, at))
    );
    observe!(
        "unknownAck",
        store.write(|tx| tx.ack_legacy_mail(&actor, &["missing".into()], None, at))
    );
    changed = base.clone();
    changed.reply_schema = Some(serde_json::json!({"$ref":"https://example.invalid/no"}));
    observe!(
        "invalidSchemaBeforeReceipt",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    changed = base.clone();
    changed.ingress_id = " ".into();
    observe!(
        "emptyIngress",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    changed = base.clone();
    changed.target_session_ref = " ".into();
    observe!(
        "emptyTarget",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    changed = base.clone();
    changed.payload.body = " ".into();
    observe!(
        "emptyBody",
        store.write(|tx| tx.create_legacy_mail(&changed, None, at))
    );
    store.close()?;
    Ok(serde_json::json!({"results":results}))
}

fn legacy_mail_body_contract(
    mut store: Store,
    origin: bool,
) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let actor = LegacyMailActor::Operator {
        principal: "fixture".into(),
    };
    let target = "agent:tabularasa:project:hrc-runtime:task:p1-store";
    let at = "2026-10-23T00:00:00.000Z";
    let mut results = vec![];
    for (index, line) in include_str!("../e2e/fixtures/mail-body.jsonl")
        .lines()
        .enumerate()
    {
        let record: serde_json::Value = serde_json::parse(line)?;
        let units = record["units"]
            .as_array()
            .expect("fixed array")
            .iter()
            .map(|v| {
                v.as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .expect("fixed u16")
            })
            .collect::<Vec<_>>();
        let input = LegacyMailSend {
            ingress_id: format!("body-ingress-{index}"),
            from: actor.clone(),
            target_session_ref: target.into(),
            payload: LegacyMailPayload {
                kind: "request".into(),
                body: JsString::from_utf16(units),
                metadata: Some(serde_json::json!({"case":index})),
            },
            reply_schema: None,
            materialization_intent: None,
        };
        let id = format!("body-envelope-{index}");
        let create = legacy_mail_observation(
            "create",
            store
                .write(|tx| {
                    if origin {
                        tx.create_legacy_mail_federated_origin(
                            &input,
                            &id,
                            &format!("body-message-{index}"),
                            at,
                        )
                    } else {
                        tx.create_legacy_mail(&input, Some(&id), at)
                    }
                })
                .map(|c| c.value),
        );
        let retry = legacy_mail_observation(
            "retry",
            store
                .write(|tx| {
                    if origin {
                        tx.create_legacy_mail_federated_origin(
                            &input,
                            &id,
                            &format!("body-message-{index}"),
                            at,
                        )
                    } else {
                        tx.create_legacy_mail(&input, Some(&id), at)
                    }
                })
                .map(|c| c.value),
        );
        let reappend = if let Some(body) = create
            .get("value")
            .and_then(|v| v.get("envelope"))
            .and_then(|v| v.get("payload"))
            .and_then(|v| v.get("body"))
            .and_then(serde_json::Value::as_js_string)
        {
            let mut reread = input.clone();
            reread.payload.body = body.clone();
            legacy_mail_observation(
                "reappend",
                store
                    .write(|tx| {
                        if origin {
                            tx.create_legacy_mail_federated_origin(
                                &reread,
                                &id,
                                &format!("body-message-{index}"),
                                at,
                            )
                        } else {
                            tx.create_legacy_mail(&reread, Some(&id), at)
                        }
                    })
                    .map(|c| c.value),
            )
        } else {
            serde_json::Value::Null
        };
        results.push(serde_json::json!({"index":index,"name":record["name"],"units":record["units"],"create":create,"retry":retry,"reappend":reappend}));
    }
    store.close()?;
    Ok(serde_json::json!({"results":results}))
}

fn legacy_mail_origin_create_contract(
    mut store: Store,
    missing: bool,
) -> Result<serde_json::Value, StoreError> {
    let at = "2026-10-23T00:00:00.000Z";
    let base: hrc_store::LegacyMailSend = hrc_store::json::from_str(
        r#"{"ingressId":"origin-ingress","from":{"kind":"operator","principal":"fixture"},"targetSessionRef":" target ","payload":{"kind":"request","body":"X\ud800Y\udfff","metadata":{"__proto__":{"kept":true},"b":2,"a":1,"\ud800":"key"}}}"#,
    )?;
    let mut results = vec![];
    macro_rules! origin {
        ($name:literal,$input:expr,$id:expr,$message:expr) => {
            results.push(legacy_mail_observation(
                $name,
                store
                    .write(|tx| tx.create_legacy_mail_federated_origin($input, $id, $message, at))
                    .map(|c| c.value),
            ));
        };
    }
    if missing {
        let result = store
            .write(|tx| {
                tx.create_legacy_mail_federated_origin(
                    &base,
                    "origin-envelope",
                    "origin-message",
                    at,
                )
            })
            .map(|c| c.value);
        results.push(match result {
            Err(StoreError::MissingRecord(message))=>serde_json::json!({"name":"missingReceipt","error":{"name":"Error","message":message}}),
            other=>legacy_mail_observation("missingReceipt",other)
        });
    } else {
        origin!("create", &base, "origin-envelope", "origin-message");
        origin!("repeat", &base, "ignored-envelope", "ignored-message");
        let mut changed = base.clone();
        changed.payload.body = "different".into();
        origin!("conflict", &changed, "origin-envelope", "origin-message");
        let changed: hrc_store::LegacyMailSend = hrc_store::json::from_str(
            r#"{"ingressId":"origin-ingress","from":{"kind":"operator","principal":"fixture"},"targetSessionRef":" target ","payload":{"kind":"request","body":"X\ud800Y\udfff","metadata":{"__proto__":{"kept":false},"b":2,"a":1,"\ud800":"key"}}}"#,
        )?;
        origin!(
            "prototypeOnlyRepeat",
            &changed,
            "origin-envelope",
            "origin-message"
        );
        let mut changed = base.clone();
        changed.reply_schema = Some(serde_json::json!({"$ref":"https://example.invalid/no"}));
        origin!(
            "invalidSchemaBeforeReceipt",
            &changed,
            "origin-envelope",
            "origin-message"
        );
        let mut changed = base.clone();
        changed.ingress_id = " ".into();
        changed.target_session_ref = " ".into();
        changed.payload.body = " ".into();
        changed.payload.metadata = None;
        origin!("blank", &changed, "blank-envelope", "blank-message");
        let mut changed = base.clone();
        changed.ingress_id = "local-ingress".into();
        changed.payload.body = "local".into();
        changed.payload.metadata = None;
        results.push(legacy_mail_observation(
            "local",
            store
                .write(|tx| tx.create_legacy_mail(&changed, Some("local-envelope"), at))
                .map(|c| c.value),
        ));
        origin!("localToOrigin", &changed, "other-envelope", "other-message");
        results.push(legacy_mail_observation(
            "originToLocal",
            store
                .write(|tx| tx.create_legacy_mail(&base, Some("other-local"), at))
                .map(|c| c.value),
        ));
    }
    store.close()?;
    Ok(serde_json::json!({"results":results}))
}

fn legacy_mail_origin_body_read_contract(
    mut store: Store,
) -> Result<serde_json::Value, StoreError> {
    let envelopes = store.read_snapshot(|tx| {
        (0..include_str!("../e2e/fixtures/mail-body.jsonl")
            .lines()
            .count())
            .map(|index| {
                tx.legacy_mail_origin_by_ingress(&format!("body-ingress-{index}"))?
                    .map(|origin| origin.envelope)
                    .ok_or_else(|| StoreError::MissingRecord(format!("body-ingress-{index}")))
            })
            .collect::<Result<Vec<_>, _>>()
    })?;
    store.close()?;
    Ok(serde_json::json!({"envelopes":envelopes}))
}

fn reconciliation_cas_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    use hrc_store::*;
    let at = "2026-10-23T01:00:00.000Z";
    let base = store
        .read_snapshot(|tx| tx.runtime_by_id("p1-runtime"))?
        .ok_or_else(|| StoreError::MissingRecord("p1-runtime".into()))?;
    let families: &[(&str, &[&str])] = &[
        (
            "aging",
            &[
                "exact",
                "pidWrong",
                "childWrong",
                "invocationMissing",
                "invocationSkip",
                "statusChanged",
                "runChanged",
                "opChanged",
                "invChanged",
                "activityChanged",
                "stateChanged",
                "hasAccepted",
                "hasTerminal",
            ],
        ),
        (
            "orphan",
            &[
                "free",
                "noRuntime",
                "ownsSame",
                "ownsOtherOpen",
                "ownsOtherTerminal",
                "ownsOtherMissing",
                "runTerminal",
                "runCompleted",
            ],
        ),
        (
            "finalize",
            &[
                "exact",
                "wrongRuntime",
                "ownerChanged",
                "terminal",
                "completed",
                "unsupportedTransport",
            ],
        ),
        (
            "reap",
            &[
                "exact",
                "wrongRuntime",
                "ownerChanged",
                "terminal",
                "completed",
                "unsupportedTransport",
            ],
        ),
        (
            "zombie",
            &["exact", "wrongTransport", "terminal", "completed"],
        ),
        ("release", &["exact", "changed"]),
    ];
    let mut results = vec![];
    for (family, variants) in families {
        for variant in *variants {
            let id = format!("{family}-{variant}");
            let runtime = format!("{id}-runtime");
            let run = format!("{id}-run");
            let changed = store
                .write(|tx| match *family {
                    "aging" => {
                        let mut observed = base.clone();
                        observed.runtime_id = runtime.clone();
                        observed.status = "ready".into();
                        observed.active_run_id = None;
                        observed.active_operation_id = None;
                        observed.active_invocation_id = None;
                        observed.last_activity_at = Some("2026-10-23T00:00:00.000Z".into());
                        observed.runtime_state_json = Some(serde_json::json!({"v":1}));
                        let evidence = RuntimeAgingInvocation {
                            invocation_id: if *variant == "invocationSkip" {
                                None
                            } else {
                                Some(
                                    if *variant == "invocationMissing" {
                                        "missing"
                                    } else {
                                        "p1-process"
                                    }
                                    .into(),
                                )
                            },
                            broker_pid: Some(if *variant == "pidWrong" { 101 } else { 100 }),
                            child_pid: Some(if *variant == "childWrong" { 201 } else { 200 }),
                        };
                        tx.age_runtime_if_unchanged(&observed, &evidence, at)
                    }
                    "orphan" => tx.fail_abandoned_run(
                        &run,
                        &runtime,
                        "fixture-error",
                        "fixture message",
                        at,
                    ),
                    "finalize" => tx.finalize_owned_run(&run, &runtime, "completed", at),
                    "reap" => {
                        tx.reap_owned_run(&run, &runtime, "fixture-error", "fixture message", at)
                    }
                    "zombie" => {
                        tx.zombie_headless_run(&run, "fixture-error", "fixture message", at)
                    }
                    "release" => tx.release_runtime_run(&runtime, &run, "ready", at),
                    _ => unreachable!("fixed family"),
                })?
                .value;
            results.push(serde_json::json!({"id":id,"changed":changed}));
        }
    }

    let mut fields = store
        .read_snapshot(|tx| tx.lifecycle_events().page(0, 1, None))?
        .rows
        .into_iter()
        .next()
        .ok_or_else(|| StoreError::MissingRecord("nonempty lifecycle".into()))?
        .fields;
    fields.ts = at.into();
    fields.runtime_id = Some("atomic-runtime".into());
    fields.run_id = Some("atomic-run".into());
    fields.category = "turn".into();
    fields.event_kind = "turn.completed".into();
    fields.transport = Some("headless".into());
    fields.payload = Some(serde_json::json!({"source":"reconciliation","success":true}));
    let before=store.read_snapshot(|tx|Ok(serde_json::json!({
        "run":tx.run_by_id("atomic-run")?,"runtime":tx.runtime_by_id("atomic-runtime")?,
        "hrcHead":tx.lifecycle_events().allocated_hrc_seq()?,"streamHead":tx.allocated_event_stream_seq()?
    })))?;
    let hints = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let observed = hints.clone();
    store.observe(move |_| observed.set(observed.get() + 1));
    let atomic = |tx: &mut hrc_store::WriteTx<'_>| -> hrc_store::Result<()> {
        if !tx.finalize_owned_run("atomic-run", "atomic-runtime", "completed", at)?
            || !tx.release_runtime_run("atomic-runtime", "atomic-run", "ready", at)?
        {
            return Err(StoreError::Invalid("missing atomic CAS".into()));
        }
        tx.append_lifecycle(&fields)?;
        Ok(())
    };
    let rejected = store.write::<()>(|tx| {
        atomic(tx)?;
        Err(StoreError::Invalid("fixture rollback".into()))
    });
    if !matches!(rejected,Err(StoreError::Invalid(ref message)) if message=="fixture rollback") {
        return Err(StoreError::Invalid("missing forced rollback".into()));
    }
    let after=store.read_snapshot(|tx|Ok(serde_json::json!({
        "run":tx.run_by_id("atomic-run")?,"runtime":tx.runtime_by_id("atomic-runtime")?,
        "hrcHead":tx.lifecycle_events().allocated_hrc_seq()?,"streamHead":tx.allocated_event_stream_seq()?
    })))?;
    let atomic_rolled_back = before == after && hints.get() == 0;
    let committed = store.write(atomic)?;
    let atomic_committed = committed.changes.len() == 2 && hints.get() == 2;
    store.close()?;
    Ok(
        serde_json::json!({"results":results,"atomicRolledBack":atomic_rolled_back,"atomicCommitted":atomic_committed,"postCommitHints":hints.get()}),
    )
}

fn reconciliation_query_contract(mut store: Store) -> Result<serde_json::Value, StoreError> {
    let result=store.read_snapshot(|tx|{
        let accepted=["chosen","missing"].map(|input|tx.accepted_broker_input_seq("read-invocation",input)).into_iter().collect::<Result<Vec<_>,_>>()?;
        let terminals=[0,2,3,4,5,99].map(|seq|tx.first_orphan_broker_terminal_after("read-invocation",seq)).into_iter().collect::<Result<Vec<_>,_>>()?;
        let prefixes=vec!["agent:literal_%\\".into()];let tasks=vec!["same-task".into()];
        Ok(serde_json::json!({
            "accepted":accepted,"terminals":terminals,
            "absorbedAll":tx.absorbed_submission_events("p1-runtime",None)?,
            "absorbedOne":tx.absorbed_submission_events("p1-runtime",Some("read-invocation"))?,
            "terminalRuntimes":tx.terminal_runtime_active_runs()?,
            "inFlight":tx.recent_in_flight_work("2026-10-23T00:00:00.000Z",false,&[],None)?,
            "acceptedInFlight":tx.recent_in_flight_work("2026-10-23T00:00:00.000Z",true,&[],None)?,
            "excluded":tx.recent_in_flight_work("2026-10-23T00:00:00.000Z",true,&["tmux".into()],Some("flight-headless"))?,
            "scoped":[tx.scoped_selector_host_ids(&[],&[])?,tx.scoped_selector_host_ids(&prefixes,&[])?,
                tx.scoped_selector_host_ids(&[],&tasks)?,tx.scoped_selector_host_ids(&prefixes,&["same-task".into(),"same-task".into()])?],
            "roleTree":tx.role_tree_selector_host_ids("agent:literal_%\\",true)?,
            "roleExact":tx.role_tree_selector_host_ids("agent:literal_%\\:role:review",false)?
        }))
    })?;
    store.close()?;
    Ok(serde_json::json!({"result":result}))
}
