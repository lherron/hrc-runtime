/**
 * T-06613 — reading the declared `[placement]` stanza off an agent profile.
 *
 * The distinction this suite exists to protect is "declares nothing" vs "could
 * not be read". Collapsing them is the easy bug, and it is the one that makes
 * locate lie: a scope whose profile failed to parse would render as an
 * unconstrained scope, and skew would silently stop being detectable for it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { resolvePlacementPolicy } from '../federation/placement-policy.js'

const SCOPE = 'agent:mable:project:hrc-runtime:task:T-06613'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function agentRootWith(profile: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 't06613-profile-'))
  roots.push(root)
  if (profile !== undefined) {
    writeFileSync(join(root, 'agent-profile.toml'), profile, 'utf8')
  }
  return root
}

describe('resolvePlacementPolicy', () => {
  test('reads default_home_node and the pin table', () => {
    const agentRoot = agentRootWith(
      [
        'schemaVersion = 1',
        '',
        '[placement]',
        'default_home_node = "max3"',
        '"hrc-runtime:T-06613" = "mini"',
        '',
        '[placement.task-defaults]',
        'labprimary = "lab"',
      ].join('\n')
    )

    const resolution = resolvePlacementPolicy(SCOPE, { agentRoot })

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.policy.placement?.defaultHomeNode).toBe('max3')
    expect(resolution.policy.placement?.pins['hrc-runtime:T-06613']).toBe('mini')
    expect(resolution.policy.placement?.taskDefaults['labprimary']).toBe('lab')
  })

  test('a profile with no [placement] stanza resolves with placement undefined', () => {
    const agentRoot = agentRootWith('schemaVersion = 1\n')

    const resolution = resolvePlacementPolicy(SCOPE, { agentRoot })

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.policy.placement).toBeUndefined()
  })

  test('a placement profile without task-defaults preserves the legacy compiled shape', () => {
    const agentRoot = agentRootWith(
      ['schemaVersion = 2', '', '[placement]', 'default_home_node = "max3"'].join('\n')
    )

    const resolution = resolvePlacementPolicy(SCOPE, { agentRoot })

    expect(resolution.outcome).toBe('resolved')
    if (resolution.outcome !== 'resolved') return
    expect(resolution.policy.placement).toEqual({ defaultHomeNode: 'max3', pins: {} })
  })

  test('a missing profile is "no-profile", not an error', () => {
    const agentRoot = agentRootWith(undefined)

    const resolution = resolvePlacementPolicy(SCOPE, { agentRoot })

    expect(resolution.outcome).toBe('no-profile')
  })

  test('an unparseable profile is "unreadable" — never confused with declaring nothing', () => {
    const agentRoot = agentRootWith('this is not = = valid toml [[[\n')

    const resolution = resolvePlacementPolicy(SCOPE, { agentRoot })

    expect(resolution.outcome).toBe('unreadable')
    if (resolution.outcome !== 'unreadable') return
    expect(resolution.detail).toContain('agent-profile.toml')
  })

  test('a read failure that is not ENOENT is "unreadable", not "no-profile"', () => {
    const resolution = resolvePlacementPolicy(SCOPE, {
      agentRoot: '/nonexistent',
      readFile: () => {
        const error = new Error('EACCES: permission denied') as Error & { code: string }
        error.code = 'EACCES'
        throw error
      },
    })

    expect(resolution.outcome).toBe('unreadable')
  })

  test('a scope naming no agent cannot have a profile', () => {
    const resolution = resolvePlacementPolicy('app:some-gateway', { agentRoot: '/unused' })

    expect(resolution.outcome).toBe('not-an-agent-scope')
  })
})
