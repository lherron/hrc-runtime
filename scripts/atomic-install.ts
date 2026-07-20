import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { InstallContext, PublishChannel, SideEffectMode } from './install-policy'
import { timestampVersion } from './publish-local-verdaccio'

const CLI_PACKAGES = {
  'hrc-cli': { bin: 'hrc', entrypoint: 'src/cli.ts' },
  'hrcchat-cli': { bin: 'hrcchat', entrypoint: 'src/main.ts' },
} as const

type CliPackageName = keyof typeof CLI_PACKAGES

export type InstalledSurfacePaths = {
  binDir: string
  currentLink: string
  globalModules: string
  lockDir: string
  releaseRoot: string
}

export type AtomicInstallOptions = {
  context: InstallContext
  linkMode: SideEffectMode
  paths: InstalledSurfacePaths
  prepareRelease: (releasePath: string) => Promise<void>
  releaseId?: string
  sourceRoot: string
}

type CliOptions = {
  context: InstallContext
  linkMode: SideEffectMode
  publishChannel: PublishChannel
  sourceRoot: string
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

async function pathKind(path: string): Promise<'missing' | 'symlink' | 'other'> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'symlink' : 'other'
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  const kind = await pathKind(linkPath)
  if (kind === 'other') {
    throw new Error(`refusing to replace non-symlink installed path: ${linkPath}`)
  }

  await mkdir(dirname(linkPath), { recursive: true })
  const temporary = join(
    dirname(linkPath),
    `.${basename(linkPath)}.next-${process.pid}-${randomUUID()}`
  )
  try {
    await symlink(target, temporary)
    await rename(temporary, linkPath)
  } finally {
    await rm(temporary, { force: true })
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function existingInstalledRoot(paths: InstalledSurfacePaths): Promise<string | undefined> {
  const roots: string[] = []
  for (const packageName of Object.keys(CLI_PACKAGES) as CliPackageName[]) {
    const packageLink = join(paths.globalModules, packageName)
    if ((await pathKind(packageLink)) === 'missing') continue
    if ((await pathKind(packageLink)) !== 'symlink') {
      throw new Error(`installed package path is not a symlink: ${packageLink}`)
    }
    const packageRoot = await realpath(packageLink)
    if (basename(packageRoot) !== packageName || basename(dirname(packageRoot)) !== 'packages') {
      throw new Error(
        `cannot derive an HRC release root from installed link ${packageLink} -> ${packageRoot}`
      )
    }
    roots.push(dirname(dirname(packageRoot)))
  }

  const unique = [...new Set(roots)]
  if (unique.length > 1) {
    throw new Error(
      `installed HRC package links disagree on their release root: ${unique.join(', ')}`
    )
  }
  return unique[0]
}

async function validateReleaseShape(releasePath: string): Promise<void> {
  for (const [packageName, cli] of Object.entries(CLI_PACKAGES)) {
    const entrypoint = join(releasePath, 'packages', packageName, cli.entrypoint)
    const nodeModules = join(releasePath, 'node_modules')
    if ((await pathKind(entrypoint)) === 'missing') {
      throw new Error(`prepared release is missing ${relative(releasePath, entrypoint)}`)
    }
    if ((await pathKind(nodeModules)) === 'missing') {
      throw new Error('prepared release is missing node_modules')
    }
    await chmod(entrypoint, 0o755)
  }
}

/**
 * Convert Bun's direct checkout links into stable indirections without changing
 * what is currently installed. Once bootstrapped, every future release is one
 * atomic rename of `currentLink`.
 */
export async function bootstrapInstalledSurface(
  paths: InstalledSurfacePaths,
  sourceRoot: string
): Promise<void> {
  const currentKind = await pathKind(paths.currentLink)
  if (currentKind === 'other') {
    throw new Error(`installed current path is not a symlink: ${paths.currentLink}`)
  }
  if (currentKind === 'missing') {
    const bootstrapRoot = (await existingInstalledRoot(paths)) ?? sourceRoot
    await atomicSymlink(bootstrapRoot, paths.currentLink)
  } else {
    await realpath(paths.currentLink)
  }

  for (const [packageName, cli] of Object.entries(CLI_PACKAGES)) {
    await atomicSymlink(
      join(paths.currentLink, 'packages', packageName),
      join(paths.globalModules, packageName)
    )
    await atomicSymlink(
      join(paths.globalModules, packageName, cli.entrypoint),
      join(paths.binDir, cli.bin)
    )
  }
}

export async function acquireInstallLock(
  lockDir: string,
  sourceRoot: string
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true })
  try {
    await mkdir(lockDir)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const owner = await readFile(join(lockDir, 'owner.json'), 'utf8').catch(
      () => 'owner unavailable'
    )
    throw new Error(`install already in progress; lock ${lockDir} is held (${owner.trim()})`)
  }

  const token = randomUUID()
  await writeFile(
    join(lockDir, 'owner.json'),
    JSON.stringify({ token, pid: process.pid, sourceRoot, startedAt: new Date().toISOString() })
  )

  return async () => {
    const owner = await readFile(join(lockDir, 'owner.json'), 'utf8').catch(() => '')
    if (owner && !owner.includes(token)) {
      throw new Error(
        `refusing to release an install lock now owned by another process: ${lockDir}`
      )
    }
    await rm(lockDir, { recursive: true })
  }
}

/** Production lifecycle plus a dependency-injected preparation hook for the live harness. */
export async function installAtomicRelease(options: AtomicInstallOptions): Promise<string> {
  const sourceRoot = resolve(options.sourceRoot)
  const releaseId =
    options.releaseId ?? `release-${new Date().toISOString().replace(/\D/g, '')}-${process.pid}`
  if (!/^release-[A-Za-z0-9._-]+$/.test(releaseId)) {
    throw new Error(`invalid release id: ${releaseId}`)
  }

  const releasePath = join(options.paths.releaseRoot, releaseId)
  if (
    !isWithin(options.paths.releaseRoot, releasePath) ||
    releasePath === options.paths.releaseRoot
  ) {
    throw new Error(`release path escaped release root: ${releasePath}`)
  }

  const releaseLock = await acquireInstallLock(options.paths.lockDir, sourceRoot)
  let cutoverComplete = false
  let releaseCreated = false
  try {
    await bootstrapInstalledSurface(options.paths, sourceRoot)
    await mkdir(options.paths.releaseRoot, { recursive: true })
    await mkdir(releasePath)
    releaseCreated = true
    await options.prepareRelease(releasePath)
    await validateReleaseShape(releasePath)
    await atomicSymlink(releasePath, options.paths.currentLink)
    cutoverComplete = true
    return releasePath
  } finally {
    if (!cutoverComplete && releaseCreated) {
      await rm(releasePath, { recursive: true, force: true })
    }
    await releaseLock()
  }
}

export function defaultInstalledSurfacePaths(): InstalledSurfacePaths {
  const bunInstallRoot = join(homedir(), '.bun', 'install')
  return {
    binDir: join(homedir(), '.bun', 'bin'),
    currentLink: join(bunInstallRoot, 'hrc-runtime-current'),
    globalModules: join(bunInstallRoot, 'global', 'node_modules'),
    lockDir: join(bunInstallRoot, 'hrc-runtime-install.lock'),
    releaseRoot: join(bunInstallRoot, 'hrc-runtime-releases'),
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}`)
  }
}

async function copySourceSnapshot(sourceRoot: string, releasePath: string): Promise<void> {
  await runCommand(
    'rsync',
    [
      '-a',
      '--exclude=/.git/',
      '--exclude=/node_modules/',
      '--exclude=node_modules/',
      '--exclude=dist/',
      '--exclude=coverage/',
      '--exclude=*.tsbuildinfo',
      '--exclude=default.profraw',
      `${sourceRoot}/`,
      `${releasePath}/`,
    ],
    sourceRoot
  )
}

async function worktreePublishVersion(sourceRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  const gitResult = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  })
  if (gitResult.status !== 0 || !gitResult.stdout.trim()) {
    throw new Error(`cannot resolve worktree publish SHA: ${gitResult.stderr || gitResult.stdout}`)
  }
  return timestampVersion(manifest.version, 'worktree', new Date(), gitResult.stdout.trim())
}

async function prepareProductionRelease(
  releasePath: string,
  options: Pick<CliOptions, 'publishChannel' | 'sourceRoot'>
): Promise<void> {
  await copySourceSnapshot(options.sourceRoot, releasePath)
  await runCommand('bun', ['install', '--frozen-lockfile'], releasePath)
  await runCommand('bun', ['run', 'clean'], releasePath)
  await runCommand('bun', ['run', 'build'], releasePath)

  for (const [packageName, cli] of Object.entries(CLI_PACKAGES)) {
    await runCommand(
      join(releasePath, 'packages', packageName, cli.entrypoint),
      ['--help'],
      releasePath
    )
  }

  const publishArgs = ['scripts/publish-local-verdaccio.ts']
  const publishEnv = { ...process.env }
  if (options.publishChannel === 'worktree') {
    publishArgs.push('--channel', 'worktree')
    publishEnv.HRC_PUBLISH_VERSION = await worktreePublishVersion(options.sourceRoot)
  }
  await runCommand('bun', publishArgs, releasePath, publishEnv)
}

async function runUnlinkedInstall(
  options: CliOptions,
  paths: InstalledSurfacePaths
): Promise<void> {
  const releaseLock = await acquireInstallLock(paths.lockDir, options.sourceRoot)
  try {
    await runCommand('bun', ['install', '--frozen-lockfile'], options.sourceRoot)
    await runCommand('bun', ['run', 'clean'], options.sourceRoot)
    await runCommand('bun', ['run', 'build'], options.sourceRoot)
    const publishArgs = ['scripts/publish-local-verdaccio.ts']
    if (options.publishChannel === 'worktree') publishArgs.push('--channel', 'worktree')
    await runCommand('bun', publishArgs, options.sourceRoot)
  } finally {
    await releaseLock()
  }
}

function parseCli(argv: string[]): CliOptions {
  const values = new Map<string, string>()
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (!match) throw new Error(`expected --name=value, received: ${arg}`)
    const [, name, value] = match
    if (name === undefined || value === undefined) throw new Error(`invalid option: ${arg}`)
    values.set(name, value)
  }

  const context = values.get('context')
  const linkMode = values.get('link-mode')
  const publishChannel = values.get('publish-channel')
  const sourceRoot = resolve(values.get('source-root') ?? process.cwd())
  if (context !== 'main' && context !== 'linked-worktree') {
    throw new Error(`invalid --context: ${context ?? '(missing)'}`)
  }
  if (linkMode !== 'on' && linkMode !== 'off' && linkMode !== 'forced') {
    throw new Error(`invalid --link-mode: ${linkMode ?? '(missing)'}`)
  }
  if (publishChannel !== 'dev' && publishChannel !== 'worktree') {
    throw new Error(`invalid --publish-channel: ${publishChannel ?? '(missing)'}`)
  }
  return { context, linkMode, publishChannel, sourceRoot }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  const paths = defaultInstalledSurfacePaths()
  console.log(
    `[install] concurrency lock=${paths.lockDir} link=${options.linkMode} publish=${options.publishChannel}`
  )

  if (options.linkMode === 'off') {
    await runUnlinkedInstall(options, paths)
    console.log('[install] linked-worktree install complete; global HRC wrappers unchanged')
    return
  }

  const releasePath = await installAtomicRelease({
    context: options.context,
    linkMode: options.linkMode,
    paths,
    sourceRoot: options.sourceRoot,
    prepareRelease: (path) => prepareProductionRelease(path, options),
  })
  console.log(`[install] atomic HRC CLI cutover complete: ${releasePath}`)
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      `atomic-install: ${message}\natomic-install: failed installs do not replace the previous coherent HRC CLI surface.`
    )
    process.exitCode = 1
  })
}
