import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  HOOK_SCOPE_IGNORE_FILE,
  loadHookScopeIgnore,
  parseHookScopeIgnore,
  worktreeRoot,
} from './hook-scope-ignore.ts'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

describe('hook scope ignore syntax', () => {
  test('matches a directory rule at the root and at any depth', () => {
    const ignore = parseHookScopeIgnore('docs/\n')

    expect(ignore.ignores('docs/reference.md')).toBeTrue()
    expect(ignore.ignores('docs/deep/nested/reference.md')).toBeTrue()
    expect(ignore.ignores('packages/hrc-server/docs/notes.md')).toBeTrue()
    // A trailing `/` names the contents, and a sibling with the same prefix is
    // not the directory.
    expect(ignore.ignores('docsy/app.ts')).toBeFalse()
    expect(ignore.ignores('docs')).toBeFalse()
  })

  test('matches a basename rule at any depth but an anchored rule only at the root', () => {
    const ignore = parseHookScopeIgnore('*.md\n/CHANGELOG.txt\n')

    expect(ignore.ignores('README.md')).toBeTrue()
    expect(ignore.ignores('packages/hrc-core/src/notes.md')).toBeTrue()
    expect(ignore.ignores('CHANGELOG.txt')).toBeTrue()
    expect(ignore.ignores('packages/hrc-core/CHANGELOG.txt')).toBeFalse()
  })

  test('anchors a pattern that contains a slash', () => {
    const ignore = parseHookScopeIgnore('architecture/**\n')

    expect(ignore.ignores('architecture/index.jsonl')).toBeTrue()
    expect(ignore.ignores('architecture/records/invariants/a.yaml')).toBeTrue()
    expect(ignore.ignores('packages/x/architecture/index.jsonl')).toBeFalse()
  })

  test('matches without regard to case', () => {
    const ignore = parseHookScopeIgnore('docs/\n*.md\n')

    expect(ignore.ignores('README.MARKDOWN')).toBeFalse()
    expect(ignore.ignores('README.MD')).toBeTrue()
    expect(ignore.ignores('DOCS/Reference.HTML')).toBeTrue()
  })

  test('lets a later rule win, so negation re-includes and breadth re-covers', () => {
    const reincluded = parseHookScopeIgnore('architecture/\n!architecture/tooling/*.ts\n')
    expect(reincluded.ignores('architecture/index.jsonl')).toBeTrue()
    expect(reincluded.ignores('architecture/tooling/build.ts')).toBeFalse()

    const recovered = parseHookScopeIgnore('!architecture/tooling/*.ts\narchitecture/\n')
    expect(recovered.ignores('architecture/tooling/build.ts')).toBeTrue()
  })

  test('skips comments, blanks and trailing whitespace without counting them as rules', () => {
    const ignore = parseHookScopeIgnore('# a comment\n\n   \ndocs/   \n')

    expect(ignore.ruleCount).toBe(1)
    expect(ignore.ignores('docs/reference.md')).toBeTrue()
  })
})

describe('hook scope ignore fails closed', () => {
  test('treats every path as code when the list is absent, empty or unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-runtime-hookignore-'))
    try {
      const absent = loadHookScopeIgnore(root)
      expect(absent.ruleCount).toBe(0)
      expect(absent.ignores('README.md')).toBeFalse()

      // A directory in place of the file is the unreadable case: the read
      // throws EISDIR rather than returning text, and the answer must still be
      // "code" rather than an exception out of a git hook.
      const unreadableRoot = await mkdtemp(join(tmpdir(), 'hrc-runtime-hookignore-dir-'))
      await mkdir(join(unreadableRoot, HOOK_SCOPE_IGNORE_FILE))
      const unreadable = loadHookScopeIgnore(unreadableRoot)
      expect(unreadable.ruleCount).toBe(0)
      expect(unreadable.ignores('docs/reference.md')).toBeFalse()
      await rm(unreadableRoot, { recursive: true })

      await writeFile(join(root, HOOK_SCOPE_IGNORE_FILE), '# nothing but a comment\n')
      const empty = loadHookScopeIgnore(root)
      expect(empty.ruleCount).toBe(0)
      expect(empty.ignores('docs/reference.md')).toBeFalse()

      // Control. Without it every assertion above is also satisfied by a loader
      // that reads nothing at all, and the fail-closed claim proves nothing.
      await writeFile(join(root, HOOK_SCOPE_IGNORE_FILE), 'docs/\n')
      const populated = loadHookScopeIgnore(root)
      expect(populated.ruleCount).toBe(1)
      expect(populated.ignores('docs/reference.md')).toBeTrue()
    } finally {
      await rm(root, { recursive: true })
    }
  })

  test('never ignores the empty path', () => {
    expect(parseHookScopeIgnore('**\n').ignores('')).toBeFalse()
  })

  test('falls back to the working directory outside a checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-runtime-hookignore-root-'))
    try {
      expect(worktreeRoot(root)).toBe(root)
    } finally {
      await rm(root, { recursive: true })
    }
  })
})

describe("this repository's hook scope ignore list", () => {
  test('excuses documentation and architecture records but nothing that builds', () => {
    const ignore = loadHookScopeIgnore(repoRoot)

    expect(ignore.ruleCount).toBeGreaterThan(0)
    // The change that bought a full pre-push suite for nothing.
    expect(ignore.ignores('architecture/records/invariants/a.yaml')).toBeTrue()
    expect(ignore.ignores('architecture/index.jsonl')).toBeTrue()
    expect(ignore.ignores('architecture/INVARIANTS.md')).toBeTrue()
    expect(ignore.ignores('docs/operations-runbook.md')).toBeTrue()
    expect(ignore.ignores('packages/hrc-server/src/wrkq/session-project-events.md')).toBeTrue()

    for (const path of [
      'packages/hrc-server/src/index.ts',
      'scripts/run-if-code-changed.ts',
      'lefthook.yml',
      'package.json',
      'bun.lock',
      '.hookignore',
      'justfile',
    ]) {
      expect(ignore.ignores(path), path).toBeFalse()
    }
  })
})
