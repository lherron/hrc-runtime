#!/usr/bin/env bun
/**
 * Regenerates route-inventory.json: the daemon route table `hrc admin metrics
 * routes --idle` names and the L3 suppressed-poll allowlist, both read from
 * this checkout's hrc-server so the native CLI reports what Bun reports.
 * Run from the repository root: bun crates/hrc-cli/src/admin/generate-route-inventory.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES } from '../../../../packages/hrc-server/src/request-log.ts'
import { listRequestRouteInventory } from '../../../../packages/hrc-server/src/request-route-inventory.ts'

const declaration = {
  generatedBy: 'crates/hrc-cli/src/admin/generate-route-inventory.ts',
  inventory: listRequestRouteInventory(),
  suppressedPoll: L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES,
}
writeFileSync(
  join(import.meta.dir, 'route-inventory.json'),
  `${JSON.stringify(declaration, null, 2)}\n`
)
