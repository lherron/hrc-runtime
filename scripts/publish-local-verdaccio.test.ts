import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type GitFixture, createGitFixture, runGit } from '../test-support/git-fixture.js'

import {
  assertNoCanonicalVersionReplacement,
  createPraesidiumBuild,
  provePublicationSource,
  timestampVersion,
} from './publish-local-verdaccio'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

async function canonicalFixture(): Promise<{ root: string; remote: string; repo: GitFixture }> {
  const fixture = await mkdtemp(join(tmpdir(), 'hrc-canonical-publish-'))
  fixtures.push(fixture)
  const remote = join(fixture, 'remote.git')
  const root = join(fixture, 'source')
  createGitFixture(remote, { bare: true })
  const repo = createGitFixture(root, {
    initialBranch: 'main',
    identity: { name: 'HRC Test', email: 'hrc-test@example.test' },
  })
  await writeFile(join(root, 'tracked.txt'), 'canonical\n')
  runGit(repo, ['add', 'tracked.txt'])
  runGit(repo, ['commit', '-m', 'canonical source'])
  runGit(repo, ['remote', 'add', 'origin', remote])
  runGit(repo, ['push', '-u', 'origin', 'main'])
  return { root, remote, repo }
}

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

describe('T-06958 canonical package provenance', () => {
  test('uses the exact normative tuple without a second fingerprint', () => {
    const build = createPraesidiumBuild({
      canonicalRemote: 'ssh://git.example.test/praesidium.git',
      sourceCommit: '1111111111111111111111111111111111111111',
      setVersion: '0.5.13-dev.20260724120000',
      builtAt: '2026-07-24T12:00:00.000Z',
    })

    expect(Object.keys(build)).toEqual([
      'schema',
      'repository',
      'canonicalRemote',
      'sourceCommit',
      'setName',
      'setVersion',
      'builtAt',
    ])
    expect(build).toEqual({
      schema: 1,
      repository: 'hrc-runtime',
      canonicalRemote: 'ssh://git.example.test/praesidium.git',
      sourceCommit: '1111111111111111111111111111111111111111',
      setName: 'hrc',
      setVersion: '0.5.13-dev.20260724120000',
      builtAt: '2026-07-24T12:00:00.000Z',
    })
  })

  test('freshly fetches and accepts a clean commit contained by the named ref', async () => {
    const fixture = await canonicalFixture()
    const proof = provePublicationSource({
      canonical: true,
      canonicalRef: 'origin/main',
      root: fixture.root,
    })

    expect(proof).toMatchObject({
      canonical: true,
      canonicalRef: 'origin/main',
      canonicalRemote: fixture.remote,
      sourceCommit: runGit(fixture.repo, ['rev-parse', 'HEAD']),
    })
  })

  test('rejects dirty and uncontained canonical sources', async () => {
    const dirty = await canonicalFixture()
    await writeFile(join(dirty.root, 'untracked.txt'), 'dirty\n')
    expect(() =>
      provePublicationSource({
        canonical: true,
        canonicalRef: 'origin/main',
        root: dirty.root,
      })
    ).toThrow('requires a clean source tree')

    const uncontained = await canonicalFixture()
    await writeFile(join(uncontained.root, 'tracked.txt'), 'local-only\n')
    runGit(uncontained.repo, ['add', 'tracked.txt'])
    runGit(uncontained.repo, ['commit', '-m', 'local only'])
    expect(() =>
      provePublicationSource({
        canonical: true,
        canonicalRef: 'origin/main',
        root: uncontained.root,
      })
    ).toThrow('is not contained by freshly fetched origin/main')
  })

  test('refuses same-name/version replacement before canonical publication', async () => {
    await expect(
      assertNoCanonicalVersionReplacement(
        [{ name: 'hrc-core', version: '0.5.13-dev.20260724120000' }],
        async () => true
      )
    ).rejects.toThrow('refuses same-name/version replacement')
  })
})
