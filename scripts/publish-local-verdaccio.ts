import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { type PraesidiumBuild, environmentWithoutGitOverrides } from 'hrc-core'

import { acquireInstallLock } from './lib/install-lock'
import {
  documentationNoticeLine,
  parsePorcelainPaths,
  partitionInstallScope,
} from './lib/install-source-scope'
import { PRAESIDIUM_BUILD_FIELDS, parsePraesidiumBuild } from './lib/praesidium-build'
import { assertPublishContainment } from './lib/publish-containment'
import { activeRegistryUrl } from './lib/registry'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = activeRegistryUrl()

const PACKAGES = [
  'packages/agent-action-render',
  'packages/hrc-core',
  'packages/hrc-sdk',
  'packages/hrc-frame-render',
  'packages/hrc-events',
  'packages/hrc-store-sqlite',
  'packages/hrc-transcript-index',
  'packages/hrc-capture-verifier',
  'packages/hrc-server',
  // CLIs last: they consume the libraries above. Added for F-1 T-06649 — svc
  // must run installed artifacts, which requires these to be published at all.
  // hrc-capture-verifier is a runtime dep of hrc-cli; a registry install of
  // hrc-cli cannot resolve without it (devbox T-06833).
  'packages/hrc-cli',
] as const

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  praesidiumBuild?: PraesidiumBuild
}

type Options = {
  channel?: 'worktree'
  dryRun: boolean
  selectedRelease: boolean
}

type RegistryMetadata = {
  versions?: Record<
    string,
    {
      dist?: {
        tarball?: string
      }
    }
  >
  'dist-tags'?: Record<string, string>
}

let publishVersion = ''
let internalNames = new Set<string>()
let publishTag = 'latest'
let publicationBuiltAt = ''
let publicationSource: PublicationSource
let publicationBuild: PraesidiumBuild
let packageRoot = ROOT

export type PublicationSource = {
  repository: 'hrc-runtime'
  canonicalRemote: string
  sourceCommit: string
  canonicalRef: string
  canonical: boolean
}

export function createPraesidiumBuild(input: {
  canonicalRemote: string
  sourceCommit: string
  setVersion: string
  builtAt: string
}): PraesidiumBuild {
  return {
    schema: 1,
    repository: 'hrc-runtime',
    canonicalRemote: input.canonicalRemote,
    sourceCommit: input.sourceCommit,
    setName: 'hrc',
    setVersion: input.setVersion,
    builtAt: input.builtAt,
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, selectedRelease: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--selected-release') {
      options.selectedRelease = true
    } else if (arg === '--channel') {
      const value = argv[++i]
      if (value !== 'worktree') {
        throw new Error('--channel only accepts "worktree"')
      }
      options.channel = value
    } else if (arg.startsWith('--channel=')) {
      const value = arg.slice('--channel='.length)
      if (value !== 'worktree') {
        throw new Error('--channel only accepts "worktree"')
      }
      options.channel = value
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.selectedRelease === (options.channel === 'worktree')) {
    throw new Error('choose exactly one publication mode: --selected-release or --channel worktree')
  }
  return options
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/publish-local-verdaccio.ts --selected-release [--dry-run]
  bun scripts/publish-local-verdaccio.ts --channel worktree [--dry-run]

Selected-release publication is the sole canonical latest writer. It publishes
the tuple already stored in the current atomic release. Worktree publication is
isolated on the worktree tag.`)
}

function gitShortSha(): string {
  const result = run('git', ['rev-parse', '--short=12', 'HEAD'])
  return result.status === 0 && result.out.trim() ? result.out.trim() : 'nogit'
}

export function timestampVersion(
  baseVersion: string,
  channel: 'dev' | 'worktree' = 'dev',
  now = new Date(),
  shortSha = gitShortSha()
): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const base = baseVersion.split('-')[0]
  return channel === 'worktree' ? `${base}-worktree.${stamp}.${shortSha}` : `${base}-dev.${stamp}`
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number; out: string } {
  const env = cmd === 'git' ? environmentWithoutGitOverrides() : process.env
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', env })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function requiredCommandOutput(cmd: string, args: string[], cwd: string): string {
  const result = run(cmd, args, cwd)
  if (result.status !== 0 || !result.out.trim()) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.out}`)
  }
  return result.out.trim()
}

/**
 * Raw stdout, untrimmed and without stderr mixed in, for output whose leading
 * whitespace carries meaning. `git status --porcelain=v1` is exactly that: the
 * status lives in the first two COLUMNS, so a trim eats the leading space of a
 * ` M path` line and every parser downstream reads the path one character short.
 */
function requiredCommandStdout(cmd: string, args: string[], cwd: string): string {
  const env = cmd === 'git' ? environmentWithoutGitOverrides() : process.env
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', env })
  if ((result.status ?? -1) !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout ?? ''
}

function parseCanonicalRef(canonicalRef: string): { branch: string; remote: string } {
  const slash = canonicalRef.indexOf('/')
  if (slash <= 0 || slash === canonicalRef.length - 1) {
    throw new Error('Canonical ref must be a remote-tracking ref (for example origin/main)')
  }
  return {
    remote: canonicalRef.slice(0, slash),
    branch: canonicalRef.slice(slash + 1),
  }
}

/** Prove the exact Git identity behind a publication. */
export function provePublicationSource(input: {
  canonical: boolean
  canonicalRef?: string | undefined
  expectedSourceCommit?: string | undefined
  root?: string | undefined
}): PublicationSource {
  const root = input.root ?? ROOT
  const canonicalRef = input.canonicalRef ?? process.env.HRC_CANONICAL_REF ?? 'origin/main'
  const { branch, remote } = parseCanonicalRef(canonicalRef)
  const canonicalRemote = requiredCommandOutput('git', ['remote', 'get-url', remote], root)

  if (input.canonical) {
    const fetched = run(
      'git',
      ['fetch', '--prune', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      root
    )
    if (fetched.status !== 0) {
      throw new Error(
        `Canonical publication could not freshly fetch ${canonicalRef}: ${fetched.out}`
      )
    }
    // Source, not dirt. An uncommitted `.ts` under `packages/` is a package
    // about to be published from bytes no commit describes; an uncommitted
    // `docs/` page is not, and refusing over one only taught operators to work
    // around the gate. Untracked files still count here — an untracked source
    // file is source that is not checked in — which is why this stays stricter
    // than the dirty-worktree guard rather than being folded into it.
    const { source, documentation } = partitionInstallScope(
      parsePorcelainPaths(
        requiredCommandStdout('git', ['status', '--porcelain=v1', '--untracked-files=all'], root),
        { includeUntracked: true }
      )
    )
    const notice = documentationNoticeLine('[publish] canonical source proof:', documentation)
    if (notice) console.log(notice)
    if (source.length > 0) {
      throw new Error(`Canonical publication requires a clean source tree:\n${source.join('\n')}`)
    }
  }

  const sourceCommit = requiredCommandOutput('git', ['rev-parse', 'HEAD'], root)
  if (input.expectedSourceCommit !== undefined && sourceCommit !== input.expectedSourceCommit) {
    throw new Error(
      `Publication source moved from ${input.expectedSourceCommit} to ${sourceCommit}`
    )
  }
  if (input.canonical) {
    const contained = run('git', ['merge-base', '--is-ancestor', sourceCommit, canonicalRef], root)
    if (contained.status !== 0) {
      throw new Error(
        `Canonical publication source ${sourceCommit} is not contained by freshly fetched ${canonicalRef}`
      )
    }
  }
  return {
    repository: 'hrc-runtime',
    canonicalRemote,
    sourceCommit,
    canonicalRef,
    canonical: input.canonical,
  }
}

export type SelectedRelease = {
  releasePath: string
  manifestPath: string
  manifestText: string
  build: PraesidiumBuild
}

export type SelectedReleasePaths = {
  currentLink: string
  lockDir: string
}

export function selectedReleasePaths(): SelectedReleasePaths {
  const installRoot = join(homedir(), '.bun', 'install')
  return {
    currentLink: join(installRoot, 'hrc-runtime-current'),
    lockDir: join(installRoot, 'hrc-runtime-install.lock'),
  }
}

function expectSelectedReleaseManifest(
  value: unknown,
  manifestPath: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`selected release manifest is invalid: ${manifestPath}`)
  }
  const expected = ['aspContracts', 'hrcBuild', 'installedAt', 'releaseId', 'schema']
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`selected release manifest has unexpected fields: ${manifestPath}`)
  }
  if (
    value['schema'] !== 1 ||
    typeof value['releaseId'] !== 'string' ||
    !/^release-[A-Za-z0-9._-]+$/.test(value['releaseId']) ||
    !Array.isArray(value['aspContracts']) ||
    typeof value['installedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['installedAt']))
  ) {
    throw new Error(`selected release manifest is invalid: ${manifestPath}`)
  }
}

export async function readSelectedRelease(
  paths: SelectedReleasePaths = selectedReleasePaths()
): Promise<SelectedRelease> {
  const { currentLink } = paths
  let releasePath: string
  try {
    releasePath = await realpath(currentLink)
  } catch {
    throw new Error(`canonical publication requires a selected atomic release at ${currentLink}`)
  }
  const manifestPath = join(releasePath, 'praesidium-release.json')
  const manifestText = await readFile(manifestPath, 'utf8').catch(() => '')
  if (!manifestText) {
    throw new Error(`selected release has no release manifest: ${manifestPath}`)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error(`selected release manifest is invalid JSON: ${manifestPath}`)
  }
  expectSelectedReleaseManifest(manifest, manifestPath)
  return {
    releasePath,
    manifestPath,
    manifestText,
    build: parsePraesidiumBuild(
      manifest['hrcBuild'],
      { repository: 'hrc-runtime', setName: 'hrc' },
      'selected release hrcBuild'
    ),
  }
}

export async function assertSelectedReleaseUnchanged(
  selected: SelectedRelease,
  paths: SelectedReleasePaths = selectedReleasePaths()
): Promise<void> {
  const { currentLink } = paths
  const current = await realpath(currentLink).catch(() => '')
  if (current !== selected.releasePath) {
    throw new Error('selected release changed while canonical publication was in progress')
  }
  const manifestText = await readFile(selected.manifestPath, 'utf8').catch(() => '')
  if (manifestText !== selected.manifestText) {
    throw new Error('selected release manifest changed while canonical publication was in progress')
  }
}

function stripBunConditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBunConditions)
  if (!value || typeof value !== 'object') return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'bun') continue
    next[key] = stripBunConditions(child)
  }
  return next
}

function findBunConditions(value: unknown, path = 'exports'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findBunConditions(child, `${path}[${index}]`))
  }
  if (!value || typeof value !== 'object') return []

  const offenders: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (key === 'bun') offenders.push(childPath)
    offenders.push(...findBunConditions(child, childPath))
  }
  return offenders
}

async function registryMetadata(name: string): Promise<RegistryMetadata | undefined> {
  const response = await fetch(`${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`)
  if (!response.ok) return undefined

  return (await response.json()) as RegistryMetadata
}

async function taggedVersion(name: string, tag: string): Promise<string | undefined> {
  const metadata = await registryMetadata(name)
  const version = metadata?.['dist-tags']?.[tag]
  return version && metadata?.versions?.[version] ? version : undefined
}

async function versionExists(name: string, version: string): Promise<boolean> {
  const metadata = await registryMetadata(name)
  return Boolean(metadata?.versions?.[version])
}

async function packageNames(): Promise<Set<string>> {
  const names = await Promise.all(
    PACKAGES.map(async (rel) => {
      const manifest = (await Bun.file(join(packageRoot, rel, 'package.json')).json()) as Manifest
      if (!manifest.name) throw new Error(`${rel}/package.json must include name`)
      return manifest.name
    })
  )
  return new Set(names)
}

// WHY: this publisher verified bun conditions and dep pinning but never checked
// that the files a manifest POINTS AT are actually in the tarball. agent-spaces
// T-06648 (3fe9020) shipped a binary that could not start for exactly that
// reason. `bin` is the surface that bit us and the one nothing checked.
//
// NOTE the limit, measured not assumed: `bun pm pack` FORCE-INCLUDES the bin
// entry file even when `files` excludes it (verified — packing hrc-cli with
// bin=./src/cli.ts yielded exactly one src file, src/cli.ts, and none of its
// imports). So "bin entry missing from tarball" is nearly unreachable and this
// assertion is close to a no-op. It is kept as a cheap backstop for a bin path
// that does not exist on disk at all.
//
// It does NOT catch the defect family that actually ships broken binaries:
// a packaged bin whose IMPORTS are unshipped (agent-spaces T-06648; hrc-cli's
// pre-fix bin=./src/cli.ts, whose ./cli/program.js was left out). The only
// guard for that is installing the tarball outside the monorepo and starting
// the binary. Do not treat a green publish as evidence a binary runs.
function exportedFilePaths(value: unknown): string[] {
  if (typeof value === 'string' && value.startsWith('./') && !value.includes('*')) {
    return [value]
  }
  if (Array.isArray(value)) return value.flatMap(exportedFilePaths)
  if (!value || typeof value !== 'object') return []

  return Object.values(value as Record<string, unknown>).flatMap(exportedFilePaths)
}

function binFilePaths(value: Manifest['bin']): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []

  return Object.values(value)
}

async function assertPackagedFile(packageDir: string, path: string, name: string): Promise<void> {
  const normalized = path.replace(/^\.\//, '')
  try {
    await access(join(packageDir, normalized))
  } catch {
    throw new Error(`${name} tarball references missing file: ${path}`)
  }
}

function pinInternalDependencies(
  deps: Record<string, string> | undefined,
  names: Set<string>,
  version: string
): Record<string, string> | undefined {
  if (!deps) return undefined

  let changed = false
  const next: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    if (names.has(name)) {
      next[name] = version
      changed = true
    } else {
      next[name] = spec
    }
  }
  return changed ? next : deps
}

type PackedPackage = {
  name: string
  version: string
  tarballPath: string
  tmp: string
}

async function packForPublish(rel: string): Promise<PackedPackage> {
  const pkgDir = join(packageRoot, rel)
  const packageJsonPath = join(pkgDir, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  let tmp = ''

  try {
    tmp = await mkdtemp(join(tmpdir(), 'hrc-publish-'))
    const stagedPackage = join(tmp, 'package')
    const stage = run('rsync', ['-a', '--exclude=node_modules/', `${pkgDir}/`, `${stagedPackage}/`])
    if (stage.status !== 0) {
      throw new Error(`could not stage ${rel} for publication: ${stage.out}`)
    }
    const manifest = JSON.parse(originalPackageJson) as Manifest
    if (!manifest.name || !manifest.version) {
      throw new Error(`${rel}/package.json must include name and version`)
    }

    const { private: _private, ...manifestWithoutPrivate } = manifest
    const publishManifest = {
      ...manifestWithoutPrivate,
      version: publishVersion,
      praesidiumBuild: publicationBuild,
      dependencies: pinInternalDependencies(manifest.dependencies, internalNames, publishVersion),
      devDependencies: pinInternalDependencies(
        manifest.devDependencies,
        internalNames,
        publishVersion
      ),
      peerDependencies: pinInternalDependencies(
        manifest.peerDependencies,
        internalNames,
        publishVersion
      ),
      optionalDependencies: pinInternalDependencies(
        manifest.optionalDependencies,
        internalNames,
        publishVersion
      ),
      exports: stripBunConditions(manifest.exports),
    }

    await writeFile(
      join(stagedPackage, 'package.json'),
      `${JSON.stringify(publishManifest, null, 2)}\n`
    )

    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], stagedPackage)
    if (pack.status !== 0) {
      throw new Error(`bun pm pack failed for ${manifest.name}: ${pack.out}`)
    }

    const entries = await readdir(tmp)
    const tarball = entries.find((entry) => entry.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bun pm pack produced no tarball for ${manifest.name}`)
    }

    const extractDir = join(tmp, 'extract')
    const mkdir = run('mkdir', ['-p', extractDir])
    if (mkdir.status !== 0) throw new Error(`mkdir failed for ${manifest.name}: ${mkdir.out}`)

    const tarballPath = join(tmp, tarball)
    const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
    if (tar.status !== 0) throw new Error(`tar failed for ${manifest.name}: ${tar.out}`)

    const stagedManifest = JSON.parse(
      await readFile(join(extractDir, 'package', 'package.json'), 'utf8')
    ) as Manifest
    const offenders = findBunConditions(stagedManifest.exports)
    if (offenders.length > 0) {
      throw new Error(
        `${manifest.name} tarball retains bun export conditions: ${offenders.join(', ')}`
      )
    }
    if (stagedManifest.private) {
      throw new Error(`${manifest.name} tarball still has private=true`)
    }
    if (
      stagedManifest.praesidiumBuild === undefined ||
      JSON.stringify(Object.keys(stagedManifest.praesidiumBuild)) !==
        JSON.stringify(PRAESIDIUM_BUILD_FIELDS)
    ) {
      throw new Error(
        `${manifest.name} tarball does not carry the exact normative praesidiumBuild tuple`
      )
    }
    const extractedPackageDir = join(extractDir, 'package')
    const referencedFiles = [
      stagedManifest.main,
      stagedManifest.types,
      ...binFilePaths(stagedManifest.bin),
      ...exportedFilePaths(stagedManifest.exports),
    ].filter((path): path is string => Boolean(path))
    for (const path of new Set(referencedFiles)) {
      await assertPackagedFile(extractedPackageDir, path, manifest.name)
    }

    return { name: manifest.name, version: publishVersion, tarballPath, tmp }
  } catch (error) {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    throw error
  }
}

export async function assertNoCanonicalVersionReplacement(
  packages: Array<{ name: string; version: string }>,
  exists: (name: string, version: string) => Promise<boolean> = versionExists
): Promise<void> {
  for (const packed of packages) {
    if (await exists(packed.name, packed.version)) {
      throw new Error(
        `Canonical publication refuses same-name/version replacement: ${packed.name}@${packed.version} already exists in ${REGISTRY}`
      )
    }
  }
}

async function publishPackedPackage(packed: PackedPackage, dryRun: boolean): Promise<void> {
  const id = `${packed.name}@${packed.version}`

  if (await versionExists(packed.name, packed.version)) {
    throw new Error(`${id} already exists in ${REGISTRY}; publication never replaces a package`)
  }

  if (dryRun) {
    console.log(`DRY_RUN  ${id} --tag ${publishTag}`)
    return
  }

  const publish = run('npm', [
    'publish',
    packed.tarballPath,
    '--ignore-scripts',
    '--registry',
    REGISTRY,
    '--tag',
    publishTag,
  ])
  if (publish.status !== 0) {
    throw new Error(`npm publish failed for ${id}: ${publish.out}`)
  }

  const tagged = await taggedVersion(packed.name, publishTag)
  if (tagged !== packed.version) {
    throw new Error(`registry ${publishTag} after publishing ${id} is ${tagged ?? '<missing>'}`)
  }

  console.log(`PUBLISHED  ${id} --tag ${publishTag}`)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`
}

async function verifyCanonicalPublishedSet(
  packedPackages: PackedPackage[]
): Promise<Array<{ name: string; version: string; tarball: string; bytes: number }>> {
  const proof: Array<{ name: string; version: string; tarball: string; bytes: number }> = []
  for (const packed of packedPackages) {
    const metadata = await registryMetadata(packed.name)
    const tarballUrl = metadata?.versions?.[packed.version]?.dist?.tarball
    if (!tarballUrl) {
      throw new Error(`Published metadata is missing ${packed.name}@${packed.version}`)
    }
    const response = await fetch(
      `${tarballUrl}${tarballUrl.includes('?') ? '&' : '?'}praesidium_no_cache=${Date.now()}`,
      {
        cache: 'no-store',
        headers: {
          'cache-control': 'no-cache, no-store, max-age=0',
          pragma: 'no-cache',
        },
      }
    )
    if (!response.ok) {
      throw new Error(
        `Cache-empty tarball fetch failed for ${packed.name}@${packed.version}: ${response.status} ${response.statusText}`
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) {
      throw new Error(`Cache-empty tarball fetch returned no bytes for ${packed.name}`)
    }

    let temp = ''
    try {
      temp = await mkdtemp(join(tmpdir(), 'hrc-published-proof-'))
      const tarballPath = join(temp, 'package.tgz')
      await writeFile(tarballPath, bytes)
      const extractDir = join(temp, 'extract')
      const mkdir = run('mkdir', ['-p', extractDir])
      if (mkdir.status !== 0) throw new Error(mkdir.out)
      const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
      if (tar.status !== 0) throw new Error(tar.out)
      const manifest = JSON.parse(
        await readFile(join(extractDir, 'package', 'package.json'), 'utf8')
      ) as Manifest
      if (manifest.name !== packed.name || manifest.version !== packed.version) {
        throw new Error(
          `Published tarball identity mismatch for ${packed.name}@${packed.version}: ${manifest.name ?? '<missing>'}@${manifest.version ?? '<missing>'}`
        )
      }
      if (stableJson(manifest.praesidiumBuild) !== stableJson(publicationBuild)) {
        throw new Error(`Published provenance mismatch for ${packed.name}@${packed.version}`)
      }
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true })
    }
    proof.push({
      name: packed.name,
      version: packed.version,
      tarball: tarballUrl,
      bytes: bytes.byteLength,
    })
  }
  return proof
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // Before ANYTHING touches the registry — pack, ping, or upload. A node under
  // publish containment (T-07959) must fail before it can expose a tuple.
  assertPublishContainment(REGISTRY)
  const canonical = options.selectedRelease
  const paths = selectedReleasePaths()
  const releaseLock = canonical ? await acquireInstallLock(paths.lockDir, ROOT) : undefined
  let selected: SelectedRelease | undefined
  const packedPackages: PackedPackage[] = []
  try {
    if (canonical) {
      selected = await readSelectedRelease(paths)
      publicationSource = provePublicationSource({
        canonical: true,
        root: ROOT,
        expectedSourceCommit: selected.build.sourceCommit,
      })
      if (publicationSource.canonicalRemote !== selected.build.canonicalRemote) {
        throw new Error('selected release canonical remote differs from the current checkout')
      }
      packageRoot = selected.releasePath
      publicationBuild = selected.build
      publishVersion = selected.build.setVersion
      publicationBuiltAt = selected.build.builtAt
      publishTag = 'latest'
    } else {
      const sourceRoot = resolve(process.env.HRC_PUBLISH_SOURCE_ROOT ?? ROOT)
      publicationSource = provePublicationSource({
        canonical: false,
        root: sourceRoot,
        expectedSourceCommit: process.env.HRC_PUBLISH_EXPECTED_SOURCE_COMMIT,
      })
      packageRoot = ROOT
      const firstManifest = (await Bun.file(
        join(packageRoot, PACKAGES[0], 'package.json')
      ).json()) as Manifest
      if (!firstManifest.version)
        throw new Error(`${PACKAGES[0]}/package.json must include version`)
      publishVersion =
        process.env.HRC_PUBLISH_VERSION ?? timestampVersion(firstManifest.version, 'worktree')
      publicationBuiltAt = process.env.HRC_PUBLISH_BUILT_AT ?? new Date().toISOString()
      if (!Number.isFinite(Date.parse(publicationBuiltAt))) {
        throw new Error(`HRC_PUBLISH_BUILT_AT must be an ISO timestamp: ${publicationBuiltAt}`)
      }
      publicationBuild = createPraesidiumBuild({
        canonicalRemote: publicationSource.canonicalRemote,
        sourceCommit: publicationSource.sourceCommit,
        setVersion: publishVersion,
        builtAt: publicationBuiltAt,
      })
      publishTag = 'worktree'
      console.log('NON_CANONICAL publication channel=worktree')
    }

    const ping = run('npm', ['ping', '--registry', REGISTRY])
    if (ping.status !== 0) throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
    internalNames = await packageNames()
    const mode = options.dryRun ? 'Dry-run publishing' : 'Publishing'
    console.log(
      `${mode} ${PACKAGES.length} HRC package(s) as ${publishVersion} --tag ${publishTag} to ${REGISTRY}`
    )

    for (const rel of PACKAGES) packedPackages.push(await packForPublish(rel))

    let fetched:
      | Array<{ name: string; version: string; tarball: string; bytes: number }>
      | undefined
    const existing = await Promise.all(
      packedPackages.map((packed) => versionExists(packed.name, packed.version))
    )
    if (canonical && existing.some(Boolean) && !existing.every(Boolean)) {
      await assertNoCanonicalVersionReplacement(packedPackages)
    }
    if (canonical && existing.every(Boolean)) {
      if (!options.dryRun) {
        fetched = await verifyCanonicalPublishedSet(packedPackages)
        console.log('CANONICAL_PUBLICATION_ALREADY_COMPLETE selected release tuple is unchanged')
      } else {
        console.log(
          'DRY_RUN_CANONICAL_PUBLICATION_ALREADY_COMPLETE selected release tuple already exists'
        )
      }
    } else {
      for (const packed of packedPackages) await publishPackedPackage(packed, options.dryRun)
      if (canonical && !options.dryRun) {
        fetched = await verifyCanonicalPublishedSet(packedPackages)
      }
    }
    if (canonical && !options.dryRun) {
      await assertSelectedReleaseUnchanged(selected as SelectedRelease, paths)
      console.log(
        `PRAESIDIUM_PUBLISH_PROOF ${JSON.stringify({
          schema: 1,
          canonical: true,
          canonicalRef: publicationSource.canonicalRef,
          repository: publicationSource.repository,
          canonicalRemote: publicationSource.canonicalRemote,
          sourceCommit: publicationSource.sourceCommit,
          setName: 'hrc',
          builtAt: publicationBuiltAt,
          packages: fetched,
        })}`
      )
    }
  } finally {
    await Promise.all(
      packedPackages.map((packed) => rm(packed.tmp, { recursive: true, force: true }))
    )
    await releaseLock?.()
  }
}

if (import.meta.main) {
  await main()
}
