import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PraesidiumBuild, PraesidiumReleaseManifest } from 'hrc-core'

import {
  PRAESIDIUM_RELEASE_MANIFEST_BASENAME,
  captureServerRelease,
  projectServerRelease,
  pruneReleasesFromCurrent,
} from '../release-provenance'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

function build(
  repository: 'agent-spaces' | 'hrc-runtime',
  setName: 'asp' | 'hrc',
  sourceCommit: string,
  setVersion: string
): PraesidiumBuild {
  return {
    schema: 1,
    repository,
    canonicalRemote: 'ssh://example.test/praesidium.git',
    sourceCommit,
    setName,
    setVersion,
    builtAt: '2026-07-24T12:00:00.000Z',
  }
}

async function writeAtomicRelease(
  installRoot: string,
  releaseId: string
): Promise<{ packagePath: string; releasePath: string }> {
  const releasePath = join(installRoot, 'hrc-runtime-releases', releaseId)
  const packagePath = join(releasePath, 'packages', 'hrc-server')
  await mkdir(packagePath, { recursive: true })
  const manifest: PraesidiumReleaseManifest = {
    schema: 1,
    releaseId,
    hrcBuild: build(
      'hrc-runtime',
      'hrc',
      releaseId === 'release-a'
        ? '1111111111111111111111111111111111111111'
        : '2222222222222222222222222222222222222222',
      `0.5.13-dev.${releaseId}`
    ),
    aspContracts: [
      { name: 'agent-scope', version: '0.1.1-dev.fixture' },
      { name: 'cli-kit', version: '0.1.1-dev.fixture' },
      { name: 'spaces-aspc-protocol', version: '0.1.1-dev.fixture' },
      { name: 'spaces-harness-broker-protocol', version: '0.1.1-dev.fixture' },
      { name: 'spaces-harness-broker-client', version: '0.1.1-dev.fixture' },
      { name: 'spaces-runtime-contracts', version: '0.1.1-dev.fixture' },
    ],
    installedAt: '2026-07-24T13:00:00.000Z',
  }
  await writeFile(
    join(releasePath, PRAESIDIUM_RELEASE_MANIFEST_BASENAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  return { packagePath, releasePath }
}

describe('T-06958 observable atomic release truth', () => {
  test('distinguishes running release A from installed release B until restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-release-provenance-'))
    fixtures.push(root)
    const installRoot = join(root, 'install')
    const currentLink = join(installRoot, 'hrc-runtime-current')
    const releaseA = await writeAtomicRelease(installRoot, 'release-a')
    const releaseB = await writeAtomicRelease(installRoot, 'release-b')

    await symlink(releaseA.releasePath, currentLink)
    const capturedA = captureServerRelease(releaseA.packagePath, '2026-07-24T14:00:00.000Z')
    expect(projectServerRelease(capturedA)).toMatchObject({
      mode: 'atomic',
      releaseId: 'release-a',
      runningEqualsInstalled: true,
    })

    await rm(currentLink)
    await symlink(releaseB.releasePath, currentLink)
    expect(projectServerRelease(capturedA)).toMatchObject({
      mode: 'atomic',
      releaseId: 'release-a',
      runningEqualsInstalled: false,
    })

    const capturedB = captureServerRelease(releaseB.packagePath, '2026-07-24T15:00:00.000Z')
    expect(projectServerRelease(capturedB)).toMatchObject({
      mode: 'atomic',
      releaseId: 'release-b',
      runningEqualsInstalled: true,
      processStartedAt: '2026-07-24T15:00:00.000Z',
    })
  })

  test('fails closed for missing or malformed atomic release manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-release-provenance-invalid-'))
    fixtures.push(root)
    const releasePath = join(root, 'install', 'hrc-runtime-releases', 'release-invalid')
    const packagePath = join(releasePath, 'packages', 'hrc-server')
    await mkdir(packagePath, { recursive: true })

    expect(() => captureServerRelease(packagePath, new Date().toISOString())).toThrow(
      'has no valid praesidium-release.json'
    )

    await writeFile(
      join(releasePath, PRAESIDIUM_RELEASE_MANIFEST_BASENAME),
      JSON.stringify({ schema: 1, releaseId: 'release-invalid' })
    )
    expect(() => captureServerRelease(packagePath, new Date().toISOString())).toThrow(
      'release manifest must contain exactly'
    )
  })

  test('reports a source checkout daemon explicitly as unmanaged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-release-provenance-unmanaged-'))
    fixtures.push(root)
    const packagePath = join(root, 'checkout', 'packages', 'hrc-server')
    await mkdir(packagePath, { recursive: true })

    expect(
      projectServerRelease(captureServerRelease(packagePath, '2026-07-24T16:00:00.000Z'))
    ).toEqual({
      mode: 'unmanaged',
      packagePath: await realpath(packagePath),
      processStartedAt: '2026-07-24T16:00:00.000Z',
      runningEqualsInstalled: false,
    })
  })
})

// T-10024: once a daemon runs from current it deletes the older releases.
describe('T-10024 startup release prune', () => {
  async function installRootWith(ids: string[], currentId: string) {
    const root = await mkdtemp(join(tmpdir(), 'hrc-startup-prune-'))
    fixtures.push(root)
    const installRoot = join(root, 'install')
    const releases = new Map<string, { packagePath: string; releasePath: string }>()
    for (const id of ids) releases.set(id, await writeAtomicRelease(installRoot, id))
    await symlink(releases.get(currentId)!.releasePath, join(installRoot, 'hrc-runtime-current'))
    return {
      installRoot,
      releases,
      list: async () => (await readdir(join(installRoot, 'hrc-runtime-releases'))).sort(),
    }
  }

  test('a daemon running from current deletes every older release', async () => {
    const f = await installRootWith(['release-1', 'release-2', 'release-3'], 'release-3')
    const captured = captureServerRelease(f.releases.get('release-3')!.packagePath, 'now')
    const result = await pruneReleasesFromCurrent(captured)
    expect(result).toMatchObject({ pruned: true, removed: ['release-1', 'release-2'] })
    expect(await f.list()).toEqual(['release-3'])
  })

  test('a daemon running from a release that is no longer current deletes nothing', async () => {
    // Install switched the link after this daemon started: its own tree is not
    // current, and current may be the release another daemon is about to load.
    const f = await installRootWith(['release-1', 'release-2'], 'release-2')
    const captured = captureServerRelease(f.releases.get('release-1')!.packagePath, 'now')
    expect(await pruneReleasesFromCurrent(captured)).toEqual({
      pruned: false,
      reason: 'current-link-mismatch',
    })
    expect(await f.list()).toEqual(['release-1', 'release-2'])
  })

  test('nothing is deleted while an install holds its lock, and a newer release survives', async () => {
    const f = await installRootWith(['release-1', 'release-2', 'release-3'], 'release-2')
    const captured = captureServerRelease(f.releases.get('release-2')!.packagePath, 'now')
    const lockDir = join(f.installRoot, 'hrc-runtime-install.lock')
    await mkdir(lockDir)
    expect(await pruneReleasesFromCurrent(captured)).toEqual({
      pruned: false,
      reason: 'install-in-progress',
    })
    await rm(lockDir, { recursive: true })
    await pruneReleasesFromCurrent(captured)
    expect(await f.list()).toEqual(['release-2', 'release-3'])
  })

  test('an unmanaged daemon (source checkout) prunes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-startup-prune-'))
    fixtures.push(root)
    const packagePath = join(root, 'checkout', 'packages', 'hrc-server')
    await mkdir(packagePath, { recursive: true })
    expect(await pruneReleasesFromCurrent(captureServerRelease(packagePath, 'now'))).toBe(undefined)
  })
})
