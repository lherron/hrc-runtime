import { describe, expect, test } from 'bun:test'

import {
  documentationNoticeLine,
  isInstallSourcePath,
  parsePorcelainPaths,
  partitionInstallScope,
} from './install-source-scope'

describe('isInstallSourcePath', () => {
  test('package, script, and tool code is source', () => {
    expect(isInstallSourcePath('packages/hrc-server/src/launch/broker.ts')).toBe(true)
    expect(isInstallSourcePath('scripts/atomic-install.ts')).toBe(true)
    expect(isInstallSourcePath('tools/fitkit/s6-hrc-runtime-verify-evidence.mjs')).toBe(true)
    expect(isInstallSourcePath('integration-tests/fixtures/hrc-shim/harness')).toBe(true)
  })

  test('build inputs at the repository root are source', () => {
    for (const path of ['package.json', 'bun.lock', 'tsconfig.json', 'justfile', 'biome.json']) {
      expect(isInstallSourcePath(path)).toBe(true)
    }
  })

  test('prose directories are not source', () => {
    expect(isInstallSourcePath('docs/operations-runbook.md')).toBe(false)
    expect(isInstallSourcePath('docs/diagrams/hrc-session-lifecycle.svg')).toBe(false)
    expect(isInstallSourcePath('docs/collection.yaml')).toBe(false)
    expect(isInstallSourcePath('architecture/index.jsonl')).toBe(false)
    expect(
      isInstallSourcePath('architecture/records/invariants/hrc-runtime.verify-gate.yaml')
    ).toBe(false)
  })

  test('prose is prose wherever it sits, including beside the code it describes', () => {
    expect(isInstallSourcePath('CLAUDE.md')).toBe(false)
    expect(isInstallSourcePath('packages/hrc-server/src/wrkq/session-project-events.md')).toBe(
      false
    )
    expect(isInstallSourcePath('docs/html/T-04901.HTML')).toBe(false)
  })

  // The point of the cut is that it holds a line, not that it moves one. A
  // directory whose name merely starts with a documentation directory's name is
  // a different directory.
  test('a lookalike prefix is still source', () => {
    expect(isInstallSourcePath('docs-generator/src/index.ts')).toBe(true)
    expect(isInstallSourcePath('architecture-tools/run.ts')).toBe(true)
  })

  test('fails closed on anything it does not recognize', () => {
    expect(isInstallSourcePath('launchd/com.praesidium.hrc-server.plist')).toBe(true)
    expect(isInstallSourcePath('.github/workflows/publish.yml')).toBe(true)
    expect(isInstallSourcePath('newly-invented-directory/thing.conf')).toBe(true)
    expect(isInstallSourcePath('.npmrc')).toBe(true)
  })
})

describe('partitionInstallScope', () => {
  test('splits a mixed dirty set and preserves order within each side', () => {
    expect(
      partitionInstallScope([
        'docs/atomic-install.md',
        'packages/hrc-cli/src/cli.ts',
        'architecture/RISKS.md',
        'bun.lock',
      ])
    ).toEqual({
      source: ['packages/hrc-cli/src/cli.ts', 'bun.lock'],
      documentation: ['docs/atomic-install.md', 'architecture/RISKS.md'],
    })
  })

  test('a documentation-only dirty tree leaves nothing to refuse over', () => {
    expect(partitionInstallScope(['docs/cli-reference.md', 'CLAUDE.md']).source).toEqual([])
  })
})

describe('documentationNoticeLine', () => {
  test('a gate that ignored nothing says nothing', () => {
    expect(documentationNoticeLine('[install] guard:', [])).toBeUndefined()
  })

  test('names what was ignored and truncates a long list', () => {
    const line = documentationNoticeLine('[install] guard:', [
      'a.md',
      'b.md',
      'c.md',
      'd.md',
      'e.md',
      'f.md',
      'g.md',
    ])
    expect(line).toContain('ignoring 7 dirty documentation path(s)')
    expect(line).toContain('a.md, b.md, c.md, d.md, e.md')
    expect(line).toContain('+2 more')
    expect(line).not.toContain('f.md')
  })
})

describe('parsePorcelainPaths', () => {
  test('reports worktree and index modifications', () => {
    expect(parsePorcelainPaths(' M justfile\nM  scripts/atomic-install.ts\n')).toEqual([
      'justfile',
      'scripts/atomic-install.ts',
    ])
  })

  test('drops untracked entries unless asked for them', () => {
    const porcelain = '?? scratch.ts\n!! dist/index.js\n M justfile\n'
    expect(parsePorcelainPaths(porcelain)).toEqual(['justfile'])
    expect(parsePorcelainPaths(porcelain, { includeUntracked: true })).toEqual([
      'scratch.ts',
      'justfile',
    ])
  })

  test('reports the destination path of a rename', () => {
    expect(parsePorcelainPaths('R  scripts/old.ts -> scripts/new.ts\n')).toEqual(['scripts/new.ts'])
  })

  test('reads clean output as no paths', () => {
    expect(parsePorcelainPaths('')).toEqual([])
  })
})
