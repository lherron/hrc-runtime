import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://127.0.0.1:4873/'

const PACKAGES = [
  'packages/agent-action-render',
  'packages/hrc-core',
  'packages/hrc-sdk',
  'packages/hrc-frame-render',
  'packages/hrc-events',
  'packages/hrc-store-sqlite',
  'packages/hrc-server',
] as const

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type Options = {
  dryRun: boolean
  force: boolean
  tag?: string
  version?: string
}

type RegistryMetadata = {
  versions?: Record<string, unknown>
  'dist-tags'?: Record<string, string>
}

let publishVersion = ''
let internalNames = new Set<string>()
let publishTag = 'latest'

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, force: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--version') {
      const value = argv[++i]
      if (!value) throw new Error('--version requires a value')
      options.version = value
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
    } else if (arg === '--tag') {
      const value = argv[++i]
      if (!value) throw new Error('--tag requires a value')
      options.tag = value
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/publish-local-verdaccio.ts [--dry-run]
  bun scripts/publish-local-verdaccio.ts --version <semver> [--tag <tag>] [--force] [--dry-run]

Default mode publishes a timestamped dev set as <base>-dev.YYYYMMDDHHMMSS tagged latest.
Explicit --version publishes that exact version. Stable versions default to --tag latest.
Explicit prerelease versions require --tag.`)
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version)
}

function timestampVersion(baseVersion: string): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `${baseVersion.split('-')[0]}-dev.${stamp}`
}

function resolvePublishVersion(baseVersion: string, options: Options): string {
  const version =
    options.version ?? process.env.HRC_PUBLISH_VERSION ?? timestampVersion(baseVersion)
  if (!isSemver(version)) {
    throw new Error(`Publish version must be valid semver: ${version}`)
  }
  if (options.version && isPrerelease(version) && !options.tag) {
    throw new Error('Explicit prerelease publishes require --tag')
  }
  return version
}

function resolveTag(_version: string, options: Options): string {
  return options.tag ?? 'latest'
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
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
      const manifest = (await Bun.file(join(ROOT, rel, 'package.json')).json()) as Manifest
      if (!manifest.name) throw new Error(`${rel}/package.json must include name`)
      return manifest.name
    })
  )
  return new Set(names)
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

async function packForPublish(rel: string): Promise<{
  name: string
  version: string
  tarballPath: string
  tmp: string
}> {
  const pkgDir = join(ROOT, rel)
  const packageJsonPath = join(pkgDir, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  let tmp = ''

  try {
    tmp = await mkdtemp(join(tmpdir(), 'hrc-publish-'))
    const manifest = JSON.parse(originalPackageJson) as Manifest
    if (!manifest.name || !manifest.version) {
      throw new Error(`${rel}/package.json must include name and version`)
    }

    const { private: _private, ...manifestWithoutPrivate } = manifest
    const publishManifest = {
      ...manifestWithoutPrivate,
      version: publishVersion,
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

    await writeFile(packageJsonPath, `${JSON.stringify(publishManifest, null, 2)}\n`)

    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], pkgDir)
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

    return { name: manifest.name, version: publishVersion, tarballPath, tmp }
  } catch (error) {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    throw error
  } finally {
    await writeFile(packageJsonPath, originalPackageJson)
  }
}

async function publishPackage(rel: string, options: Options): Promise<void> {
  const packed = await packForPublish(rel)
  const id = `${packed.name}@${packed.version}`

  try {
    if ((await versionExists(packed.name, packed.version)) && !options.force) {
      throw new Error(`${id} already exists in ${REGISTRY}; use --force to replace it`)
    }

    if (options.dryRun) {
      console.log(`DRY_RUN  ${id} --tag ${publishTag}`)
      return
    }

    if (options.force) {
      const unpublish = run('npm', ['unpublish', id, '--force', '--registry', REGISTRY])
      if (unpublish.status !== 0 && !/E404|404 Not Found|not found/i.test(unpublish.out)) {
        throw new Error(`npm unpublish failed for ${id}: ${unpublish.out}`)
      }
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
  } finally {
    await rm(packed.tmp, { recursive: true, force: true })
  }
}

const options = parseArgs(process.argv.slice(2))

async function main() {
  const ping = run('npm', ['ping', '--registry', REGISTRY])
  if (ping.status !== 0) {
    throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
  }

  const firstManifest = (await Bun.file(join(ROOT, PACKAGES[0], 'package.json')).json()) as Manifest
  if (!firstManifest.version) {
    throw new Error(`${PACKAGES[0]}/package.json must include version`)
  }
  publishVersion = resolvePublishVersion(firstManifest.version, options)
  publishTag = resolveTag(publishVersion, options)
  internalNames = await packageNames()

  const mode = options.dryRun ? 'Dry-run publishing' : 'Publishing'
  console.log(
    `${mode} ${PACKAGES.length} HRC package(s) as ${publishVersion} --tag ${publishTag} to ${REGISTRY}`
  )
  for (const rel of PACKAGES) {
    await publishPackage(rel, options)
  }
}

await main()
