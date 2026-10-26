// Included only by native #[cfg(test)] modules; no production feature or API.
use std::{fs, path::PathBuf, process::Command};

pub struct ScratchStore {
    pub root: PathBuf,
}
impl ScratchStore {
    pub fn new() -> anyhow::Result<(Self, hrc_store::Store)> {
        let root = std::env::temp_dir().join(format!("hrc-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("state"))?;
        fs::create_dir_all(root.join("run"))?;
        let fixture = Self { root };
        let db = fixture.root.join("state/state.sqlite");
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let result = Command::new("bun")
            .current_dir(repo)
            .args(["-e", "import {openHrcDatabase} from './packages/hrc-store-sqlite/src/database.ts'; openHrcDatabase(process.argv[1]).close()"])
            .arg(&db)
            .output()
            .map_err(|e| anyhow::anyhow!("Bun owns all migrations, including scratch stores (standing ruling); bun is required, never skip: {e}"))?;
        anyhow::ensure!(result.status.success(), "Bun scratch migration failed: {}", String::from_utf8_lossy(&result.stderr));
        Ok((fixture, hrc_store::Store::open(&db)?))
    }
}
impl Drop for ScratchStore {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
