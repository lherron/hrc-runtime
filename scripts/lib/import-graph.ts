import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

export type ExportReference = {
  file: string
  line: number
  kind: 'star' | 'namespace' | 'type' | 'value'
  statement: string
  symbol?: string | undefined
  local?: string | undefined
  specifier?: string | undefined
}

export type ImportEdge = {
  target?: string
  targetPackage?: string
}

export function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
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
    return { local: aliasMatch[1], symbol: aliasMatch[2], typeOnly }
  }

  const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*|default)$/)
  if (nameMatch) {
    return { local: nameMatch[1], symbol: nameMatch[1], typeOnly }
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

function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

export function repoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function buildPackageNameMap(repoRoot: string): Promise<Map<string, string>> {
  const packageNames = new Map<string, string>()
  const packagesDir = join(repoRoot, 'packages')
  const entries = await readdir(packagesDir, { withFileTypes: true })

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
): ImportEdge {
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
