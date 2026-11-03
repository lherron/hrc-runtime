import type { HrcMigration } from './types.js'

// T-12413: hot readers must not scan every runtime or session ever recorded.
// Partial-index predicates are matched textually by SQLite's planner, so the
// literal lists below must stay byte-identical to the Rust readers'
// predicates (hrc-store `status::live_sql` / `status::available_sql`); the
// hrc-native plan test fails when they drift.
export const runtimeLiveIndexes: HrcMigration = {
  id: '0131_runtime_live_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_status ON runtimes(status);
      CREATE INDEX IF NOT EXISTS idx_runtimes_live ON runtimes(created_at, runtime_id)
        WHERE status NOT IN ('archived','crashed','dead','disposed','exited','failed','stale','stopped','terminal','terminated');
      CREATE INDEX IF NOT EXISTS idx_runtimes_available ON runtimes(host_session_id)
        WHERE status NOT IN ('terminated','dead','stale','crashed','detached');
      CREATE INDEX IF NOT EXISTS idx_runtimes_recent_activity
        ON runtimes(COALESCE(last_activity_at, status_changed_at, updated_at, created_at));
      CREATE INDEX IF NOT EXISTS idx_runtimes_session_activity
        ON runtimes(COALESCE(last_activity_at, created_at), host_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
    `)
  },
}
