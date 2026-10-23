use crate::{
    ReadTx, Result,
    sessions::{identity, map_session},
    typed_sql::{many, one},
};
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value};
const RECENCY: &str = "MAX(COALESCE((SELECT si.last_activity_at FROM session_index si WHERE si.host_session_id=s.host_session_id),''),COALESCE((SELECT MAX(COALESCE(r.last_activity_at,r.created_at)) FROM runtimes r WHERE r.host_session_id=s.host_session_id),''),s.created_at)";
const LIVE: &str = "EXISTS(SELECT 1 FROM runtimes r2 WHERE r2.host_session_id=s.host_session_id AND (r2.active_run_id IS NOT NULL OR r2.status NOT IN ('terminated','dead','stale','crashed','detached')))";
fn filter(f: &SessionIndexFilters, exclude: Option<&str>) -> (Vec<String>, Vec<Value>) {
    let mut p = vec!["scope_ref NOT LIKE 'app:%'".into()];
    let mut v = vec![];
    if let Some(q) = &f.q {
        p.push("scope_ref LIKE ? ESCAPE '\\'".into());
        v.push(
            format!(
                "%{}%",
                q.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
            .into(),
        );
    }
    for (col, value) in [
        ("agent_id", &f.agent_id),
        ("project_id", &f.project_id),
        ("lane_ref", &f.lane_ref),
        ("effective_status", &f.effective_status),
        ("execution_mode", &f.execution_mode),
    ] {
        if Some(col) != exclude
            && let Some(value) = value
        {
            p.push(format!("{col}=?"));
            v.push(value.clone().into());
        }
    }
    (p, v)
}
impl ReadTx<'_> {
    pub fn session_index_page(
        &self,
        f: &SessionIndexFilters,
        cursor: Option<&SessionIndexCursor>,
        limit: usize,
    ) -> Result<SessionIndexPage> {
        let (mut p, mut v) = filter(f, None);
        if let Some(c) = cursor {
            p.push("(last_activity_at,host_session_id)<(?,?)".into());
            v.extend([
                c.last_activity_at.clone().into(),
                c.host_session_id.clone().into(),
            ]);
        }
        v.push((limit.saturating_add(1) as i64).into());
        let mut rows: Vec<rows::SessionIndexRow> = many(
            self.db,
            &format!(
                "SELECT * FROM session_index WHERE {} ORDER BY last_activity_at DESC,host_session_id DESC LIMIT ?",
                p.join(" AND ")
            ),
            params_from_iter(v),
        )?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let items = rows
            .into_iter()
            .map(|mut r| {
                let id = identity(self.db, &r.scope_ref, &r.lane_ref)?;
                r.task_id = id.as_ref().and_then(|i| i.task_id.clone());
                r.lane_ref = crate::events::canonical_lane(&r.lane_ref)?;
                Ok(SessionIndexRecord {
                    fields: r,
                    identity: id,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(SessionIndexPage { items, has_more })
    }
    fn session_index_count_map(
        &self,
        f: &SessionIndexFilters,
        column: &str,
    ) -> Result<std::collections::BTreeMap<String, i64>> {
        let (p, v) = filter(f, Some(column));
        let sql = format!(
            "SELECT {column},count(*) FROM session_index WHERE {} GROUP BY {column}",
            p.join(" AND ")
        );
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(v), |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?)
    }
    pub fn session_index_facets(&self, f: &SessionIndexFilters) -> Result<SessionIndexFacets> {
        let (p, v) = filter(f, None);
        let total = self.db.query_row(
            &format!(
                "SELECT count(*) FROM session_index WHERE {}",
                p.join(" AND ")
            ),
            params_from_iter(v),
            |r| r.get(0),
        )?;
        Ok(SessionIndexFacets {
            total,
            node_facet_count: total,
            by_effective_status: self.session_index_count_map(f, "effective_status")?,
            by_execution_mode: self.session_index_count_map(f, "execution_mode")?,
            by_agent_id: self.session_index_count_map(f, "agent_id")?,
        })
    }
    pub fn session_index_backfill_evidence(&self) -> Result<Option<SessionIndexBackfillEvidence>> {
        one(
            self.db,
            "SELECT * FROM session_index_backfill_evidence WHERE migration_id='0041_session_index'",
            [],
        )
    }
    fn selector_session_rows(
        &self,
        sql: &str,
        p: impl rusqlite::Params,
    ) -> Result<Vec<SessionRecord>> {
        let mut rows = self
            .db
            .prepare(sql)?
            .query_map(p, map_session)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for r in &mut rows {
            crate::validation::session_status(&r.status)?;
            r.identity = identity(self.db, &r.scope_ref, &r.lane_ref)?;
        }
        Ok(rows)
    }
    pub fn selector_sessions(&self, lane: Option<&str>) -> Result<Vec<SessionRecord>> {
        match lane {
            Some(lane) => self.selector_session_rows(
                "SELECT * FROM sessions WHERE lane_ref=? ORDER BY scope_ref ASC,generation ASC",
                [lane],
            ),
            None => self.selector_session_rows(
                "SELECT * FROM sessions ORDER BY scope_ref ASC,lane_ref ASC,generation ASC",
                [],
            ),
        }
    }
    pub fn recent_selector_sessions(
        &self,
        since: &str,
        lane: Option<&str>,
    ) -> Result<Vec<SessionRecord>> {
        self.selector_session_rows(&format!("SELECT s.* FROM sessions s WHERE ({RECENCY}>=? OR {LIVE}) AND (? IS NULL OR s.lane_ref=?) ORDER BY s.scope_ref ASC,s.lane_ref ASC,s.generation ASC"),params![since,lane,lane])
    }
    pub fn session_is_recent_or_running(&self, host: &str, since: &str) -> Result<bool> {
        Ok(self.db.query_row(&format!("SELECT 1 FROM sessions s WHERE s.host_session_id=? AND ({RECENCY}>=? OR {LIVE})"),params![host,since],|r|r.get::<_,i64>(0)).optional()?.is_some())
    }
    pub fn inactive_archive_candidates(&self, since: &str) -> Result<Vec<String>> {
        Ok(self.db.prepare(&format!("SELECT s.host_session_id FROM sessions s WHERE s.status='active' AND {RECENCY}<? AND NOT {LIVE}"))?.query_map([since],|r|r.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
}

impl ReadTx<'_> {
    /// Finite SQL portion of monitor's scoped selector set. Exact selectors are
    /// resolved separately by its caller. Empty scoped inputs select no hosts.
    pub fn scoped_selector_host_ids(
        &self,
        prefixes: &[String],
        task_ids: &[String],
    ) -> Result<Vec<String>> {
        let mut predicates = vec![];
        let mut values = vec![];
        for prefix in prefixes {
            predicates.push("scope_ref LIKE ? ESCAPE '\\'");
            values.push(format!("{}%", crate::events::escape_like(prefix)));
        }
        for task in task_ids {
            predicates.push("(sessions.scope_ref,sessions.lane_ref) IN (SELECT c.scope_ref,c.lane_ref FROM continuities c WHERE c.task_id=?)");
            values.push(task.clone());
        }
        if predicates.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT host_session_id FROM sessions WHERE {} ORDER BY host_session_id",
            predicates.join(" OR ")
        );
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(values), |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Caller passes true precisely when the parsed selector leaves role
    /// unspecified; all stored generations are retained by this finite query.
    pub fn role_tree_selector_host_ids(
        &self,
        scope: &str,
        include_roles: bool,
    ) -> Result<Vec<String>> {
        if include_roles {
            let prefix = format!("{}:role:%", crate::events::escape_like(scope));
            Ok(self.db.prepare("SELECT host_session_id FROM sessions WHERE scope_ref=? OR scope_ref LIKE ? ESCAPE '\\' ORDER BY host_session_id")?
                .query_map(params![scope,prefix],|row|row.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?)
        } else {
            Ok(self.db.prepare("SELECT host_session_id FROM sessions WHERE scope_ref=? ORDER BY host_session_id")?
                .query_map([scope],|row|row.get(0))?.collect::<std::result::Result<Vec<_>,_>>()?)
        }
    }
}
