/**
 * T-08708 AC3: `hrc run -v` streams client-side phases as they complete.
 *
 * On a TTY an in-progress phase owns one in-place line with a live elapsed
 * counter, overwritten on each tick and cleared before the phase's completed
 * line (and before attach). Off a TTY only plain completed lines are written —
 * no counter, no control sequences. Rendering never throws into the run.
 */
import { describe, expect, it } from 'bun:test'

import { createLiveRunPhaseStream, failedRunPhases } from '../cli/handlers-scope-cmd'

const CLEAR = '\r\x1b[2K'

function harness(isTTY: boolean, options: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = []
  let clock = 0
  let tick: (() => void) | undefined
  let cancelled = 0
  const stream = createLiveRunPhaseStream({
    output: {
      isTTY,
      write(chunk: string) {
        if (options.throwOnWrite) throw new Error('EPIPE')
        writes.push(chunk)
        return true
      },
    },
    now: () => clock,
    every: (fn) => {
      tick = fn
      return () => {
        cancelled += 1
        tick = undefined
      }
    },
  })
  return {
    stream,
    writes,
    advance(ms: number) {
      clock += ms
      tick?.()
    },
    ticking: () => tick !== undefined,
    cancelled: () => cancelled,
  }
}

describe('live run phase stream on a TTY', () => {
  it('overwrites an in-progress counter in place, then clears it before the completed line', () => {
    const h = harness(true)
    h.stream.begin('create-session')
    expect(h.writes).toEqual([`${CLEAR}  … create session  0ms`])
    h.advance(250)
    h.advance(1_250)
    expect(h.writes.slice(1)).toEqual([
      `${CLEAR}  … create session  250ms`,
      `${CLEAR}  … create session  1.50s`,
    ])

    h.stream.complete({ id: 'create-session', status: 'ok', ms: 1_512 })
    expect(h.writes.slice(3)).toEqual([CLEAR, '  ✓ create session  1.51s\n'])
    expect(h.ticking()).toBe(false)
    h.advance(1_000)
    expect(h.writes).toHaveLength(5)
  })

  it('streams server substeps atomically under their completed parent', () => {
    const h = harness(true)
    h.stream.begin('prepare-run')
    h.stream.complete({
      id: 'prepare-run',
      status: 'ok',
      ms: 900,
      children: [
        { id: 'compile', status: 'ok', ms: 600 },
        { id: 'broker-ready', status: 'warn', ms: 300, limitMs: 200 },
      ],
    })
    expect(h.writes.slice(1).join('')).toBe(
      `${CLEAR}  ✓ prepare run  900ms\n    ✓ compile  600ms\n    ⚠ wait for broker ready  300ms  (limit 200ms)\n`
    )
  })

  it('clear() erases the in-place counter and stops ticking before attach', () => {
    const h = harness(true)
    h.stream.begin('attach')
    h.stream.clear()
    expect(h.writes.at(-1)).toBe(CLEAR)
    expect(h.cancelled()).toBe(1)
    h.advance(500)
    expect(h.writes).toHaveLength(2)
    h.stream.clear()
    expect(h.writes).toHaveLength(2)
  })

  it('finish prints only what was not already streamed: remaining phases, envelope, total', () => {
    const h = harness(true)
    h.stream.complete({ id: 'resolve-scope', status: 'ok', ms: 10 })
    h.stream.begin('create-session')
    h.stream.finish(
      {
        releases: { hrc: { releaseId: 'r1', sourceCommit: 'abc123' } },
        ids: { runId: 'run-1' },
        phases: [
          { id: 'resolve-scope', status: 'ok', ms: 10 },
          { id: 'compile', status: 'error', ms: 5, reason: 'refused' },
        ],
      },
      { totalLabel: 'total' }
    )
    expect(h.writes.join('')).toBe(
      `  ✓ resolve scope  10ms\n${CLEAR}  … create session  0ms${CLEAR}  ✗ compile  5ms  refused\n  hrc r1 @ abc123\n  ids run run-1\n  total  15ms\n`
    )
    expect(h.ticking()).toBe(false)
  })
})

describe('live run phase stream off a TTY', () => {
  it('writes plain completed lines only: no counter, no ticker, no control sequences', () => {
    const h = harness(false)
    h.stream.begin('create-session')
    h.advance(1_000)
    expect(h.ticking()).toBe(false)
    h.stream.complete({ id: 'create-session', status: 'ok', ms: 1_000 })
    h.stream.clear()
    expect(h.writes).toEqual(['  ✓ create session  1s\n'])
    expect(h.writes.join('')).not.toContain('\x1b')
    expect(h.writes.join('')).not.toContain('\r')
  })
})

describe('live run phase stream never alters the run', () => {
  it('swallows output errors from every entry point', () => {
    const h = harness(true, { throwOnWrite: true })
    expect(() => {
      h.stream.begin('create-session')
      h.advance(100)
      h.stream.complete({ id: 'create-session', status: 'ok', ms: 100 })
      h.stream.begin('attach')
      h.stream.clear()
      h.stream.finish({ releases: {}, ids: {}, phases: [] })
    }).not.toThrow()
    expect(h.ticking()).toBe(false)
  })
})

describe('a thrown client operation keeps its record (AC5)', () => {
  const completed = [
    { id: 'resolve-scope', status: 'ok' as const, ms: 4 },
    { id: 'create-session', status: 'ok' as const, ms: 20 },
  ]

  it('marks the in-flight step failed with its duration and later client steps not-reached', () => {
    expect(failedRunPhases(completed, { id: 'prepare-run', ms: 812 }, [])).toEqual([
      ...completed,
      { id: 'prepare-run', status: 'error', ms: 812 },
      { id: 'attach', status: 'not-reached', reason: 'not reached after prepare-run' },
    ])
  })

  it('preserves server-supplied failing children under the failed client step', () => {
    const serverPhases = [
      { id: 'compile', status: 'ok' as const, ms: 500 },
      { id: 'admission', status: 'error' as const, ms: 2, reason: 'refused' },
    ]
    expect(failedRunPhases(completed, { id: 'prepare-run', ms: 812 }, serverPhases)).toEqual([
      ...completed,
      { id: 'prepare-run', status: 'error', ms: 812, children: serverPhases },
      { id: 'attach', status: 'not-reached', reason: 'not reached after prepare-run' },
    ])
  })

  it('a thrown resolveSession fails create-session and never reaches prepare or attach', () => {
    expect(failedRunPhases(completed.slice(0, 1), { id: 'create-session', ms: 30 }, [])).toEqual([
      completed[0],
      { id: 'create-session', status: 'error', ms: 30 },
      { id: 'prepare-run', status: 'not-reached', reason: 'not reached after create-session' },
      { id: 'attach', status: 'not-reached', reason: 'not reached after create-session' },
    ])
  })

  it('renders through finish after the streamed prefix, clearing the counter', () => {
    const h = harness(true)
    h.stream.complete(completed[0])
    h.stream.complete(completed[1])
    h.stream.begin('prepare-run')
    h.stream.finish({
      releases: {},
      ids: {},
      phases: failedRunPhases(completed, { id: 'prepare-run', ms: 812 }, [
        { id: 'admission', status: 'error', ms: 2, reason: 'refused' },
      ]),
    })
    expect(h.writes.slice(3).join('')).toBe(
      `${CLEAR}  ✗ prepare run  812ms\n    ✗ check identity + admission  2ms  refused\n  – attach terminal  not reached after prepare-run\n  total  836ms\n`
    )
  })
})
