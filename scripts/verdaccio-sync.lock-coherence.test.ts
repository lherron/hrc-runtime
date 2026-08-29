import { describe, expect, test } from 'bun:test'

import { lockCoherenceViolations, parseLockResolutions } from './lib/verdaccio-sync'

const GROUPS = [{ label: 'ASP', packages: ['agent-harness', 'agent-scope', 'spaces-config'] }]

function lock(entries: Record<string, string>): string {
  const lines = Object.entries(entries).map(
    ([key, resolution]) =>
      `    "${key}": ["${resolution}", "http://mini:4873/x.tgz", {}, "sha512-x"],`
  )
  return `{\n  "packages": {\n${lines.join('\n')}\n  }\n}\n`
}

describe('bun.lock coherence', () => {
  test('parses hoisted and nested resolutions, scoped names included', () => {
    const parsed = parseLockResolutions(
      lock({
        'agent-scope': 'agent-scope@0.1.1-dev.1',
        'agent-harness/agent-scope': 'agent-scope@0.1.1-dev.2',
        '@wrkq/client': '@wrkq/client@0.1.0-dev.9',
      })
    )
    expect(parsed).toEqual([
      { key: 'agent-scope', name: 'agent-scope', version: '0.1.1-dev.1', nested: false },
      {
        key: 'agent-harness/agent-scope',
        name: 'agent-scope',
        version: '0.1.1-dev.2',
        nested: true,
      },
      { key: '@wrkq/client', name: '@wrkq/client', version: '0.1.0-dev.9', nested: false },
    ])
  })

  test('one version, one copy each is coherent', () => {
    const coherent = lock({
      'agent-harness': 'agent-harness@0.1.1-dev.1',
      'agent-scope': 'agent-scope@0.1.1-dev.1',
      'spaces-config': 'spaces-config@0.1.1-dev.1',
      unrelated: 'unrelated@9.9.9',
    })
    expect(lockCoherenceViolations(GROUPS, coherent)).toEqual([])
  })

  test('a hand-advanced subset is a split set with nested duplicates', () => {
    // The 2026-08-29 shape: `bun update agent-harness@<new>` moved two packages and
    // left bun nesting new copies of their dependencies under them.
    const split = lock({
      'agent-harness': 'agent-harness@0.1.1-dev.2',
      'agent-scope': 'agent-scope@0.1.1-dev.1',
      'spaces-config': 'spaces-config@0.1.1-dev.1',
      'agent-harness/agent-scope': 'agent-scope@0.1.1-dev.2',
    })
    const violations = lockCoherenceViolations(GROUPS, split)
    expect(violations.some((line) => line.includes('nested copy agent-harness/agent-scope'))).toBe(
      true
    )
    expect(violations.some((line) => line.includes('split across 2 versions'))).toBe(true)
  })

  test('packages absent from the lock are freshness, not coherence', () => {
    expect(lockCoherenceViolations(GROUPS, lock({ 'agent-scope': 'agent-scope@1' }))).toEqual([])
  })
})
