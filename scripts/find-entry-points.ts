import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  buildDependencyGraph,
  hrcPackages,
  parseExportReferences,
  repoPath,
} from './lib/import-graph.ts'

type Hit = {
  file: string
  line: number
  role: string
  score: number
}

const topic = process.argv[2]?.trim()

if (!topic) {
  console.error('usage: bun scripts/find-entry-points.ts <topic>')
  process.exit(1)
}

const repoRoot = process.cwd()
const topicLower = topic.toLowerCase()

function isEntryPointCandidate(file: string): boolean {
  if (file === 'packages/hrc-cli/src/cli/build-program.ts') {
    return true
  }
  if (file === 'packages/hrcchat-cli/src/main.ts') {
    return true
  }
  if (file.startsWith('packages/hrc-cli/src/commands/')) {
    return true
  }
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) {
    return true
  }
  if (/(route|routes|handler|handlers|server|daemon|controller|registry)/i.test(file)) {
    return true
  }
  return /(\.test|\.red|\.spec)\.tsx?$/.test(file) || file.includes('/__tests__/')
}

function isSpecCandidate(file: string): boolean {
  return /(\.test|\.red|\.spec)\.tsx?$/.test(file) || file.includes('/__tests__/')
}

function roleFor(file: string, lineText: string): string {
  if (isSpecCandidate(file)) {
    return `acceptance/spec coverage: ${lineText}`
  }
  if (file === 'packages/hrc-cli/src/cli/build-program.ts') {
    return `hrc CLI command registry: ${lineText}`
  }
  if (file === 'packages/hrcchat-cli/src/main.ts') {
    return `hrcchat CLI entry: ${lineText}`
  }
  if (file.startsWith('packages/hrc-cli/src/commands/')) {
    return `hrc CLI command entry: ${lineText}`
  }
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) {
    return `exported package surface: ${lineText}`
  }
  if (/(route|routes|handler|handlers|server|daemon|controller|registry)/i.test(file)) {
    return `runtime entry/handler: ${lineText}`
  }
  return `acceptance/spec coverage: ${lineText}`
}

function scoreHit(file: string, lineText: string): number {
  let score = 0
  const lowerFile = file.toLowerCase()
  const lowerLine = lineText.toLowerCase()
  if (lowerFile.includes(topicLower)) score += 80
  if (basename(file).toLowerCase().includes(topicLower)) score += 20
  if (lowerLine.includes(topicLower)) score += 60
  if (file === 'packages/hrc-cli/src/cli/build-program.ts') score += 25
  if (file === 'packages/hrcchat-cli/src/main.ts') score += 25
  if (file.startsWith('packages/hrc-cli/src/commands/')) score += 20
  if (/^packages\/[^/]+\/src\/index\.ts$/.test(file)) score += 10
  if (isSpecCandidate(file)) score -= 60
  return score
}

function firstMeaningfulLine(content: string): { line: number; text: string } {
  const lines = content.split('\n')
  const index = lines.findIndex((line) => line.trim().length > 0)
  return {
    line: index === -1 ? 1 : index + 1,
    text: (lines[index] ?? '').trim(),
  }
}

const graph = await buildDependencyGraph(repoRoot, ['packages'])
const packageRoots = new Set(hrcPackages.map((name) => `packages/${name}`))
const hits: Hit[] = []

for (const file of graph.files) {
  if (!packageRoots.has(file.split('/').slice(0, 2).join('/')) || !isEntryPointCandidate(file)) {
    continue
  }

  const absoluteFile = `${repoRoot}/${file}`
  const content = await readFile(absoluteFile, 'utf8')
  const lowerContent = content.toLowerCase()
  const fileMatches = file.toLowerCase().includes(topicLower)
  if (!fileMatches && !lowerContent.includes(topicLower)) {
    continue
  }

  const lines = content.split('\n')
  const matchingLineIndex = lines.findIndex((line) => line.toLowerCase().includes(topicLower))
  const locus =
    matchingLineIndex === -1
      ? firstMeaningfulLine(content)
      : { line: matchingLineIndex + 1, text: lines[matchingLineIndex]?.trim() ?? '' }
  const roleLine = locus.text.replace(/\s+/g, ' ').slice(0, 120)
  hits.push({
    file,
    line: locus.line,
    role: roleFor(file, roleLine),
    score: scoreHit(file, roleLine),
  })
}

for (const edge of graph.edges) {
  if (!edge.targetPackage || !edge.specifier.toLowerCase().includes(topicLower)) {
    continue
  }
  hits.push({
    file: edge.file,
    line: edge.line,
    role: `source-graph import: ${edge.specifier} -> ${edge.targetPackage}`,
    score: 55,
  })
}

for (const file of graph.files.filter((item) => /^packages\/[^/]+\/src\/index\.ts$/.test(item))) {
  const content = await readFile(`${repoRoot}/${file}`, 'utf8')
  for (const exported of parseExportReferences(
    repoPath(repoRoot, `${repoRoot}/${file}`),
    content
  )) {
    const text = [exported.symbol, exported.statement].filter(Boolean).join(' ')
    if (!text.toLowerCase().includes(topicLower)) {
      continue
    }
    hits.push({
      file,
      line: exported.line,
      role: `public export: ${exported.statement.replace(/\s+/g, ' ').slice(0, 120)}`,
      score: 70,
    })
  }
}

const uniqueHits = new Map<string, Hit>()
for (const hit of hits.sort(
  (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line
)) {
  const key = `${hit.file}:${hit.line}:${hit.role}`
  if (!uniqueHits.has(key)) {
    uniqueHits.set(key, hit)
  }
}

for (const hit of [...uniqueHits.values()].slice(0, 50)) {
  console.log(`${hit.file}:${hit.line}\t${hit.role}`)
}
