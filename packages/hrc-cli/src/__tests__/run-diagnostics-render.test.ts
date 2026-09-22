import { describe, expect, it } from 'bun:test'

import type { RunDiagnostics } from 'hrc-core'

import { compactRunTimingFooter, renderRunDiagnostics } from '../cli/run-diagnostics-render.js'

describe('run diagnostics rendering', () => {
  const diagnostics: RunDiagnostics = {
    releases: {},
    ids: {},
    phases: [
      { id: 'resolve-scope', status: 'ok', ms: 4 },
      {
        id: 'daemon-preview',
        status: 'ok',
        ms: 1_620,
        children: [
          { id: 'compile', status: 'warn', ms: 1_210, limitMs: 1_000 },
          { id: 'inspect-prompt', status: 'ok', ms: 361 },
          { id: 'other', status: 'ok', ms: 49 },
        ],
      },
      { id: 'attach', status: 'skipped', reason: 'skipped (dry run)' },
    ],
  }

  it('renders nested phases, limits, reconciliation, and unmeasured skips', () => {
    const lines: string[] = []
    renderRunDiagnostics(diagnostics, { write: (line) => lines.push(line) })
    expect(lines.join('\n')).toContain('  ✓ daemon preview  1.62s')
    expect(lines.join('\n')).toContain('    ⚠ compile  1.21s  (limit 1s)')
    expect(lines.join('\n')).toContain('    · other  49ms')
    expect(lines.join('\n')).toContain('  – attach terminal  skipped (dry run)')
    expect(lines.find((line) => line.includes('attach terminal'))).not.toContain('0ms')
  })

  it('summarizes compile and prompt timing for default dry-run output', () => {
    expect(compactRunTimingFooter(diagnostics)).toBe(
      'ready in 1.62s (compile 1.21s, prompt 361ms) — -v for timeline'
    )
  })
})
