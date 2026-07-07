import { describe, expect, test } from 'bun:test'

import { timestampVersion } from './publish-local-verdaccio'

describe('publish-local-verdaccio version policy', () => {
  const now = new Date(2026, 6, 7, 6, 45, 30)

  test('keeps ordinary dev publishes on the dev timestamp channel', () => {
    expect(timestampVersion('0.1.0', 'dev', now, 'abcdef123456')).toBe('0.1.0-dev.20260707064530')
  })

  test('uses an isolated worktree prerelease including the source sha', () => {
    expect(timestampVersion('0.1.0-dev.20260701000000', 'worktree', now, 'abcdef123456')).toBe(
      '0.1.0-worktree.20260707064530.abcdef123456'
    )
  })
})
