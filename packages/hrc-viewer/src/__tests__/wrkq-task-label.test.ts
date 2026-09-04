/**
 * T-04977 — best-effort wrkq task-slug resolution for the status bar.
 *
 * Covers task-id extraction from scope refs, slug parsing, and the memoizing
 * resolver across success / non-zero exit / malformed JSON / empty result /
 * missing slug / thrown-runner / non-task-scope paths. The resolver must never
 * throw and must never spawn for non-task scopes.
 */

import { describe, expect, it } from 'bun:test'

import {
  type WrkqRunResult,
  createTaskSlugResolver,
  extractTaskIdFromScope,
  isPlaceholderTaskSlug,
  parseTaskSlug,
} from '../wrkq-task-label.js'

const ok = (stdout: string): WrkqRunResult => ({ stdout, stderr: '', exitCode: 0 })
const slugJson = (slug: unknown) => JSON.stringify([{ id: 'T-04977', slug }])
/** A real hcs placeholder observed on a chief pane (T-08028). */
const PLACEHOLDER = 'context-1788523795324905000'

describe('extractTaskIdFromScope', () => {
  it('returns the task id for a canonical T-<digits> scope', () => {
    expect(extractTaskIdFromScope('agent:clod:project:hrc-runtime:task:T-04977')).toBe('T-04977')
  })

  it('returns null for primary, lane-only, or non-task scopes', () => {
    expect(extractTaskIdFromScope('agent:daedalus:project:agent-spaces:task:primary')).toBeNull()
    expect(extractTaskIdFromScope('agent:clod:project:hrc-runtime')).toBeNull()
  })

  it('returns null for a non-T task segment', () => {
    expect(extractTaskIdFromScope('agent:clod:project:hrc-runtime:task:repair')).toBeNull()
  })

  it('returns null for an unparseable scope ref', () => {
    expect(extractTaskIdFromScope('not-a-scope')).toBeNull()
  })
})

describe('parseTaskSlug', () => {
  it('reads the slug from the first record of a wrkq cat array', () => {
    expect(parseTaskSlug(slugJson('add-task-slug-to-ghostmux-status-bar'))).toBe(
      'add-task-slug-to-ghostmux-status-bar'
    )
  })

  it('accepts a bare object record too', () => {
    expect(parseTaskSlug(JSON.stringify({ slug: 'a-slug' }))).toBe('a-slug')
  })

  it('returns null on malformed JSON', () => {
    expect(parseTaskSlug('Error: container not found')).toBeNull()
    expect(parseTaskSlug('')).toBeNull()
  })

  it('returns null on an empty array', () => {
    expect(parseTaskSlug('[]')).toBeNull()
  })

  it('returns null on a missing or empty slug', () => {
    expect(parseTaskSlug(JSON.stringify([{ id: 'T-1' }]))).toBeNull()
    expect(parseTaskSlug(slugJson(''))).toBeNull()
    expect(parseTaskSlug(slugJson('   '))).toBeNull()
    expect(parseTaskSlug(slugJson(42))).toBeNull()
  })

  it('trims surrounding whitespace from the slug', () => {
    expect(parseTaskSlug(slugJson('  trimmed  '))).toBe('trimmed')
  })
})

describe('createTaskSlugResolver', () => {
  it('resolves the slug for a task scope', async () => {
    const resolve = createTaskSlugResolver({ runner: async () => ok(slugJson('my-slug')) })
    expect(await resolve('agent:clod:project:hrc-runtime:task:T-04977')).toBe('my-slug')
  })

  it('never spawns the runner for a non-task scope', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return ok(slugJson('x'))
      },
    })
    expect(await resolve('agent:daedalus:project:agent-spaces:task:primary')).toBeNull()
    expect(calls).toBe(0)
  })

  it('returns null on a non-zero exit', async () => {
    const resolve = createTaskSlugResolver({
      runner: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }),
    })
    expect(await resolve('agent:clod:project:hrc-runtime:task:T-1')).toBeNull()
  })

  it('returns null on malformed JSON and on a missing slug', async () => {
    const bad = createTaskSlugResolver({ runner: async () => ok('not json') })
    expect(await bad('agent:clod:project:hrc-runtime:task:T-1')).toBeNull()
    const noSlug = createTaskSlugResolver({ runner: async () => ok('[]') })
    expect(await noSlug('agent:clod:project:hrc-runtime:task:T-2')).toBeNull()
  })

  it('returns null (never throws) when the runner throws', async () => {
    const resolve = createTaskSlugResolver({
      runner: async () => {
        throw new Error('wrkq missing')
      },
    })
    expect(await resolve('agent:clod:project:hrc-runtime:task:T-1')).toBeNull()
  })

  it('memoizes a successful slug per task id (one spawn for repeated repaints)', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return ok(slugJson('cached-slug'))
      },
    })
    const scope = 'agent:clod:project:hrc-runtime:task:T-04977'
    expect(await resolve(scope)).toBe('cached-slug')
    expect(await resolve(scope)).toBe('cached-slug')
    expect(await resolve(scope)).toBe('cached-slug')
    expect(calls).toBe(1)
  })

  it('does not cache failures — a transient miss stays retryable', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return calls === 1 ? { stdout: '', stderr: 'fail', exitCode: 1 } : ok(slugJson('later'))
      },
    })
    const scope = 'agent:clod:project:hrc-runtime:task:T-04977'
    expect(await resolve(scope)).toBeNull()
    expect(await resolve(scope)).toBe('later')
    expect(calls).toBe(2)
  })
})

describe('isPlaceholderTaskSlug (T-08028)', () => {
  it('recognizes the hcs `context-<19 digits>` placeholder', () => {
    expect(isPlaceholderTaskSlug(PLACEHOLDER)).toBe(true)
  })

  it('does not classify a settled human slug as a placeholder', () => {
    expect(isPlaceholderTaskSlug('wrkc-steer-default')).toBe(false)
    expect(isPlaceholderTaskSlug('context-aware-routing')).toBe(false)
    expect(isPlaceholderTaskSlug('context-1788523795324905000-renamed')).toBe(false)
    expect(isPlaceholderTaskSlug('context-123')).toBe(false)
  })
})

describe('createTaskSlugResolver placeholder staleness (T-08028)', () => {
  it('re-reads a placeholder and yields the real slug on the next call', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return ok(slugJson(calls === 1 ? PLACEHOLDER : 'wrkc-steer-default'))
      },
    })
    const scope = 'agent:chief:project:hcs:task:T-07987'
    expect(await resolve(scope)).toBe(PLACEHOLDER)
    expect(await resolve(scope)).toBe('wrkc-steer-default')
    expect(calls).toBe(2)
  })

  it('pins the real slug once it lands — no further spawns', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return ok(slugJson(calls === 1 ? PLACEHOLDER : 'wrkc-steer-default'))
      },
    })
    const scope = 'agent:chief:project:hcs:task:T-07987'
    await resolve(scope)
    expect(await resolve(scope)).toBe('wrkc-steer-default')
    expect(await resolve(scope)).toBe('wrkc-steer-default')
    expect(await resolve(scope)).toBe('wrkc-steer-default')
    expect(calls).toBe(2)
  })

  it('spawns exactly once for a task whose slug is already settled', async () => {
    let calls = 0
    const resolve = createTaskSlugResolver({
      runner: async () => {
        calls++
        return ok(slugJson('already-settled'))
      },
    })
    const scope = 'agent:chief:project:hcs:task:T-08007'
    for (let i = 0; i < 5; i++) expect(await resolve(scope)).toBe('already-settled')
    expect(calls).toBe(1)
  })
})
