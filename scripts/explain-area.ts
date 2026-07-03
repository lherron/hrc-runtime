import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type DependencyGraph,
  type ImportEdge,
  buildDependencyGraph,
  collectTsFiles,
  layerOf,
  packageGroup,
  parseExportReferences,
  repoPath,
} from './lib/import-graph.ts'

type Entry = {
  file: string
  line: number
  role: string
}

const areaInput = process.argv[2]?.trim()

if (!areaInput) {
  console.error('usage: bun scripts/explain-area.ts <file|dir>')
  process.exit(1)
}

const repoRoot = process.cwd()
const area = areaInput.replace(/\/+$/, '')
const areaAbsolute = join(repoRoot, area)

if (!existsSync(areaAbsolute)) {
  console.error(`area not found: ${area}`)
  process.exit(1)
}

function isInArea(file: string): boolean {
  return file === area || file.startsWith(`${area}/`)
}

function targetMatchesArea(edge: ImportEdge): boolean {
  if (edge.target && isInArea(edge.target)) {
    return true
  }
  if (
    edge.targetPackage &&
    (edge.targetPackage === area || edge.targetPackage.startsWith(`${area}/`))
  ) {
    return true
  }
  if (
    edge.targetPackage &&
    packageGroup(area) === edge.targetPackage &&
    area.startsWith(edge.targetPackage)
  ) {
    return true
  }
  return false
}

function printSection(title: string, entries: Entry[]): void {
  console.log(`${title}:`)
  for (const entry of entries) {
    console.log(`  ${entry.file}:${entry.line}\t${entry.role}`)
  }
}

function sortEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>()
  const unique: Entry[] = []
  for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const key = `${entry.file}:${entry.line}:${entry.role}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(entry)
    }
  }
  return unique
}

async function areaFiles(): Promise<string[]> {
  if (area.endsWith('.ts') || area.endsWith('.tsx')) {
    return [areaAbsolute]
  }
  const sourceRoot = existsSync(join(areaAbsolute, 'src'))
    ? join(areaAbsolute, 'src')
    : areaAbsolute
  return collectTsFiles(sourceRoot)
}

async function exportEntries(): Promise<Entry[]> {
  const entries: Entry[] = []

  for (const absoluteFile of (await areaFiles()).sort()) {
    const file = repoPath(repoRoot, absoluteFile)
    if (!/\/index\.ts$/.test(file) && file !== area) {
      continue
    }
    const content = await readFile(absoluteFile, 'utf8')
    for (const exported of parseExportReferences(file, content)) {
      entries.push({
        file,
        line: exported.line,
        role: `public export: ${exported.statement.replace(/\s+/g, ' ').slice(0, 120)}`,
      })
    }
  }

  return sortEntries(entries).slice(0, 40)
}

function importedByEntries(graph: DependencyGraph): Entry[] {
  return sortEntries(
    graph.edges
      .filter((edge) => !isInArea(edge.file) && targetMatchesArea(edge))
      .map((edge) => ({
        file: edge.file,
        line: edge.line,
        role: `imports ${edge.specifier}`,
      }))
  ).slice(0, 40)
}

function importEntries(graph: DependencyGraph): Entry[] {
  return sortEntries(
    graph.edges
      .filter((edge) => isInArea(edge.file))
      .map((edge) => ({
        file: edge.file,
        line: edge.line,
        role: `imports ${edge.specifier}${edge.target ? ` -> ${edge.target}` : ''}`,
      }))
  ).slice(0, 40)
}

async function specEntries(): Promise<Entry[]> {
  const files = await areaFiles()
  const packageName = packageGroup(area).split('/')[1] ?? area
  return sortEntries(
    files
      .map((absoluteFile) => repoPath(repoRoot, absoluteFile))
      .filter((file) => file.includes('/__tests__/') || /(\.test|\.red|\.spec)\.tsx?$/.test(file))
      .map((file) => ({
        file,
        line: 1,
        role: `spec for ${packageName}`,
      }))
  ).slice(0, 40)
}

const graph = await buildDependencyGraph(repoRoot, ['packages'])

console.log(`layer: ${layerOf(area)}`)
printSection('exports', await exportEntries())
printSection('imported by', importedByEntries(graph))
printSection('imports', importEntries(graph))
printSection('specs', await specEntries())
