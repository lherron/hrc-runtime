import { describe, expect, it } from 'bun:test'

import { readTaskState } from '../task-state.js'

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
})
