import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'
const LOCK_DIR = join(ROOT, '.wrkq-sync.lock')
const LOCK_STALE_MS = 120_000

const WRKQ_PACKAGES = ['@wrkq/client'] as const

type WrkqPackage = (typeof WRKQ_PACKAGES)[number]

type Manifest = {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
  'dist-tags'?: Record<string, string>
}

type SyncResult = {
  changed: boolean
  used: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      await mkdir(LOCK_DIR)
      await writeFile(join(LOCK_DIR, 'pid'), `${process.pid}\n`)
      break
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'EEXIST') throw error

      const lockStat = await stat(LOCK_DIR).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_DIR, { recursive: true, force: true })
        continue
      }
      await sleep(250)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true })
  }
}

async function latestVersion(name: WrkqPackage): Promise<string> {
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

async function latestWrkqVersions(): Promise<Map<WrkqPackage, string>> {
  const entries = await Promise.all(
    WRKQ_PACKAGES.map(async (name) => [name, await latestVersion(name)] as const)
  )
  return new Map(entries)
}

function syncDependencySet(
  deps: Record<string, string> | undefined,
  latest: Map<WrkqPackage, string>
): SyncResult {
  if (!deps) return { changed: false, used: false }

  let changed = false
  let used = false
  for (const name of WRKQ_PACKAGES) {
    if (deps[name]) {
      used = true
      if (deps[name] !== latest.get(name)) {
        deps[name] = latest.get(name) ?? deps[name]
        changed = true
      }
    }
  }
  return { changed, used }
}

async function packageManifestPaths(): Promise<string[]> {
  const packageDirs = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
  const packageJsonPaths = await Promise.all(
    packageDirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const packageJsonPath = join(ROOT, 'packages', entry.name, 'package.json')
        const packageJsonStat = await stat(packageJsonPath).catch(() => undefined)
        return packageJsonStat?.isFile() ? packageJsonPath : undefined
      })
  )
  return packageJsonPaths.filter((path): path is string => path !== undefined)
}

async function syncManifests(latest: Map<WrkqPackage, string>): Promise<SyncResult> {
  let changed = false
  let used = false
  for (const packageJsonPath of await packageManifestPaths()) {
    const original = await readFile(packageJsonPath, 'utf8')
    const manifest = JSON.parse(original) as Manifest
    const results = [
      syncDependencySet(manifest.dependencies, latest),
      syncDependencySet(manifest.devDependencies, latest),
      syncDependencySet(manifest.peerDependencies, latest),
      syncDependencySet(manifest.optionalDependencies, latest),
    ]
    const manifestChanged = results.some((result) => result.changed)
    const manifestUsed = results.some((result) => result.used)

    if (manifestChanged) {
      await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`UPDATED  ${manifest.name ?? packageJsonPath}`)
      changed = true
    }
    used ||= manifestUsed
  }
  return { changed, used }
}

async function installedVersion(name: WrkqPackage): Promise<string | undefined> {
  const packageJsonPath = join(ROOT, 'node_modules', name, 'package.json')
  const raw = await readFile(packageJsonPath, 'utf8').catch(() => undefined)
  if (!raw) return undefined

  const manifest = JSON.parse(raw) as { version?: string }
  return manifest.version
}

async function installedWrkqIsLatest(latest: Map<WrkqPackage, string>): Promise<boolean> {
  for (const name of WRKQ_PACKAGES) {
    if ((await installedVersion(name)) !== latest.get(name)) return false
  }
  return true
}

async function verifyInstalled(latest: Map<WrkqPackage, string>): Promise<void> {
  const stale: string[] = []
  for (const name of WRKQ_PACKAGES) {
    const installed = await installedVersion(name)
    const expected = latest.get(name)
    if (installed !== expected)
      stale.push(`${name}: installed ${installed ?? '<missing>'}, latest ${expected}`)
  }
  if (stale.length > 0) {
    throw new Error(`WRKQ dependency sync failed:\n${stale.join('\n')}`)
  }
}

async function syncWrkq(): Promise<void> {
  const latest = await latestWrkqVersions()
  const { changed, used } = await syncManifests(latest)
  if (!used) {
    console.log(`WRKQ_SYNC  ${WRKQ_PACKAGES[0]}@${latest.get(WRKQ_PACKAGES[0])} (no refs)`)
    return
  }

  const installedLatest = await installedWrkqIsLatest(latest)
  if (changed || !installedLatest) {
    const tmp = await mkdtemp(join(tmpdir(), 'hrc-wrkq-sync-'))
    try {
      const bunfig = join(tmp, 'bunfig.toml')
      await writeFile(bunfig, '[install]\nminimumReleaseAge = 0\n')
      const install = run('bun', ['install', '--no-cache', `--config=${bunfig}`])
      if (install.status !== 0) {
        throw new Error(`bun install failed while syncing WRKQ packages:\n${install.out}`)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  await verifyInstalled(latest)
  console.log(`WRKQ_SYNC  ${WRKQ_PACKAGES[0]}@${latest.get(WRKQ_PACKAGES[0])}`)
}

await withLock(syncWrkq)
