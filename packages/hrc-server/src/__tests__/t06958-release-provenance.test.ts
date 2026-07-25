import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PraesidiumBuild, PraesidiumReleaseManifest } from 'hrc-core'

import {
  PRAESIDIUM_RELEASE_MANIFEST_BASENAME,
  captureServerRelease,
  projectServerRelease,
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
    aspBuild: build(
      'agent-spaces',
      'asp',
      '3333333333333333333333333333333333333333',
      '0.1.0-dev.fixture'
    ),
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
