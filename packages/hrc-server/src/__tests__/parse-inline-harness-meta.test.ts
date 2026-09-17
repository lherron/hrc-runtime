import { describe, expect, test } from 'bun:test'

import { parseRuntimeIntent } from '../parsers/runtime.js'

describe('parseRuntimeIntent — meta provider admission (muse seat)', () => {
  test('an inline harness with the meta provider and muse-cli id parses', () => {
    const parsed = parseRuntimeIntent({
      harness: { provider: 'meta', interactive: true, id: 'muse-cli' },
    })
    expect(parsed.harness).toEqual({ provider: 'meta', interactive: true, id: 'muse-cli' })
  })
})
