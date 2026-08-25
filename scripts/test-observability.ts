/**
 * Runs authored test files independently and writes durable timing/retry evidence.
 *
 * Intended for scheduled CI: a failing first attempt is retried once so the report
 * distinguishes a persistent failure from a flake. The JSON report is suitable for
 * CI artifact retention; the Markdown companion keeps the slowest twenty readable.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type TestAttempt = {
  durationMs: number
  exitCode: number
  file: string
  attempt: number
}

export type TestFileResult = {
  attempts: TestAttempt[]
  file: string
  status: 'passed' | 'flaky_pass' | 'failed'
}

export function summarizeAttempts(file: string, attempts: TestAttempt[]): TestFileResult {
  const passed = attempts.some((attempt) => attempt.exitCode === 0)
  return {
    file,
    attempts,
    status: passed ? (attempts[0]?.exitCode === 0 ? 'passed' : 'flaky_pass') : 'failed',
  }
}

export function slowest(results: TestFileResult[], count = 20): TestFileResult[] {
  return [...results]
    .sort((left, right) => {
      const leftDuration = left.attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
      const rightDuration = right.attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
      return rightDuration - leftDuration || left.file.localeCompare(right.file)
    })
    .slice(0, count)
}

async function testFiles(): Promise<string[]> {
  const files = new Set<string>()
  for (const root of ['packages', 'scripts']) {
    for (const pattern of ['**/*.test.ts', '**/*.spec.ts']) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        files.add(`${root}/${path}`)
      }
    }
  }
  return [...files].sort()
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function markdown(results: TestFileResult[]): string {
  const flaky = results.filter((result) => result.status === 'flaky_pass')
  const failed = results.filter((result) => result.status === 'failed')
  const rows = slowest(results).map((result) => {
    const duration = result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
    return `| ${result.file} | ${result.status} | ${(duration / 1000).toFixed(2)} | ${result.attempts.length} |`
  })
  return [
    '# HRC test observability',
    '',
    `Files: ${results.length}; persistent failures: ${failed.length}; flaky passes: ${flaky.length}.`,
    '',
    '## Slowest 20 files',
    '',
    '| File | Status | Total seconds | Attempts |',
    '| --- | --- | ---: | ---: |',
    ...rows,
    '',
  ].join('\n')
}

async function runFile(file: string, retries: number): Promise<TestFileResult> {
  const attempts: TestAttempt[] = []
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const startedAt = performance.now()
    const proc = Bun.spawn(['bun', 'test', file], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: '/tmp' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    attempts.push({ attempt, durationMs: performance.now() - startedAt, exitCode, file })
    if (exitCode === 0) break
  }
  return summarizeAttempts(file, attempts)
}

async function main(): Promise<number> {
  const output = argument('--output') ?? 'test-observability.json'
  const retries = Number(argument('--retries') ?? '1')
  if (!Number.isInteger(retries) || retries < 0)
    throw new Error('--retries must be a non-negative integer')

  const results: TestFileResult[] = []
  for (const file of await testFiles()) {
    const result = await runFile(file, retries)
    results.push(result)
    console.log(`${result.status.padEnd(10)} ${result.file}`)
  }

  const report = { generatedAt: new Date().toISOString(), results, slowest: slowest(results) }
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(output.replace(/\.json$/, '.md'), markdown(results))
  return results.some((result) => result.status === 'failed') ? 1 : 0
}

if (import.meta.main) process.exit(await main())
