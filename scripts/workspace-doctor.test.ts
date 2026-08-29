import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findStaleCopies, governedDependencies, parseRoot } from './workspace-doctor.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))
  )
})

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** A workspace with a root install and a set of `<package>/node_modules/<dep>` copies. */
async function makeTree(options: {
  overrides: Record<string, unknown>
  rootInstalled?: Record<string, string>
  nested?: Record<string, Record<string, string>>
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doctor-'))
  temporaryRoots.push(root)
  await writeManifest(root, { name: 'fixture', overrides: options.overrides })

  for (const [dependency, version] of Object.entries(options.rootInstalled ?? {})) {
    await writeManifest(join(root, 'node_modules', dependency), { name: dependency, version })
  }
  for (const [pkg, deps] of Object.entries(options.nested ?? {})) {
    await writeManifest(join(root, 'packages', pkg), { name: pkg })
    for (const [dependency, version] of Object.entries(deps)) {
      await writeManifest(join(root, 'packages', pkg, 'node_modules', dependency), {
        name: dependency,
        version,
      })
    }
  }
  return root
}

describe('parseRoot', () => {
  test('defaults to the fallback and honours an explicit --root', () => {
    expect(parseRoot([], '/fallback')).toBe('/fallback')
    expect(parseRoot(['--root', '/tmp'], '/fallback')).toBe('/tmp')
  })

  test('refuses --root without a directory rather than sweeping the wrong tree', () => {
    expect(() => parseRoot(['--root'], '/fallback')).toThrow('--root requires a directory')
  })
})

describe('governedDependencies', () => {
  test('are the root overrides naming one exact version', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14', ranged: '^1.0.0', redirected: 'workspace:*' },
    })

    expect(await governedDependencies(root)).toEqual(['@types/bun'])
  })
})

describe('findStaleCopies', () => {
  test('reports a nested copy whose version differs from the root resolution', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14' },
      nested: { 'hrc-core': { '@types/bun': '1.4.0' } },
    })

    const { stale } = await findStaleCopies(root, root)
    expect(stale).toEqual([
      {
        where: join('packages', 'hrc-core', 'node_modules', '@types/bun'),
        dependency: '@types/bun',
        version: '1.4.0',
        rootVersion: '1.3.14',
      },
    ])
  })

  test('keeps a nested copy at the SAME version — it shadows nothing', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14' },
      nested: { 'hrc-core': { '@types/bun': '1.3.14' } },
    })

    expect((await findStaleCopies(root, root)).stale).toEqual([])
  })

  test('never touches an ungoverned dependency, which bun nests deliberately', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14', ungoverned: '1.0.0' },
      nested: { 'hrc-core': { ungoverned: '2.0.0' } },
    })

    expect((await findStaleCopies(root, root)).stale).toEqual([])
  })

  test('keeps, and reports, a copy with no root resolution to compare against', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      nested: { 'hrc-core': { '@types/bun': '1.4.0' } },
    })

    const { stale, unresolved } = await findStaleCopies(root, root)
    expect(stale).toEqual([])
    expect(unresolved).toEqual([
      `${join('packages', 'hrc-core', 'node_modules', '@types/bun')}@1.4.0`,
    ])
  })

  /**
   * The dev-workspace layout, which is what this repo actually runs in: the repo's
   * own node_modules is EMPTY because the parent praesidium root owns the install.
   * Reading the resolution at the repo root would find nothing to compare against
   * and keep every stale copy while reporting success.
   */
  test('reads the root resolution from a separate install root', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'doctor-install-'))
    temporaryRoots.push(installRoot)
    await writeManifest(join(installRoot, 'node_modules', '@types/bun'), {
      name: '@types/bun',
      version: '1.3.14',
    })

    const repoRoot = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      nested: { 'hrc-core': { '@types/bun': '1.4.0' } },
    })

    const separate = await findStaleCopies(repoRoot, installRoot)
    expect(separate.stale.map((copy) => copy.rootVersion)).toEqual(['1.3.14'])
    expect(separate.unresolved).toEqual([])

    // Control: the same tree swept with the repo as its own install root finds no
    // resolution and therefore prunes nothing.
    const conflated = await findStaleCopies(repoRoot, repoRoot)
    expect(conflated.stale).toEqual([])
    expect(conflated.unresolved).toHaveLength(1)
  })

  test('finds a copy nested inside another package install, not just at the top level', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14' },
    })
    await writeManifest(join(root, 'node_modules', 'other', 'node_modules', '@types/bun'), {
      name: '@types/bun',
      version: '1.4.0',
    })

    expect((await findStaleCopies(root, root)).stale.map((copy) => copy.where)).toEqual([
      join('node_modules', 'other', 'node_modules', '@types/bun'),
    ])
  })

  test('does not report the install root own copy as nested', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14' },
    })

    expect((await findStaleCopies(root, root)).stale).toEqual([])
  })
})

describe('pruning', () => {
  test('removes the stale directory and leaves the healthy one', async () => {
    const root = await makeTree({
      overrides: { '@types/bun': '1.3.14' },
      rootInstalled: { '@types/bun': '1.3.14' },
      nested: { stale: { '@types/bun': '1.4.0' }, healthy: { '@types/bun': '1.3.14' } },
    })

    const stalePath = join(root, 'packages', 'stale', 'node_modules', '@types/bun')
    const healthyPath = join(root, 'packages', 'healthy', 'node_modules', '@types/bun')

    const check = Bun.spawnSync([
      'bun',
      join(import.meta.dir, 'workspace-doctor.ts'),
      '--root',
      root,
      '--check',
    ])
    expect(check.exitCode).toBe(1)
    expect(existsSync(stalePath)).toBe(true)

    const prune = Bun.spawnSync([
      'bun',
      join(import.meta.dir, 'workspace-doctor.ts'),
      '--root',
      root,
    ])
    expect(prune.exitCode).toBe(0)
    expect(existsSync(stalePath)).toBe(false)
    expect(existsSync(healthyPath)).toBe(true)

    // Idempotent: a second sweep of the repaired tree is clean.
    const again = Bun.spawnSync([
      'bun',
      join(import.meta.dir, 'workspace-doctor.ts'),
      '--root',
      root,
      '--check',
    ])
    expect(again.exitCode).toBe(0)
  })
})
