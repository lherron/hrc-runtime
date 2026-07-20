import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type InstalledSurfacePaths, installAtomicRelease } from './atomic-install'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  )
})

async function makeLegacyLinkedSurface(): Promise<{
  binPath: string
  dependencyRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-legacy-install-repro-'))
  fixtures.push(root)

  const checkout = join(root, 'checkout')
  const packageRoot = join(checkout, 'packages', 'hrcchat-cli')
  const dependencyRoot = join(checkout, 'node_modules')
  const globalModules = join(root, 'global', 'node_modules')
  const binDir = join(root, 'bin')

  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await mkdir(join(dependencyRoot, 'fixture-dependency'), { recursive: true })
  await mkdir(globalModules, { recursive: true })
  await mkdir(binDir, { recursive: true })

  const entrypoint = join(packageRoot, 'src', 'main.ts')
  await writeFile(
    entrypoint,
    "#!/usr/bin/env bun\nimport value from 'fixture-dependency'\nconsole.log(value)\n"
  )
  await chmod(entrypoint, 0o755)
  await writeFile(
    join(dependencyRoot, 'fixture-dependency', 'package.json'),
    JSON.stringify({ name: 'fixture-dependency', type: 'module', exports: './index.js' })
  )
  await writeFile(
    join(dependencyRoot, 'fixture-dependency', 'index.js'),
    "export default 'legacy-surface-ok'\n"
  )

  await symlink(packageRoot, join(globalModules, 'hrcchat-cli'))
  const binPath = join(binDir, 'hrcchat')
  await symlink(join(globalModules, 'hrcchat-cli', 'src', 'main.ts'), binPath)

  return { binPath, dependencyRoot }
}

async function writeCliSources(releasePath: string, generation: string): Promise<void> {
  for (const [packageName, entrypoint] of [
    ['hrc-cli', 'cli.ts'],
    ['hrcchat-cli', 'main.ts'],
  ] as const) {
    const sourceDir = join(releasePath, 'packages', packageName, 'src')
    await mkdir(sourceDir, { recursive: true })
    const sourcePath = join(sourceDir, entrypoint)
    await writeFile(
      sourcePath,
      `#!/usr/bin/env bun\nimport value from 'fixture-dependency'\nconsole.log('${generation}:' + value)\n`
    )
    await chmod(sourcePath, 0o755)
  }
}

async function writeReleaseDependency(releasePath: string): Promise<void> {
  const dependencyRoot = join(releasePath, 'node_modules', 'fixture-dependency')
  await mkdir(dependencyRoot, { recursive: true })
  await writeFile(
    join(dependencyRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-dependency', type: 'module', exports: './index.js' })
  )
  await writeFile(join(dependencyRoot, 'index.js'), "export default 'dependency-ok'\n")
}

async function writeRelease(releasePath: string, generation: string): Promise<void> {
  await writeCliSources(releasePath, generation)
  await writeReleaseDependency(releasePath)
}

async function makeAtomicSurface(): Promise<{
  binPath: string
  oldRelease: string
  paths: InstalledSurfacePaths
  sourceRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'hrc-atomic-install-'))
  fixtures.push(root)

  const paths: InstalledSurfacePaths = {
    binDir: join(root, 'bin'),
    currentLink: join(root, 'install', 'hrc-runtime-current'),
    globalModules: join(root, 'install', 'global', 'node_modules'),
    lockDir: join(root, 'install', 'hrc-runtime-install.lock'),
    releaseRoot: join(root, 'install', 'hrc-runtime-releases'),
  }
  const oldRelease = join(paths.releaseRoot, 'release-old')
  await writeRelease(oldRelease, 'old')
  await mkdir(paths.globalModules, { recursive: true })
  await mkdir(paths.binDir, { recursive: true })

  // Model the pre-migration Bun-link topology. installAtomicRelease first
  // converts this to the stable current-link topology without changing roots.
  await symlink(join(oldRelease, 'packages', 'hrc-cli'), join(paths.globalModules, 'hrc-cli'))
  await symlink(
    join(oldRelease, 'packages', 'hrcchat-cli'),
    join(paths.globalModules, 'hrcchat-cli')
  )
  await symlink(join(paths.globalModules, 'hrc-cli', 'src', 'cli.ts'), join(paths.binDir, 'hrc'))
  const binPath = join(paths.binDir, 'hrcchat')
  await symlink(join(paths.globalModules, 'hrcchat-cli', 'src', 'main.ts'), binPath)

  return { binPath, oldRelease, paths, sourceRoot: join(root, 'checkout') }
}

function invokeInstalled(binPath: string): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync([binPath])
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  }
}

describe('T-06685 installed CLI continuity harness', () => {
  test('legacy checkout link deterministically exposes the dependency-gap failure', async () => {
    const fixture = await makeLegacyLinkedSurface()

    const before = Bun.spawnSync([fixture.binPath])
    expect(before.exitCode).toBe(0)
    expect(before.stdout.toString()).toContain('legacy-surface-ok')

    const hiddenDependencies = `${fixture.dependencyRoot}.install-gap`
    await rename(fixture.dependencyRoot, hiddenDependencies)
    const during = Bun.spawnSync([fixture.binPath])
    await rename(hiddenDependencies, fixture.dependencyRoot)

    expect(during.exitCode).not.toBe(0)
    expect(during.stderr.toString()).toMatch(/fixture-dependency|module/i)
  })

  test('installed CLI remains coherent throughout preparation and one-step cutover', async () => {
    const fixture = await makeAtomicSurface()
    let signalPreparationStarted: () => void = () => undefined
    const preparationStarted = new Promise<void>((resolve) => {
      signalPreparationStarted = resolve
    })
    let allowPreparationToFinish: () => void = () => undefined
    const preparationMayFinish = new Promise<void>((resolve) => {
      allowPreparationToFinish = resolve
    })

    const install = installAtomicRelease({
      context: 'main',
      linkMode: 'on',
      paths: fixture.paths,
      releaseId: 'release-new',
      sourceRoot: fixture.sourceRoot,
      prepareRelease: async (releasePath) => {
        await writeCliSources(releasePath, 'new')
        signalPreparationStarted()
        await preparationMayFinish
        await writeReleaseDependency(releasePath)
      },
    })

    await preparationStarted
    const during = Array.from({ length: 25 }, () => invokeInstalled(fixture.binPath))
    expect(during.every((result) => result.exitCode === 0)).toBeTrue()
    expect(during.every((result) => result.stderr === '')).toBeTrue()
    expect(during.every((result) => result.stdout.includes('old:dependency-ok'))).toBeTrue()

    allowPreparationToFinish()
    const installedRelease = await install
    expect(installedRelease).toBe(join(fixture.paths.releaseRoot, 'release-new'))

    const after = Array.from({ length: 10 }, () => invokeInstalled(fixture.binPath))
    expect(after.every((result) => result.exitCode === 0)).toBeTrue()
    expect(after.every((result) => result.stderr === '')).toBeTrue()
    expect(after.every((result) => result.stdout.includes('new:dependency-ok'))).toBeTrue()
  })

  test('failed preparation leaves the previous coherent CLI selected', async () => {
    const fixture = await makeAtomicSurface()

    await expect(
      installAtomicRelease({
        context: 'main',
        linkMode: 'on',
        paths: fixture.paths,
        releaseId: 'release-broken',
        sourceRoot: fixture.sourceRoot,
        prepareRelease: async (releasePath) => {
          await writeCliSources(releasePath, 'broken')
          throw new Error('deterministic preparation failure')
        },
      })
    ).rejects.toThrow('deterministic preparation failure')

    expect(await realpath(fixture.paths.currentLink)).toBe(await realpath(fixture.oldRelease))
    expect(invokeInstalled(fixture.binPath)).toMatchObject({
      exitCode: 0,
      stderr: '',
      stdout: 'old:dependency-ok\n',
    })
  })

  test('a concurrent install fails loudly while the owner keeps the surface usable', async () => {
    const fixture = await makeAtomicSurface()
    let signalOwnerReady: () => void = () => undefined
    const ownerReady = new Promise<void>((resolve) => {
      signalOwnerReady = resolve
    })
    let allowOwnerToFinish: () => void = () => undefined
    const ownerMayFinish = new Promise<void>((resolve) => {
      allowOwnerToFinish = resolve
    })

    const owner = installAtomicRelease({
      context: 'main',
      linkMode: 'on',
      paths: fixture.paths,
      releaseId: 'release-owner',
      sourceRoot: fixture.sourceRoot,
      prepareRelease: async (releasePath) => {
        signalOwnerReady()
        await ownerMayFinish
        await writeRelease(releasePath, 'owner')
      },
    })
    await ownerReady

    await expect(
      installAtomicRelease({
        context: 'main',
        linkMode: 'on',
        paths: fixture.paths,
        releaseId: 'release-racer',
        sourceRoot: fixture.sourceRoot,
        prepareRelease: (releasePath) => writeRelease(releasePath, 'racer'),
      })
    ).rejects.toThrow('install already in progress')
    expect(invokeInstalled(fixture.binPath).stdout).toBe('old:dependency-ok\n')

    allowOwnerToFinish()
    await owner
    expect(invokeInstalled(fixture.binPath).stdout).toBe('owner:dependency-ok\n')
  })
})
