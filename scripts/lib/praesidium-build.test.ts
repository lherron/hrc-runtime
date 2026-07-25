import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ASP_PACKAGE_NAMES,
  readCoherentInstalledAspBuild,
  readPublishedHrcBuild,
} from './praesidium-build'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

function aspBuild() {
  return {
    schema: 1 as const,
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: '1111111111111111111111111111111111111111',
    setName: 'asp' as const,
    setVersion: '0.1.1-dev.fixture',
    builtAt: '2026-07-24T12:00:00.000Z',
  }
}

async function writeAspSet(root: string): Promise<void> {
  for (const name of ASP_PACKAGE_NAMES) {
    const packageRoot = join(root, 'node_modules', name)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name,
        version: aspBuild().setVersion,
        praesidiumBuild: aspBuild(),
      })
    )
  }
}

describe('T-06958 installed package build readers', () => {
  test('accepts one exact coherent ASP package set and rejects tuple divergence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hrc-asp-build-reader-'))
    fixtures.push(root)
    await writeAspSet(root)

    expect(await readCoherentInstalledAspBuild(root)).toEqual(aspBuild())

    const divergent = ASP_PACKAGE_NAMES.at(-1)!
    await writeFile(
      join(root, 'node_modules', divergent, 'package.json'),
      JSON.stringify({
        name: divergent,
        version: aspBuild().setVersion,
        praesidiumBuild: {
          ...aspBuild(),
          sourceCommit: '2222222222222222222222222222222222222222',
        },
      })
    )
    await expect(readCoherentInstalledAspBuild(root)).rejects.toThrow(
      'does not share the installed coherent ASP build tuple'
    )
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
