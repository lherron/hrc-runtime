import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${result.stderr.toString()}${result.stdout.toString()}`)
  }
  return result.stdout.toString().trim()
}

async function canonicalFixture(): Promise<{ root: string; remote: string }> {
  const fixture = await mkdtemp(join(tmpdir(), 'hrc-canonical-publish-'))
  fixtures.push(fixture)
  const remote = join(fixture, 'remote.git')
  const root = join(fixture, 'source')
  await mkdir(root)
  git(['init', '--bare', remote], fixture)
  git(['init', '-b', 'main'], root)
  git(['config', 'user.name', 'HRC Test'], root)
  git(['config', 'user.email', 'hrc-test@example.test'], root)
  await writeFile(join(root, 'tracked.txt'), 'canonical\n')
  git(['add', 'tracked.txt'], root)
  git(['commit', '-m', 'canonical source'], root)
  git(['remote', 'add', 'origin', remote], root)
  git(['push', '-u', 'origin', 'main'], root)
  return { root, remote }
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
      sourceCommit: git(['rev-parse', 'HEAD'], fixture.root),
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
    git(['add', 'tracked.txt'], uncontained.root)
    git(['commit', '-m', 'local only'], uncontained.root)
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
