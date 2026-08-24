import { describe, expect, it } from 'bun:test'

import {
  HARD_CEILING_LINES,
  PRESSURE_LINES,
  countLines,
  evaluateTestSourceSizes,
} from './check-test-source-size.ts'

describe('check-test-source-size', () => {
  it('counts a final line without requiring a trailing newline', () => {
    expect(countLines('one\ntwo')).toBe(2)
    expect(countLines('one\ntwo\n')).toBe(3)
    expect(countLines('')).toBe(0)
  })

  it('reports pressure at 800 lines without rejecting the hard ceiling', () => {
    const report = evaluateTestSourceSizes([
      { path: 'packages/a.test.ts', lines: PRESSURE_LINES - 1 },
      { path: 'packages/b.test.ts', lines: PRESSURE_LINES },
      { path: 'scripts/c.test.ts', lines: HARD_CEILING_LINES },
    ])

    expect(report.pressure.map((file) => file.path)).toEqual([
      'scripts/c.test.ts',
      'packages/b.test.ts',
    ])
    expect(report.violations).toEqual([])
  })

  it('rejects only files above the 1,000-line ceiling', () => {
    const report = evaluateTestSourceSizes([
      { path: 'packages/allowed.test.ts', lines: HARD_CEILING_LINES },
      { path: 'packages/too-large.test.ts', lines: HARD_CEILING_LINES + 1 },
    ])

    expect(report.violations).toEqual([
      { path: 'packages/too-large.test.ts', lines: HARD_CEILING_LINES + 1 },
    ])
  })
})
