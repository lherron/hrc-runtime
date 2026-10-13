import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { slowest, summarizeAttempts } from './test-observability'

describe('test observability report', () => {
  test('distinguishes a retried flake from a persistent failure', () => {
    expect(
      summarizeAttempts('flake.test.ts', [
        { file: 'flake.test.ts', attempt: 1, durationMs: 100, exitCode: 1 },
        { file: 'flake.test.ts', attempt: 2, durationMs: 200, exitCode: 0 },
      ]).status
    ).toBe('flaky_pass')
    expect(
      summarizeAttempts('failed.test.ts', [
        { file: 'failed.test.ts', attempt: 1, durationMs: 100, exitCode: 1 },
        { file: 'failed.test.ts', attempt: 2, durationMs: 200, exitCode: 1 },
      ]).status
    ).toBe('failed')
  })

  test('orders slowest files by all attempts', () => {
    const results = [
      summarizeAttempts('fast.test.ts', [
        { file: 'fast.test.ts', attempt: 1, durationMs: 5, exitCode: 0 },
      ]),
      summarizeAttempts('slow.test.ts', [
        { file: 'slow.test.ts', attempt: 1, durationMs: 100, exitCode: 1 },
        { file: 'slow.test.ts', attempt: 2, durationMs: 200, exitCode: 0 },
      ]),
    ]
    expect(slowest(results)).toMatchObject([{ file: 'slow.test.ts' }, { file: 'fast.test.ts' }])
  })
})

describe('test observability CLI', () => {
  test('selects one root, isolates children, and retains Bun results', async () => {
    const root = await mkdtemp('/tmp/hrc-test-observability-')
    try {
      await mkdir(join(root, 'scripts'))
      await mkdir(join(root, 'packages'))
      await writeFile(
        join(root, 'scripts', 'probe.test.ts'),
        `import { test, expect } from 'bun:test';
test('startup environment', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'console.log(JSON.stringify({wrkq:process.env.WRKQ_DB, federation:process.env.HRC_FEDERATION_TEST_MODE}))'], {stdout:'pipe'});
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({wrkq:'rpc://127.0.0.1:1', federation:'loopback'});
  expect(await child.exited).toBe(0);
});`
      )
      await writeFile(
        join(root, 'packages', 'excluded.test.ts'),
        `import { test } from 'bun:test'; test('excluded', () => { throw new Error('wrong root'); });`
      )
      const output = join(root, 'report.json')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'test-observability.ts'),
          '--root',
          'scripts',
          '--retries',
          '0',
          '--output',
          output,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            WRKQ_DB: 'rpc://127.0.0.1:9',
            HRC_WRKQ_DB: 'rpc://127.0.0.1:9',
            HRC_FEDERATION_TEST_MODE: '',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).toContain('Files: 1; persistent failures: 0')
      const report = JSON.parse(await readFile(output, 'utf8'))
      expect(report.results).toHaveLength(1)
      expect(report.results[0].status).toBe('passed')
      const log = await readFile(report.results[0].attempts[0].logPath, 'utf8')
      expect(log).toContain('(pass) startup environment')
      expect(log).toContain('1 pass')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('kills a hung file and still writes a failure summary and log', async () => {
    const root = await mkdtemp('/tmp/hrc-test-observability-')
    try {
      await mkdir(join(root, 'scripts'))
      await mkdir(join(root, 'packages'))
      await writeFile(
        join(root, 'scripts', 'hang.test.ts'),
        `import { test } from 'bun:test'; test('hang', () => Bun.sleep(60000), 70000);`
      )
      const output = join(root, 'report.json')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'test-observability.ts'),
          '--root',
          'scripts',
          '--retries',
          '0',
          '--file-timeout-ms',
          '250',
          '--output',
          output,
        ],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' }
      )
      const [stdout, , exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit).toBe(1)
      expect(stdout).toContain('Files: 1; persistent failures: 1')
      const report = JSON.parse(await readFile(output, 'utf8'))
      expect(report.results[0].attempts[0]).toMatchObject({ exitCode: 124, timedOut: true })
      expect(report.results[0].attempts[0].durationMs).toBeLessThan(5000)
      expect(await readFile(report.results[0].attempts[0].logPath, 'utf8')).toContain(
        'file deadline exceeded'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
