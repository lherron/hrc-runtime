//! R6 and continuity fences: expectations precede the implementation.
use hrc_store::{Store, classify_seat};
use serde_json::json;
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}
#[test]
fn r6_boundaries_and_declared_slots() {
    let p = json!({"homes":{"primary":"max3","review":"svc"},"pins":{"hrc-runtime:hrcdev":"hrcdev","p:T-1":"svc"}});
    for (task, kind) in [
        ("T-123", "task"),
        ("T-", "adhoc"),
        ("T-1x", "adhoc"),
        ("T-1-nova", "adhoc"),
        ("primary", "standing"),
        ("primary-nova", "standing"),
        ("hrcdev", "standing"),
        ("primary-unknown", "adhoc"),
        ("scratch", "adhoc"),
    ] {
        assert_eq!(classify_seat(Some(task), &p), kind, "{task}");
    }
    assert_eq!(classify_seat(None, &p), "adhoc");
    assert_eq!(classify_seat(Some("primary"), &json!({})), "adhoc");
}
#[test]
fn work_birth_fence_and_profile_refresh() -> anyhow::Result<()> {
    let (_scratch, mut db): (_, Store) = fixture::ScratchStore::new()?;
    let scope = "agent:a:project:p:task:T-123";
    db.create_session(scope, "main")?;
    assert_eq!(
        db.seat_state(scope, "main")?["work"],
        json!({"kind":"task","taskId":"T-123"})
    );
    let free = "agent:a:project:p:task:primary";
    db.create_session(free, "main")?;
    assert_eq!(db.seat_state(free, "main")?["kind"], "adhoc");
    db.refresh_seat_kinds("a", &json!({"homes":{"primary":"max3"}}))?;
    assert_eq!(db.seat_state(free, "main")?["kind"], "standing");
    let work = json!({"kind":"workstream","workstreamId":"stream-1"});
    assert!(db.set_seat_work(free, "main", &work, 1)?.is_some());
    assert!(
        db.set_seat_work(free, "main", &json!({"kind":"none"}), 1)?
            .is_none()
    );
    assert_eq!(db.seat_state(free, "main")?["work"], work);
    assert_eq!(db.seat_state(free, "main")?["workEtag"], 2);
    db.refresh_seat_kinds("a", &json!({}))?;
    assert_eq!(db.seat_state(free, "main")?["kind"], "adhoc");
    assert_eq!(db.seat_state(free, "main")?["work"], work);
    Ok(())
}

/// Explicit acceptance: reads the real source profiles, never fixture copies.
#[test]
#[ignore = "requires the operator's real agent profiles"]
fn r6_real_profiles() -> anyhow::Result<()> {
    let root = std::env::var("HRC_R6_PROFILES_ROOT")
        .unwrap_or_else(|_| format!("{}/praesidium/var/agents", std::env::var("HOME").unwrap()));
    let output = std::process::Command::new("python3").args(["-c",r#"
import json, pathlib, sys, tomllib
rows=[]
for p in sorted(pathlib.Path(sys.argv[1]).glob('*/agent-profile.toml')):
    rows.append({'agent':p.parent.name,'placement':tomllib.loads(p.read_text()).get('placement',{})})
print(json.dumps(rows))
"#, &root]).output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)?;
    anyhow::ensure!(
        rows.len() >= 50,
        "expected at least the 50 real profiles, got {}",
        rows.len()
    );
    let mut checks = 0;
    for row in &rows {
        let p = &row["placement"];
        assert_eq!(classify_seat(Some("T-12247"), p), "task");
        assert_eq!(classify_seat(Some("undeclared-r6-acceptance"), p), "adhoc");
        for name in p["homes"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.keys())
            .map(String::as_str)
            .chain(
                p["pins"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.keys())
                    .filter_map(|k| k.rsplit(':').next()),
            )
        {
            let task = name
                .strip_prefix("T-")
                .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
            assert_eq!(
                classify_seat(Some(name), p),
                if task { "task" } else { "standing" },
                "{}:{name}",
                row["agent"]
            );
            if !task {
                assert_eq!(
                    classify_seat(Some(&format!("{name}-cosmos")), p),
                    "standing"
                );
            }
            checks += 1;
        }
    }
    println!(
        "R6 real profiles: {} profiles, {checks} declared home/pin checks plus task/adhoc boundaries",
        rows.len()
    );
    Ok(())
}
