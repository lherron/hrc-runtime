import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ASP_CONTRACT_PACKAGE_NAMES,
  readInstalledAspContracts,
  readPublishedHrcBuild,
} from './praesidium-build'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

async function writeContractSet(root: string, version = '0.1.1-dev.fixture'): Promise<void> {
  for (const name of ASP_CONTRACT_PACKAGE_NAMES) {
    const packageRoot = join(root, 'node_modules', name)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version }))
  }
}

describe('T-06958 installed package build readers (T-08596: contracts, not a coherent tuple)', () => {
  test('reads the thin contract set versions and rejects name/version mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-asp-build-reader-'))
    fixtures.push(root)
    await writeContractSet(root)

    expect(await readInstalledAspContracts(root)).toEqual(
      ASP_CONTRACT_PACKAGE_NAMES.map((name) => ({ name, version: '0.1.1-dev.fixture' }))
    )

    const divergent = ASP_CONTRACT_PACKAGE_NAMES.at(-1)!
    await writeFile(
      join(root, 'node_modules', divergent, 'package.json'),
      JSON.stringify({ name: 'wrong-name', version: '0.1.1-dev.fixture' })
    )
    await expect(readInstalledAspContracts(root)).rejects.toThrow('installed ASP contract mismatch')
  })

  test('requires the publisher channel proof expected by the installer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-build-output-reader-'))
    fixtures.push(root)
    const path = join(root, 'build.json')
    const build = {
      schema: 1 as const,
      repository: 'hrc-runtime',
      canonicalRemote: 'git@github.com:lherron/hrc-runtime.git',
      sourceCommit: '3333333333333333333333333333333333333333',
      setName: 'hrc' as const,
      setVersion: '0.5.13-dev.fixture',
      builtAt: '2026-07-24T13:00:00.000Z',
    }
    await writeFile(path, JSON.stringify({ schema: 1, canonical: true, build }))

    expect(await readPublishedHrcBuild(path, true)).toEqual(build)
    await expect(readPublishedHrcBuild(path, false)).rejects.toThrow('expected false')
  })
})
