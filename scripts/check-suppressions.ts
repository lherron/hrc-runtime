import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

type CliOptions = {
  root: string
  baseline: string
  updateBaseline: boolean
}

type CommentLine = {
  line: number
  text: string
}

type Suppression = {
  file: string
  line: number
  rule: string
  text: string
  hash: string
  commentText: string
}

type BaselineEntry = {
  file: string
  rule: string
  hash: string
  count: number
}

type BaselineFile = {
  _meta?: unknown
  suppressions?: unknown
}

const ignoredDirectories = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'tmp',
])

const ignoredRelativeDirectories = new Set(['packages/spaces-harness-broker/payload-dist'])

const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

const baselineMeta = {
  schemaVersion: 1,
  generatedBy: 'bun scripts/check-suppressions.ts --update-baseline',
  warning:
    'future suppressions use EXCEPTION(T-00000): reason; baseline update is for intentional grandfather/reset only and must be reviewed',
}

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd()
  let baseline = join(process.cwd(), '.suppression-baseline.json')
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
  return path.split('\\').join('/')
}

function extensionOf(path: string): string {
  const name = path.toLowerCase()
  for (const extension of sourceExtensions) {
    if (name.endsWith(extension)) {
      return extension
    }
  }
  return ''
}

function shouldScanFile(path: string): boolean {
  if (path.endsWith('.d.ts')) {
    return false
  }
  return sourceExtensions.has(extensionOf(path))
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        const relativePath = toSlash(relative(root, path))
        if (!ignoredDirectories.has(entry.name) && !ignoredRelativeDirectories.has(relativePath)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && shouldScanFile(path)) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function normalizeSuppressionLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function hashSuppressionLine(text: string): string {
  return createHash('sha256').update(normalizeSuppressionLine(text)).digest('hex')
}

function cleanCommentText(text: string): string {
  return text
    .replace(/^\s*\/\//, '')
    .replace(/^\s*\/\*/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*/, '')
    .trim()
}

function hasValidException(text: string): boolean {
  const cleaned = cleanCommentText(text)
  const match = cleaned.match(/\bEXCEPTION\(T-\d{4,}\):\s*(.+)$/)
  if (!match) {
    return false
  }

  const reason = match[1].replace(/\*\/\s*$/, '').trim()
  if (!reason) {
    return false
  }

  const normalizedReason = reason
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim()
  return !new Set(['todo', 'temporary', 'fix later']).has(normalizedReason)
}

function hasAdjacentException(
  suppression: Suppression,
  commentLinesByLine: Map<number, CommentLine[]>
): boolean {
  if (hasValidException(suppression.commentText)) {
    return true
  }

  const previousLineComments = commentLinesByLine.get(suppression.line - 1) ?? []
  return previousLineComments.some((comment) => hasValidException(comment.text))
}

function extractRule(kind: string, rest: string): string {
  const cleanedRest = rest.replace(/\*\/\s*$/, '').trim()

  if (kind.startsWith('@ts-')) {
    return kind
  }

  if (kind.startsWith('biome-ignore')) {
    const rule = cleanedRest.match(/^([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/)?.[1]
    return rule ?? kind
  }

  const ruleText = cleanedRest
    .split(/\s--\s/)[0]
    ?.replace(/:.*/, '')
    .trim()
  return ruleText || `${kind}:all`
}

function suppressionMatches(text: string): { kind: string; rest: string }[] {
  const matches: { kind: string; rest: string }[] = []
  const cleaned = cleanCommentText(text)
  const patterns = [
    /^(?<kind>biome-ignore(?:-(?:all|start|end))?)\b(?<rest>[^\n\r]*)/,
    /^(?<kind>@ts-ignore)\b(?<rest>[^\n\r]*)/,
    /^(?<kind>@ts-expect-error)\b(?<rest>[^\n\r]*)/,
    /^(?<kind>eslint-disable(?:-(?:next-line|line))?)\b(?<rest>[^\n\r]*)/,
  ]

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)
    const kind = match?.groups?.kind
    const rest = match?.groups?.rest
    if (kind === undefined || rest === undefined) {
      continue
    }
    matches.push({ kind, rest })
  }

  return matches
}

function collectCommentLines(content: string): CommentLine[] {
  const comments: CommentLine[] = []
  const lines = content.split(/\n/)
  let inBlockComment = false
  let stringQuote: "'" | '"' | '`' | undefined

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const lineNumber = lineIndex + 1
    let column = 0

    while (column < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', column)
        if (end === -1) {
          comments.push({ line: lineNumber, text: line.slice(column) })
          break
        }

        comments.push({ line: lineNumber, text: line.slice(column, end + 2) })
        column = end + 2
        inBlockComment = false
        continue
      }

      if (stringQuote) {
        const char = line[column]
        if (char === '\\') {
          column += 2
          continue
        }
        if (char === stringQuote) {
          stringQuote = undefined
        }
        column += 1
        continue
      }

      const char = line[column]
      const next = line[column + 1]
      if (char === "'" || char === '"' || char === '`') {
        stringQuote = char
        column += 1
        continue
      }

      if (char === '/' && next === '/') {
        comments.push({ line: lineNumber, text: line.slice(column) })
        break
      }

      if (char === '/' && next === '*') {
        const end = line.indexOf('*/', column + 2)
        if (end === -1) {
          comments.push({ line: lineNumber, text: line.slice(column) })
          inBlockComment = true
          break
        }

        comments.push({ line: lineNumber, text: line.slice(column, end + 2) })
        column = end + 2
        continue
      }

      column += 1
    }
  }

  return comments
}

function suppressionsInFile(root: string, file: string, content: string): Suppression[] {
  const relativeFile = toSlash(relative(root, file))
  const commentLines = collectCommentLines(content)
  const suppressions: Suppression[] = []

  for (const commentLine of commentLines) {
    for (const match of suppressionMatches(commentLine.text)) {
      suppressions.push({
        file: relativeFile,
        line: commentLine.line,
        rule: extractRule(match.kind, match.rest),
        text: normalizeSuppressionLine(commentLine.text),
        hash: hashSuppressionLine(commentLine.text),
        commentText: commentLine.text,
      })
    }
  }

  return suppressions
}

async function collectSuppressions(root: string): Promise<{
  suppressions: Suppression[]
  commentLinesByFile: Map<string, Map<number, CommentLine[]>>
}> {
  const files = await collectSourceFiles(root)
  const suppressions: Suppression[] = []
  const commentLinesByFile = new Map<string, Map<number, CommentLine[]>>()

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const relativeFile = toSlash(relative(root, file))
    const commentLines = collectCommentLines(content)
    const byLine = new Map<number, CommentLine[]>()

    for (const commentLine of commentLines) {
      const lineComments = byLine.get(commentLine.line) ?? []
      lineComments.push(commentLine)
      byLine.set(commentLine.line, lineComments)
    }

    commentLinesByFile.set(relativeFile, byLine)
    suppressions.push(...suppressionsInFile(root, file, content))
  }

  return {
    suppressions: suppressions.sort((left, right) => {
      const fileOrder = left.file.localeCompare(right.file)
      if (fileOrder !== 0) {
        return fileOrder
      }
      return left.line - right.line
    }),
    commentLinesByFile,
  }
}

function baselineKey(entry: Pick<BaselineEntry, 'file' | 'rule' | 'hash'>): string {
  return `${entry.file}\u0000${entry.rule}\u0000${entry.hash}`
}

function entriesForSuppressions(suppressions: Suppression[]): BaselineEntry[] {
  const counts = new Map<string, BaselineEntry>()
  for (const suppression of suppressions) {
    const key = baselineKey(suppression)
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      continue
    }

    counts.set(key, {
      file: suppression.file,
      rule: suppression.rule,
      hash: suppression.hash,
      count: 1,
    })
  }

  return [...counts.values()].sort((left, right) => {
    const fileOrder = left.file.localeCompare(right.file)
    if (fileOrder !== 0) {
      return fileOrder
    }
    const ruleOrder = left.rule.localeCompare(right.rule)
    if (ruleOrder !== 0) {
      return ruleOrder
    }
    return left.hash.localeCompare(right.hash)
  })
}

async function writeBaseline(path: string, suppressions: Suppression[]): Promise<void> {
  const baseline = {
    _meta: baselineMeta,
    suppressions: entriesForSuppressions(suppressions),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function parseBaselineEntry(value: unknown): BaselineEntry | undefined {
  const record = asRecord(value)
  const file = record.file
  const rule = record.rule
  const hash = record.hash
  const count = record.count ?? 1

  if (
    typeof file !== 'string' ||
    typeof rule !== 'string' ||
    typeof hash !== 'string' ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    return undefined
  }

  return { file, rule, hash, count }
}

async function readBaseline(path: string): Promise<Map<string, number>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineFile
  const entries = Array.isArray(parsed.suppressions) ? parsed.suppressions : []
  const counts = new Map<string, number>()

  for (const value of entries) {
    const entry = parseBaselineEntry(value)
    if (!entry) {
      continue
    }
    counts.set(baselineKey(entry), (counts.get(baselineKey(entry)) ?? 0) + entry.count)
  }

  return counts
}

function diagnosticFor(suppression: Suppression): string {
  return [
    `${suppression.file}:${suppression.line}: unapproved suppression`,
    `  ${suppression.text}`,
    '  fix: add `EXCEPTION(T-00000): reason` above it, or remove the suppression.',
    '  why: suppressions are reviewed exceptions, not free local silencing.',
    '  exception: update .suppression-baseline.json only for reviewed grandfather/reset changes.',
  ].join('\n')
}

async function main(): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const { suppressions, commentLinesByFile } = await collectSuppressions(options.root)

  if (options.updateBaseline) {
    await writeBaseline(options.baseline, suppressions)
    console.log(
      `Suppression baseline updated: ${toSlash(relative(process.cwd(), options.baseline))}`
    )
    return 0
  }

  let availableCounts: Map<string, number>
  try {
    availableCounts = await readBaseline(options.baseline)
  } catch (error) {
    console.error(
      `Unable to read suppression baseline ${toSlash(relative(process.cwd(), options.baseline))}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return 1
  }

  const failures: Suppression[] = []
  for (const suppression of suppressions) {
    const key = baselineKey(suppression)
    const available = availableCounts.get(key) ?? 0
    if (available > 0) {
      availableCounts.set(key, available - 1)
      continue
    }

    const fileComments = commentLinesByFile.get(suppression.file) ?? new Map()
    if (hasAdjacentException(suppression, fileComments)) {
      continue
    }

    failures.push(suppression)
  }

  if (failures.length === 0) {
    console.log('Suppression check passed.')
    return 0
  }

  console.error('Suppression check failed: new or changed suppressions need a reviewed exception.')
  console.error('')
  for (const failure of failures) {
    console.error(diagnosticFor(failure))
    console.error('')
  }

  return 1
}

process.exit(await main())
