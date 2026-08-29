#!/usr/bin/env bun
/**
 * Refuse a bun.lock whose dependency sets are split.
 *
 * Each sync spec names a coherence group: packages published together as ONE
 * dev-timestamp stream. A release is built from this lock with
 * `--frozen-lockfile`, so if the lock resolves that group to two versions — or
 * carries a nested duplicate copy — the release ships two agent-spaces tuples at
 * once. That shape has exactly one cause in practice: someone advanced part of
 * the set by hand (`bun update <pkg>@<ver>`) instead of `just pull-deps`, which
 * moves the whole set together.
 *
 * Unlike ASP *skew* (a consumer lagging its producer, the intended steady state
 * and only a warning outside release qualification), an incoherent lock is never
 * legitimate: `just install`, `just check` and `just pull-deps` all refuse.
 */
import { resolve } from 'node:path'

import { lockCoherenceViolations } from './lib/verdaccio-sync'
import { aspSyncSpec } from './sync-asp-from-verdaccio'
import { wrkqSyncSpec } from './sync-wrkq-from-verdaccio'

const lockPath = resolve(import.meta.dir, '..', 'bun.lock')
const lock = await Bun.file(lockPath).text()
const violations = lockCoherenceViolations([...aspSyncSpec.groups, ...wrkqSyncSpec.groups], lock)
if (violations.length === 0) {
  console.log('LOCK_COHERENT  every synced set resolves to one version, one copy')
  process.exit(0)
}
console.error('check-lock-coherence: bun.lock would ship a split dependency set:')
for (const line of violations) console.error(`  ${line}`)
console.error(
  '  Fix: `git checkout -- bun.lock` to the last coherent lock, then `just pull-deps` to advance the whole set together.\n' +
    '  Never `bun update <pkg>@<ver>` / `bun add` a synced package.'
)
process.exit(1)
