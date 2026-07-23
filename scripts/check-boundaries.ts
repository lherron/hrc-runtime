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
  'hrc-top',
  'hrc-pi-top',
  'hrc-cli',
  'hrcchat-cli',
  'hrcmail-cli',
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

const mailPersistencePaths = ['packages/hrc-store-sqlite/src/mail']
const mailIngressPaths = [
  'packages/hrc-server/src/mail/mail-ingress*.ts',
  'packages/hrc-server/src/mail/mail-handlers*.ts',
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

function resolvesWithin(file: string, specifier: string, root: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(dirname(file), specifier).replace(/\.(?:js|ts)$/, '')
  const absoluteRoot = resolve(root)
  return resolved === absoluteRoot || resolved.startsWith(`${absoluteRoot}/`)
}

function findMailScopedViolation(
  scope: 'persistence' | 'ingress',
  file: string,
  specifier: string
): string | undefined {
  if (scope === 'persistence') {
    if (
      specifier === 'hrc-server' ||
      specifier.startsWith('hrc-server/') ||
      resolvesWithin(file, specifier, 'packages/hrc-server/src')
    ) {
      return 'mail persistence must not import server runtime/orchestration code'
    }
    return undefined
  }

  const normalized = specifier.toLowerCase()
  if (
    normalized.includes('kicker') ||
    normalized.includes('dispatch') ||
    normalized.includes('summon')
  ) {
    return 'mail ingress must persist only; it must not import kicker, dispatch, or summon paths'
  }
  return undefined
}

async function findMailScopedViolations(
  scope: 'persistence' | 'ingress',
  paths: string[]
): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await collectExistingTsFiles(paths)).sort()
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const reason = findMailScopedViolation(scope, file, specifier)
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

async function collectBoundaryViolations(): Promise<Map<string, Violation[]>> {
  const found = new Map<string, Violation[]>()

  for (const layer of layers) {
    const violations = await findViolations(layer)
    if (violations.length > 0) {
      found.set(layer.name, violations)
    }
  }

  const brokerScopedViolations = await findBrokerScopedViolations()
  if (brokerScopedViolations.length > 0) {
    found.set('HRC broker-path scoped', brokerScopedViolations)
  }

  const mailPersistenceViolations = await findMailScopedViolations(
    'persistence',
    mailPersistencePaths
  )
  if (mailPersistenceViolations.length > 0) {
    found.set('HRC mail persistence scoped', mailPersistenceViolations)
  }

  const mailIngressViolations = await findMailScopedViolations('ingress', mailIngressPaths)
  if (mailIngressViolations.length > 0) {
    found.set('HRC mail ingress scoped', mailIngressViolations)
  }

  return found
}

function fixForViolation(layerName: string, violation: Violation): string {
  if (layerName === 'HRC mail persistence scoped') {
    return [
      `FIX: remove the orchestration import '${violation.specifier}' from ${violation.file}.`,
      'Keep the envelope repository as a pure SQLite state machine; wake/dispatch policy belongs in hrc-server.',
    ].join(' ')
  }
  if (layerName === 'HRC mail ingress scoped') {
    return [
      `FIX: remove the execution-path import '${violation.specifier}' from ${violation.file}.`,
      'Mail ingress may validate, persist, and return a receipt only; the kicker owns execution decisions.',
    ].join(' ')
  }
  if (violation.reason) {
    return [
      `FIX: remove the direct '${violation.specifier}' import from ${violation.file}.`,
      'Route broker-path code through the broker client/protocol seam or move the adapter to the owning subsystem; do not widen the broker-path allowlist.',
    ].join(' ')
  }

  if (layerName === 'ASP') {
    return [
      `FIX: remove the '${violation.specifier}' import from ${violation.file}.`,
      'Move shared contracts into an ASP-owned package, invert the dependency through a caller-supplied adapter, or keep the HRC/ACP call at the application edge.',
    ].join(' ')
  }

  return [
    `FIX: remove the '${violation.specifier}' import from ${violation.file}.`,
    'Use an HRC-owned package, an allowed pinned ASP package, or pass data through an adapter owned by the forbidden layer instead of importing that layer directly.',
  ].join(' ')
}

function whyForViolation(layerName: string, violation: Violation): string {
  if (layerName === 'HRC mail persistence scoped') {
    return [
      'WHY: hrc-store-sqlite owns envelope persistence and state transitions, not execution.',
      'Importing server runtime code would collapse the embedded-store boundary and make persistence capable of dispatch.',
    ].join(' ')
  }
  if (layerName === 'HRC mail ingress scoped') {
    return [
      'WHY: ingress-never-provisions is an hrcmail safety invariant.',
      'Only the kicker may summon or dispatch; a send must commit a receipt without creating sessions or runtimes.',
    ].join(' ')
  }
  if (violation.reason) {
    return [
      'WHY: broker-path files are the runtime-control boundary.',
      'Direct launch/harness internals couple durable broker dispatch to legacy execution details and make the broker split unenforceable.',
    ].join(' ')
  }

  if (layerName === 'ASP') {
    return [
      'WHY: ASP packages are the lower reusable layer.',
      'Pulling HRC/ACP/gateway/task implementations into ASP makes the platform split cyclic and breaks cross-repo package reuse.',
    ].join(' ')
  }

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
  findMailScopedViolation,
  formatBoundaryViolationDiagnostic,
  reportBoundaryViolations,
  type Violation,
}

if (import.meta.main) {
  const found = await collectBoundaryViolations()

  if (found.size === 0) {
    console.log('Boundary check passed.')
    console.log(`Broker-path scoped guard passed for: ${brokerScopedPaths.join(', ')}`)
    console.log(`Mail persistence scoped guard passed for: ${mailPersistencePaths.join(', ')}`)
    console.log(`Mail ingress scoped guard passed for: ${mailIngressPaths.join(', ')}`)
    process.exit(0)
  }

  reportBoundaryViolations(found)
  process.exit(1)
}
