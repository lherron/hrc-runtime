/**
 * T-07318 — P1: repoint hrc-server onto the aspc facade composition package.
 *
 * AC #1 — DEP REPOINT. `packages/hrc-server/package.json` must declare
 * `spaces-aspc-facade` (the cohosted-broker composition package that now owns the
 * `aspc-facade` bin spawned at `option-resolvers.ts:32`) in place of `spaces-aspc`.
 * hrc-server imports no `spaces-aspc` module in source — the dependency exists purely
 * to place `node_modules/.bin/aspc-facade` — so the manifest IS the deliverable.
 *
 * SCOPE: this task now owns AC #1 only. AC #3 (collapsing the in-process compile path
 * onto the facade RPC, and retiring the duplicated harness mapping table) was split out
 * to the dormant T-07434 by ruling #20167 (SPEC AMENDMENT #2), because the aspc facade
 * exposes no method returning a CLI process invocation spec. The AC #3 tests and their
 * import-resolution detector were carved out of this file per the T-07434 C-15548
 * manifest; T-07434 recovers them from the pre-carve commits 0b68f1e / 5528ff3.
 *
 * AC #2 (REQUIRED_BOUNDARY_CHECKS consumption) was deferred out earlier by ruling
 * #20164, and is likewise untested here.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const HRC_SERVER_PACKAGE_JSON = resolve(REPO_ROOT, 'packages/hrc-server/package.json')

// ── AC #1: dependency repoint ────────────────────────────────────────────────

describe('T-07318 AC #1 — hrc-server depends on the aspc facade composition package', () => {
  test('package.json declares spaces-aspc-facade instead of spaces-aspc', () => {
    const manifest = JSON.parse(readFileSync(HRC_SERVER_PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = Object.keys(manifest.dependencies ?? {})

    // spaces-aspc-facade owns the `aspc-facade` bin that option-resolvers.ts:32 spawns.
    expect(dependencies).toContain('spaces-aspc-facade')
    // The repoint replaces the old name; hrc-server imports no `spaces-aspc` module,
    // so leaving it declared would strand a second, bin-less claim on the seam.
    expect(dependencies).not.toContain('spaces-aspc')
  })
})
