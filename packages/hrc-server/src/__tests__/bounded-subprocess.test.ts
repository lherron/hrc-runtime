import { describe, expect, it } from 'bun:test'

import { SubprocessTimeoutError, runBoundedSubprocess } from '../bounded-subprocess'

describe('runBoundedSubprocess (T-10226)', () => {
  it('returns stdout, stderr and the exit code of a child that finishes', async () => {
    const result = await runBoundedSubprocess(['sh', '-c', 'printf out; printf err >&2; exit 3'], {
      timeoutMs: 5_000,
    })
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3 })
  })

  it('ends the wait at the budget even when an orphaned grandchild holds the pipes (0960fbc3)', async () => {
    const started = performance.now()
    const run = runBoundedSubprocess(['sh', '-c', 'sleep 30 & echo stale-stderr >&2; sleep 30'], {
      timeoutMs: 250,
    })
    await expect(run).rejects.toBeInstanceOf(SubprocessTimeoutError)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
