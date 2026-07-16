import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type HrcSelector, parseSelector } from '../selectors.js'

type ProfileAwareSelectorOptions = {
  defaultRoleName?: string | undefined
}

const parseSelectorWithOptions = parseSelector as (
  input: unknown,
  options?: ProfileAwareSelectorOptions
) => HrcSelector

describe('profile default role injection into the pure monitor selector', () => {
  test('fills the configured role only for an explicit task', () => {
    expect(
      parseSelectorWithOptions('clod@proj:T-123', { defaultRoleName: 'coordinator' })
    ).toMatchObject({
      kind: 'target',
      scopeRef: 'agent:clod:project:proj:task:T-123:role:coordinator',
      sessionRef: 'agent:clod:project:proj:task:T-123:role:coordinator/lane:main',
    })
  })

  test('keeps an explicit role instead of the configured default', () => {
    expect(
      parseSelectorWithOptions('clod@proj:T-123/tester', {
        defaultRoleName: 'coordinator',
      })
    ).toMatchObject({
      kind: 'target',
      scopeRef: 'agent:clod:project:proj:task:T-123:role:tester',
      sessionRef: 'agent:clod:project:proj:task:T-123:role:tester/lane:main',
    })
  })

  test('does not apply the configured role to an auto-filled primary task', () => {
    expect(parseSelectorWithOptions('clod@proj', { defaultRoleName: 'coordinator' })).toMatchObject(
      {
        kind: 'target',
        scopeRef: 'agent:clod:project:proj:task:primary',
        sessionRef: 'agent:clod:project:proj:task:primary/lane:main',
      }
    )
  })

  test('propagates an invalid configured role instead of dropping it', () => {
    expect(() =>
      parseSelectorWithOptions('clod@proj:T-123', { defaultRoleName: 'not/a/role' })
    ).toThrow()
  })

  test('does not enrich prefixed selectors', () => {
    expect(
      parseSelectorWithOptions('runtime:rt-profile-pin', { defaultRoleName: 'coordinator' })
    ).toEqual({
      kind: 'runtime',
      raw: 'runtime:rt-profile-pin',
      runtimeId: 'rt-profile-pin',
    })
  })

  test('does not enrich object selectors', () => {
    const sessionRef = 'agent:clod:project:proj:task:T-123/lane:main'
    expect(parseSelectorWithOptions({ sessionRef }, { defaultRoleName: 'coordinator' })).toEqual({
      kind: 'stable',
      sessionRef,
    })
  })
})

test('selectors.ts remains pure and performs no profile or filesystem reads', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'selectors.ts'), 'utf8')

  expect(source).not.toContain("from 'node:fs'")
  expect(source).not.toContain("from 'node:fs/promises'")
  expect(source).not.toContain("from 'spaces-config'")
  expect(source).not.toContain('parseAgentProfile')
  expect(source).not.toContain('resolveAgentPlacementPaths')
})
