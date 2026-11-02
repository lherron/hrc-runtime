//! The current-generation session index is maintained by Bun's SQL triggers.
//! Native readers query it with the same filtering and keyset traversal.
use super::{Store, canonical_lane, fields};
use anyhow::Result;
use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) fn session_recency() -> &'static str {
    static SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        format!(
            "(MAX(COALESCE((SELECT si.last_activity_at FROM session_index si WHERE si.host_session_id=s.host_session_id),''),COALESCE((SELECT MAX(COALESCE(r.last_activity_at,r.created_at)) FROM runtimes r WHERE r.host_session_id=s.host_session_id),''),s.created_at) >= ? OR EXISTS (SELECT 1 FROM runtimes r2 WHERE r2.host_session_id=s.host_session_id AND (r2.active_run_id IS NOT NULL OR r2.status NOT IN ({}))))",
            crate::status::unavailable_sql()
        )
    });
    SQL.as_str()
}

fn filters(input: &HashMap<String, String>, excluded: &str) -> (String, Vec<SqlValue>) {
    let mut predicates = vec!["scope_ref NOT LIKE 'app:%'".to_owned()];
    let mut values = Vec::new();
    if let Some(q) = input.get("q") {
        predicates.push("scope_ref LIKE ? ESCAPE '\\'".into());
        values.push(SqlValue::Text(format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )));
    }
    for (field, column) in [
        ("agentId", "agent_id"),
        ("projectId", "project_id"),
        ("laneRef", "lane_ref"),
        ("effectiveStatus", "effective_status"),
        ("executionMode", "execution_mode"),
    ] {
        if field != excluded
            && let Some(value) = input.get(field)
        {
            predicates.push(format!("{column} = ?"));
            values.push(SqlValue::Text(value.clone()));
        }
    }
    (format!("WHERE {}", predicates.join(" AND ")), values)
}
/// `/v1/sessions?latestGeneration=true`: only each seat's newest generation.
pub fn retain_latest_generation(sessions: &mut Vec<Value>) -> Result<()> {
    let generation = |s: &Value| {
        s["generation"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("session row lacks an integer generation"))
    };
    let seat = |s: &Value| (s["scopeRef"].to_string(), s["laneRef"].to_string());
    let mut latest = HashMap::<(String, String), i64>::new();
    for s in sessions.iter() {
        let g = generation(s)?;
        latest
            .entry(seat(s))
            .and_modify(|v| *v = (*v).max(g))
            .or_insert(g);
    }
    sessions.retain(|s| generation(s).is_ok_and(|g| latest[&seat(s)] == g));
    Ok(())
}

impl Store {
    /// A `/v1/sessions` row's identity and title. Bun's scoped list maps
    /// through the store repository (identity last); the unscoped projection
    /// maps through mapSessionRow(row, db).
    pub fn annotate_session(&self, s: &mut Value, scoped: bool) -> Result<()> {
        let (Some(scope), Some(lane)) = (s["scopeRef"].as_str(), s["laneRef"].as_str()) else {
            anyhow::bail!("session row lacks scopeRef or laneRef");
        };
        let (scope, lane) = (scope.to_owned(), super::storage_lane(lane).to_owned());
        let identity = self.optional_identity(&scope, &lane)?;
        let metadata = self.metadata(&scope, &lane)?;
        if let Some(identity) = identity {
            if scoped {
                s["identity"] = identity;
            } else {
                *s = super::with_session_identity(s.take(), identity);
            }
        }
        if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string()) {
            s["title"] = title.clone();
        }
        Ok(())
    }

    /// Bun's bounded session projection. Scope reads retain all history;
    /// callers pass no cutoff for those and for explicit all=true reads.
    pub fn sessions_for_projection(
        &self,
        scope: Option<&str>,
        lane: Option<&str>,
        since: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut predicates = Vec::new();
        let mut values = Vec::<SqlValue>::new();
        if let Some(scope) = scope {
            predicates.push("s.scope_ref = ?");
            values.push(scope.to_owned().into());
        }
        if let Some(lane) = lane {
            predicates.push("s.lane_ref = ?");
            values.push(lane.to_owned().into());
        }
        if scope.is_none()
            && let Some(since) = since
        {
            // Activity clocks exclude sessions.updated_at: housekeeping writes
            // must not bring cold sessions back into the projection.
            predicates.push(session_recency());
            values.push(since.to_owned().into());
        }
        let clause = if predicates.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", predicates.join(" AND "))
        };
        let mut stmt = self.sqlite.prepare(&format!(
            "SELECT s.* FROM sessions s {clause} ORDER BY s.scope_ref,s.lane_ref,s.generation ASC"
        ))?;
        Ok(stmt
            .query_map(params_from_iter(values), super::session_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn session_index_page(
        &self,
        input: &HashMap<String, String>,
        cursor: Option<(&str, &str)>,
        limit: usize,
    ) -> Result<(Vec<Value>, bool)> {
        let (mut clause, mut values) = filters(input, "");
        if let Some((t, h)) = cursor {
            clause += " AND (last_activity_at, host_session_id) < (?, ?)";
            values.extend([SqlValue::Text(t.into()), SqlValue::Text(h.into())]);
        }
        values.push(SqlValue::Integer(limit as i64 + 1));
        let sql = format!(
            // Bound the index walk before joining continuity. Exact stored lane
            // keys preserve historical identities; LEFT JOIN retains orphan rows.
            // Keep index denormalizations distinct from continuity identity columns.
            "SELECT page.host_session_id,page.scope_ref,page.lane_ref,page.generation,\
             page.agent_id AS index_agent_id,page.project_id AS index_project_id,\
             page.created_at,page.effective_status,page.execution_mode,page.last_activity_at,page.title,\
             c.scope_kind,c.agent_id,c.project_id,c.task_id,c.role_name,c.seat_kind,c.seat_work_json FROM \
             (SELECT * FROM session_index {clause} ORDER BY last_activity_at DESC, host_session_id DESC LIMIT ?) page \
             LEFT JOIN continuities c ON c.scope_ref=page.scope_ref AND c.lane_ref=page.lane_ref \
             ORDER BY page.last_activity_at DESC,page.host_session_id DESC"
        );
        let mut stmt = self.sqlite.prepare(&sql)?;
        let mut rows = stmt
            .query_map(params_from_iter(values), |r| {
                let mut row = fields(
                    r,
                    &[
                        ("host_session_id", "hostSessionId"),
                        ("scope_ref", "scopeRef"),
                        ("lane_ref", "laneRef"),
                        ("index_agent_id", "agentId"),
                        ("created_at", "createdAt"),
                        ("effective_status", "effectiveStatus"),
                        ("execution_mode", "executionMode"),
                        ("last_activity_at", "lastActivityAt"),
                    ],
                    &[("title", "title"), ("index_project_id", "projectId")],
                    &[],
                )?;
                row["identity"] = if r.get::<_, Option<String>>("scope_kind")?.is_some() {
                    super::identity_row(r)?
                } else {
                    Value::Null
                };
                row["kind"] = r.get::<_, Option<String>>("seat_kind")?.into();
                let work: Option<String> = r.get("seat_work_json")?;
                row["work"] = work
                    .map(|raw| {
                        serde_json::from_str(&raw).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                r.as_ref().column_index("seat_work_json").unwrap(),
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })
                    })
                    .transpose()?
                    .unwrap_or(Value::Null);
                Ok(row)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        for row in &mut rows {
            if let Some(task) = row["identity"].get("taskId") {
                row["taskId"] = task.clone();
            }
            row["laneRef"] = canonical_lane(row["laneRef"].as_str().unwrap()).into();
        }
        Ok((rows, more))
    }
    pub fn session_index_facets(&self, input: &HashMap<String, String>) -> Result<Value> {
        let (clause, values) = filters(input, "");
        let total: i64 = self.sqlite.query_row(
            &format!("SELECT COUNT(*) FROM session_index {clause}"),
            params_from_iter(values),
            |r| r.get(0),
        )?;
        let mut output = json!({"total":total,"nodeFacetCount":total});
        for (field, column, output_field) in [
            ("agentId", "agent_id", "byAgentId"),
            ("effectiveStatus", "effective_status", "byEffectiveStatus"),
            ("executionMode", "execution_mode", "byExecutionMode"),
        ] {
            let (clause, values) = filters(input, field);
            let mut stmt = self.sqlite.prepare(&format!(
                "SELECT {column},COUNT(*) FROM session_index {clause} GROUP BY {column}"
            ))?;
            let pairs = stmt
                .query_map(params_from_iter(values), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let map = pairs
                .into_iter()
                .map(|(key, count)| (key, json!(count)))
                .collect::<serde_json::Map<_, _>>();
            output[output_field] = map.into();
        }
        Ok(output)
    }
}
