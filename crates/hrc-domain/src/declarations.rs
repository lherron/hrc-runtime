use serde_json::{Value, json};

fn fields(names: &[&str]) -> Value {
    names
        .iter()
        .map(|s| ((*s).to_string(), json!({"kind":"string"})))
        .collect::<serde_json::Map<_, _>>()
        .into()
}
pub fn declarations() -> Value {
    let mut seat = fields(&[
        "sessionRef",
        "scopeRef",
        "laneRef",
        "displayRef",
        "hostSessionId",
        "runtimeId",
        "agentId",
        "projectId",
        "taskId",
        "status",
        "summaryStatus",
        "sessionStatus",
        "lastActivityAt",
        "title",
    ]);
    seat["generation"] = json!({"kind":"integer"});
    seat["lastHrcSeq"] = json!({"kind":"integer"});
    for name in ["latestEvent", "contextReading", "tmux", "metadata"] {
        seat[name] = json!({"kind":"json"});
    }
    let mut runtime = fields(&[
        "runtimeId",
        "hostSessionId",
        "scopeRef",
        "laneRef",
        "status",
        "sessionRef",
        "title",
    ]);
    runtime["generation"] = json!({"kind":"integer"});
    for name in [
        "identity",
        "metadata",
        "presentation",
        "tmux",
        "contextReading",
        "operatorSurfaces",
    ] {
        runtime[name] = json!({"kind":"json"});
    }
    let types = vec![
        json!({"name":"hrc.seat","schema_version":1,"family":"hrc.observation","root":true,"observation":true,"natural_key":["sessionRef"],"live_until":"live_until","attachable":{"transport":"tmux-attach","fence":["hostSessionId","generation","runtimeId"]},"payload":{"kind":"object","fields":seat,"required":["sessionRef","hostSessionId","generation","status","summaryStatus","lastActivityAt"]},"hints":{"title_field":"displayRef","summary_fields":["status","latestEvent"],"sort":{"field":"lastActivityAt","dir":"desc"}}}),
        json!({"name":"hrc.runtime","schema_version":1,"family":"hrc.observation","root":true,"observation":true,"natural_key":["runtimeId"],"live_until":"live_until","payload":{"kind":"object","fields":runtime,"nullable":["contextReading"],"required":["runtimeId","sessionRef","status"]},"hints":{"title_field":"runtimeId"}}),
        json!({"name":"hrc.project","schema_version":1,"family":"hrc.observation","root":true,"observation":true,"natural_key":["projectId"],"payload":{"kind":"object","fields":fields(&["projectId","name"]),"required":["projectId","name"]},"hints":{"title_field":"name"}}),
    ];
    json!({"provider":"hrc","version":"1","node_families":[{"name":"hrc.observation","domain_attributes":{"kind":"object","fields":{"source":{"kind":"string"},"live_until":{"kind":"string"}},"required":["source","live_until"],"nullable":["live_until"]}}],"node_types":types,"operations":[crate::summon::declaration(),{"name":"hrc.project","kind":"ingest","writes":["hrc.seat","hrc.runtime","hrc.project"],"reports_catch_up":true,"input":{"kind":"object","fields":{}},"output":{"kind":"object","fields":{}}}]})
}
