import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  CANONICAL_REGISTRY_URL,
  activeRegistryUrl,
  registryOrigin,
  scanLockContent,
} from './lib/registry.js'

const REPO_ROOT = resolve(import.meta.dir, '..')

/** One poisoned entry beside a canonical one — the exact 2026-08-21 shape. */
const POISONED_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "@types/bun": ["@types/bun@1.4.0", "http://127.0.0.1:4873/@types/bun/-/bun-1.4.0.tgz", { "dependencies": { "bun-types": "1.4.0" } }, "sha512-aaa=="],
    "zod": ["zod@4.1.5", "http://mini:4873/zod/-/zod-4.1.5.tgz", {}, "sha512-bbb=="]
  }
}
`

describe('lock-hygiene scan', () => {
  it('rejects a loopback registry URL and names its line', () => {
    const violations = scanLockContent(POISONED_LOCK)
    expect(violations).toEqual([
      {
        line: 4,
        host: '127.0.0.1:4873',
        url: 'http://127.0.0.1:4873/@types/bun/-/bun-1.4.0.tgz',
      },
    ])
  })

  it('rejects any other non-canonical host, including public npm', () => {
    expect(
      scanLockContent('"x": ["x@1", "http://max3:4873/x/-/x-1.tgz", {}, "sha512-c=="]')
    ).toEqual([{ line: 1, host: 'max3:4873', url: 'http://max3:4873/x/-/x-1.tgz' }])
    expect(
      scanLockContent('"x": ["x@1", "https://registry.npmjs.org/x/-/x-1.tgz", {}, "sha512-c=="]')
    ).toHaveLength(1)
  })

  it('passes a lock that is entirely on the canonical host', () => {
    expect(scanLockContent(POISONED_LOCK.replaceAll('127.0.0.1:4873', 'mini:4873'))).toEqual([])
    expect(scanLockContent('')).toEqual([])
  })

  it("passes this repo's tracked bun.lock", () => {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8')
    expect(scanLockContent(lock)).toEqual([])
  })
})

describe('canonical registry', () => {
  it('is the single source both the publish path and the gate read', () => {
    expect(registryOrigin(CANONICAL_REGISTRY_URL)).toBe('mini:4873')
    expect(activeRegistryUrl({})).toBe(CANONICAL_REGISTRY_URL)
    expect(activeRegistryUrl({ VERDACCIO_REGISTRY: 'http://127.0.0.1:4873/' })).toBe(
      'http://127.0.0.1:4873/'
    )
  })

  it('holds the gate to the canonical host even on a node pointed elsewhere', () => {
    // The whole defect class: a guest publishes to loopback. The gate must not
    // inherit that opinion from the environment.
    expect(scanLockContent(POISONED_LOCK)).toHaveLength(1)
  })
})
