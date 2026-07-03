import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  type ExportReference,
  parseExportReferences,
  resolveImportTarget,
  workspacePackageDirs,
} from './lib/import-graph.ts'

type CliOptions = {
  root: string
  baseline: string
  updateBaseline: boolean
}

type RatifiedPackage = {
  dir: string
  fallbackName: string
}

type Surface = {
  package: string
  symbol: string
  kind: string
  file: string
  line: number
}

type BaselineEntry = {
  package: string
  symbol: string
  kind: string
  file: string
  hash: string
  count: number
}

type BaselineFile = {
  _meta?: unknown
  surfaces?: BaselineEntry[]
}

type ParserDiagnostic = {
  file: string
  line: number
  message: string
}

const ratifiedPackages: RatifiedPackage[] = [
  { dir: 'packages/agent-action-render', fallbackName: 'agent-action-render' },
  { dir: 'packages/hrc-core', fallbackName: 'hrc-core' },
  { dir: 'packages/hrc-sdk', fallbackName: 'hrc-sdk' },
  { dir: 'packages/hrc-frame-render', fallbackName: 'hrc-frame-render' },
]

const baselineMeta = {
  schemaVersion: 1,
  generatedBy: 'bun scripts/check-public-surface.ts --update-baseline',
  warning:
    'Grandfathers the ACP-consumed public package exports. Regenerate only after reviewed API surface changes.',
}

async function packageName(root: string, pkg: RatifiedPackage): Promise<string> {
  try {
    const packageJson = JSON.parse(await readText(root, `${pkg.dir}/package.json`)) as {
      name?: unknown
    }
    return typeof packageJson.name === 'string' ? packageJson.name : pkg.fallbackName
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return pkg.fallbackName
    }
    throw error
  }
}

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd()
  let baseline = join(process.cwd(), '.public-surface-baseline.json')
  let updateBaseline = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--root requires a directory')
      }
      root = resolve(value)
      index += 1
      continue
    }

    if (arg === '--baseline') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--baseline requires a path')
      }
      baseline = isAbsolute(value) ? value : resolve(process.cwd(), value)
      index += 1
      continue
    }

    if (arg === '--update-baseline') {
      updateBaseline = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { root, baseline, updateBaseline }
}

function toSlash(path: string): string {
  return path.split(sep).join('/')
}

function repoPath(root: string, path: string): string {
  return toSlash(relative(root, path))
}

async function readText(root: string, file: string): Promise<string> {
  return readFile(join(root, file), 'utf8')
}

function identityOf(surface: Pick<Surface, 'package' | 'symbol' | 'kind'>): string {
  return `${surface.package}|${surface.symbol}|${surface.kind}`
}

async function resolveSymbolOrigin(
  root: string,
  packageDirs: Map<string, string>,
  file: string,
  local: string,
  diagnostics: ParserDiagnostic[],
  visited = new Set<string>()
): Promise<{ file: string; line: number; kind: string } | undefined> {
  const key = `${file}:${local}`
  if (visited.has(key)) {
    return undefined
  }
  visited.add(key)

  const content = await readText(root, file)
  const refs = parseExportReferences(file, content)

  for (const ref of refs) {
    if (!ref.symbol) {
      continue
    }

    if (!ref.specifier && ref.symbol === local) {
      return {
        file,
        line: ref.line,
        kind: ref.kind === 'type' ? 'type' : 'value',
      }
    }

    if (ref.specifier && ref.symbol === local && ref.local) {
      const target = resolveModule(root, packageDirs, file, ref.specifier)
      if (!target) {
        failParser(diagnostics, ref, `cannot resolve re-export '${ref.specifier}' for ${local}`)
        return undefined
      }
      return resolveSymbolOrigin(root, packageDirs, target, ref.local, diagnostics, visited)
    }
  }

  for (const ref of refs) {
    if (ref.kind !== 'star' || !ref.specifier) {
      continue
    }
    const target = resolveModule(root, packageDirs, file, ref.specifier)
    if (!target) {
      failParser(
        diagnostics,
        ref,
        `cannot resolve star export '${ref.specifier}' while looking for ${local}`
      )
      continue
    }
    const origin = await resolveSymbolOrigin(root, packageDirs, target, local, diagnostics, visited)
    if (origin) {
      return origin
    }
  }

  return undefined
}

function resolveModule(
  root: string,
  packageDirs: Map<string, string>,
  fromFile: string,
  specifier: string
): string | undefined {
  const resolved = resolveImportTarget(fromFile, specifier, packageDirs, root)
  if (!resolved.target) {
    return undefined
  }

  const packageIndex = `${resolved.target}/src/index.ts`
  if (!specifier.startsWith('.') && existsSync(join(root, packageIndex))) {
    return packageIndex
  }

  return resolved.target
}

function failParser(
  diagnostics: ParserDiagnostic[],
  reference: ExportReference,
  message: string
): void {
  diagnostics.push({ file: reference.file, line: reference.line, message })
}

async function collectModuleSurfaces(
  root: string,
  packageDirs: Map<string, string>,
  packageName: string,
  file: string,
  diagnostics: ParserDiagnostic[],
  visited = new Set<string>()
): Promise<Surface[]> {
  if (visited.has(file)) {
    return []
  }
  visited.add(file)

  const content = await readText(root, file)
  const refs = parseExportReferences(file, content)
  const surfaces: Surface[] = []

  for (const ref of refs) {
    if (ref.kind === 'star') {
      if (!ref.specifier) {
        continue
      }
      const target = resolveModule(root, packageDirs, file, ref.specifier)
      if (!target) {
        failParser(diagnostics, ref, `cannot resolve star export '${ref.specifier}'`)
        continue
      }
      surfaces.push(
        ...(await collectModuleSurfaces(
          root,
          packageDirs,
          packageName,
          target,
          diagnostics,
          visited
        ))
      )
      continue
    }

    if (!ref.symbol) {
      continue
    }

    if (ref.kind === 'namespace') {
      surfaces.push({
        package: packageName,
        symbol: ref.symbol,
        kind: 'namespace',
        file: ref.file,
        line: ref.line,
      })
      continue
    }

    if (!ref.specifier) {
      surfaces.push({
        package: packageName,
        symbol: ref.symbol,
        kind: ref.kind === 'type' ? 'type' : 'value',
        file: ref.file,
        line: ref.line,
      })
      continue
    }

    const target = resolveModule(root, packageDirs, file, ref.specifier)
    if (!target || !ref.local) {
      failParser(diagnostics, ref, `cannot resolve re-export '${ref.specifier}' for ${ref.symbol}`)
      continue
    }

    const origin = await resolveSymbolOrigin(root, packageDirs, target, ref.local, diagnostics)
    if (!origin) {
      failParser(
        diagnostics,
        ref,
        `cannot resolve exported symbol '${ref.local}' from '${ref.specifier}'`
      )
      continue
    }
    surfaces.push({
      package: packageName,
      symbol: ref.symbol,
      kind: ref.kind === 'type' ? 'type' : origin.kind,
      file: origin.file,
      line: origin.line,
    })
  }

  return surfaces
}

async function collectPackageSurfaces(
  root: string,
  diagnostics: ParserDiagnostic[]
): Promise<Surface[]> {
  const surfaces: Surface[] = []
  const packageDirs = await workspacePackageDirs(root)
  for (const pkg of ratifiedPackages) {
    const indexFile = `${pkg.dir}/src/index.ts`
    if (!existsSync(join(root, indexFile))) {
      continue
    }
    surfaces.push(
      ...(await collectModuleSurfaces(
        root,
        packageDirs,
        await packageName(root, pkg),
        indexFile,
        diagnostics
      ))
    )
  }
  return surfaces
}

function dedupeSurfaces(surfaces: Surface[]): Surface[] {
  const byIdentity = new Map<string, Surface>()
  for (const surface of surfaces) {
    const identity = identityOf(surface)
    const existing = byIdentity.get(identity)
    if (!existing || surface.file.localeCompare(existing.file) < 0) {
      byIdentity.set(identity, surface)
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    identityOf(left).localeCompare(identityOf(right))
  )
}

function baselineEntries(surfaces: Surface[]): BaselineEntry[] {
  const grouped = new Map<string, Surface[]>()
  for (const surface of surfaces) {
    const identity = identityOf(surface)
    grouped.set(identity, [...(grouped.get(identity) ?? []), surface])
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, group]) => {
      const first = group.sort((left, right) => left.file.localeCompare(right.file))[0]
      return {
        package: first.package,
        symbol: first.symbol,
        kind: first.kind,
        file: first.file,
        hash,
        count: group.length,
      }
    })
}

async function readBaseline(path: string): Promise<BaselineEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineFile
    return parsed.surfaces ?? []
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function writeBaseline(path: string, surfaces: Surface[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const payload = {
    _meta: baselineMeta,
    surfaces: baselineEntries(surfaces),
  }
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`)
}

function printAddedSurface(surface: Surface): void {
  console.error('    x PUBLIC_SURFACE_ADDED public package export missing from baseline')
  console.error(`      ${surface.file}:${surface.line}`)
  console.error(
    `      expected: '${identityOf(surface)}' is already ratified in .public-surface-baseline.json; got: new public export`
  )
  console.error(
    '      FIX -> review the API change, then ratify with bun scripts/check-public-surface.ts --update-baseline.'
  )
}

function printRemovedSurface(entry: BaselineEntry): void {
  console.error('    x PUBLIC_SURFACE_REMOVED ratified public package export no longer exists')
  console.error(`      ${entry.file}`)
  console.error(
    `      expected: '${entry.hash}' still exists in the ACP-consumed package barrels; got: missing public export`
  )
  console.error(
    '      FIX -> restore the export or ratify the reviewed API removal with bun scripts/check-public-surface.ts --update-baseline.'
  )
}

function printParserDiagnostic(diagnostic: ParserDiagnostic): void {
  console.error('    x PUBLIC_SURFACE_PARSER_SUPPORT unresolved public barrel export')
  console.error(`      ${diagnostic.file}:${diagnostic.line}`)
  console.error(
    `      expected: barrel export resolves to origin symbols; got: ${diagnostic.message}`
  )
  console.error(
    '      FIX -> extend scripts/lib/import-graph.ts export parsing or adjust the barrel.'
  )
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const diagnostics: ParserDiagnostic[] = []
  const surfaces = dedupeSurfaces(await collectPackageSurfaces(options.root, diagnostics))

  if (diagnostics.length > 0) {
    console.error('Public package surface check failed: unsupported public barrel export form.')
    for (const diagnostic of diagnostics) {
      printParserDiagnostic(diagnostic)
    }
    process.exit(1)
  }

  if (options.updateBaseline) {
    await writeBaseline(options.baseline, surfaces)
    console.log(
      `Public package surface baseline updated: ${repoPath(options.root, options.baseline)}`
    )
    process.exit(0)
  }

  const baseline = await readBaseline(options.baseline)
  const baselineByIdentity = new Map(
    baseline.map((entry) => [entry.hash ?? `${entry.package}|${entry.symbol}|${entry.kind}`, entry])
  )
  const currentByIdentity = new Map(surfaces.map((surface) => [identityOf(surface), surface]))
  const added = surfaces.filter((surface) => !baselineByIdentity.has(identityOf(surface)))
  const removed = baseline.filter(
    (entry) =>
      !currentByIdentity.has(entry.hash ?? `${entry.package}|${entry.symbol}|${entry.kind}`)
  )

  if (added.length === 0 && removed.length === 0) {
    console.log('Public package surface check passed.')
    process.exit(0)
  }

  console.error('Public package surface check failed: baseline drift found.')
  for (const surface of added) {
    printAddedSurface(surface)
  }
  for (const entry of removed) {
    printRemovedSurface(entry)
  }
  process.exit(1)
}

await main()
