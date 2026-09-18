/**
 * T-07318 — P1 (SUPERSEDED by T-08596 / T-08569A closure): the facade repoint is
 * retired. `packages/hrc-server/package.json` must NOT declare
 * `spaces-aspc-facade` (nor `spaces-aspc`): the facade spawn is deleted, the
 * `.bin/aspc-facade` entry is absent from the release, and the manifest is the
 * deliverable of the removal. This file now pins the post-closure shape.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const HRC_SERVER_PACKAGE_JSON = resolve(REPO_ROOT, 'packages/hrc-server/package.json')

// ── AC #1: dependency repoint ────────────────────────────────────────────────

describe('T-07318 AC #1 (superseded by T-08596) — hrc-server declares no facade execution package', () => {
  test('package.json declares neither spaces-aspc-facade nor spaces-aspc', () => {
    const manifest = JSON.parse(readFileSync(HRC_SERVER_PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = Object.keys(manifest.dependencies ?? {})

    // The facade spawn is deleted (T-08596); declaring either package would
    // reinstall the execution closure the closure task removed.
    expect(dependencies).not.toContain('spaces-aspc-facade')
    expect(dependencies).not.toContain('spaces-aspc')
  })
})
