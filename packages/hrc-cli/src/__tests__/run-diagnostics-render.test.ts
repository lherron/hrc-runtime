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

  it('renders the diagnostic envelope without hiding ordinary release and correlation values', () => {
    const lines: string[] = []
    const withEnvelope: RunDiagnostics = {
      ...diagnostics,
      releases: {
        hrc: { releaseId: 'hrc-20260922', sourceCommit: 'ca930f04' },
        aspd: { releaseId: 'aspd-20260922', sourceCommit: '9aff8211' },
        execution: { releaseId: 'execution-20260922', sourceCommit: 'f00d1234' },
      },
      ids: {
        requestId: 'req-open-value',
        operationId: 'op-open-value',
        compileId: 'cmp-open-value',
        runtimeId: 'rt-open-value',
        invocationId: 'inv-open-value',
        runId: 'run-open-value',
      },
      selection: {
        harness: 'claude-code',
        modelProvider: 'anthropic',
        model: 'claude-opus-5',
        reasoningEffort: 'high',
        presentation: true,
        provenance: {
          harness: 'profile clod',
          modelProvider: 'project target hrc-runtime',
          model: 'project target hrc-runtime',
          reasoningEffort: 'default',
          presentation: 'summon directive',
        },
      },
      execution: {
        driver: 'claude-tmux',
        recipeId: 'claude-interactive',
        protocol: 'harness-broker/0.2',
      },
    }

    renderRunDiagnostics(withEnvelope, { write: (line) => lines.push(line) })

    expect(lines.join('\n')).toContain(
      '  hrc hrc-20260922 @ ca930f04   aspd aspd-20260922 @ 9aff8211   execution execution-20260922 @ f00d1234'
    )
    expect(lines.join('\n')).toContain(
      '  ids request req-open-value   operation op-open-value   compile cmp-open-value   runtime rt-open-value   invocation inv-open-value   run run-open-value'
    )
    expect(lines.join('\n')).toContain('Selection')
    expect(lines.join('\n')).toContain('  harness  claude-code  from profile clod')
    expect(lines.join('\n')).toContain(
      '  model provider  anthropic  from project target hrc-runtime'
    )
    expect(lines.join('\n')).toContain('  model  claude-opus-5  from project target hrc-runtime')
    expect(lines.join('\n')).toContain('  effort  high  from default')
    expect(lines.join('\n')).toContain(
      '  driver claude-tmux  ·  recipe claude-interactive  ·  protocol harness-broker/0.2'
    )
  })

  it('omits absent diagnostic envelope fields instead of rendering undefined', () => {
    const lines: string[] = []
    renderRunDiagnostics(
      {
        ...diagnostics,
        releases: { hrc: { sourceCommit: 'ca930f04' } },
        ids: { runId: 'run-present' },
        selection: {
          harness: 'codex',
          modelProvider: 'openai',
          model: 'gpt-5',
          presentation: false,
          provenance: {
            harness: 'default',
            modelProvider: 'default',
            model: 'default',
            presentation: 'default',
          },
        },
      },
      { write: (line) => lines.push(line) }
    )

    const output = lines.join('\n')
    expect(output).toContain('  hrc ca930f04')
    expect(output).toContain('  ids run run-present')
    expect(output).not.toContain('undefined')
    expect(output).not.toContain('aspd')
    expect(output).not.toContain('execution')
    expect(output).not.toContain('effort')
    expect(output).not.toContain('driver')
  })
})
