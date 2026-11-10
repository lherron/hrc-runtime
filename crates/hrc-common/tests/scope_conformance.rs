//! agent-scope grammar fixture (agent-spaces contracts/agent-scope/conformance,
//! copied by `just sync-agent-scope-fixtures`): every case of every operation
//! HRC declares, against hrc-common's parser. All ten operations are declared.
use hrc_common::scope::{self, ResolveOptions, ScopeError, ScopeRef};
use serde_json::{Value, json};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../conformance/agent-scope/scope-cases.json"
);
const DECLARED: &[&str] = &[
    "scopeRef.parse",
    "scopeRef.format",
    "scopeHandle.parse",
    "scopeHandle.format",
    "laneRef.normalize",
    "sessionHandle.parse",
    "sessionRef.parse",
    "sessionRef.format",
    "input.resolve",
    "identity.project",
];

fn parts(p: &ScopeRef<'_>) -> Value {
    let mut v = json!({"kind":p.kind(),"agentId":p.agent});
    for (k, x) in [
        ("projectId", p.project),
        ("taskId", p.task),
        ("roleName", p.role),
    ] {
        if let Some(x) = x {
            v[k] = x.into();
        }
    }
    v
}
fn session(s: scope::SessionRef) -> Value {
    json!({"scopeRef":s.scope_ref,"laneRef":s.lane_ref})
}

fn run(op: &str, input: &Value, opts: &Value) -> Result<Value, ScopeError> {
    let text = || input.as_str().expect("string input");
    let field = |v: &Value, k: &str| v[k].as_str().map(str::to_owned);
    Ok(match op {
        "scopeRef.parse" => parts(&ScopeRef::parse(text())?),
        "scopeRef.format" => scope::build_scope_ref(
            input["agentId"].as_str().unwrap(),
            input["projectId"].as_str(),
            input["taskId"].as_str(),
            input["roleName"].as_str(),
        )
        .into(),
        "scopeHandle.parse" => scope::parse_scope_handle(text())?.into(),
        "scopeHandle.format" => scope::format_scope_handle(text())?.into(),
        "laneRef.normalize" => scope::normalize_lane_ref(input.as_str())?.into(),
        "sessionHandle.parse" => session(scope::parse_session_handle(text())?),
        "sessionRef.parse" => session(scope::parse_session_ref(text())?),
        "sessionRef.format" => scope::format_session_ref(
            input["scopeRef"].as_str().unwrap(),
            input["laneRef"].as_str().unwrap(),
        )?
        .into(),
        "input.resolve" => {
            let (p, t, d, e, r) = (
                field(opts, "projectId"),
                field(opts, "taskId"),
                field(opts, "defaultTaskId"),
                field(opts, "envDefaultTask"),
                field(opts, "defaultRoleName"),
            );
            let opts = ResolveOptions {
                project_id: p.as_deref(),
                task_id: t.as_deref(),
                default_task_id: d.as_deref(),
                env_default_task: e.as_deref(),
                default_role_name: r.as_deref(),
                ..Default::default()
            };
            let r = scope::resolve_qualified_scope_input(text(), &opts)?;
            json!({"scopeRef":r.scope_ref,"laneRef":r.lane_ref})
        }
        "identity.project" => scope::legacy_derive_identity(text()),
        other => panic!("undeclared operation {other}"),
    })
}

#[test]
fn every_declared_operation_passes_every_case() {
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    assert_eq!(fixture["version"], 1, "fixture version");
    let cases = fixture["cases"].as_array().unwrap();
    let mut failures = vec![];
    let mut ran = 0;
    for case in cases {
        let (id, op) = (case["id"].as_str().unwrap(), case["op"].as_str().unwrap());
        assert!(
            DECLARED.contains(&op),
            "{id}: operation {op} is not declared"
        );
        ran += 1;
        let got = match run(op, &case["in"], case.get("opts").unwrap_or(&json!({}))) {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"refuse":e.code.as_str(),"message":e.message}),
        };
        let pass = match (case.get("ok"), case.get("refuse")) {
            (Some(want), _) => got.get("ok") == Some(want),
            (_, Some(code)) => got.get("refuse") == Some(code),
            _ => panic!("{id}: case has neither ok nor refuse"),
        };
        if !pass {
            let want = case
                .get("ok")
                .map_or_else(|| json!({"refuse":case["refuse"]}), |v| json!({"ok":v}));
            failures.push(format!("{id} {op} {}: want {want}, got {got}", case["in"]));
        }
    }
    assert_eq!(ran, cases.len());
    assert!(
        failures.is_empty(),
        "{} of {ran} cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
