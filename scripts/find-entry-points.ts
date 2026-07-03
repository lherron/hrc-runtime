import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  buildDependencyGraph,
  hrcPackages,
  parseExportStatements,
  repoPath,
} from './lib/import-graph.ts'

type Hit = {
  file: string
  line: number
  role: string
  score: number
}

type ClassifiedLine = {
  line: number
  text: string
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

function roleFor(file: string, lineText: string, classification: string): string {
  if (classification === 'command') {
    return `CLI command registration: ${lineText}`
  }
  if (classification === 'definition') {
    return `definition entry: ${lineText}`
  }
  if (classification === 'wiring') {
    return `wiring import: ${lineText}`
  }
  if (classification === 'usage') {
    return `usage: ${lineText}`
  }
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

function isCommentLine(lineText: string): boolean {
  const trimmed = lineText.trim()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('/**')
  )
}

function isImportLine(lineText: string): boolean {
  return /^\s*import\b/.test(lineText)
}

function isTypeOnlyLine(lineText: string): boolean {
  return /^\s*(export\s+)?(type|interface)\b/.test(lineText) || /^\s*import\s+type\b/.test(lineText)
}

function isCommandRegistrationLine(lineText: string): boolean {
  return /\.command\(\s*['"][^'"]+['"]/.test(lineText)
}

function isDefinitionLine(lineText: string): boolean {
  return (
    /^\s*export\s+(async\s+)?(function|class|const|let|var|enum)\b/.test(lineText) ||
    /^\s*(async\s+)?function\s+[A-Za-z_$][\w$]*/.test(lineText) ||
    /^\s*class\s+[A-Za-z_$][\w$]*/.test(lineText)
  )
}

function classifyLine(
  file: string,
  lineNumber: number,
  lineText: string
): ClassifiedLine | undefined {
  const text = lineText.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!text || isCommentLine(lineText) || isTypeOnlyLine(lineText)) {
    return undefined
  }

  if (isSpecCandidate(file)) {
    return {
      line: lineNumber,
      text,
      role: roleFor(file, text, 'spec'),
      score: 10,
    }
  }

  if (isCommandRegistrationLine(lineText)) {
    return {
      line: lineNumber,
      text,
      role: roleFor(file, text, 'command'),
      score: 95,
    }
  }

  if (isDefinitionLine(lineText)) {
    return {
      line: lineNumber,
      text,
      role: roleFor(file, text, 'definition'),
      score: 90,
    }
  }

  if (isImportLine(lineText)) {
    return {
      line: lineNumber,
      text,
      role: roleFor(file, text, 'wiring'),
      score: 20,
    }
  }

  return {
    line: lineNumber,
    text,
    role: roleFor(file, text, 'usage'),
    score: 5,
  }
}

function bestMatchingLine(file: string, content: string): ClassifiedLine | undefined {
  const lines = content.split('\n')
  const matches: ClassifiedLine[] = []

  for (const [index, line] of lines.entries()) {
    if (!line.toLowerCase().includes(topicLower)) {
      continue
    }
    const classified = classifyLine(file, index + 1, line)
    if (classified) {
      matches.push(classified)
    }
  }

  if (matches.length === 0 && basename(file).toLowerCase().includes(topicLower)) {
    for (const [index, line] of lines.entries()) {
      const classified = classifyLine(file, index + 1, line)
      if (classified && classified.score >= 90) {
        matches.push(classified)
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score || a.line - b.line)[0]
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

  const locus = bestMatchingLine(file, content)
  if (!locus) {
    continue
  }
  hits.push({
    file,
    line: locus.line,
    role: locus.role,
    score: locus.score + scoreHit(file, locus.text),
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
  for (const exported of parseExportStatements(
    repoPath(repoRoot, `${repoRoot}/${file}`),
    content
  )) {
    const text = [exported.symbols.join(' '), exported.statement].filter(Boolean).join(' ')
    if (!text.toLowerCase().includes(topicLower)) {
      continue
    }
    hits.push({
      file,
      line: exported.line,
      role: `public export: ${exported.symbols.join(', ')}`,
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
