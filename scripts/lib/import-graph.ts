import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

export type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

export type ImportReference = {
  file: string
  line: number
  specifier: string
}

export type ExportReference = {
  file: string
  line: number
  kind: 'star' | 'namespace' | 'type' | 'value'
  statement: string
  symbol?: string | undefined
  local?: string | undefined
  specifier?: string | undefined
}

export type ImportEdge = ImportReference & {
  target?: string
  targetPackage?: string
}

export type DependencyGraph = {
  files: string[]
  edges: ImportEdge[]
  packageNames: Map<string, string>
}

export const hrcPackages = [
  'agent-action-render',
  'hrc-capture-verifier',
  'hrc-cli',
  'hrc-core',
  'hrc-events',
  'hrc-frame-render',
  'hrc-pi-top',
  'hrc-sdk',
  'hrc-server',
  'hrc-store-sqlite',
  'hrc-top',
  'hrcchat-cli',
]

export const layers: Layer[] = [
  {
    name: 'HRC Core Contracts',
    roots: ['packages/hrc-core/src', 'packages/hrc-events/src'],
    forbidden: ['hrc-server', 'hrc-cli', 'hrcchat-cli', 'acp-', 'gateway-', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC Storage',
    roots: ['packages/hrc-store-sqlite/src'],
    forbidden: ['hrc-server', 'hrc-cli', 'hrcchat-cli', 'acp-', 'gateway-', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC Rendering',
    roots: ['packages/agent-action-render/src', 'packages/hrc-frame-render/src'],
    forbidden: ['hrc-server', 'hrc-cli', 'hrcchat-cli', 'acp-', 'gateway-', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC Runtime',
    roots: ['packages/hrc-capture-verifier/src', 'packages/hrc-sdk/src', 'packages/hrc-server/src'],
    forbidden: ['acp-', 'gateway-', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC Operator CLIs',
    roots: [
      'packages/hrc-cli/src',
      'packages/hrcchat-cli/src',
      'packages/hrc-top/src',
      'packages/hrc-pi-top/src',
    ],
    forbidden: ['acp-', 'gateway-', 'wrkq-lib', 'wlearn'],
  },
]

export const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])

export const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

export function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

export async function collectTsFiles(root: string): Promise<string[]> {
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

export function parseImportReferences(file: string, content: string): ImportReference[] {
  const imports: ImportReference[] = []
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2]
    if (!specifier) {
      continue
    }

    imports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      specifier,
    })
  }
  return imports
}

function lineNumberForExportMember(
  content: string,
  fallbackIndex: number,
  memberIndex: number
): number {
  return lineNumberForIndex(content, memberIndex >= 0 ? memberIndex : fallbackIndex)
}

function parseExportMembers(text: string): string[] {
  return text
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean)
}

function cleanExportMember(
  text: string
): { local: string; symbol: string; typeOnly: boolean } | undefined {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (!withoutComments) {
    return undefined
  }

  const typeOnly = withoutComments.startsWith('type ')
  const cleaned = typeOnly ? withoutComments.replace(/^type\s+/, '').trim() : withoutComments
  const aliasMatch = cleaned.match(/^([A-Za-z_$][\w$]*|default)\s+as\s+([A-Za-z_$][\w$]*)$/)
  if (aliasMatch) {
    const local = aliasMatch[1]
    const symbol = aliasMatch[2]
    if (local && symbol) {
      return { local, symbol, typeOnly }
    }
  }

  const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*|default)$/)
  if (nameMatch) {
    const symbol = nameMatch[1]
    if (symbol) {
      return { local: symbol, symbol, typeOnly }
    }
  }

  return undefined
}

export function parseExportReferences(file: string, content: string): ExportReference[] {
  const exports: ExportReference[] = []

  for (const match of content.matchAll(
    /\bexport\s+(type\s+)?\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/g
  )) {
    const typeOnlyBlock = Boolean(match[1])
    const members = match[2] ?? ''
    const specifier = match[3]
    const statement = match[0]
    const statementIndex = match.index

    for (const member of parseExportMembers(members)) {
      const parsed = cleanExportMember(member)
      if (!parsed) {
        continue
      }

      const memberIndex = content.indexOf(member, statementIndex)
      exports.push({
        file,
        line: lineNumberForExportMember(content, statementIndex, memberIndex),
        kind: typeOnlyBlock || parsed.typeOnly ? 'type' : 'value',
        statement,
        symbol: parsed.symbol,
        local: parsed.local,
        specifier,
      })
    }
  }

  for (const match of content.matchAll(
    /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g
  )) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'namespace',
      statement: match[0],
      symbol: match[1],
      local: '*',
      specifier: match[2],
    })
  }

  for (const match of content.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'star',
      statement: match[0],
      specifier: match[1],
    })
  }

  for (const match of content.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(type|interface|const|let|var|async\s+function|function|class|enum)\s+([A-Za-z_$][\w$]*)/g
  )) {
    const declarationKind = match[1]
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: declarationKind === 'type' || declarationKind === 'interface' ? 'type' : 'value',
      statement: match[0],
      symbol: match[2],
      local: match[2],
    })
  }

  for (const match of content.matchAll(
    /\bexport\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/g
  )) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'value',
      statement: match[0],
      symbol: 'default',
      local: match[1] || 'default',
    })
  }

  return exports.sort(
    (left, right) => left.line - right.line || left.symbol?.localeCompare(right.symbol ?? '') || 0
  )
}

export function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

export function layerOf(file: string): string {
  const normalized = file.split(sep).join('/')
  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`
  for (const layer of layers) {
    if (
      layer.roots.some((root) => {
        const rootPrefix = root.endsWith('/') ? root : `${root}/`
        return (
          normalized === root ||
          withSlash.startsWith(rootPrefix) ||
          rootPrefix.startsWith(withSlash)
        )
      })
    ) {
      return layer.name
    }
  }
  return 'Unclassified'
}

export function repoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function buildPackageNameMap(repoRoot: string): Promise<Map<string, string>> {
  const packageNames = new Map<string, string>()
  const packagesDir = join(repoRoot, 'packages')
  let entries: Dirent[]
  try {
    entries = await readdir(packagesDir, { withFileTypes: true })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return packageNames
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const packageDir = `packages/${entry.name}`
    try {
      const packageJson = JSON.parse(
        await readFile(join(repoRoot, packageDir, 'package.json'), 'utf8')
      ) as { name?: string }
      if (typeof packageJson.name === 'string') {
        packageNames.set(packageJson.name, packageDir)
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') {
        throw error
      }
    }
  }

  return packageNames
}

function existingRepoPath(repoRoot: string, absoluteBase: string): string | undefined {
  const candidates =
    extname(absoluteBase) === ''
      ? [
          absoluteBase,
          `${absoluteBase}.ts`,
          `${absoluteBase}.tsx`,
          join(absoluteBase, 'index.ts'),
          join(absoluteBase, 'index.tsx'),
        ]
      : [
          absoluteBase,
          absoluteBase.replace(/\.(js|mjs|cjs)$/, '.ts'),
          absoluteBase.replace(/\.(js|mjs|cjs)$/, '.tsx'),
        ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return repoPath(repoRoot, candidate)
    }
  }

  return undefined
}

export async function workspacePackageDirs(repoRoot: string): Promise<Map<string, string>> {
  return buildPackageNameMap(repoRoot)
}

export function resolveImportTarget(
  fromFile: string,
  specifier: string,
  packageNames: Map<string, string>,
  repoRoot = process.cwd()
): Pick<ImportEdge, 'target' | 'targetPackage'> {
  if (specifier.startsWith('.')) {
    const absoluteFrom = join(repoRoot, fromFile)
    const target = existingRepoPath(repoRoot, resolve(dirname(absoluteFrom), specifier))
    return target ? { target, targetPackage: packageGroup(target) } : {}
  }

  const [scopeOrName, maybeName] = specifier.split('/')
  const packageName = specifier.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName
  if (packageName) {
    const targetPackage = packageNames.get(packageName)
    if (targetPackage) {
      return { target: targetPackage, targetPackage }
    }
  }

  return {}
}

export async function buildDependencyGraph(
  repoRoot = process.cwd(),
  roots = ['packages']
): Promise<DependencyGraph> {
  const packageNames = await buildPackageNameMap(repoRoot)
  const files = (
    await Promise.all(roots.map((root) => collectTsFiles(join(repoRoot, root))))
  ).flat()
  const edges: ImportEdge[] = []

  for (const absoluteFile of files.sort()) {
    const file = repoPath(repoRoot, absoluteFile)
    const content = await readFile(absoluteFile, 'utf8')
    for (const reference of parseImportReferences(file, content)) {
      edges.push({
        ...reference,
        ...resolveImportTarget(reference.file, reference.specifier, packageNames, repoRoot),
      })
    }
  }

  return {
    files: files.map((file) => repoPath(repoRoot, file)).sort(),
    edges,
    packageNames,
  }
}
