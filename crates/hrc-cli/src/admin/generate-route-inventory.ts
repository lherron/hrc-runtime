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

// Routes only rusthrc serves (no Bun handler exists), placed after the session
// metadata PATCH on the main and peer listeners. seat-annotations r1.1 §4.
const NATIVE_ONLY_AFTER_METADATA = [
  { method: 'GET', route: '/v1/sessions/annotations' },
  { method: 'PUT', route: '/v1/sessions/annotations' },
  { method: 'POST', route: '/v1/sessions/annotations/delete' },
  { method: 'POST', route: '/v1/sessions/annotations/act' },
]
const inventory = listRequestRouteInventory().flatMap((entry) =>
  entry.method === 'PATCH' && entry.route === '/v1/sessions/metadata'
    ? [entry, ...NATIVE_ONLY_AFTER_METADATA.map((r) => ({ listener: entry.listener, ...r }))]
    : [entry]
)
const declaration = {
  generatedBy: 'crates/hrc-cli/src/admin/generate-route-inventory.ts',
  inventory,
  suppressedPoll: L3_SUPPRESSED_SUCCESSFUL_POLL_ROUTES,
}
writeFileSync(
  join(import.meta.dir, 'route-inventory.json'),
  `${JSON.stringify(declaration, null, 2)}\n`
)
