import { describe, expect, test } from 'bun:test'

import { runtimeHarness } from '../broker/runtime-state.js'

describe('runtimeHarness — record label (muse seat)', () => {
  test('maps known runtimes and records muse-cli for the muse family', () => {
    expect(runtimeHarness('codex-cli')).toBe('codex-cli')
    expect(runtimeHarness('claude-code-cli')).toBe('claude-code')
    expect(runtimeHarness('muse-cli')).toBe('muse-cli')
    expect(runtimeHarness('something-unknown')).toBe('codex-cli')
  })
})
