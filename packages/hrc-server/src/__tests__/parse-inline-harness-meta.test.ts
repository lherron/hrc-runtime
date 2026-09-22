import { describe, expect, test } from 'bun:test'

import { parseRuntimeIntent } from '../parsers/runtime.js'

describe('parseRuntimeIntent — meta provider admission (muse seat)', () => {
  test('an inline harness with the meta provider and muse-cli id parses', () => {
    const parsed = parseRuntimeIntent({
      harness: { provider: 'meta', interactive: true, id: 'muse-cli' },
    })
    expect(parsed.harness).toEqual({ provider: 'meta', interactive: true, id: 'muse-cli' })
  })

  test('preserves an ordinary v2 omission plus explicit false and raw summon directives', () => {
    const parsed = parseRuntimeIntent({
      harness: { interactive: false },
      selection: { model: 'gpt-5.5', presentation: false },
      summonDirectives: {
        model: 'gpt-5.5-mini',
        reasoning_effort: 'high',
        presentation: true,
      },
    })

    expect(parsed.harness).toEqual({ interactive: false })
    expect(parsed.selection).toEqual({ model: 'gpt-5.5', presentation: false })
    expect(parsed.summonDirectives).toEqual({
      model: 'gpt-5.5-mini',
      reasoning_effort: 'high',
      presentation: true,
    })
  })
})
