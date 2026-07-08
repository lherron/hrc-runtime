import { describe, expect, it } from 'bun:test'

import type { HrcSessionRecord } from 'hrc-core'

import { toLegacyArgv } from '../cli/argv'
import { buildProgram } from '../cli/build-program'
import {
  parseScopeRef,
  parseSinceMs,
  relativeTime,
  renderPorcelain,
  renderSessions,
  shortSessionId,
} from '../session-render'

const NOW = new Date('2026-06-15T12:00:00.000Z')

function session(over: Partial<HrcSessionRecord>): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-ff6c1c65-4116-449c-a2df-547345fe1f4f',
    scopeRef: 'agent:clod:project:hrc-runtime:task:primary',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-06-15T11:00:00.000Z',
    updatedAt: '2026-06-15T11:58:00.000Z',
    ancestorScopeRefs: [],
    ...over,
  }
}

const baseOpts = { now: NOW, color: false, all: false, gens: false }

function dormantSession(over: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  return session({
    hostSessionId: 'hsid-d0d0d0d0-0000',
    scopeRef: 'agent:ariadne:project:hrc-runtime:task:T-04834',
    status: 'archived',
    updatedAt: '2026-05-10T08:00:00.000Z',
    continuation: { provider: 'anthropic', key: 'claude-resume-token' },
    ...over,
  })
}

describe('parseScopeRef', () => {
  it('splits agent and project:task label', () => {
    expect(parseScopeRef('agent:clod:project:hrc-runtime:task:primary')).toEqual({
      agent: 'clod',
      project: 'hrc-runtime',
      task: 'primary',
      scopeLabel: 'hrc-runtime:primary',
    })
  })
  it('handles project without task', () => {
    expect(parseScopeRef('agent:cody:project:agent-spaces')).toEqual({
      agent: 'cody',
      project: 'agent-spaces',
      task: undefined,
      scopeLabel: 'agent-spaces',
    })
  })
  it('handles an agent-root scope', () => {
    expect(parseScopeRef('agent:agent-minder')).toEqual({
      agent: 'agent-minder',
      project: undefined,
      task: undefined,
      scopeLabel: '(agent root)',
    })
  })
})

describe('shortSessionId', () => {
  it('strips hsid- and keeps the first uuid group', () => {
    expect(shortSessionId('hsid-ff6c1c65-4116-449c-a2df-547345fe1f4f')).toBe('ff6c1c65')
  })
})

describe('relativeTime', () => {
  it('renders minutes, hours, days', () => {
    expect(relativeTime(new Date('2026-06-15T11:58:00.000Z'), NOW)).toBe('2m ago')
    expect(relativeTime(new Date('2026-06-15T08:00:00.000Z'), NOW)).toBe('4h ago')
    expect(relativeTime(new Date('2026-06-12T12:00:00.000Z'), NOW)).toBe('3d ago')
  })
  it('clamps sub-minute to now', () => {
    expect(relativeTime(NOW, NOW)).toBe('now')
  })
})

describe('parseSinceMs', () => {
  it('parses h/d/w', () => {
    expect(parseSinceMs('12h')).toBe(12 * 3_600_000)
    expect(parseSinceMs('7d')).toBe(7 * 86_400_000)
    expect(parseSinceMs('2w')).toBe(14 * 86_400_000)
  })
  it('rejects junk', () => {
    expect(() => parseSinceMs('soon')).toThrow()
  })
})

describe('renderSessions', () => {
  it('shows a recent active head grouped under its agent', () => {
    const out = renderSessions([session({})], baseOpts)
    expect(out).toContain('clod')
    expect(out).toContain('hrc-runtime:primary')
    expect(out).toContain('◆')
    expect(out).toContain('ff6c1c65')
    expect(out).toContain('2m ago')
    expect(out).toContain('1 total')
  })

  it('hides archived + stale sessions by default and reports the count', () => {
    const out = renderSessions(
      [
        session({ hostSessionId: 'hsid-aaaaaaaa-0000', updatedAt: '2026-06-15T11:58:00.000Z' }),
        session({
          hostSessionId: 'hsid-bbbbbbbb-0000',
          status: 'archived',
          scopeRef: 'agent:clod:project:old:task:primary',
          updatedAt: '2026-05-01T00:00:00.000Z',
        }),
      ],
      baseOpts
    )
    expect(out).toContain('aaaaaaaa')
    expect(out).not.toContain('bbbbbbbb')
    expect(out).toContain('1 hidden')
    expect(out).toContain('1 archived')
  })

  it('collapses rotated generations into a rollup', () => {
    const lineage = (gen: number, id: string, updatedAt: string, status = 'active') =>
      session({ hostSessionId: id, generation: gen, status, updatedAt })
    const out = renderSessions(
      [
        lineage(3, 'hsid-cccc3333-0000', '2026-06-15T11:50:00.000Z'),
        lineage(2, 'hsid-cccc2222-0000', '2026-06-14T00:00:00.000Z', 'archived'),
        lineage(1, 'hsid-cccc1111-0000', '2026-06-13T00:00:00.000Z', 'archived'),
      ],
      baseOpts
    )
    expect(out).toContain('cccc3333')
    expect(out).toContain('2 older generations')
    expect(out).not.toContain('cccc2222') // collapsed, not listed
  })

  it('expands generations under --gens', () => {
    const lineage = (gen: number, id: string, updatedAt: string, status = 'active') =>
      session({ hostSessionId: id, generation: gen, status, updatedAt })
    const out = renderSessions(
      [
        lineage(2, 'hsid-dddd2222-0000', '2026-06-15T11:50:00.000Z'),
        lineage(1, 'hsid-dddd1111-0000', '2026-06-14T00:00:00.000Z', 'archived'),
      ],
      { ...baseOpts, gens: true }
    )
    expect(out).toContain('dddd2222')
    expect(out).toContain('dddd1111')
    expect(out).not.toContain('older generation')
  })

  it('keeps one head per lineage under --all (no predecessor promoted to a head)', () => {
    const lineage = (gen: number, id: string, updatedAt: string, status = 'active') =>
      session({ hostSessionId: id, generation: gen, status, updatedAt })
    const out = renderSessions(
      [
        lineage(3, 'hsid-eeee3333-0000', '2026-06-15T11:50:00.000Z'),
        lineage(2, 'hsid-eeee2222-0000', '2026-06-14T00:00:00.000Z', 'archived'),
        lineage(1, 'hsid-eeee1111-0000', '2026-06-13T00:00:00.000Z', 'archived'),
      ],
      { ...baseOpts, all: true }
    )
    // exactly one ◆ head, the newest generation; predecessors stay collapsed
    expect(out.match(/◆/g)?.length).toBe(1)
    expect(out).toContain('eeee3333')
    expect(out).toContain('2 older generations')
  })

  it('groups by project under --by-project, leading rows with the agent', () => {
    const out = renderSessions(
      [
        session({
          hostSessionId: 'hsid-11110000-0000',
          scopeRef: 'agent:clod:project:hrc-runtime:task:primary',
        }),
        session({
          hostSessionId: 'hsid-22220000-0000',
          scopeRef: 'agent:larry:project:hrc-runtime:task:T-04780',
        }),
        session({
          hostSessionId: 'hsid-33330000-0000',
          scopeRef: 'agent:cody:project:agent-spaces:task:primary',
        }),
      ],
      { ...baseOpts, groupBy: 'project' }
    )
    // project eyebrows, not agent eyebrows
    expect(out).toContain('hrc-runtime')
    expect(out).toContain('agent-spaces')
    // rows now lead with the agent · task
    expect(out).toContain('clod · primary')
    expect(out).toContain('larry · T-04780')
    expect(out).toContain('cody · primary')
  })

  it('flags a non-main lane', () => {
    const out = renderSessions([session({ laneRef: 'repair' })], baseOpts)
    expect(out).toContain('⟜repair')
  })

  it('renders an empty state', () => {
    expect(renderSessions([], baseOpts)).toContain('No sessions.')
  })

  it('reports an empty window when nothing is recent', () => {
    const out = renderSessions(
      [session({ status: 'archived', updatedAt: '2026-01-01T00:00:00.000Z' })],
      baseOpts
    )
    expect(out).toContain('No active sessions')
  })

  it('hides dormant heads by default but reports them with the narrow --dormant widener', () => {
    // Dormant sessions are archived rows with a continuation key: hidden by
    // default, but not silent because they are valid resume targets.
    const out = renderSessions(
      [
        session({ hostSessionId: 'hsid-active11-0000' }),
        dormantSession({ hostSessionId: 'hsid-dormant1-0000' }),
      ],
      baseOpts
    )

    expect(out).toContain('active11')
    expect(out).not.toContain('dormant1')
    expect(out).toContain('1 dormant')
    expect(out).toContain('widen: --dormant')
    expect(out.indexOf('--dormant')).toBeLessThan(out.indexOf('--all'))
  })

  it('--dormant includes resumable archived heads and keeps non-dormant archived heads hidden', () => {
    const out = renderSessions(
      [
        session({
          hostSessionId: 'hsid-active-recent-0000',
          scopeRef: 'agent:clod:project:hrc-runtime:task:recent',
          updatedAt: '2026-06-15T11:58:00.000Z',
        }),
        session({
          hostSessionId: 'hsid-active-stale-0000',
          scopeRef: 'agent:clod:project:hrc-runtime:task:stale',
          updatedAt: '2026-06-10T00:00:00.000Z',
        }),
        dormantSession({ hostSessionId: 'hsid-resum222-0000' }),
        session({
          hostSessionId: 'hsid-archived2-0000',
          scopeRef: 'agent:ariadne:project:hrc-runtime:task:archived',
          status: 'archived',
          updatedAt: '2026-05-10T08:00:00.000Z',
        }),
      ],
      { ...baseOpts, dormant: true }
    )

    expect(out).toContain('hrc-runtime:recent')
    expect(out).not.toContain('hrc-runtime:stale')
    expect(out).toContain('resum222')
    expect(out).toMatch(/\bdormant\b/)
    expect(out).not.toContain('archived2')
  })

  it('--all labels dormant and non-dormant archived heads distinctly from active heads', () => {
    const out = renderSessions(
      [
        session({ hostSessionId: 'hsid-actv3333-0000' }),
        dormantSession({ hostSessionId: 'hsid-resum333-0000' }),
        session({
          hostSessionId: 'hsid-archv333-0000',
          scopeRef: 'agent:ariadne:project:hrc-runtime:task:archived',
          status: 'archived',
          updatedAt: '2026-05-10T08:00:00.000Z',
        }),
      ],
      { ...baseOpts, all: true }
    )

    expect(out).toContain('actv3333')
    expect(out).toContain('resum333')
    expect(out).toContain('archv333')
    expect(out).toMatch(/\bdormant\b/)
    expect(out).toMatch(/\barchived\b/)
  })

  it('keeps dormant lineages to one head with older generations collapsed unless --gens expands them', () => {
    const head = dormantSession({
      hostSessionId: 'hsid-resmhead-0000',
      generation: 3,
      updatedAt: '2026-05-10T08:00:00.000Z',
    })
    const older = [
      dormantSession({
        hostSessionId: 'hsid-resmold2-0000',
        generation: 2,
        updatedAt: '2026-05-09T08:00:00.000Z',
      }),
      dormantSession({
        hostSessionId: 'hsid-resmold1-0000',
        generation: 1,
        updatedAt: '2026-05-08T08:00:00.000Z',
      }),
    ]

    const collapsed = renderSessions([head, ...older], { ...baseOpts, dormant: true })
    expect(collapsed).toContain('resmhead')
    expect(collapsed).toContain('2 older generations')
    expect(collapsed).not.toContain('resmold2')
    expect(collapsed).not.toContain('resmold1')

    const expanded = renderSessions([head, ...older], {
      ...baseOpts,
      dormant: true,
      gens: true,
    })
    expect(expanded).toContain('resmhead')
    expect(expanded).toContain('resmold2')
    expect(expanded).toContain('resmold1')
    expect(expanded).not.toContain('older generations')
  })
})

describe('renderPorcelain', () => {
  it('emits one tab-separated line per session', () => {
    const out = renderPorcelain([session({})])
    const cols = out.trimEnd().split('\t')
    expect(cols[0]).toBe('hsid-ff6c1c65-4116-449c-a2df-547345fe1f4f')
    expect(cols[1]).toBe('agent:clod:project:hrc-runtime:task:primary')
    expect(cols[2]).toBe('main')
    expect(cols[3]).toBe('g1')
    expect(cols[4]).toBe('active')
  })
  it('emits nothing for no sessions', () => {
    expect(renderPorcelain([])).toBe('')
  })
})

describe('session list --dormant CLI plumbing', () => {
  it('exposes --dormant on the commander session list command and preserves it for legacy handlers', () => {
    const program = buildProgram()
    const session = program.commands.find((cmd) => cmd.name() === 'session')
    const list = session?.commands.find((cmd) => cmd.name() === 'list')

    expect(list?.options.some((option) => option.long === '--dormant')).toBe(true)
    expect(toLegacyArgv([], { dormant: true }, { strings: [], booleans: ['dormant'] })).toContain(
      '--dormant'
    )
  })
})
