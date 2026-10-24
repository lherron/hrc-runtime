import type { HrcMigration } from './types.js'

// T-11713: broker policy owns permission decisions. HRC retains permission.*
// observations in its event ledgers; the separate write-only audit is retired.
export const permissionAuditRemoval: HrcMigration = {
  id: '0127_permission_audit_removal',
  apply(db) {
    // SQLite drops the table's explicit and automatic indexes with the table.
    db.exec('DROP TABLE IF EXISTS permission_decisions')
  },
}
