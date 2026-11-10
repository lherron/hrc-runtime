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
  reason?: string
}

const hrcPackages = [
  'agent-action-render',
  'hrc-core',
  'hrc-events',
  'hrc-sdk',
  'hrc-turn-attention',
  'hrc-frame-render',
]

const layers: Layer[] = [
  {
    name: 'HRC',
    roots: hrcPackages.map((name) => `packages/${name}`),
    forbidden: [
      'acp-',
      'gateway-discord',
      'gateway-ios',
      'hrc-injector-core',
      'hrc-mail-injector',
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

async function collectRequiredTsFiles(groupName: string, paths: string[]): Promise<string[]> {
  const files = await collectExistingTsFiles(paths)
  if (files.length === 0) {
    throw new Error(
      `Boundary check configuration failed: ${groupName} resolved to zero TypeScript inputs from: ${paths.join(', ')}`
    )
  }
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
  const files = await collectRequiredTsFiles(`${layer.name} layer`, layer.roots)

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

async function collectBoundaryViolations(): Promise<Map<string, Violation[]>> {
  const found = new Map<string, Violation[]>()

  for (const layer of layers) {
    const violations = await findViolations(layer)
    if (violations.length > 0) {
      found.set(layer.name, violations)
    }
  }

  return found
}

function fixForViolation(_layerName: string, violation: Violation): string {
  return [
    `FIX: remove the '${violation.specifier}' import from ${violation.file}.`,
    'Use an HRC-owned package, an allowed pinned ASP package, or pass data through an adapter owned by the forbidden layer instead of importing that layer directly.',
  ].join(' ')
}

function whyForViolation(_layerName: string, _violation: Violation): string {
  return [
    'WHY: HRC runtime packages must stay independent of ACP gateways, coordination substrate, wrkq, wlearn, and other application-layer implementations.',
    'A forbidden import turns those systems into undeclared runtime dependencies and lets architecture drift ship silently.',
  ].join(' ')
}

function exceptionForViolation(layerName: string): string {
  return [
    'EXCEPTION: if this crossing is intentional, get architecture approval in a wrkq task and encode a named, narrow exception in scripts/check-boundaries.ts',
    `for the exact ${layerName} file/specifier pair with the reason and expiry/review condition.`,
  ].join(' ')
}

function formatBoundaryViolationDiagnostic(layerName: string, violation: Violation): string[] {
  return [
    fixForViolation(layerName, violation),
    whyForViolation(layerName, violation),
    exceptionForViolation(layerName),
  ]
}

function reportBoundaryViolations(found: Map<string, Violation[]>): void {
  console.error('Boundary check failed: forbidden layer imports found.')

  for (const [layerName, violations] of found) {
    console.error('')
    console.error(`${layerName} layer violations:`)

    const grouped = Map.groupBy(violations, (violation) => packageGroup(violation.file))
    for (const [group, groupViolations] of grouped) {
      console.error(`  ${group}`)
      for (const violation of groupViolations) {
        const reason = violation.reason ? ` (${violation.reason})` : ''
        console.error(`    ${violation.file}: forbidden '${violation.specifier}'${reason}`)
        for (const line of formatBoundaryViolationDiagnostic(layerName, violation)) {
          console.error(`      ${line}`)
        }
      }
    }
  }
}

export {
  collectBoundaryViolations,
  collectRequiredTsFiles,
  formatBoundaryViolationDiagnostic,
  isForbidden,
  layers,
  reportBoundaryViolations,
  type Violation,
}

if (import.meta.main) {
  const found = await collectBoundaryViolations()

  if (found.size === 0) {
    console.log('Boundary check passed.')
    process.exit(0)
  }

  reportBoundaryViolations(found)
  process.exit(1)
}
