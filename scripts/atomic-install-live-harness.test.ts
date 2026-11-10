import { afterEach, describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type InstalledSurfacePaths,
  RELEASE_SHAPE,
  type RunningReleaseAnswer,
  installAtomicRelease,
} from './atomic-install'

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
  const packageRoot = join(checkout, 'packages', 'legacy-cli')
  const dependencyRoot = join(checkout, 'node_modules')
  const globalModules = join(root, 'global', 'node_modules')
  const binDir = join(root, 'bin')

  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await mkdir(join(dependencyRoot, 'fixture-dependency'), { recursive: true })
  await mkdir(globalModules, { recursive: true })
  await mkdir(binDir, { recursive: true })

  const entrypoint = join(packageRoot, 'src', 'cli.ts')
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

  await symlink(packageRoot, join(globalModules, 'legacy-cli'))
  const binPath = join(binDir, 'hrc')
  await symlink(join(globalModules, 'legacy-cli', 'src', 'cli.ts'), binPath)

  return { binPath, dependencyRoot }
}

type ShapeEntry =
  | (typeof RELEASE_SHAPE.executables)[number]
  | (typeof RELEASE_SHAPE.directories)[number]

/**
 * A release holding exactly what the real installer demands, read from its own
 * table rather than restated here, minus `omit`. A hand-written list drifts in
 * the direction that matters: a new requirement would make the installer
 * refuse a release this harness built itself. No package directory is written,
 * so the five retired packages cannot be what makes a release valid.
 *
 * Every executable prints `<generation>:dependency-ok`; `bin/rusthrc` is what
 * the installed `hrc` and `rusthrc` names run.
 */
async function writeRelease(
  releasePath: string,
  generation: string,
  omit: readonly ShapeEntry[] = []
): Promise<void> {
  for (const directory of RELEASE_SHAPE.directories) {
    if (!omit.includes(directory)) await mkdir(join(releasePath, directory), { recursive: true })
  }
  for (const executable of RELEASE_SHAPE.executables) {
    if (omit.includes(executable)) continue
    const path = join(releasePath, executable)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${generation}:dependency-ok'\n`)
    // Left non-executable on purpose: the installer marks them executable.
    await chmod(path, 0o644)
  }
}

/** Every path under a release, relative to it, sorted. */
async function releaseTree(releasePath: string): Promise<string[]> {
  const entries = await readdir(releasePath, { recursive: true })
  return entries.map(String).sort()
}

function fixtureBuilds() {
  return {
    hrcBuild: {
      schema: 1 as const,
      repository: 'hrc-runtime',
      canonicalRemote: 'ssh://example.test/praesidium.git',
      sourceCommit: '1111111111111111111111111111111111111111',
      setName: 'hrc' as const,
      setVersion: '0.5.13-dev.fixture',
      builtAt: '2026-07-24T12:00:00.000Z',
    },
    aspContracts: [
      { name: 'agent-scope', version: '0.1.1-dev.fixture' },
      { name: 'cli-kit', version: '0.1.1-dev.fixture' },
      { name: 'spaces-harness-broker-protocol', version: '0.1.1-dev.fixture' },
      { name: 'spaces-harness-broker-client', version: '0.1.1-dev.fixture' },
      { name: 'spaces-runtime-contracts', version: '0.1.1-dev.fixture' },
    ],
  }
}

/**
 * Today's installed topology: `hrc-runtime-current` names release-old and both
 * command names go through it. `legacyBunCli` instead leaves `hrc` where an
 * install from before the native CLI did: on the Bun entrypoint of an older
 * release (now gone, so dangling), with the global `hrc-cli` package link
 * those installs created.
 */
async function makeAtomicSurface(options: { legacyBunCli?: boolean } = {}): Promise<{
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
  await chmod(join(oldRelease, 'bin', 'rusthrc'), 0o755)
  await mkdir(paths.globalModules, { recursive: true })
  await mkdir(paths.binDir, { recursive: true })
  await symlink(oldRelease, paths.currentLink)
  const binPath = join(paths.binDir, 'hrc')
  await symlink(join(paths.currentLink, 'bin', 'rusthrc'), join(paths.binDir, 'rusthrc'))
  if (options.legacyBunCli) {
    await symlink(join(oldRelease, 'packages', 'hrc-cli', 'bin', 'hrc.js'), binPath)
    await symlink(
      join(paths.currentLink, 'packages', 'hrc-cli'),
      join(paths.globalModules, 'hrc-cli')
    )
  } else {
    await symlink(join(paths.currentLink, 'bin', 'rusthrc'), binPath)
  }

  return { binPath, oldRelease, paths, sourceRoot: join(root, 'checkout') }
}

async function selectedLinks(paths: InstalledSurfacePaths): Promise<Record<string, string>> {
  return {
    current: await readlink(paths.currentLink),
    hrc: await readlink(join(paths.binDir, 'hrc')),
    rusthrc: await readlink(join(paths.binDir, 'rusthrc')),
  }
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
  test("moves an hrc link left on an older release's Bun CLI entrypoint to bin/rusthrc", async () => {
    const fixture = await makeAtomicSurface({ legacyBunCli: true })
    expect(await readlink(fixture.binPath)).toBe(
      join(fixture.oldRelease, 'packages', 'hrc-cli', 'bin', 'hrc.js')
    )
    await expect(realpath(fixture.binPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await installAtomicRelease({
      context: 'main',
      linkMode: 'on',
      paths: fixture.paths,
      sourceRoot: fixture.sourceRoot,
      releaseId: 'release-first',
      readRunningRelease: () => ({ answered: true }),
      prepareRelease: async (path) => {
        await writeRelease(path, 'release-first')
        return fixtureBuilds()
      },
    })
    for (const name of ['hrc', 'rusthrc']) {
      expect(await readlink(join(fixture.paths.binDir, name))).toBe(
        join(fixture.paths.currentLink, 'bin', 'rusthrc')
      )
      expect(invokeInstalled(join(fixture.paths.binDir, name)).stdout).toBe(
        'release-first:dependency-ok\n'
      )
    }
    await expect(lstat(join(fixture.paths.globalModules, 'hrc-cli'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('the installer selects a release with no package directories', async () => {
    const fixture = await makeAtomicSurface()
    const installed = await installAtomicRelease({
      context: 'main',
      linkMode: 'on',
      paths: fixture.paths,
      sourceRoot: fixture.sourceRoot,
      releaseId: 'release-native',
      readRunningRelease: () => ({ answered: true }),
      prepareRelease: async (path) => {
        await writeRelease(path, 'native')
        return fixtureBuilds()
      },
    })
    expect(await realpath(fixture.paths.currentLink)).toBe(await realpath(installed))
    expect(await releaseTree(installed)).toEqual(
      [
        'bin',
        'praesidium-release.json',
        ...RELEASE_SHAPE.executables,
        ...RELEASE_SHAPE.directories,
      ].sort()
    )
    for (const executable of RELEASE_SHAPE.executables) {
      expect((await stat(join(installed, executable))).mode & 0o111, executable).not.toBe(0)
    }
    expect(invokeInstalled(fixture.binPath).stdout).toBe('native:dependency-ok\n')
  })

  for (const missing of [...RELEASE_SHAPE.executables, ...RELEASE_SHAPE.directories]) {
    test(`a release without ${missing} is refused and the selected links stay as they were`, async () => {
      const fixture = await makeAtomicSurface()
      const before = await selectedLinks(fixture.paths)
      const releasesBefore = await readdir(fixture.paths.releaseRoot)
      await expect(
        installAtomicRelease({
          context: 'main',
          linkMode: 'on',
          paths: fixture.paths,
          sourceRoot: fixture.sourceRoot,
          releaseId: 'release-incomplete',
          readRunningRelease: () => ({ answered: true }),
          prepareRelease: async (path) => {
            await writeRelease(path, 'incomplete', [missing])
            return fixtureBuilds()
          },
        })
      ).rejects.toThrow(`prepared release is missing ${missing}`)
      expect(await selectedLinks(fixture.paths)).toEqual(before)
      expect(await readdir(fixture.paths.releaseRoot)).toEqual(releasesBefore)
      expect(invokeInstalled(fixture.binPath).stdout).toBe('old:dependency-ok\n')
    })
  }

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
      readRunningRelease: () => ({ answered: true }),
      prepareRelease: async (releasePath) => {
        await writeRelease(releasePath, 'new', RELEASE_SHAPE.executables)
        signalPreparationStarted()
        await preparationMayFinish
        await writeRelease(releasePath, 'new')
        return fixtureBuilds()
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
    const manifest = JSON.parse(
      await readFile(join(installedRelease, 'praesidium-release.json'), 'utf8')
    )
    expect(Object.keys(manifest)).toEqual([
      'schema',
      'releaseId',
      'hrcBuild',
      'aspContracts',
      'installedAt',
    ])
    expect(manifest.releaseId).toBe('release-new')
    expect(manifest.hrcBuild).toEqual(fixtureBuilds().hrcBuild)
    expect(manifest.aspContracts).toEqual(fixtureBuilds().aspContracts)

    expect(await readlink(fixture.binPath)).toBe(join(fixture.paths.currentLink, 'bin', 'rusthrc'))
    expect(await realpath(fixture.binPath)).toBe(
      await realpath(join(fixture.paths.binDir, 'rusthrc'))
    )
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
        readRunningRelease: () => ({ answered: true }),
        prepareRelease: async (releasePath) => {
          await writeRelease(releasePath, 'broken')
          throw new Error('deterministic preparation failure')
        },
      })
    ).rejects.toThrow('deterministic preparation failure')

    expect(await realpath(fixture.paths.currentLink)).toBe(await realpath(fixture.oldRelease))
    expect(await readdir(fixture.paths.releaseRoot)).toEqual(['release-old'])
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
      readRunningRelease: () => ({ answered: true }),
      prepareRelease: async (releasePath) => {
        signalOwnerReady()
        await ownerMayFinish
        await writeRelease(releasePath, 'owner')
        return fixtureBuilds()
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
        readRunningRelease: () => ({ answered: true }),
        prepareRelease: async (releasePath) => {
          await writeRelease(releasePath, 'racer')
          return fixtureBuilds()
        },
      })
    ).rejects.toThrow('install already in progress')
    expect(invokeInstalled(fixture.binPath).stdout).toBe('old:dependency-ok\n')

    allowOwnerToFinish()
    await owner
    expect(invokeInstalled(fixture.binPath).stdout).toBe('owner:dependency-ok\n')
  })
})

// T-10024: install deletes old releases outright after its cutover.
describe('T-10024 install prunes old releases', () => {
  async function installWith(answer: (paths: InstalledSurfacePaths) => RunningReleaseAnswer) {
    const fixture = await makeAtomicSurface()
    for (const id of ['release-older', 'release-oldest']) {
      await writeRelease(join(fixture.paths.releaseRoot, id), id)
    }
    await mkdir(join(fixture.paths.releaseRoot, '.gc-quarantine', 'release-quarantined'), {
      recursive: true,
    })
    const installed = await installAtomicRelease({
      context: 'main',
      linkMode: 'on',
      paths: fixture.paths,
      releaseId: 'release-new',
      sourceRoot: fixture.sourceRoot,
      readRunningRelease: (releasePath) => {
        // The daemon is asked only once the link already names the new release.
        expect(realpathSync(fixture.paths.currentLink)).toBe(realpathSync(releasePath))
        return answer(fixture.paths)
      },
      prepareRelease: async (releasePath) => {
        await writeRelease(releasePath, 'new')
        return fixtureBuilds()
      },
    })
    return { fixture, installed }
  }

  test('keeps current and the release the running daemon reports', async () => {
    const { fixture } = await installWith((paths) => ({
      answered: true,
      releasePath: join(paths.releaseRoot, 'release-old'),
    }))
    expect((await readdir(fixture.paths.releaseRoot)).sort()).toEqual([
      'release-new',
      'release-old',
    ])
    expect(invokeInstalled(fixture.binPath).stdout).toBe('new:dependency-ok\n')
  })

  test('a daemon that is not running leaves only current, quarantine debris included', async () => {
    const { fixture } = await installWith(() => ({ answered: true }))
    expect(await readdir(fixture.paths.releaseRoot)).toEqual(['release-new'])
    expect(await realpath(fixture.paths.currentLink)).toBe(
      await realpath(join(fixture.paths.releaseRoot, 'release-new'))
    )
  })

  test('a daemon status with no answer prunes nothing', async () => {
    // The daemon may be alive and running from any old tree; deleting on a
    // guess could pull files out from under its lazy imports.
    const { fixture } = await installWith(() => ({ answered: false, detail: 'timed out' }))
    expect((await readdir(fixture.paths.releaseRoot)).sort()).toEqual([
      '.gc-quarantine',
      'release-new',
      'release-old',
      'release-older',
      'release-oldest',
    ])
  })
})
