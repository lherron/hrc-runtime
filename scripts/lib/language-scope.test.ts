import { expect, test } from 'bun:test'
import { languageScope } from './language-scope'

test('Rust, TS and shared paths select the required validation legs', () => {
  expect(languageScope(['crates/hrc-domain/src/lib.rs'])).toEqual({ ts: false, cargo: true })
  expect(languageScope(['packages/hrc-server/src/server.ts'])).toEqual({ ts: true, cargo: false })
  for (const path of [
    'contract/routes.json',
    'conformance/probe.py',
    'packages/hrc-store-sqlite/src/migrations/0124.ts',
    'justfile',
    '.hookignore-cargo',
  ]) {
    expect(languageScope([path])).toEqual({ ts: true, cargo: true })
  }
  expect(languageScope(['docs/guide.md'])).toEqual({ ts: false, cargo: false })
  expect(languageScope(['new-unknown-input'])).toEqual({ ts: true, cargo: false })
})
