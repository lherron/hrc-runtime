import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  type AspContractPackage,
  type PraesidiumBuild,
  type PraesidiumReleaseManifest,
  environmentWithoutGitOverrides,
  resolveDatabasePath,
} from 'hrc-core'
import { DIRECT_STORE_OPEN_COMMANDS, readStoreSchemaState } from 'hrc-store-sqlite'

import type { InstallContext, PublicationMode, SideEffectMode } from './install-policy'
import { acquireInstallLock } from './lib/install-lock'
import { ASP_CONTRACT_PACKAGE_NAMES, readInstalledAspContracts } from './lib/praesidium-build'
import {
  type PublicationSource,
  createPraesidiumBuild,
  provePublicationSource,
  timestampVersion,
} from './publish-local-verdaccio'

export { acquireInstallLock } from './lib/install-lock'

export const CLI_PACKAGES = {
  'hrc-cli': { bin: 'hrc', entrypoint: 'src/cli.ts', helpExitCode: 0 },
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
  prepareRelease: (releasePath: string) => Promise<PreparedReleaseBuilds>
  releaseId?: string
  sourceRoot: string
}

export type PreparedReleaseBuilds = {
  hrcBuild: PraesidiumBuild
  aspContracts: AspContractPackage[]
}

type CliOptions = {
  context: InstallContext
  linkMode: SideEffectMode
  publicationMode: PublicationMode
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
    // A DANGLING link carries no release root. Pre-split leftovers exist in the
    // wild (`hrc-server -> agent-spaces/packages/hrc-server`, from before the
    // repo split), and `realpath` throws ENOENT on one — which would turn a
    // bootstrap install into a hard failure over an artifact the very next
    // `installLinks` replaces.
    let packageRoot: string
    try {
      packageRoot = await realpath(packageLink)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
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

function expectExactFields(
  value: unknown,
  expectedFields: string[],
  context: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`)
  }
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expectedFields.length ||
    actual.some((field, index) => field !== expectedFields[index])
  ) {
    throw new Error(`${context} must contain exactly ${expectedFields.join(', ')}`)
  }
}

function expectBuildTuple(
  value: unknown,
  repository: string,
  setName: 'asp' | 'hrc'
): asserts value is PraesidiumBuild {
  expectExactFields(
    value,
    [
      'schema',
      'repository',
      'canonicalRemote',
      'sourceCommit',
      'setName',
      'setVersion',
      'builtAt',
    ].sort(),
    `${setName} build`
  )
  if (
    value['schema'] !== 1 ||
    value['repository'] !== repository ||
    value['setName'] !== setName ||
    typeof value['canonicalRemote'] !== 'string' ||
    value['canonicalRemote'] === '' ||
    typeof value['sourceCommit'] !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(value['sourceCommit']) ||
    typeof value['setVersion'] !== 'string' ||
    value['setVersion'] === '' ||
    typeof value['builtAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['builtAt']))
  ) {
    throw new Error(`${setName} build is not a valid normative provenance tuple`)
  }
}

/** The manifest names exactly the thin ASP contract set, with installed versions. */
function expectAspContracts(value: unknown): asserts value is AspContractPackage[] {
  if (!Array.isArray(value) || value.length !== ASP_CONTRACT_PACKAGE_NAMES.length) {
    throw new Error(
      `release manifest aspContracts must list exactly ${ASP_CONTRACT_PACKAGE_NAMES.join(', ')}`
    )
  }
  const names = new Set<string>()
  for (const [index, entry] of value.entries()) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as { name?: unknown }).name !== 'string' ||
      ((entry as { name?: unknown }).name as string).trim() === '' ||
      typeof (entry as { version?: unknown }).version !== 'string' ||
      ((entry as { version?: unknown }).version as string).trim() === ''
    ) {
      throw new Error(`release manifest aspContracts[${index}] must be {name, version}`)
    }
    names.add((entry as { name?: unknown }).name as string)
  }
  for (const expected of ASP_CONTRACT_PACKAGE_NAMES) {
    if (!names.has(expected)) {
      throw new Error(`release manifest aspContracts is missing ${expected}`)
    }
  }
}

async function validateReleaseShape(releasePath: string, releaseId: string): Promise<void> {
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

  const manifestPath = join(releasePath, 'praesidium-release.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  expectExactFields(
    manifest,
    ['schema', 'releaseId', 'hrcBuild', 'aspContracts', 'installedAt'].sort(),
    'release manifest'
  )
  if (manifest['schema'] !== 1) throw new Error('release manifest schema must be 1')
  if (manifest['releaseId'] !== releaseId) {
    throw new Error(`release manifest ID must be ${releaseId}`)
  }
  if (
    typeof manifest['installedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(manifest['installedAt']))
  ) {
    throw new Error('release manifest installedAt must be an ISO timestamp')
  }
  expectBuildTuple(manifest['hrcBuild'], 'hrc-runtime', 'hrc')
  expectAspContracts(manifest['aspContracts'])
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
    const builds = await options.prepareRelease(releasePath)
    const manifest: PraesidiumReleaseManifest = {
      schema: 1,
      releaseId,
      hrcBuild: builds.hrcBuild,
      aspContracts: builds.aspContracts,
      installedAt: new Date().toISOString(),
    }
    await writeFile(
      join(releasePath, 'praesidium-release.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    await validateReleaseShape(releasePath, releaseId)
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
  env: Record<string, string | undefined> = process.env,
  expectedExitCode = 0
): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== expectedExitCode) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${exitCode}; expected ${expectedExitCode}`
    )
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

async function copyCanonicalSourceSnapshot(
  sourceRoot: string,
  releasePath: string,
  sourceCommit: string
): Promise<void> {
  const archiveRoot = await mkdtemp(join(tmpdir(), 'hrc-canonical-source-'))
  const archivePath = join(archiveRoot, 'source.tar')
  try {
    await runCommand(
      'git',
      ['archive', '--format=tar', `--output=${archivePath}`, sourceCommit],
      sourceRoot,
      environmentWithoutGitOverrides()
    )
    await runCommand('tar', ['-xf', archivePath, '-C', releasePath], sourceRoot)
  } finally {
    await rm(archiveRoot, { recursive: true, force: true })
  }
}

async function releaseBuildVersion(
  sourceRoot: string,
  publicationMode: PublicationMode
): Promise<string> {
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  const gitResult = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: environmentWithoutGitOverrides(),
  })
  if (gitResult.status !== 0 || !gitResult.stdout.trim()) {
    throw new Error(`cannot resolve worktree publish SHA: ${gitResult.stderr || gitResult.stdout}`)
  }
  return timestampVersion(
    manifest.version,
    publicationMode === 'worktree' ? 'worktree' : 'dev',
    new Date(),
    gitResult.stdout.trim()
  )
}

async function prepareProductionRelease(
  releasePath: string,
  options: Pick<CliOptions, 'publicationMode' | 'sourceRoot'>,
  source: PublicationSource
): Promise<PreparedReleaseBuilds> {
  if (options.publicationMode === 'worktree') {
    await copySourceSnapshot(options.sourceRoot, releasePath)
  } else {
    // A local main-checkout install is a commit-only candidate. It may be
    // unpushed, but its bytes must still come from the recorded HEAD rather
    // than an untracked or modified file next to it.
    await copyCanonicalSourceSnapshot(options.sourceRoot, releasePath, source.sourceCommit)
  }
  await runCommand('bun', ['install', '--frozen-lockfile'], releasePath)
  await runCommand('bun', ['run', 'clean'], releasePath)
  await runCommand('bun', ['run', 'build'], releasePath)

  for (const [packageName, cli] of Object.entries(CLI_PACKAGES)) {
    await runCommand(
      join(releasePath, 'packages', packageName, cli.entrypoint),
      ['--help'],
      releasePath,
      process.env,
      cli.helpExitCode
    )
  }

  return {
    hrcBuild: createPraesidiumBuild({
      canonicalRemote: source.canonicalRemote,
      sourceCommit: source.sourceCommit,
      setVersion: await releaseBuildVersion(options.sourceRoot, options.publicationMode),
      builtAt: new Date().toISOString(),
    }),
    aspContracts: await readInstalledAspContracts(releasePath),
  }
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
    if (options.publicationMode === 'worktree') {
      await runCommand(
        'bun',
        ['scripts/publish-local-verdaccio.ts', '--channel', 'worktree'],
        options.sourceRoot
      )
    }
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
  const publicationMode = values.get('publication-mode')
  const sourceRoot = resolve(values.get('source-root') ?? process.cwd())
  if (context !== 'main' && context !== 'linked-worktree') {
    throw new Error(`invalid --context: ${context ?? '(missing)'}`)
  }
  if (linkMode !== 'on' && linkMode !== 'off' && linkMode !== 'forced') {
    throw new Error(`invalid --link-mode: ${linkMode ?? '(missing)'}`)
  }
  if (publicationMode !== 'none' && publicationMode !== 'worktree') {
    throw new Error(`invalid --publication-mode: ${publicationMode ?? '(missing)'}`)
  }
  return { context, linkMode, publicationMode, sourceRoot }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  const paths = defaultInstalledSurfacePaths()
  console.log(
    `[install] concurrency lock=${paths.lockDir} link=${options.linkMode} publication=${options.publicationMode}`
  )

  if (options.linkMode === 'off') {
    await runUnlinkedInstall(options, paths)
    console.log('[install] linked-worktree install complete; global HRC wrappers unchanged')
    return
  }

  const publicationSource = provePublicationSource({
    canonical: false,
    root: options.sourceRoot,
  })
  let builds: PreparedReleaseBuilds | undefined
  const releasePath = await installAtomicRelease({
    context: options.context,
    linkMode: options.linkMode,
    paths,
    sourceRoot: options.sourceRoot,
    prepareRelease: async (path) => {
      builds = await prepareProductionRelease(path, options, publicationSource)
      return builds
    },
  })
  if (options.publicationMode === 'worktree') {
    const build = builds?.hrcBuild
    if (build === undefined) throw new Error('worktree release has no HRC build tuple')
    await runCommand(
      'bun',
      ['scripts/publish-local-verdaccio.ts', '--channel', 'worktree'],
      releasePath,
      {
        ...process.env,
        HRC_PUBLISH_SOURCE_ROOT: options.sourceRoot,
        HRC_PUBLISH_EXPECTED_SOURCE_COMMIT: build.sourceCommit,
        HRC_PUBLISH_BUILT_AT: build.builtAt,
        HRC_PUBLISH_VERSION: build.setVersion,
      }
    )
  }
  console.log(`[install] atomic HRC CLI cutover complete: ${releasePath}`)
  for (const line of schemaArmedWindowLines()) console.log(line)
}

/**
 * The install→restart armed window (T-08118). The CLI surface is now this
 * release; the daemon still runs the previous one against a store at the
 * previous schema. The direct-open commands refuse until the restart, so say so
 * here rather than letting the operator meet the refusal cold.
 *
 * Returns lines rather than printing them so both states — armed and quiet —
 * are assertable. A warning that is emitted in every state teaches the reader
 * to skip it.
 */
export function schemaArmedWindowLines(dbPath: string = resolveDatabasePath()): string[] {
  const schema = readStoreSchemaState(dbPath)
  if (!schema.readable) {
    return [`[install] store schema: unreadable (${schema.error ?? 'unknown'})`]
  }
  if (!schema.schemaAhead) {
    return [`[install] store schema: ${schema.storeVersion ?? '(none)'} matches running`]
  }
  return [
    `[install] store schema: ${schema.storeVersion ?? '(none)'} differs from running — this release carries ${schema.pending.length} unapplied migration(s) (through ${schema.releaseVersion}).`,
    '[install] run `hrc server restart` to apply them. Until then these refuse:',
    ...DIRECT_STORE_OPEN_COMMANDS.map((command) => `[install]   ${command}`),
  ]
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
