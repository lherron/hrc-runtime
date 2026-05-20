import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'
const LOCK_DIR = join(ROOT, '.asp-sync.lock')
const LOCK_STALE_MS = 120_000

const ASP_PACKAGES = [
  'agent-scope',
  'cli-kit',
  'spaces-config',
  'spaces-runtime',
  'spaces-execution',
  'spaces-harness-claude',
  'spaces-harness-codex',
  'spaces-harness-pi',
  'spaces-harness-pi-sdk',
  'agent-spaces',
] as const

type AspPackage = (typeof ASP_PACKAGES)[number]

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

async function latestVersion(name: AspPackage): Promise<string> {
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

async function latestAspVersions(): Promise<Map<AspPackage, string>> {
  const entries = await Promise.all(
    ASP_PACKAGES.map(async (name) => [name, await latestVersion(name)] as const)
  )
  const versions = new Set(entries.map(([, version]) => version))
  if (versions.size !== 1) {
    throw new Error(
      `ASP Verdaccio latest set is incoherent: ${entries
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}`
    )
  }
  return new Map(entries)
}

function updateDependencySet(
  deps: Record<string, string> | undefined,
  latest: Map<AspPackage, string>
): boolean {
  if (!deps) return false

  let changed = false
  for (const name of ASP_PACKAGES) {
    if (deps[name] && deps[name] !== latest.get(name)) {
      deps[name] = latest.get(name) ?? deps[name]
      changed = true
    }
  }
  return changed
}

async function packageManifestPaths(): Promise<string[]> {
  const packageDirs = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
  return packageDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, 'packages', entry.name, 'package.json'))
}

async function syncManifests(latest: Map<AspPackage, string>): Promise<boolean> {
  let changed = false
  for (const packageJsonPath of await packageManifestPaths()) {
    const original = await readFile(packageJsonPath, 'utf8')
    const manifest = JSON.parse(original) as Manifest
    const manifestChanged = [
      updateDependencySet(manifest.dependencies, latest),
      updateDependencySet(manifest.devDependencies, latest),
      updateDependencySet(manifest.peerDependencies, latest),
      updateDependencySet(manifest.optionalDependencies, latest),
    ].some(Boolean)

    if (manifestChanged) {
      await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`UPDATED  ${manifest.name ?? packageJsonPath}`)
      changed = true
    }
  }
  return changed
}

async function installedVersion(name: AspPackage): Promise<string | undefined> {
  const packageJsonPath = join(ROOT, 'node_modules', name, 'package.json')
  const raw = await readFile(packageJsonPath, 'utf8').catch(() => undefined)
  if (!raw) return undefined

  const manifest = JSON.parse(raw) as { version?: string }
  return manifest.version
}

async function installedAspIsLatest(latest: Map<AspPackage, string>): Promise<boolean> {
  for (const name of ASP_PACKAGES) {
    if ((await installedVersion(name)) !== latest.get(name)) return false
  }
  return true
}

async function verifyInstalled(latest: Map<AspPackage, string>): Promise<void> {
  const stale: string[] = []
  for (const name of ASP_PACKAGES) {
    const installed = await installedVersion(name)
    const expected = latest.get(name)
    if (installed !== expected)
      stale.push(`${name}: installed ${installed ?? '<missing>'}, latest ${expected}`)
  }
  if (stale.length > 0) {
    throw new Error(`ASP dependency sync failed:\n${stale.join('\n')}`)
  }
}

async function syncAsp(): Promise<void> {
  const latest = await latestAspVersions()
  const changed = await syncManifests(latest)
  const installedLatest = await installedAspIsLatest(latest)

  if (changed || !installedLatest) {
    const tmp = await mkdtemp(join(tmpdir(), 'hrc-asp-sync-'))
    try {
      const bunfig = join(tmp, 'bunfig.toml')
      await writeFile(bunfig, '[install]\nminimumReleaseAge = 0\n')
      const install = run('bun', ['install', `--config=${bunfig}`])
      if (install.status !== 0) {
        throw new Error(`bun install failed while syncing ASP packages:\n${install.out}`)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  await verifyInstalled(latest)
  console.log(`ASP_SYNC  ${ASP_PACKAGES[0]}@${latest.get(ASP_PACKAGES[0])}`)
}

await withLock(syncAsp)
