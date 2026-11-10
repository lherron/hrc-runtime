import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
  pruneReleaseDirs,
  resolveDatabasePath,
} from 'hrc-core'

import type { InstallContext, PublicationMode, SideEffectMode } from './install-policy'
import { acquireInstallLock } from './lib/install-lock'
import { prepareNativeRelease } from './lib/native-release'
import { ASP_CONTRACT_PACKAGE_NAMES, readInstalledAspContracts } from './lib/praesidium-build'
import {
  type PublicationSource,
  createPraesidiumBuild,
  provePublicationSource,
  timestampVersion,
} from './publish-local-verdaccio'

export { acquireInstallLock } from './lib/install-lock'

/**
 * What a prepared release must hold before it can be selected, besides the
 * release manifest. `hrc` and `rusthrc` both resolve to `bin/rusthrc`;
 * `hrc-pty` is the per-seat supervisor rusthrc starts from beside itself.
 * `node_modules` serves the retained TypeScript packages (publication and the
 * owner stage's retention step import them from the release).
 */
export const RELEASE_SHAPE = {
  executables: ['bin/rusthrc', 'bin/hrc-pty'],
  directories: ['node_modules'],
} as const

/**
 * Every command that opens the store directly instead of going over the socket,
 * and therefore refuses while the store's applied migrations differ from the
 * installed release's (T-08118): `hrc monitor show/watch/wait` open the
 * daemon-reported dbPath through `Store::open_readonly`, whose admission
 * refuses a missing or unknown migration (crates/hrc-store/src/lib.rs).
 * Copy-pasteable command paths.
 */
export const DIRECT_STORE_OPEN_COMMANDS = [
  'hrc monitor show',
  'hrc monitor watch',
  'hrc monitor wait',
] as const

export type InstalledSurfacePaths = {
  binDir: string
  currentLink: string
  /** Only to remove the Bun `hrc-cli` package link earlier installs created. */
  globalModules: string
  lockDir: string
  releaseRoot: string
}

/**
 * What the running daemon says about its own release, read after the cutover.
 * `answered: false` means status gave no usable answer at all — not the same as
 * a clean "not running", which arrives as `answered: true` with no path.
 */
export type RunningReleaseAnswer =
  | { answered: true; releasePath?: string }
  | { answered: false; detail: string }

export type AtomicInstallOptions = {
  context: InstallContext
  linkMode: SideEffectMode
  paths: InstalledSurfacePaths
  prepareRelease: (releasePath: string) => Promise<PreparedReleaseBuilds>
  /** Asked after the cutover so the running daemon's tree survives the prune. */
  readRunningRelease: (releasePath: string) => RunningReleaseAnswer
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
  for (const executable of RELEASE_SHAPE.executables) {
    const path = join(releasePath, executable)
    if ((await pathKind(path)) === 'missing') {
      throw new Error(`prepared release is missing ${executable}`)
    }
    await chmod(path, 0o755)
  }
  for (const directory of RELEASE_SHAPE.directories) {
    if ((await pathKind(join(releasePath, directory))) === 'missing') {
      throw new Error(`prepared release is missing ${directory}`)
    }
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
 * Point `hrc` and `rusthrc` at `currentLink/bin/rusthrc`, whatever they named
 * before (a Bun `packages/hrc-cli` entrypoint of an older release included).
 * Once bootstrapped, every future release is one atomic rename of
 * `currentLink`. A missing `currentLink` starts at the checkout until the
 * cutover replaces it.
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
    await atomicSymlink(sourceRoot, paths.currentLink)
  } else {
    await realpath(paths.currentLink)
  }

  for (const bin of ['hrc', 'rusthrc']) {
    await atomicSymlink(join(paths.currentLink, 'bin', 'rusthrc'), join(paths.binDir, bin))
  }

  // Earlier installs linked the Bun CLI package here through currentLink. The
  // release no longer selects it, so remove that link and only that link.
  const legacyPackageLink = join(paths.globalModules, 'hrc-cli')
  if (
    (await pathKind(legacyPackageLink)) === 'symlink' &&
    (await readlink(legacyPackageLink)) === join(paths.currentLink, 'packages', 'hrc-cli')
  ) {
    await rm(legacyPackageLink)
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
    // Still under the install lock, so no other install is preparing a release.
    await pruneAfterCutover(options, releasePath)
    return releasePath
  } finally {
    if (!cutoverComplete && releaseCreated) {
      await rm(releasePath, { recursive: true, force: true })
    }
    await releaseLock()
  }
}

/**
 * Keep current and the release the running daemon reports; delete every other
 * release (T-10024). A daemon that cleanly reports "not running" keeps nothing
 * extra. A status that gives no answer at all prunes nothing: the daemon may be
 * alive and running from an old tree, and its own startup prune clears the
 * leftovers once it runs from current. The cutover already succeeded, so a
 * prune failure is reported and never fails the install.
 */
async function pruneAfterCutover(options: AtomicInstallOptions, releasePath: string) {
  try {
    const running = options.readRunningRelease(releasePath)
    if (!running.answered) {
      console.log(
        `[install] release prune skipped: daemon status gave no answer (${running.detail}); old releases are left for the daemon's startup prune`
      )
      return
    }
    const result = await pruneReleaseDirs({
      releaseRoot: options.paths.releaseRoot,
      currentLink: options.paths.currentLink,
      expectedCurrent: releasePath,
      keep: running.releasePath === undefined ? [] : [running.releasePath],
    })
    if (!result.pruned) {
      console.log(`[install] release prune skipped: ${result.reason}`)
      return
    }
    const held = Object.entries(result.heldBy).map(([id, pids]) => `${id} (pid ${pids.join(', ')})`)
    console.log(
      `[install] release prune: kept ${result.kept.join(', ')}; removed ${result.removed.length}${
        held.length > 0 ? `; held by live processes ${held.join(', ')}` : ''
      }${result.failed.length > 0 ? `; failed ${result.failed.join(', ')}` : ''}`
    )
  } catch (error) {
    console.log(
      `[install] release prune failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Ask the running daemon, through the just-installed CLI, which release it runs from. */
export function readRunningReleaseFromDaemon(releasePath: string): RunningReleaseAnswer {
  const cli = join(releasePath, 'bin', 'rusthrc')
  const result = spawnSync(cli, ['server', 'status', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  if (result.error !== undefined) return { answered: false, detail: result.error.message }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout ?? '')
  } catch {
    return { answered: false, detail: `unparseable status (exit ${result.status})` }
  }
  if (parsed === null || typeof parsed !== 'object' || !('running' in parsed)) {
    return { answered: false, detail: 'status has no running field' }
  }
  const status = parsed as { running?: unknown; release?: unknown }
  if (typeof status.running !== 'boolean') {
    return { answered: false, detail: 'status running is not a boolean' }
  }
  if (!status.running) return { answered: true }
  const release = status.release as { mode?: unknown; releasePath?: unknown } | null | undefined
  // From the daemon's own captured identity, never derived from the symlink.
  if (release?.mode === 'atomic' && typeof release.releasePath === 'string') {
    return { answered: true, releasePath: release.releasePath }
  }
  // A running daemon with no atomic identity runs from a checkout, not a release.
  return { answered: true }
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
      '--exclude=/crates/target/',
      '--exclude=__pycache__/',
      '--exclude=*.tsbuildinfo',
      '--exclude=default.profraw',
      `${sourceRoot}/`,
      `${releasePath}/`,
    ],
    sourceRoot
  )
}

export async function copyCanonicalSourceSnapshot(
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
    // Commit timestamps can predate a cached Cargo artifact from another
    // snapshot. Use extraction time so changed selected inputs invalidate it.
    await runCommand('tar', ['-m', '-xf', archivePath, '-C', releasePath], sourceRoot)
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
  const hrcBuild = createPraesidiumBuild({
    canonicalRemote: source.canonicalRemote,
    sourceCommit: source.sourceCommit,
    setVersion: await releaseBuildVersion(options.sourceRoot, options.publicationMode),
    builtAt: new Date().toISOString(),
  })
  const aspContracts = await readInstalledAspContracts(releasePath)
  // The Rust release reads its source identity from this manifest (native-release
  // input digest, hrc-native build.rs), because a release snapshot has no .git.
  // installAtomicRelease rewrites it with the final installedAt after preparation.
  await writeFile(
    join(releasePath, 'praesidium-release.json'),
    `${JSON.stringify(
      {
        schema: 1,
        releaseId: basename(releasePath),
        hrcBuild,
        aspContracts,
        installedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  )
  await prepareNativeRelease(
    options.sourceRoot,
    releasePath,
    defaultInstalledSurfacePaths().currentLink,
    runCommand
  )

  return { hrcBuild, aspContracts }
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
    readRunningRelease: readRunningReleaseFromDaemon,
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
  for (const line of schemaArmedWindowLines(join(releasePath, 'bin', 'rusthrc'))) console.log(line)
}

/**
 * The install→restart armed window (T-08118). The CLI surface is now this
 * release; the daemon still runs the previous one against a store at the
 * previous schema, and migrates it when it next boots this release. The
 * direct-open commands refuse until the restart, so say so here rather than
 * letting the operator meet the refusal cold.
 *
 * The reading comes from `rusthrc` of the release just selected (`rusthrc
 * store state`, read-only, no store lock): the build whose migration registry
 * the next boot applies, so "pending" means exactly what that boot will do. A
 * store from a newer release reads `ahead`, which that boot refuses.
 *
 * Returns lines rather than printing them so every state is assertable. A
 * warning that is emitted in every state teaches the reader to skip it. Never
 * throws: the cutover has already happened.
 */
export function schemaArmedWindowLines(
  rusthrc: string,
  dbPath: string = resolveDatabasePath()
): string[] {
  const result = spawnSync(rusthrc, ['store', 'state', dbPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  let reading: {
    state?: unknown
    releaseVersion?: unknown
    pending?: unknown
    unknown?: unknown
    missing?: unknown
    error?: unknown
  }
  try {
    if (result.error !== undefined) throw result.error
    reading = JSON.parse(result.stdout ?? '')
    if (reading === null || typeof reading !== 'object') throw new Error('not an object')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [
      `[install] store schema: unreadable (${rusthrc} store state gave no reading: ${detail}; exit ${result.status})`,
    ]
  }
  const release = String(reading.releaseVersion ?? '(unknown)')
  const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])
  switch (reading.state) {
    case 'current':
      return [`[install] store schema: ${release} matches running`]
    case 'pending': {
      const pending = ids(reading.pending)
      return [
        `[install] store schema: differs from running — this release carries ${pending.length} unapplied migration(s) (through ${release}): ${pending.join(', ')}.`,
        '[install] run `hrc server restart` to apply them. Until then these refuse:',
        ...DIRECT_STORE_OPEN_COMMANDS.map((command) => `[install]   ${command}`),
      ]
    }
    case 'ahead':
      return [
        `[install] store schema: ahead of this release (${release}); it carries migration(s) this release does not know: ${ids(reading.unknown).join(', ')}. This release's daemon refuses that store at its next boot.`,
      ]
    case 'absent':
      return [`[install] store schema: unreadable (store not found at ${dbPath})`]
    case 'unreadable':
      return [`[install] store schema: unreadable (${String(reading.error ?? 'unknown')})`]
    case 'below_baseline':
      return [
        `[install] store schema: below this release's baseline; missing ${ids(reading.missing).join(', ')}`,
      ]
    case 'not_hrc':
      return [`[install] store schema: ${dbPath} is not an HRC store`]
    default:
      return [`[install] store schema: unreadable (unknown state ${JSON.stringify(reading.state)})`]
  }
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
