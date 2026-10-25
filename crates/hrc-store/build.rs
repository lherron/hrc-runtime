//! Derive the schema admission set from the checked-out Bun migration graph.
//! This generates names only: the native owner never executes Bun migrations.
use std::{collections::BTreeSet, env, fs, path::Path};

fn visit(path: &Path, visited: &mut BTreeSet<std::path::PathBuf>, ids: &mut BTreeSet<String>) {
    let path = path.canonicalize().expect("migration source must exist");
    if !visited.insert(path.clone()) {
        return;
    }
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).expect("read migration source");
    let id = regex::Regex::new(r#"\bid:\s*['"]([0-9]{4}_[^'"]+)['"]"#).unwrap();
    for capture in id.captures_iter(&text) {
        assert!(ids.insert(capture[1].to_owned()), "duplicate migration id");
    }
    let import = regex::Regex::new(r#"from\s+['"](\.[^'"]+)\.js['"]"#).unwrap();
    for capture in import.captures_iter(&text) {
        visit(
            &path.parent().unwrap().join(format!("{}.ts", &capture[1])),
            visited,
            ids,
        );
    }
}

fn main() {
    let mut ids = BTreeSet::new();
    visit(
        Path::new("../../packages/hrc-store-sqlite/src/migrations.ts"),
        &mut BTreeSet::new(),
        &mut ids,
    );
    assert!(
        ids.len() > 100,
        "migration extraction must not silently be empty"
    );
    // Declaration order matters to diagnostics even though admission compares sets.
    // Regenerate with `bun crates/hrc-store/generate-migration-order.ts`.
    println!("cargo:rerun-if-changed=migration-order.json");
    let order = fs::read_to_string("migration-order.json").expect("migration order");
    let ordered_ids = regex::Regex::new(r#""([0-9]{4}_[^"]+)""#)
        .unwrap()
        .captures_iter(&order)
        .map(|c| c[1].to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        ordered_ids, ids,
        "regenerate native migration order declaration"
    );
    let source = format!(
        "pub const MIGRATIONS: &[&str] = &{:?};\n",
        ids.into_iter().collect::<Vec<_>>()
    );
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        source,
    )
    .unwrap();
}
