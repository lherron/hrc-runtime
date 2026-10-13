/**
 * Runs authored test files independently and writes durable timing/retry evidence.
 *
 * Intended for scheduled CI: a failing first attempt is retried once so the report
 * distinguishes a persistent failure from a flake. The JSON report is suitable for
 * CI artifact retention; the Markdown companion keeps the slowest twenty readable.
 */
import { closeSync, openSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { hermeticTestEnvironment } from './lib/hermetic-test-env'

export type TestAttempt = {
  durationMs: number
  exitCode: number
  file: string
  attempt: number
  logPath?: string
  timedOut?: boolean
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

async function testFiles(roots: string[]): Promise<string[]> {
  const files = new Set<string>()
  for (const root of roots) {
    for (const pattern of ['**/*.test.ts', '**/*.spec.ts']) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
        if (!path.split('/').includes('node_modules')) files.add(`${root}/${path}`)
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

async function runFile(
  file: string,
  retries: number,
  timeoutMs: number,
  logDirectory: string
): Promise<TestFileResult> {
  const attempts: TestAttempt[] = []
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const startedAt = performance.now()
    const logPath = resolve(logDirectory, `${file.replaceAll('/', '__')}.attempt-${attempt}.log`)
    await writeFile(logPath, `# ${file}, attempt ${attempt}\n`)
    // One shared file descriptor preserves both streams without holding a pipe
    // open when a test spawns descendants. Evidence survives a runner timeout.
    const logFd = openSync(logPath, 'a')
    // Match the root integration tier, including the environment a child with
    // no explicit env inherits. A preload alone cannot seal that environment.
    const proc = Bun.spawn([process.execPath, 'test', '--timeout', '10000', `./${file}`], {
      cwd: process.cwd(),
      env: {
        ...hermeticTestEnvironment(process.env),
        TMPDIR: '/tmp',
        HRC_FEDERATION_TEST_MODE: 'loopback',
      },
      stdout: logFd,
      stderr: logFd,
      detached: true,
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      // Only this test's process group: includes any fixture children that
      // would otherwise survive the deadline with inherited output handles.
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }, timeoutMs)
    const childExitCode = await proc.exited.finally(() => {
      clearTimeout(deadline)
      closeSync(logFd)
    })
    const exitCode = timedOut ? 124 : childExitCode
    await appendFile(
      logPath,
      `\n${timedOut ? `file deadline exceeded (${timeoutMs}ms)\n` : ''}exit ${exitCode}\n`
    )
    attempts.push({
      attempt,
      durationMs: performance.now() - startedAt,
      exitCode,
      file,
      logPath,
      timedOut,
    })
    if (exitCode === 0) break
  }
  return summarizeAttempts(file, attempts)
}

async function main(): Promise<number> {
  const output = argument('--output') ?? 'test-observability.json'
  const retries = Number(argument('--retries') ?? '1')
  const timeoutMs = Number(argument('--file-timeout-ms') ?? '120000')
  const selectedRoot = argument('--root')
  const roots = selectedRoot === undefined ? ['packages', 'scripts'] : [selectedRoot]
  if (!Number.isInteger(retries) || retries < 0)
    throw new Error('--retries must be a non-negative integer')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('--file-timeout-ms must be a positive integer')

  const files = await testFiles(roots)
  if (files.length === 0) throw new Error(`no test files found in ${roots.join(', ')}`)
  const logDirectory = `${output}.logs`
  await mkdir(logDirectory, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const results: TestFileResult[] = []
  for (const file of files) {
    const result = await runFile(file, retries, timeoutMs, logDirectory)
    results.push(result)
    const seconds = result.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / 1000
    console.log(`${result.status.padEnd(10)} ${seconds.toFixed(2)}s ${result.file}`)
    // Keep partial evidence if the caller's overall deadline ends the run.
    await Bun.write(
      output,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results, slowest: slowest(results) }, null, 2)}\n`
    )
  }

  const report = { generatedAt: new Date().toISOString(), results, slowest: slowest(results) }
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`)
  await Bun.write(output.replace(/\.json$/, '.md'), markdown(results))
  console.log(
    `Files: ${results.length}; persistent failures: ${results.filter((result) => result.status === 'failed').length}; flaky passes: ${results.filter((result) => result.status === 'flaky_pass').length}.`
  )
  return results.some((result) => result.status === 'failed') ? 1 : 0
}

if (import.meta.main) process.exit(await main())
