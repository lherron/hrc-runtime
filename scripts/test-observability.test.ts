import { describe, expect, test } from 'bun:test'

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
