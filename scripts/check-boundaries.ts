import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

type Violation = {
  file: string
  specifier: string
  reason?: string
}

const aspPackages = [
  'agent-scope',
  'cli-kit',
  'config',
  'runtime',
  'execution',
  'harness-claude',
  'harness-codex',
  'harness-pi',
  'harness-pi-sdk',
  'agent-spaces',
  'cli',
]

const hrcPackages = [
  'agent-action-render',
  'hrc-core',
  'hrc-events',
  'hrc-store-sqlite',
  'hrc-capture-verifier',
  'hrc-server',
  'hrc-sdk',
  'hrc-cli',
  'hrcchat-cli',
  'hrc-frame-render',
]

const layers: Layer[] = [
  {
    name: 'ASP',
    roots: [...aspPackages.map((name) => `packages/${name}`), 'integration-tests'],
    forbidden: ['hrc-', 'acp-', 'gateway-', 'coordination-substrate', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC',
    roots: hrcPackages.map((name) => `packages/${name}`),
    forbidden: [
      'acp-',
      'gateway-discord',
      'gateway-ios',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
]

const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

async function collectTsFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files
}

async function collectExistingTsFiles(paths: string[]): Promise<string[]> {
  const files = await Promise.all(
    paths.map(async (path) => {
      if (path.includes('*')) {
        const directory = dirname(path)
        const basenamePattern = new RegExp(
          `^${path
            .slice(directory.length + 1)
            .replaceAll('.', '\\.')
            .replaceAll('*', '.*')}$`
        )

        return (await collectTsFiles(directory)).filter((file) =>
          basenamePattern.test(file.slice(directory.length + 1))
        )
      }

      return collectTsFiles(path)
    })
  )

  return files.flat()
}

function isForbidden(specifier: string, token: string): boolean {
  if (token.endsWith('-')) {
    return specifier.startsWith(token)
  }
  return specifier === token || specifier.startsWith(`${token}/`)
}

function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

const brokerScopedPaths = [
  // Broker-path scoped guard only: future broker subsystem files and compile adapters.
  // This must not become a global hrc-server import ban because legacy launch/exec.ts
  // still owns direct spaces-harness-codex integration until the cutover removes it.
  'packages/hrc-server/src/broker',
  'packages/hrc-server/src/agent-spaces-adapter/compile-*.ts',
]

function resolvesToHrcLaunchExec(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) {
    return false
  }

  const resolved = resolve(dirname(file), specifier)
  const launchExec = resolve('packages/hrc-server/src/launch/exec')
  return (
    resolved === launchExec || resolved === `${launchExec}.ts` || resolved === `${launchExec}.js`
  )
}

function findBrokerScopedViolation(file: string, specifier: string): string | undefined {
  if (resolvesToHrcLaunchExec(file, specifier)) {
    return 'broker-path files must not import launch/exec.ts'
  }

  if (specifier === 'spaces-harness-codex' || specifier.startsWith('spaces-harness-codex/')) {
    return 'broker-path files must not import concrete spaces-harness-codex APIs'
  }

  if (specifier === 'spaces-harness-broker' || specifier.startsWith('spaces-harness-broker/')) {
    return 'broker-path files may import broker client/protocol packages, not spaces-harness-broker internals'
  }

  return undefined
}

async function findBrokerScopedViolations(): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await collectExistingTsFiles(brokerScopedPaths)).sort()

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      const reason = findBrokerScopedViolation(file, specifier)
      if (reason) {
        violations.push({ file: relative(process.cwd(), file), specifier, reason })
      }
    }
  }

  return violations
}

async function findViolations(layer: Layer): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(root)))).flat()

  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      if (layer.forbidden.some((token) => isForbidden(specifier, token))) {
        violations.push({ file: relative(process.cwd(), file), specifier })
      }
    }
  }

  return violations
}

const violationsByLayer = new Map<string, Violation[]>()

for (const layer of layers) {
  const violations = await findViolations(layer)
  if (violations.length > 0) {
    violationsByLayer.set(layer.name, violations)
  }
}

const brokerScopedViolations = await findBrokerScopedViolations()
if (brokerScopedViolations.length > 0) {
  violationsByLayer.set('HRC broker-path scoped', brokerScopedViolations)
}

if (violationsByLayer.size === 0) {
  console.log('Boundary check passed.')
  console.log(`Broker-path scoped guard passed for: ${brokerScopedPaths.join(', ')}`)
  process.exit(0)
}

console.error('Boundary check failed: forbidden layer imports found.')

for (const [layerName, violations] of violationsByLayer) {
  console.error('')
  console.error(`${layerName} layer violations:`)

  const grouped = Map.groupBy(violations, (violation) => packageGroup(violation.file))
  for (const [group, groupViolations] of grouped) {
    console.error(`  ${group}`)
    for (const violation of groupViolations) {
      const reason = violation.reason ? ` (${violation.reason})` : ''
      console.error(`    ${violation.file}: forbidden '${violation.specifier}'${reason}`)
    }
  }
}

process.exit(1)
