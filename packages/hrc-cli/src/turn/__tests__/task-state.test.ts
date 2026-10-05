import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boundedProcess, readTaskState } from '../task-state.js'

type ExecResult = { stdout: string; stderr: string; exitCode: number }

function fakeExec(result: Partial<ExecResult> | (() => never)) {
  return async (argv: string[]): Promise<ExecResult> => {
    if (typeof result === 'function') {
      result()
    }
    lastArgv = argv
    return { stdout: '', stderr: '', exitCode: 0, ...(result as Partial<ExecResult>) }
  }
}

let lastArgv: string[] = []

describe('readTaskState', () => {
  it('returns the state from the first record of a wrkq cat --json array', async () => {
    const state = await readTaskState(
      'T-04216',
      fakeExec({ stdout: JSON.stringify([{ id: 'T-04216', state: 'completed' }]) })
    )
    expect(state).toBe('completed')
    expect(lastArgv).toEqual(['wrkq', 'cat', 'T-04216', '--json'])
  })

  it('accepts a bare object as well as an array', async () => {
    const state = await readTaskState(
      'T-1',
      fakeExec({ stdout: JSON.stringify({ id: 'T-1', state: 'in_progress' }) })
    )
    expect(state).toBe('in_progress')
  })

  it('returns null on a non-zero exit code (task not found)', async () => {
    const state = await readTaskState(
      'T-404',
      fakeExec({ stdout: '', stderr: 'not found', exitCode: 1 })
    )
    expect(state).toBeNull()
  })

  it('returns null on unparseable output', async () => {
    const state = await readTaskState('T-1', fakeExec({ stdout: 'not json' }))
    expect(state).toBeNull()
  })

  it('returns null when the subprocess throws (wrkq unavailable)', async () => {
    const state = await readTaskState(
      'T-1',
      fakeExec(() => {
        throw new Error('spawn failed')
      })
    )
    expect(state).toBeNull()
  })

  it('returns null when the record has no state field', async () => {
    const state = await readTaskState('T-1', fakeExec({ stdout: JSON.stringify([{ id: 'T-1' }]) }))
    expect(state).toBeNull()
  })

  // --- adversarial additions (smokey) ---

  it('returns null when wrkq cat --json returns an empty array', async () => {
    const state = await readTaskState('T-1', fakeExec({ stdout: JSON.stringify([]) }))
    expect(state).toBeNull()
  })

  it('returns null when the state field is an empty string', async () => {
    const state = await readTaskState(
      'T-1',
      fakeExec({ stdout: JSON.stringify([{ id: 'T-1', state: '' }]) })
    )
    expect(state).toBeNull()
  })

  it('returns null when the state field is JSON null', async () => {
    const state = await readTaskState(
      'T-1',
      fakeExec({ stdout: JSON.stringify([{ id: 'T-1', state: null }]) })
    )
    expect(state).toBeNull()
  })

  // T-10244: enrichment must not stall the final frame on a slow wrkq.
  it('counts a wrkq that outlives the bound as no enrichment', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'slow-wrkq-'))
    const wrkq = join(bin, 'wrkq')
    writeFileSync(wrkq, '#!/bin/sh\n/bin/sleep 30\necho \'[{"state":"completed"}]\'\n')
    chmodSync(wrkq, 0o755)
    const startedAt = performance.now()
    try {
      const state = await readTaskState('T-1', boundedProcess(200, { ...process.env, PATH: bin }))
      expect(state).toBeNull()
      expect(performance.now() - startedAt).toBeLessThan(2_000)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
