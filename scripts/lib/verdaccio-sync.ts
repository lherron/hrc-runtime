import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// scripts/lib/ -> repo root
const ROOT = resolve(import.meta.dir, '..', '..')
// Destructure rather than index/property access: consumers span tsconfigs that
// require bracket access on index signatures (noPropertyAccessFromIndexSignature)
// and biome configs that forbid it (useLiteralKeys); destructuring satisfies both.
const { VERDACCIO_REGISTRY } = process.env
const REGISTRY = VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
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

/** Rewrite every synced-package specifier across all manifests; quiet no-op when already correct. */
async function rewriteManifests(
  discover: (root: string) => Promise<string[]>,
  latest: Map<string, string>,
  specifierFor: (name: string, version: string) => string
): Promise<RewriteResult> {
  let changed = false
  let used = false
  for (const path of await discover(ROOT)) {
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

async function installedVersion(name: string): Promise<string | undefined> {
  const raw = await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8').catch(
    () => undefined
  )
  if (!raw) return undefined
  return (JSON.parse(raw) as { version?: string }).version
}

async function installedAreLatest(latest: Map<string, string>): Promise<boolean> {
  for (const [name, version] of latest) {
    const installed = await installedVersion(name)
    if (installed === undefined) continue
    if (installed !== version) return false
  }
  return true
}

async function verifyInstalled(latest: Map<string, string>, label: string): Promise<void> {
  const stale: string[] = []
  for (const [name, version] of latest) {
    const installed = await installedVersion(name)
    if (installed === undefined) continue
    if (installed !== version) stale.push(`${name}: installed ${installed}, latest ${version}`)
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

async function bunInstallFromVerdaccio(label: string, tmpPrefix: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix))
  try {
    const bunfig = join(tmp, 'bunfig.toml')
    await writeFile(bunfig, await isolatedBunfigContent())
    // --no-cache bypasses bun's manifest cache so we always see Verdaccio's
    // current dist-tags. Without it, a freshly-published dev version can
    // "fail to resolve" until the cache TTL expires.
    const install = run('bun', ['install', '--no-cache', `--config=${bunfig}`])
    if (install.status !== 0) {
      throw new Error(`bun install failed while syncing ${label} packages:\n${install.out}`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * After a sync advances the resolved versions, bun.lock is the only tracked file
 * that changed. Commit it immediately (lockfile-only pathspec commit) so worktrees
 * stay clean for whoever runs next. Failure is tolerated (mid-rebase, concurrent
 * index lock, ...) — the next sync run retries. Opt out with
 * PRAESIDIUM_SYNC_NO_COMMIT=1.
 *
 * Skipped entirely when GIT_INDEX_FILE is set: that means we were invoked from a
 * git hook (a pre-commit that builds → syncs), and committing here would move
 * HEAD out from under the in-flight commit and abort it with "cannot lock ref
 * 'HEAD'". The outer commit will carry the lock change instead; if not, the next
 * top-level sync commits it.
 */
function commitLockfile(label: string, summary: string): void {
  const { PRAESIDIUM_SYNC_NO_COMMIT, GIT_INDEX_FILE } = process.env
  if (PRAESIDIUM_SYNC_NO_COMMIT === '1') return
  if (GIT_INDEX_FILE) return
  const status = run('git', ['status', '--porcelain', '--', 'bun.lock'])
  if (status.status !== 0 || status.out.trim() === '') return
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
 * Sync a set of locally-published Verdaccio dev packages into this repo.
 *
 * Tracked manifests permanently declare synced packages as "latest" (dist-tag
 * specifier); the resolved dev-timestamp lives only in bun.lock + node_modules.
 * When Verdaccio's coherent latest differs from what's installed, we advance
 * deterministically: temporarily pin the exact verified versions, install, then
 * restore the tag specifier and reinstall so bun.lock records "latest" again.
 * (bun won't re-resolve a tag already satisfied by the lock, and `bun update`
 * both rewrites package.json and re-resolves tags outside our coherence check —
 * hence the pin/restore dance.) The resulting lockfile-only change is
 * auto-committed. Serialized by a repo-root lock dir so concurrent syncs of the
 * same stream don't collide.
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
    const summary = spec.groups
      .map((group) => {
        const first = group.packages[0]
        return `${group.label}@${first ? latest.get(first) : '?'}`
      })
      .join('  ')

    // Enforce the stable tag specifier (also migrates any stray exact pins).
    const normalized = await rewriteManifests(discover, latest, () => TAG_SPECIFIER)
    if (!normalized.used) {
      console.log(`${spec.label}_SYNC  ${summary} (no refs)`)
      return
    }

    const stale = !(await installedAreLatest(latest))
    if (stale) {
      await rewriteManifests(discover, latest, (_name, version) => version)
      await bunInstallFromVerdaccio(spec.label, tmpPrefix)
      await rewriteManifests(discover, latest, () => TAG_SPECIFIER)
    }
    if (stale || normalized.changed) {
      // Reconcile bun.lock so it records the tag specifier, not the exact pin.
      await bunInstallFromVerdaccio(spec.label, tmpPrefix)
    }
    await verifyInstalled(latest, spec.label)
    // Only commit churn this run produced — a bun.lock dirtied by someone
    // else's in-flight work is theirs to commit.
    if (stale || normalized.changed) commitLockfile(spec.label, summary)
    console.log(`${spec.label}_SYNC  ${summary}`)
  })
}
