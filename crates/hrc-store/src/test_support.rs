// Included only by native #[cfg(test)] modules; no production feature or API.
use std::{fs, path::PathBuf};

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
        let (_owner, _) = hrc_store::migrate::own_and_migrate(
            &db,
            hrc_store::migrate::FORWARD,
            &hrc_store::migrate::Actor::current(),
            |_| {},
        )?;
        Ok((fixture, hrc_store::Store::open(&db)?))
    }
}
impl Drop for ScratchStore {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
