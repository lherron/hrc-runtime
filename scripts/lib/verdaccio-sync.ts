import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { CANONICAL_REGISTRY_URL, activeRegistryUrl, scanLockContent } from './registry'
import { resolveInstallRoot } from './workspace-root'

import { environmentWithoutGitOverrides } from 'hrc-core'

// scripts/lib/ -> repo root. THIS repo's manifests, THIS repo's bun.lock, THIS
// repo's git history. Every lock read and write below targets REPO_ROOT: the
// atomic release is built from `hrc-runtime/bun.lock --frozen-lockfile`, so a
// sync that advanced any other lockfile advanced nothing a release can see.
const REPO_ROOT = resolve(import.meta.dir, '..', '..')
// Dependencies may be installed by a parent workspace rather than this repo; the
// installed-version probes below must read the node_modules that actually exists.
// Under the praesidium dev workspace this is `~/praesidium`, whose bun.lock
// resolves every agent-spaces package to `workspace:` — reading it as the release
// lock is exactly how `just pull-deps` became an exit-0 no-op (2026-08-29).
const ROOT = resolveInstallRoot(REPO_ROOT)
const WORKSPACE_OWNED = ROOT !== REPO_ROOT
const REPO_LOCK = join(REPO_ROOT, 'bun.lock')
const REGISTRY = activeRegistryUrl()
const LOCK_STALE_MS = 120_000

/**
 * Tracked manifests always carry this dist-tag specifier for synced packages,
 * never an exact dev-timestamp. The resolved version lives only in bun.lock and
 * node_modules, so a Verdaccio publish never dirties package.json files.
 */
const TAG_SPECIFIER = 'latest'

type Manifest = {
  name?: string
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
  // Typed as a concrete field (not Record) so `.latest` is a real-property dot
  // access — valid under both noPropertyAccessFromIndexSignature and useLiteralKeys.
  'dist-tags'?: { latest?: string }
}

/** A set of packages published together as ONE coherent dev-timestamp stream. */
export type CoherenceGroup = {
  label: string
  packages: readonly string[]
}

export type SyncSpec = {
  /** Human label for log + error text, e.g. 'ASP' or 'WRKQ'. */
  label: string
  /** Lock-dir name under the repo root, e.g. '.asp-sync.lock'. */
  lockName: string
  /** Coherence groups; each must resolve to a single shared latest version. */
  groups: readonly CoherenceGroup[]
  /**
   * Optional manifest discovery override. Defaults to the repo root plus every
   * packages/* member. Repos with apps/* or other workspace roots should pass
   * `workspaceManifestPaths`.
   */
  manifestPaths?: (root: string) => Promise<string[]>
  /** Tmp-dir prefix for the isolated install bunfig (default 'verdaccio-sync-'). */
  tmpPrefix?: string
}

export type VerdaccioFreshness = {
  fresh: boolean
  summary: string
  stale: string[]
}

/** commitLockfile is synchronous (it runs inside a git-hook-sensitive path). */
function readFileSyncUtf8(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function run(cmd: string, args: string[], cwd = REPO_ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    ...(cmd === 'git' ? { env: environmentWithoutGitOverrides() } : {}),
  })
  return { status: result.status ?? -1, out: `${result.stdout || ''}${result.stderr || ''}` }
}

async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      await mkdir(lockDir)
      await writeFile(join(lockDir, 'pid'), `${process.pid}\n`)
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      const lockStat = await stat(lockDir).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
      await sleep(250)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function latestVersion(name: string): Promise<string> {
  const url = `${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to read ${name} from Verdaccio (${response.status})`)
  }
  const metadata = (await response.json()) as RegistryMetadata
  const latest = metadata['dist-tags']?.latest
  if (!latest || !metadata.versions?.[latest]) {
    throw new Error(`Verdaccio metadata for ${name} has no valid latest dist-tag`)
  }
  return latest
}

/** Resolve every group to its single coherent latest version; merge into one map. */
async function resolveLatest(groups: readonly CoherenceGroup[]): Promise<Map<string, string>> {
  const latest = new Map<string, string>()
  for (const group of groups) {
    const entries = await Promise.all(
      group.packages.map(async (name) => [name, await latestVersion(name)] as const)
    )
    const versions = new Set(entries.map(([, version]) => version))
    if (versions.size !== 1) {
      throw new Error(
        `${group.label} Verdaccio latest set is incoherent: ${entries
          .map(([name, version]) => `${name}@${version}`)
          .join(', ')}`
      )
    }
    for (const [name, version] of entries) latest.set(name, version)
  }
  return latest
}

function summaryForGroups(
  groups: readonly CoherenceGroup[],
  versions: ReadonlyMap<string, string>
): string {
  return groups
    .map((group) => {
      const first = group.packages[0]
      const version = first ? versions.get(first) : undefined
      // A group nothing in this repo consumes has no lock entry; leave it out of
      // the summary rather than record `LABEL@undefined` in a commit message.
      return version ? `${group.label}@${version}` : undefined
    })
    .filter((entry): entry is string => entry !== undefined)
    .join('  ')
}

async function usedPackageNames(
  discover: (root: string) => Promise<string[]>,
  candidates: ReadonlyMap<string, string>
): Promise<Set<string>> {
  const used = new Set<string>()
  for (const path of await discover(REPO_ROOT)) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      if (!dependencies) continue
      for (const name of candidates.keys()) {
        if (dependencies[name] !== undefined) used.add(name)
      }
    }
  }
  return used
}

export type LockResolution = {
  /** The lock key: `name` for a hoisted entry, `parent/name` for a nested copy. */
  key: string
  name: string
  version: string
  nested: boolean
}

/**
 * Every package resolution recorded in a bun text lockfile, nested copies
 * included. A nested key (`agent-harness/spaces-harness-broker`) is bun recording
 * that two different versions of one package coexist in the tree — the shape a
 * hand-run `bun update <pkg>@<ver>` leaves behind.
 */
export function parseLockResolutions(lock: string): LockResolution[] {
  const resolutions: LockResolution[] = []
  for (const line of lock.split(/\r?\n/)) {
    const match = line.match(/^\s*("(?:\\.|[^"\\])*"):\s*\[("(?:\\.|[^"\\])*")/)
    if (!match?.[1] || !match[2]) continue
    const key = JSON.parse(match[1]) as string
    const resolution = JSON.parse(match[2]) as string
    const at = resolution.lastIndexOf('@')
    if (at <= 0) continue
    const name = resolution.slice(0, at)
    const version = resolution.slice(at + 1)
    const nested = key !== name
    if (nested && !key.endsWith(`/${name}`)) continue
    resolutions.push({ key, name, version, nested })
  }
  return resolutions
}

async function lockfileVersions(lockPath = REPO_LOCK): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  for (const entry of parseLockResolutions(await readFile(lockPath, 'utf8'))) {
    if (!entry.nested) versions.set(entry.name, entry.version)
  }
  return versions
}

/**
 * A coherence group's packages must resolve to ONE version in the lock, and to
 * one copy each: a split set or a nested duplicate means the release would ship
 * two agent-spaces tuples at once. Returns human-readable violations; empty is
 * coherent. Packages the lock does not mention are not violations here — that is
 * freshness, not coherence.
 */
export function lockCoherenceViolations(groups: readonly CoherenceGroup[], lock: string): string[] {
  const resolutions = parseLockResolutions(lock)
  const violations: string[] = []
  for (const group of groups) {
    const members = new Set(group.packages)
    const versions = new Map<string, Set<string>>()
    for (const entry of resolutions) {
      if (!members.has(entry.name)) continue
      if (entry.nested) {
        violations.push(
          `${group.label}: nested copy ${entry.key} -> ${entry.name}@${entry.version} (two versions of one package in the tree)`
        )
      }
      const seen = versions.get(entry.version) ?? new Set<string>()
      seen.add(entry.name)
      versions.set(entry.version, seen)
    }
    if (versions.size > 1) {
      const detail = [...versions]
        .map(([version, names]) => `${version} (${[...names].sort().join(', ')})`)
        .join('; ')
      violations.push(`${group.label}: set is split across ${versions.size} versions: ${detail}`)
    }
  }
  return violations
}

export async function assertLockCoherent(
  groups: readonly CoherenceGroup[],
  lockPath = REPO_LOCK
): Promise<void> {
  const violations = lockCoherenceViolations(groups, await readFile(lockPath, 'utf8'))
  if (violations.length === 0) return
  throw new Error(
    `bun.lock is incoherent — a release built from it would ship a split dependency set:\n${violations.join('\n')}\nNever advance these with \`bun update\` or \`bun add\`; run \`just pull-deps\`, which moves the whole set together.`
  )
}

async function lockfileIsLatest(
  discover: (root: string) => Promise<string[]>,
  latest: ReadonlyMap<string, string>
): Promise<boolean> {
  const used = await usedPackageNames(discover, latest)
  const locked = await lockfileVersions()
  return [...used].every((name) => locked.get(name) === latest.get(name))
}

export async function checkVerdaccioFreshness(spec: SyncSpec): Promise<VerdaccioFreshness> {
  const discover = spec.manifestPaths ?? packagesManifestPaths
  const latest = await resolveLatest(spec.groups)
  const used = await usedPackageNames(discover, latest)
  const locked = await lockfileVersions()
  const stale: string[] = []
  for (const name of used) {
    const expected = latest.get(name)
    const actual = locked.get(name)
    if (actual !== expected)
      stale.push(`${name}: locked ${actual ?? 'missing'}, latest ${expected}`)
  }
  return { fresh: stale.length === 0, summary: summaryForGroups(spec.groups, latest), stale }
}

export async function runVerdaccioSyncCli(
  spec: SyncSpec,
  argv: readonly string[] = Bun.argv.slice(2)
): Promise<void> {
  if (argv.includes('--pull')) {
    await syncFromVerdaccio(spec)
    return
  }
  try {
    const freshness = await checkVerdaccioFreshness(spec)
    if (freshness.fresh) console.log(`VERDACCIO_FRESH  ${freshness.summary}`)
    else {
      console.warn(
        `VERDACCIO_STALE  ${freshness.summary}; run just pull-deps\n${freshness.stale.join('\n')}`
      )
    }
  } catch (error) {
    console.warn(
      `VERDACCIO_UNKNOWN  ${spec.label}: ${String(error)}; run just pull-deps explicitly`
    )
  }
}

/** Default discovery: repo root + every packages/* member manifest. */
export async function packagesManifestPaths(root: string): Promise<string[]> {
  const packageDirs = await readdir(join(root, 'packages'), { withFileTypes: true }).catch(() => [])
  const workspacePaths = (
    await Promise.all(
      packageDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(root, 'packages', entry.name, 'package.json')
          return (await stat(path).catch(() => undefined))?.isFile() ? path : undefined
        })
    )
  ).filter((path): path is string => path !== undefined)
  return [join(root, 'package.json'), ...workspacePaths]
}

/**
 * Discovery honoring the root `workspaces` globs (e.g. apps/*, packages/*), for
 * repos whose synced consumers live outside packages/*. Only the `dir/*` glob
 * form is supported — the only shape these repos use.
 */
export async function workspaceManifestPaths(root: string): Promise<string[]> {
  const paths = new Set<string>([join(root, 'package.json')])
  const rootRaw = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined)
  const workspaces = rootRaw ? ((JSON.parse(rootRaw) as Manifest).workspaces ?? []) : []
  for (const pattern of workspaces) {
    if (pattern.endsWith('/*')) {
      // Glob member: every immediate subdirectory is a package.
      const base = join(root, pattern.slice(0, -2))
      const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const path = join(base, entry.name, 'package.json')
        if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
      }
    } else {
      // Bare member: the directory is itself the package (e.g. "examples", "loops").
      const path = join(root, pattern, 'package.json')
      if ((await stat(path).catch(() => undefined))?.isFile()) paths.add(path)
    }
  }
  return [...paths]
}

type RewriteResult = { changed: boolean; used: boolean }

function rewriteDependencySet(
  deps: Record<string, string> | undefined,
  latest: Map<string, string>,
  specifierFor: (name: string, version: string) => string
): RewriteResult {
  if (!deps) return { changed: false, used: false }
  let changed = false
  let used = false
  for (const [name, version] of latest) {
    if (deps[name]) {
      used = true
      const specifier = specifierFor(name, version)
      if (deps[name] !== specifier) {
        deps[name] = specifier
        changed = true
      }
    }
  }
  return { changed, used }
}

/**
 * Rewrite every synced-package specifier across the discovered manifests; quiet
 * no-op when already correct. `discover` is handed REPO_ROOT; a staging copy
 * passes a discoverer that ignores it and returns the staged paths.
 */
async function rewriteManifests(
  discover: (root: string) => Promise<string[]>,
  latest: Map<string, string>,
  specifierFor: (name: string, version: string) => string
): Promise<RewriteResult> {
  let changed = false
  let used = false
  for (const path of await discover(REPO_ROOT)) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
    const results = [
      rewriteDependencySet(manifest.dependencies, latest, specifierFor),
      rewriteDependencySet(manifest.devDependencies, latest, specifierFor),
      rewriteDependencySet(manifest.peerDependencies, latest, specifierFor),
      rewriteDependencySet(manifest.optionalDependencies, latest, specifierFor),
    ]
    if (results.some((result) => result.changed)) {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
      changed = true
    }
    used ||= results.some((result) => result.used)
  }
  return { changed, used }
}

/**
 * A workspace-linked package is a symlink to a sibling repo's source, so its
 * version is that repo's package.json version and has no relationship to any
 * published dev-timestamp. Comparing the two would report every linked package as
 * permanently stale and invite `pull-deps` to rewrite bun.lock against source
 * that was never published. Linked packages are simply not registry-managed.
 */
async function isWorkspaceLinked(name: string): Promise<boolean> {
  return await lstat(join(ROOT, 'node_modules', name))
    .then((entry) => entry.isSymbolicLink())
    .catch(() => false)
}

async function installedVersion(name: string): Promise<string | undefined> {
  const raw = await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8').catch(
    () => undefined
  )
  if (!raw) return undefined
  return (JSON.parse(raw) as { version?: string }).version
}

async function installedAreLatest(latest: Map<string, string>): Promise<boolean> {
  // A parent workspace owns node_modules and links producers from source; what
  // is installed there says nothing about what the lock will ship.
  if (WORKSPACE_OWNED) return true
  for (const [name, version] of latest) {
    if (await isWorkspaceLinked(name)) continue
    const installed = await installedVersion(name)
    if (installed === undefined) return false
    if (installed !== version) return false
  }
  return true
}

async function verifyInstalled(latest: Map<string, string>, label: string): Promise<void> {
  if (WORKSPACE_OWNED) {
    console.log(
      `${label}: node_modules is owned by the workspace at ${ROOT} (source-linked); only bun.lock is registry-managed here`
    )
    return
  }
  const stale: string[] = []
  const linked: string[] = []
  for (const [name, version] of latest) {
    if (await isWorkspaceLinked(name)) {
      linked.push(name)
      continue
    }
    const installed = await installedVersion(name)
    if (installed === undefined) {
      stale.push(`${name}: missing from node_modules, latest ${version}`)
      continue
    }
    if (installed !== version) stale.push(`${name}: installed ${installed}, latest ${version}`)
  }
  if (linked.length > 0) {
    console.log(
      `${label}: ${linked.length} package(s) source-linked by a workspace; not registry-managed`
    )
  }
  if (stale.length > 0) {
    throw new Error(`${label} dependency sync failed:\n${stale.join('\n')}`)
  }
}

/**
 * Isolated bunfig for the sync install. Forces minimumReleaseAge = 0 so a
 * just-published dev version is not age-gated by a global ~/.npmrc, while
 * preserving the repo's install linker: a `--config` bunfig fully replaces the
 * repo's, and dropping a `linker = "hoisted"` makes bun relink file: workspace
 * deps and fail with EEXIST.
 */
async function isolatedBunfigContent(): Promise<string> {
  const repoBunfig = await readFile(join(ROOT, 'bunfig.toml'), 'utf8').catch(() => '')
  const linker = repoBunfig.match(/^\s*linker\s*=\s*("[^"]*"|'[^']*')/m)?.[1]
  const lines = ['[install]', 'minimumReleaseAge = 0']
  if (linker) lines.push(`linker = ${linker}`)
  return `${lines.join('\n')}\n`
}

function bunInstall(label: string, args: string[], cwd: string, bunfig: string): void {
  // --no-cache bypasses bun's manifest cache so we always see Verdaccio's
  // current dist-tags. Without it, a freshly-published dev version can
  // "fail to resolve" until the cache TTL expires.
  const install = run('bun', ['install', '--no-cache', `--config=${bunfig}`, ...args], cwd)
  if (install.status !== 0) {
    throw new Error(`bun install failed while syncing ${label} packages:\n${install.out}`)
  }
}

/**
 * Advance THIS repo's bun.lock to `latest` without touching any node_modules.
 *
 * The resolution runs in a staging copy of the repo's manifests + lock, in a
 * temp dir with no parent workspace above it, so bun resolves against the
 * registry and writes a lock in the exact shape the release install will consume
 * (`bun install --frozen-lockfile` in an exported tree). Only the resulting
 * bun.lock is copied back. Tracked manifests in the repo are never pinned, even
 * transiently.
 *
 * Pin/restore dance, in staging: bun won't re-resolve a tag already satisfied by
 * the lock, and `bun update` rewrites package.json and re-resolves tags outside
 * the coherence check. So pin the verified versions exactly, resolve, restore the
 * tag specifier, resolve again so the lock records `latest`.
 */
async function advanceRepoLockfile(
  label: string,
  discover: (root: string) => Promise<string[]>,
  latest: Map<string, string>,
  tmpPrefix: string
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), tmpPrefix))
  try {
    const bunfig = join(staging, '.sync-bunfig.toml')
    await writeFile(bunfig, await isolatedBunfigContent())
    const stagedManifests: string[] = []
    const manifests = new Set([join(REPO_ROOT, 'package.json'), ...(await discover(REPO_ROOT))])
    for (const path of manifests) {
      const relative = relativeTo(REPO_ROOT, path)
      if (relative === undefined) continue
      const target = join(staging, relative)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(path, target)
      stagedManifests.push(target)
    }
    for (const name of ['bun.lock', '.npmrc']) {
      const source = join(REPO_ROOT, name)
      if (await stat(source).catch(() => undefined)) await copyFile(source, join(staging, name))
    }
    const staged = async () => stagedManifests
    await rewriteManifests(staged, latest, (_name, version) => version)
    bunInstall(label, ['--lockfile-only'], staging, bunfig)
    await rewriteManifests(staged, latest, () => TAG_SPECIFIER)
    bunInstall(label, ['--lockfile-only'], staging, bunfig)
    await copyFile(join(staging, 'bun.lock'), REPO_LOCK)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function relativeTo(root: string, path: string): string | undefined {
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel
}

/**
 * Materialize node_modules from the (now advanced) lock. Standalone checkouts
 * only: under a parent workspace the workspace's own install owns node_modules
 * (scripts/install-workspace-deps.ts) and links producers from source.
 */
async function installFromRepoLockfile(label: string, tmpPrefix: string): Promise<void> {
  if (WORKSPACE_OWNED) return
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix))
  try {
    const bunfig = join(tmp, 'bunfig.toml')
    await writeFile(bunfig, await isolatedBunfigContent())
    bunInstall(label, ['--frozen-lockfile'], REPO_ROOT, bunfig)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Refuse to write a bun.lock naming any host but the canonical registry. Reads
 * the worktree, which is what the pathspec commit below would record.
 */
function assertLockHygiene(): void {
  const lock = readFileSyncUtf8(REPO_LOCK)
  if (lock === undefined) return
  const violations = scanLockContent(lock)
  if (violations.length === 0) return
  const hosts = [...new Set(violations.map((violation) => violation.host))].sort()
  throw new Error(
    `refusing to commit bun.lock: ${violations.length} URL(s) on non-canonical host(s) ${hosts.join(', ')} (canonical: ${CANONICAL_REGISTRY_URL}). First: line ${violations[0]?.line} ${violations[0]?.url}. Re-sync on a host that resolves the canonical registry.`
  )
}

/**
 * Commit the advanced bun.lock as one lockfile-only pathspec commit. Reached ONLY
 * from `commitSyncedLockfile`, i.e. from this repo's own deliberate `just
 * pull-deps` — a sync never commits on its own (T-07629): an install driven from
 * a producer repo must not write git history in a repo it does not own.
 * Failure is tolerated (mid-rebase, concurrent index lock, ...).
 *
 * Skipped entirely when GIT_INDEX_FILE is set: that means we were invoked from a
 * git hook (a pre-commit that builds → syncs), and committing here would move
 * HEAD out from under the in-flight commit and abort it with "cannot lock ref
 * 'HEAD'". The outer commit will carry the lock change instead.
 */
function commitLockfile(label: string, summary: string): void {
  const { GIT_INDEX_FILE } = process.env
  if (GIT_INDEX_FILE) return
  const status = run('git', ['status', '--porcelain', '--', 'bun.lock'])
  if (status.status !== 0 || status.out.trim() === '') return
  // This commit is `--no-verify`, so the pre-commit lock-hygiene gate never
  // sees it — and a sync run on a host that reaches Verdaccio under a
  // machine-local name is precisely how 26 loopback URLs reached origin/main
  // (T-07412). Re-check here rather than let the one path that skips the hook
  // be the one that caused the incident.
  assertLockHygiene()
  const commit = run('git', [
    'commit',
    '--no-verify',
    '-m',
    `chore: sync bun.lock (${summary})`,
    '--',
    'bun.lock',
  ])
  if (commit.status === 0) {
    console.log(`COMMITTED  bun.lock (${label} sync)`)
  } else {
    console.warn(`WARN  could not auto-commit bun.lock:\n${commit.out.trim()}`)
  }
}

/**
 * A sync leaves its bun.lock change UNCOMMITTED and says so. The repo that
 * dirtied it is not necessarily the repo that ran the sync — a producer's
 * `just install` drives this in each consumer — so the commit belongs to
 * whoever owns this checkout, on their next landing (T-07629).
 */
function announceDirtyLockfile(label: string): void {
  const status = run('git', ['status', '--porcelain', '--', 'bun.lock'])
  if (status.status !== 0 || status.out.trim() === '') return
  console.log(
    `LOCK_DIRTY  bun.lock (${label} sync) — uncommitted; commit it with your next landing`
  )
}

export async function commitSyncedLockfile(groups: readonly CoherenceGroup[]): Promise<void> {
  const locked = await lockfileVersions()
  commitLockfile('dependency', summaryForGroups(groups, locked))
}

/**
 * Sync a set of locally-published Verdaccio dev packages into this repo.
 *
 * Tracked manifests permanently declare synced packages as "latest" (dist-tag
 * specifier); the resolved dev-timestamp lives only in bun.lock + node_modules.
 * When Verdaccio's coherent latest differs from what's installed, we advance
 * deterministically: temporarily pin the exact verified versions, install, then
 * restore the tag specifier and reinstall so bun.lock records "latest" again.
 * (bun won't re-resolve a tag already satisfied by the lock, and `bun update`
 * both rewrites package.json and re-resolves tags outside our coherence check —
 * hence the pin/restore dance.) The resulting lockfile-only change is left
 * uncommitted and announced. Serialized by a repo-root lock dir so concurrent
 * syncs of the same stream don't collide.
 *
 * Steady state (installed == latest, manifests already tagged) does zero
 * installs and zero writes. A republish between resolveLatest and the reconcile
 * install can make verifyInstalled fail loudly; rerunning the sync converges.
 */
export async function syncFromVerdaccio(spec: SyncSpec): Promise<void> {
  const discover = spec.manifestPaths ?? packagesManifestPaths
  const tmpPrefix = spec.tmpPrefix ?? 'verdaccio-sync-'
  await withLock(join(ROOT, spec.lockName), async () => {
    const latest = await resolveLatest(spec.groups)
    const summary = summaryForGroups(spec.groups, latest)

    // Enforce the stable tag specifier (also migrates any stray exact pins).
    const normalized = await rewriteManifests(discover, latest, () => TAG_SPECIFIER)
    if (!normalized.used) {
      console.log(`${spec.label}_SYNC  ${summary} (no refs)`)
      return
    }

    const lockStale = !(await lockfileIsLatest(discover, latest))
    const stale = lockStale || !(await installedAreLatest(latest))
    if (lockStale || normalized.changed) {
      await advanceRepoLockfile(spec.label, discover, latest, tmpPrefix)
    }
    if (stale || normalized.changed) {
      await installFromRepoLockfile(spec.label, tmpPrefix)
    }
    // A pull that leaves the lock behind latest is a failure, never a warning:
    // the release is built from this lock, and an exit-0 no-op here shipped the
    // old agent-spaces tuple twice in one afternoon (2026-08-29).
    if (!(await lockfileIsLatest(discover, latest))) {
      const locked = await lockfileVersions()
      const behind = [...latest]
        .filter(([name, version]) => locked.has(name) && locked.get(name) !== version)
        .map(([name, version]) => `${name}: locked ${locked.get(name)}, latest ${version}`)
      throw new Error(
        `${spec.label} sync did not advance ${relative(process.cwd(), REPO_LOCK) || 'bun.lock'}:\n${behind.join('\n')}`
      )
    }
    await assertLockCoherent(spec.groups)
    await verifyInstalled(latest, spec.label)
    // Only report churn this run produced — a bun.lock dirtied by someone
    // else's in-flight work is theirs to speak for.
    if (stale || normalized.changed) announceDirtyLockfile(spec.label)
    console.log(`${spec.label}_SYNC  ${summary}`)
  })
}
