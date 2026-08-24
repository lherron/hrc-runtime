/**
 * Reports authored TypeScript test-source pressure.
 *
 * The check deliberately scans only package and repository scripts test files;
 * generated output, dependencies, documentation, and production sources are
 * outside this policy. Use --enforce once the current baseline is below the
 * hard ceiling.
 */

export const PRESSURE_LINES = 800
export const HARD_CEILING_LINES = 1000

export interface TestSourceSize {
  path: string
  lines: number
}

export interface TestSourceSizeReport {
  pressure: TestSourceSize[]
  violations: TestSourceSize[]
}

export function countLines(source: string): number {
  return source === '' ? 0 : source.split('\n').length
}

export function evaluateTestSourceSizes(
  files: TestSourceSize[],
  pressureLines = PRESSURE_LINES,
  hardCeilingLines = HARD_CEILING_LINES
): TestSourceSizeReport {
  const ordered = [...files].sort(
    (left, right) => right.lines - left.lines || left.path.localeCompare(right.path)
  )
  return {
    pressure: ordered.filter((file) => file.lines >= pressureLines),
    violations: ordered.filter((file) => file.lines > hardCeilingLines),
  }
}

async function authoredTestSources(): Promise<TestSourceSize[]> {
  const files = new Set<string>()
  for (const root of ['packages', 'scripts']) {
    for (const pattern of ['**/*.test.ts', '**/*.spec.ts']) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        files.add(`${root}/${path}`)
      }
    }
  }

  return Promise.all(
    [...files]
      .sort()
      .map(async (path) => ({ path, lines: countLines(await Bun.file(path).text()) }))
  )
}

function format(report: TestSourceSizeReport): string {
  const rows = report.pressure.map((file) => {
    const status = file.lines > HARD_CEILING_LINES ? 'VIOLATION' : 'pressure'
    return `  ${status.padEnd(9)} ${String(file.lines).padStart(4)}  ${file.path}`
  })
  return rows.length === 0
    ? `test-source-size: no authored test file is at or above ${PRESSURE_LINES} lines ✓`
    : [
        `test-source-size: ${report.pressure.length} file(s) at or above ${PRESSURE_LINES} lines`,
        ...rows,
      ].join('\n')
}

async function main(): Promise<number> {
  const enforce = process.argv.includes('--enforce')
  const report = evaluateTestSourceSizes(await authoredTestSources())
  console.log(format(report))
  if (enforce && report.violations.length > 0) {
    console.error(
      `test-source-size: ${report.violations.length} authored test file(s) exceed ${HARD_CEILING_LINES} lines`
    )
    return 1
  }
  return 0
}

if (import.meta.main) process.exit(await main())
