import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

type Violation = {
  file: string
  specifier: string
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

const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

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

if (violationsByLayer.size === 0) {
  console.log('Boundary check passed.')
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
      console.error(`    ${violation.file}: forbidden '${violation.specifier}'`)
    }
  }
}

process.exit(1)
