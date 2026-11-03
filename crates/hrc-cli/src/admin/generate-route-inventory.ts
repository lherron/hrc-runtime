#!/usr/bin/env bun
/**
 * Regenerates route-inventory.json: the daemon route table `hrc admin metrics
 * routes --idle` names, read from
 * this checkout's hrc-server so the native CLI reports what Bun reports.
 * Run from the repository root: bun crates/hrc-cli/src/admin/generate-route-inventory.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listRequestRouteInventory } from '../../../../packages/hrc-server/src/request-route-inventory.ts'

// Routes only rusthrc serves (no Bun handler exists), placed after the session
// metadata PATCH on the main and peer listeners (seat-annotations r1.1 §4).
// `mainOnly` routes are local: the peer listener does not admit them (T-12212).
const NATIVE_ONLY_AFTER_METADATA = [
  { method: 'GET', route: '/v1/sessions/work' },
  { method: 'PUT', route: '/v1/sessions/work' },
  { method: 'GET', route: '/v1/seat-handoffs', mainOnly: true },
  { method: 'GET', route: '/v1/seat-handoffs/get', mainOnly: true },
  { method: 'POST', route: '/v1/seat-handoffs', mainOnly: true },
  { method: 'POST', route: '/v1/seat-handoffs/acknowledge', mainOnly: true },
  { method: 'GET', route: '/v1/sessions/annotations' },
  { method: 'PUT', route: '/v1/sessions/annotations' },
  { method: 'POST', route: '/v1/sessions/annotations/delete' },
  { method: 'POST', route: '/v1/sessions/annotations/act' },
  { method: 'GET', route: '/v1/sessions/attention', mainOnly: true },
]
const inventory = listRequestRouteInventory().flatMap((entry) =>
  entry.method === 'PATCH' && entry.route === '/v1/sessions/metadata'
    ? [
        entry,
        ...NATIVE_ONLY_AFTER_METADATA.filter((r) => !r.mainOnly || entry.listener === 'main').map(
          ({ method, route }) => ({ listener: entry.listener, method, route })
        ),
      ]
    : [entry]
)
const declaration = {
  generatedBy: 'crates/hrc-cli/src/admin/generate-route-inventory.ts',
  inventory,
}
writeFileSync(
  join(import.meta.dir, 'route-inventory.json'),
  `${JSON.stringify(declaration, null, 2)}\n`
)
