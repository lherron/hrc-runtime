import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SubprocessOutputLimitError,
  SubprocessTimeoutError,
  runBoundedSubprocess,
} from '../bounded-subprocess'

describe('runBoundedSubprocess (T-10226)', () => {
  it('returns stdout, stderr and the exit code of a child that finishes', async () => {
    const result = await runBoundedSubprocess(['sh', '-c', 'printf out; printf err >&2; exit 3'], {
      timeoutMs: 5_000,
    })
    expect(result).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
      signalCode: null,
      stdoutBytes: 3,
    })
  })

  it('ends the wait at the budget even when an orphaned grandchild holds the pipes (0960fbc3)', async () => {
    const started = performance.now()
    const run = runBoundedSubprocess(['sh', '-c', 'sleep 30 & echo stale-stderr >&2; sleep 30'], {
      timeoutMs: 250,
    })
    await expect(run).rejects.toBeInstanceOf(SubprocessTimeoutError)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('feeds stdin and closes it, so a reader that waits for EOF finishes', async () => {
    const result = await runBoundedSubprocess(['cat'], { timeoutMs: 5_000, stdin: '{"a":1}' })
    expect(result.stdout).toBe('{"a":1}')
    expect(result.exitCode).toBe(0)
  })

  it('kills a child past maxStdoutBytes and rejects with the output-limit error', async () => {
    const started = performance.now()
    const run = runBoundedSubprocess(['sh', '-c', 'yes; sleep 30'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    })
    await expect(run).rejects.toBeInstanceOf(SubprocessOutputLimitError)
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('stops reading past maxStdoutBytes, so an orphaned writer dies of a closed pipe', async () => {
    // Without processGroup the kill reaches only the shell; its background
    // writer kept the pipe and the reader drained it for the rest of the
    // process. In the server test tier that leaked `yes` preceded every Bun
    // SIGTRAP (T-10232 phase 3).
    const pidFile = join(mkdtempSync(join(tmpdir(), 'bounded-subprocess-')), 'writer.pid')
    const run = runBoundedSubprocess(['sh', '-c', `yes & echo $! > ${pidFile}; wait`], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    })
    await expect(run).rejects.toBeInstanceOf(SubprocessOutputLimitError)
    const writer = Number(readFileSync(pidFile, 'utf8').trim())
    expect(writer).toBeGreaterThan(0)
    const deadline = performance.now() + 2_000
    let alive = true
    while (alive && performance.now() < deadline) {
      await Bun.sleep(50)
      try {
        process.kill(writer, 0)
      } catch {
        alive = false
      }
    }
    if (alive) process.kill(writer, 'SIGKILL')
    expect(alive).toBe(false)
  })

  it('kills the whole process group on timeout when processGroup is set', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'bounded-subprocess-')), 'grandchild.pid')
    const run = runBoundedSubprocess(['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], {
      timeoutMs: 500,
      processGroup: true,
    })
    await expect(run).rejects.toBeInstanceOf(SubprocessTimeoutError)
    await Bun.sleep(100)
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    expect(grandchild).toBeGreaterThan(0)
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  it('reports the signal that ended a child, never a clean exit', async () => {
    const result = await runBoundedSubprocess(['sh', '-c', 'kill -TERM $$'], { timeoutMs: 5_000 })
    expect(result.signalCode).toBe('SIGTERM')
    expect(result.exitCode).not.toBe(0)
  })

  it('keeps only the stderr tail when stderrTailChars is set', async () => {
    const result = await runBoundedSubprocess(['sh', '-c', 'printf abcdefghij >&2'], {
      timeoutMs: 5_000,
      stderrTailChars: 4,
    })
    expect(result.stderr).toBe('ghij')
  })
})
