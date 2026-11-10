//! Scheduled duties independent of the lake mark and runtime prune window.
use super::*;
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, params};
use std::collections::BTreeSet;

pub const PACE: Duration = Duration::from_millis(250);
pub const MAX_WRITE_HOLD: Duration = Duration::from_millis(500);
pub const MAX_DUTY_CYCLE: f64 = 0.25;
pub const VACUUM_PAGES: usize = 20_000;
pub const VACUUM_CHUNK: usize = 100;
const BACKUP_DAYS: i64 = 7;
const BUNDLE_DAYS: i64 = 14;
const BUNDLE_KEEP: usize = 3;
const ORPHAN_GRACE_MS: i64 = 5000;

pub struct Budget {
    deadline: DateTime<Local>,
    started: Instant,
    max_hold: Duration,
    rows: BTreeMap<String, usize>,
    pages: usize,
    backups: usize,
    checkpointed: bool,
    bundles: Value,
    errors: Vec<String>,
    stop: &'static str,
}
impl Budget {
    fn check(&self) -> Result<()> {
        anyhow::ensure!(Local::now() < self.deadline, "deadline");
        Ok(())
    }
    async fn pause(&self, hold: Duration) {
        let pause = PACE.max(hold.mul_f64(1. / MAX_DUTY_CYCLE - 1.));
        let left = (self.deadline - Local::now()).to_std().unwrap_or_default();
        tokio::time::sleep(pause.min(left)).await;
    }
    async fn step<T>(
        &mut self,
        s: &Server,
        action: impl FnOnce(&hrc_store::Store, Duration) -> Result<T>,
    ) -> Result<T> {
        self.check()?;
        let _write = s.owner_writes.enter().context("shutdown")?;
        let (result, held) = {
            let store = s.store.lock().unwrap();
            // Recheck after waiting for the owner mutex, before taking SQLite's writer.
            self.check()?;
            let left = (self.deadline - Local::now()).to_std().unwrap_or_default();
            let started = Instant::now();
            let result = action(&store, MAX_WRITE_HOLD.min(left));
            (result, started.elapsed())
        };
        drop(_write);
        self.max_hold = self.max_hold.max(held);
        self.pause(held).await;
        result
    }
    async fn write<T>(
        &mut self,
        s: &Server,
        action: impl FnOnce(&hrc_store::Store) -> Result<T>,
    ) -> Result<T> {
        self.step(s, |store, limit| store.retention_step(limit, action))
            .await
    }
    fn failed(&mut self, error: anyhow::Error) {
        self.stop = if Local::now() >= self.deadline {
            "deadline"
        } else {
            "error"
        };
        self.errors.push(error.to_string());
    }
}

fn migrations(db: &Connection) -> Result<BTreeSet<String>> {
    let ids = db
        .prepare("SELECT id FROM hrc_migrations")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<BTreeSet<String>>>()?;
    anyhow::ensure!(!ids.is_empty(), "empty migration ledger");
    Ok(ids)
}
fn backup_stamp(name: &str) -> Option<i64> {
    let part = name
        .strip_prefix("pre-activate-")?
        .strip_suffix(".sqlite")?;
    let (stamp, pid) = part.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if stamp.len() != 16
        || stamp.as_bytes()[8] != b'T'
        || stamp.as_bytes()[15] != b'Z'
        || !stamp
            .bytes()
            .enumerate()
            .all(|(i, c)| i == 8 || i == 15 || c.is_ascii_digit())
    {
        return None;
    }
    // Date.parse accepts days up to 31 and normalizes February/short months,
    // and accepts 24:00:00. Preserve that Bun filename-age behavior exactly.
    let day: i64 = stamp[6..8].parse().ok()?;
    let hour: i64 = stamp[9..11].parse().ok()?;
    let minute: i64 = stamp[11..13].parse().ok()?;
    let second: i64 = stamp[13..15].parse().ok()?;
    if !(1..=31).contains(&day)
        || !(0..=24).contains(&hour)
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0))
    {
        return None;
    }
    let first = format!("{}-{}-01T00:00:00Z", &stamp[..4], &stamp[4..6]);
    let ms = hrc_common::js::parse_date(&first);
    ms.is_finite().then_some(
        ms as i64 + (day - 1) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000,
    )
}
fn modified_ms(meta: &std::fs::Metadata) -> Result<i64> {
    Ok(meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64)
}
fn age_backups(s: &Server, b: &mut Budget, now: i64) -> Result<()> {
    let dir = s.state.join("backups");
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let ours = migrations(&s.store.lock().unwrap().sqlite);
    for entry in entries {
        b.check()?;
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stamp) = backup_stamp(&name) else {
            continue;
        };
        let meta = std::fs::symlink_metadata(entry.path())?;
        if !meta.is_file() || now - stamp.max(modified_ms(&meta)?) < BACKUP_DAYS * 86_400_000 {
            continue;
        }
        let Ok(ours) = &ours else { continue };
        // Immutable avoids WAL/shm side effects on a backup copied from a WAL store.
        let uri = format!(
            "{}?immutable=1",
            reqwest::Url::from_file_path(entry.path())
                .map_err(|_| anyhow::anyhow!("backup path"))?
        );
        let backup = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(anyhow::Error::from)
        .and_then(|db| migrations(&db));
        let Ok(backup) = backup else { continue };
        if ours.len() <= backup.len() || !backup.is_subset(ours) {
            continue;
        }
        b.check()?;
        std::fs::remove_file(entry.path())?;
        b.backups += 1;
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", entry.path().display()));
        }
    }
    Ok(())
}

async fn tables(s: &Server, b: &mut Budget, now: i64) -> Result<()> {
    for &table in hrc_store::Store::retention_tables() {
        b.rows.insert(table.into(), 0);
        let days = if table == "runtime_buffers" { 1 } else { 14 };
        let cutoff = DateTime::from_timestamp_millis(now - days * 86_400_000)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut size = 250;
        loop {
            b.check()?;
            let keys = s.store.lock().unwrap().retention_candidates(
                table,
                &cutoff,
                size,
                (b.deadline - Local::now()).to_std().unwrap_or_default(),
            )?;
            if keys.is_empty() {
                break;
            }
            let start = Instant::now();
            match b
                .write(s, |store| store.retention_delete(table, &cutoff, &keys))
                .await
            {
                Ok(n) => *b.rows.get_mut(table).unwrap() += n,
                Err(e) => {
                    // Interrupted SQL rolls back. Retry smaller; a single-row failure ends this phase.
                    if size == 1 || Local::now() >= b.deadline {
                        return Err(e);
                    }
                    size = (size / 2).max(1);
                    continue;
                }
            }
            // Includes the duty pause: ramp conservatively rather than probe a huge first write.
            if start.elapsed() < Duration::from_millis(350) {
                size = (size * 3 / 2).min(10_000);
            }
        }
    }
    Ok(())
}

/// Remove a tree between deadline checks, without following symlink directories.
fn remove_tree(path: &Path, b: &Budget) -> Result<()> {
    b.check()?;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if meta.is_dir() {
        for entry in std::fs::read_dir(path)? {
            remove_tree(&entry?.path(), b)?;
        }
        b.check()?;
        std::fs::remove_dir(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
async fn bundles(s: &Server, b: &mut Budget, now: i64) -> Result<()> {
    let trips = s.store.lock().unwrap().retention_bundle_trips()?;
    let mut counts = BTreeMap::new();
    let mut linked = BTreeSet::new();
    let mut referenced = BTreeSet::new();
    let mut doomed = Vec::new();
    let mut report = json!({"scanned":trips.len(),"overKeepLimit":0,"expired":0,"orphanDirs":0,"deletedDirs":0,"deletedArtifactRows":0,"errors":[]});
    for trip in &trips {
        b.check()?;
        let key = (
            trip["runtime_id"].as_str().unwrap_or(""),
            trip["generation"].as_i64().unwrap_or(0),
        );
        let index = counts.entry(key).or_insert(0usize);
        let over = *index >= BUNDLE_KEEP;
        *index += 1;
        let expired = hrc_common::js::parse_date(
            trip["first_turn_missing_tripped_at"].as_str().unwrap_or(""),
        ) < (now - BUNDLE_DAYS * 86_400_000) as f64;
        let dir = trip["bundle_dir"].as_str().unwrap_or("").to_owned();
        if !trip["diagnostics_event_seq"].is_null() {
            linked.insert(dir.clone());
        }
        if over || expired {
            let field = if over { "overKeepLimit" } else { "expired" };
            report[field] = (report[field].as_u64().unwrap() + 1).into();
            doomed.push(trip);
        } else {
            referenced.insert(dir);
        }
    }
    let stamp = DateTime::from_timestamp_millis(now)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for trip in doomed {
        b.check()?;
        let dir = Path::new(trip["bundle_dir"].as_str().context("bundle path")?);
        if let Err(e) = remove_tree(dir, b) {
            report["errors"]
                .as_array_mut()
                .unwrap()
                .push(e.to_string().into());
            continue;
        }
        report["deletedDirs"] = (report["deletedDirs"].as_u64().unwrap() + 1).into();
        let removed = b.write(s, |store| {
            let n = store.sqlite.execute("DELETE FROM runtime_artifacts WHERE artifact_id=?", [format!("first-turn-missing-{}", trip["trip_event_seq"])])?;
            store.sqlite.execute("UPDATE runtime_first_turn_watch SET bundle_dir=NULL,updated_at=? WHERE runtime_id=? AND generation=?", params![stamp,trip["runtime_id"].as_str(),trip["generation"].as_i64()])?;
            Ok(n)
        }).await?;
        report["deletedArtifactRows"] =
            (report["deletedArtifactRows"].as_u64().unwrap() + removed as u64).into();
    }
    if let Ok(runtimes) = std::fs::read_dir(s.runtime.join("artifacts")) {
        for runtime in runtimes {
            b.check()?;
            let Ok(entries) = std::fs::read_dir(runtime?.path().join("first-turn-missing")) else {
                continue;
            };
            for entry in entries {
                b.check()?;
                let path = entry?.path();
                let name = path.to_string_lossy().into_owned();
                if linked.contains(&name) || referenced.contains(&name) {
                    continue;
                }
                if !std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| modified_ms(&m).ok())
                    .is_some_and(|m| now - m > ORPHAN_GRACE_MS)
                {
                    continue;
                }
                report["orphanDirs"] = (report["orphanDirs"].as_u64().unwrap() + 1).into();
                match remove_tree(&path, b) {
                    Ok(()) => {
                        report["deletedDirs"] = (report["deletedDirs"].as_u64().unwrap() + 1).into()
                    }
                    Err(e) => report["errors"]
                        .as_array_mut()
                        .unwrap()
                        .push(e.to_string().into()),
                }
            }
        }
    }
    let artifacts = s.store.lock().unwrap().sqlite.prepare("SELECT artifact_id,artifact_path FROM runtime_artifacts WHERE artifact_kind='first-turn-missing-bundle'")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, path) in artifacts {
        b.check()?;
        let Some(path) = path else { continue };
        if std::fs::metadata(path).is_ok() {
            continue;
        }
        let n = b
            .write(s, |store| {
                Ok(store
                    .sqlite
                    .execute("DELETE FROM runtime_artifacts WHERE artifact_id=?", [&id])?)
            })
            .await?;
        report["deletedArtifactRows"] =
            (report["deletedArtifactRows"].as_u64().unwrap() + n as u64).into();
    }
    b.bundles = report;
    Ok(())
}

pub async fn before(s: &Server, deadline: DateTime<Local>) -> Budget {
    let mut b = Budget {
        deadline,
        started: Instant::now(),
        max_hold: Duration::ZERO,
        rows: hrc_store::Store::retention_tables()
            .iter()
            .map(|t| ((*t).to_owned(), 0))
            .collect(),
        pages: 0,
        backups: 0,
        checkpointed: false,
        bundles: Value::Null,
        errors: Vec::new(),
        stop: "complete",
    };
    let now = chrono::Utc::now().timestamp_millis();
    if let Err(e) = age_backups(s, &mut b, now) {
        b.failed(e);
    }
    // The Bun retention operation refused all row and bundle aging when the
    // pointer map was absent. Backups alone precede that prerequisite.
    let mode = s.store.lock().unwrap().retention_auto_vacuum();
    match mode {
        Ok(2) => {}
        Ok(mode) => {
            b.failed(anyhow::anyhow!(
                "auto_vacuum mode {mode} must be INCREMENTAL"
            ));
            return b;
        }
        Err(e) => {
            b.failed(e);
            return b;
        }
    }
    if let Err(e) = tables(s, &mut b, now).await {
        b.failed(e);
    }
    if let Err(e) = bundles(s, &mut b, now).await {
        b.failed(e);
    }
    b
}
pub async fn after(s: &Server, mut b: Budget) {
    let vacuum = async {
        anyhow::ensure!(
            s.store.lock().unwrap().retention_auto_vacuum()? == 2,
            "auto_vacuum must be INCREMENTAL"
        );
        b.step(s, |store, limit| {
            store.retention_statement(limit, |store| store.retention_checkpoint())
        })
        .await?;
        b.checkpointed = true;
        while b.pages < VACUUM_PAGES {
            let requested = VACUUM_CHUNK.min(VACUUM_PAGES - b.pages);
            let n = b
                .write(s, |store| store.retention_vacuum(requested))
                .await?;
            b.pages += n;
            if n == 0 {
                break;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = vacuum {
        b.failed(e);
    }
    stderr_json(
        "info",
        "maintenance",
        "retention.report",
        json!({"rowsDeleted":b.rows,"backupsRemoved":b.backups,"pagesReturned":b.pages,"checkpointed":b.checkpointed,"firstTurnBundles":b.bundles,"maxWriteHoldMs":b.max_hold.as_secs_f64()*1000.,"elapsedMs":b.started.elapsed().as_millis() as u64,"stopReason":b.stop,"errors":b.errors,"deadline":b.deadline.to_rfc3339()}),
    );
}
