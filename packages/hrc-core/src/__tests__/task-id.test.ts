import { describe, expect, test } from 'bun:test'

import fixtures from '../../fixtures/task-id-grammar.json'
import { findTaskIds, isTaskId, ownerTaskTokens, parseTaskId, taskOwnerId } from '../task-id.js'

describe('task-id grammar (shared fixtures)', () => {
  for (const valid of fixtures.valid) {
    test(`accepts ${valid.id}`, () => {
      const { $comment: _, ...expected } = valid as typeof valid & { $comment?: string }
      expect(parseTaskId(valid.id)).toEqual(expected)
      expect(taskOwnerId(valid.id)).toBe(valid.ownerId)
    })
  }

  for (const invalid of fixtures.invalid) {
    test(`refuses ${JSON.stringify(invalid)}`, () => {
      expect(parseTaskId(invalid)).toBeUndefined()
      expect(isTaskId(invalid)).toBe(false)
    })
  }

  for (const prose of fixtures.prose) {
    test(`prose ${JSON.stringify(prose.text)}`, () => {
      expect(findTaskIds(prose.text)).toEqual(prose.ids)
    })
  }
})

describe('ownerTaskTokens', () => {
  test('a subtask token in a branch or path names its owner', () => {
    expect(ownerTaskTokens('clod/T-12345.render-preview')).toEqual(['T-12345'])
    expect(ownerTaskTokens('/wt/hrc-runtime-T-12345.slug')).toEqual(['T-12345'])
  })
})
