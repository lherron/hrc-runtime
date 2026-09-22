import { describe, expect, test } from 'bun:test'

import {
  createPhaseRecorder,
  formatDiagnosticDuration,
  maskDiagnosticArgv,
  maskDiagnosticEnvironment,
  maskDiagnosticString,
} from '../run-diagnostics.js'

describe('run diagnostics phase recorder', () => {
  test('retains a failing step duration and rethrows the original error', async () => {
    let now = 10
    const recorder = createPhaseRecorder({ now: () => now })
    const failure = new Error('boom')

    await expect(
      recorder.step('compile', async () => {
        now = 42
        throw failure
      })
    ).rejects.toBe(failure)

    expect(recorder.records()).toEqual([{ id: 'compile', status: 'error', ms: 32 }])
  })

  test('nests child records, clamps unattributed time, and marks remaining steps', async () => {
    let now = 0
    const recorder = createPhaseRecorder({ now: () => now })

    await recorder.step('preview', async (parent) => {
      await parent.step('compile', async () => {
        now = 8
      })
      await parent.step('inspect-prompt', async () => {
        now = 20
      })
      now = 19 // a non-monotonic test clock must not produce negative `other`
    })
    recorder.notReached('attach', 'compile failed')

    expect(recorder.records()).toEqual([
      {
        id: 'preview',
        status: 'ok',
        ms: 19,
        children: [
          { id: 'compile', status: 'ok', ms: 8 },
          { id: 'inspect-prompt', status: 'ok', ms: 12 },
          { id: 'other', status: 'ok', ms: 0 },
        ],
      },
      { id: 'attach', status: 'not-reached', reason: 'compile failed' },
    ])
  })

  test('warns at a limit and swallows a throwing observation sink', async () => {
    let now = 0
    const recorder = createPhaseRecorder({
      now: () => now,
      sink: () => {
        throw new Error('sink unavailable')
      },
    })

    const value = await recorder.step(
      'compile',
      async () => {
        now = 16
        return 'ok'
      },
      { limitMs: 15 }
    )

    expect(value).toBe('ok')
    expect(recorder.records()).toEqual([{ id: 'compile', status: 'warn', ms: 16, limitMs: 15 }])
  })
})

describe('run diagnostics presentation primitives', () => {
  test('formats short and long durations without rendering missing data as zero', () => {
    expect(formatDiagnosticDuration(4)).toBe('4ms')
    expect(formatDiagnosticDuration(361)).toBe('361ms')
    expect(formatDiagnosticDuration(1210)).toBe('1.21s')
    expect(formatDiagnosticDuration(124_000)).toBe('2m04s')
    expect(formatDiagnosticDuration(undefined)).toBe('—')
  })

  test('masks secret environment values but preserves non-secret and *_FILE paths', () => {
    expect(
      maskDiagnosticEnvironment({
        API_KEY: 'super-secret-value',
        TOKEN_FILE: '/run/secrets/token',
        AUTHOR: 'Lance',
        hostSessionId: 'hs-123',
      })
    ).toEqual({
      API_KEY: '•••• (18 chars)',
      TOKEN_FILE: '/run/secrets/token',
      AUTHOR: 'Lance',
      hostSessionId: 'hs-123',
    })
  })

  test('masks secret argv flag values and credential-shaped free strings', () => {
    expect(
      maskDiagnosticArgv(['tool', '--token=abc123', '--api-key', 'xyz789', '--author', 'Lance'])
    ).toEqual([
      'tool',
      '--token=•••• (6 chars)',
      '--api-key',
      '•••• (6 chars)',
      '--author',
      'Lance',
    ])
    expect(
      maskDiagnosticString('Bearer eyJabc.def.ghi and ghp_abcdefghijklmnopqrstuvwxyz123456')
    ).toBe('Bearer •••• (14 chars) and •••• (36 chars)')
  })
})
