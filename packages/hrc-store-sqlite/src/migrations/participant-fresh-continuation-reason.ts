import type { HrcMigration } from './types.js'

const TABLE = 'participant_registration_attempts'
const PRIOR_REASONS = `'carried', 'no_continuation', 'continuation_invalidated', 'reuse_disabled'`

/**
 * R6.6 amendment (T-11435): admit `participant_fresh` as a continuation reason.
 *
 * SQLite cannot alter a CHECK, so the attempt table is rebuilt from its own
 * stored definition with only the reason list widened, and its indexes and
 * triggers are recreated from their stored SQL. No view or foreign key
 * references the table, so nothing outside it moves.
 */
export const participantFreshContinuationReason: HrcMigration = {
  id: '0123_participant_fresh_continuation_reason',
  requiresForeignKeysDisabled: true,
  apply(db) {
    const objects = db
      .query<{ type: string; name: string; sql: string }, [string]>(
        'SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL'
      )
      .all(TABLE)
    const table = objects.find((object) => object.type === 'table')
    if (table === undefined || !table.sql.includes(PRIOR_REASONS)) {
      throw new Error(`${TABLE} does not carry the expected continuation reason CHECK`)
    }
    const rebuilt = table.sql
      .replace(PRIOR_REASONS, `${PRIOR_REASONS}, 'participant_fresh'`)
      .replace(/^CREATE TABLE "?participant_registration_attempts"?/, `CREATE TABLE ${TABLE}_v0123`)
    db.exec(rebuilt)
    db.exec(`INSERT INTO ${TABLE}_v0123 SELECT * FROM ${TABLE}`)
    db.exec(`DROP TABLE ${TABLE}`)
    db.exec(`ALTER TABLE ${TABLE}_v0123 RENAME TO ${TABLE}`)
    for (const object of objects) {
      if (object.type === 'index' || object.type === 'trigger') db.exec(object.sql)
    }
    const violations = db.query('PRAGMA foreign_key_check').all()
    if (violations.length > 0)
      throw new Error(
        `continuation reason rebuild left ${violations.length} foreign key violations`
      )
  },
}
