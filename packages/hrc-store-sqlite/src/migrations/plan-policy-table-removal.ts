import type { HrcMigration } from './types.js'

// Plan readers were retired before this migration. Lifecycle acceptance already
// fences against broker_invocations.lifecycle_policy_hash; neither hash column
// references these tables through a foreign key.
export const planPolicyTableRemoval: HrcMigration = {
  id: '0126_plan_policy_table_removal',
  apply(db) {
    db.exec('DROP TABLE IF EXISTS compiled_runtime_plans')
    db.exec('DROP TABLE IF EXISTS lifecycle_policies')
  },
}
