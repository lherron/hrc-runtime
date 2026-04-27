/**
 * RED/GREEN TDD tests for HRC selector parsing and normalization (T-00949)
 *
 * Spec reference: HRC_IMPLEMENTATION_PLAN.md § Selectors
 *
 * Selectors identify sessions for HRC operations. Two kinds:
 *   - Stable selectors: { sessionRef } — used for mutating APIs (resolve, ensure, dispatch, clear-context)
 *   - Concrete selectors: { hostSessionId } — allowed only for interrupt, terminate, capture, attach
 *
 * parseSelector must:
 *   - accept valid sessionRef strings and return a normalized HrcSelector
 *   - accept concrete hostSessionId selectors for read/observational operations
 *   - reject malformed or empty selectors
 *   - normalize whitespace and casing in sessionRef values
 */

import { describe, expect, test } from 'bun:test'

import {
  type HrcSelector,
  formatCanonicalScopeRef,
  formatCanonicalSessionRef,
  formatSelector,
  isConcreteSelector,
  isStableSelector,
  normalizeSessionRef,
  parseSelector,
} from '../selectors.js'

// ===================================================================
// Selector parsing
// ===================================================================

describe('parseSelector (T-00949)', () => {
  test('parses a valid sessionRef selector', () => {
    const result = parseSelector({ sessionRef: 'agent:rex:project:myproject/lane:default' })
    expect(result).toBeDefined()
    expect(result.kind).toBe('stable')
    expect(result.sessionRef).toBe('agent:rex:project:myproject/lane:default')
  })

  test('parses a valid concrete hostSessionId selector', () => {
    const result = parseSelector({ hostSessionId: 'hsid-abc-123' })
    expect(result).toBeDefined()
    expect(result.kind).toBe('concrete')
    expect(result.hostSessionId).toBe('hsid-abc-123')
  })

  test('rejects empty object', () => {
    expect(() => parseSelector({} as any)).toThrow()
  })

  test('rejects selector with both sessionRef and hostSessionId', () => {
    expect(() => parseSelector({ sessionRef: 'x', hostSessionId: 'y' } as any)).toThrow()
  })

  test('rejects empty sessionRef string', () => {
    expect(() => parseSelector({ sessionRef: '' })).toThrow()
  })

  test('rejects whitespace-only sessionRef', () => {
    expect(() => parseSelector({ sessionRef: '   ' })).toThrow()
  })

  test('rejects empty hostSessionId string', () => {
    expect(() => parseSelector({ hostSessionId: '' })).toThrow()
  })

  test('rejects non-string sessionRef', () => {
    expect(() => parseSelector({ sessionRef: 42 } as any)).toThrow()
  })

  test('rejects non-string hostSessionId', () => {
    expect(() => parseSelector({ hostSessionId: null } as any)).toThrow()
  })
})

// ===================================================================
// Session ref normalization
// ===================================================================

describe('normalizeSessionRef (T-00949)', () => {
  test('trims leading/trailing whitespace', () => {
    expect(normalizeSessionRef('  agent:rex:project:foo/lane:bar  ')).toBe(
      'agent:rex:project:foo/lane:bar'
    )
  })

  test('preserves valid sessionRef as-is', () => {
    const ref = 'agent:rex:project:my-project/lane:default'
    expect(normalizeSessionRef(ref)).toBe(ref)
  })

  test('returns consistent output for equivalent refs', () => {
    const a = normalizeSessionRef('agent:rex:project:foo/lane:bar')
    const b = normalizeSessionRef('  agent:rex:project:foo/lane:bar  ')
    expect(a).toBe(b)
  })
})

// ===================================================================
// Selector kind guards
// ===================================================================

// ===================================================================
// Canonical scopeRef validation (T-01077 — SCOPEREF_CLEANUP Phase 2)
//
// RED GATE: splitSessionRef must call validateScopeRef() from agent-scope
// and reject non-canonical forms. Currently it only checks format, not
// canonical prefix.
// ===================================================================

describe('splitSessionRef rejects non-canonical scopeRefs (T-01077)', () => {
  // Non-canonical forms must be rejected
  const nonCanonical = [
    { input: 'app:hrc-cli/lane:main', reason: 'app: prefix is not a canonical agent scope' },
    { input: 'app:workbench/lane:default', reason: 'app: prefix is synthetic' },
    {
      input: 'project:myproject/lane:default',
      reason: 'project: without agent: prefix is invalid',
    },
    { input: 'project:foo/lane:bar', reason: 'bare project: is not canonical' },
    { input: 'task:T-001/lane:main', reason: 'bare task: is not canonical' },
    { input: 'role:operator/lane:main', reason: 'bare role: is not canonical' },
    { input: 'workspace:main/lane:default', reason: 'workspace: is not a valid scope kind' },
    { input: 'user:alice/lane:default', reason: 'user: is not a valid scope kind' },
  ]

  for (const { input, reason } of nonCanonical) {
    test(`rejects "${input}" — ${reason}`, () => {
      expect(() => normalizeSessionRef(input)).toThrow()
    })

    test(`parseSelector rejects non-canonical "${input}"`, () => {
      expect(() => parseSelector({ sessionRef: input })).toThrow()
    })
  }
})

describe('splitSessionRef accepts all 5 canonical agent: forms (T-01077)', () => {
  // All 5 canonical ScopeRef forms per acp-spec
  const canonical = [
    'agent:rex/lane:main',
    'agent:rex:project:agent-spaces/lane:default',
    'agent:rex:project:agent-spaces:role:operator/lane:main',
    'agent:rex:project:agent-spaces:task:T-00123/lane:main',
    'agent:rex:project:agent-spaces:task:T-00123:role:investigator/lane:repair',
  ]

  for (const ref of canonical) {
    test(`accepts canonical "${ref}"`, () => {
      const result = normalizeSessionRef(ref)
      expect(result).toBe(ref)
    })

    test(`parseSelector accepts canonical "${ref}"`, () => {
      const sel = parseSelector({ sessionRef: ref })
      expect(sel.kind).toBe('stable')
      expect(sel.sessionRef).toBe(ref)
    })
  }
})

// ===================================================================
// Selector kind guards
// ===================================================================

describe('Selector kind guards (T-00949)', () => {
  test('isStableSelector returns true for sessionRef selectors', () => {
    const sel: HrcSelector = { kind: 'stable', sessionRef: 'agent:rex:project:x/lane:y' }
    expect(isStableSelector(sel)).toBe(true)
    expect(isConcreteSelector(sel)).toBe(false)
  })

  test('isConcreteSelector returns true for hostSessionId selectors', () => {
    const sel: HrcSelector = { kind: 'concrete', hostSessionId: 'hsid-1' }
    expect(isConcreteSelector(sel)).toBe(true)
    expect(isStableSelector(sel)).toBe(false)
  })
})

// ===================================================================
// Monitor selector grammar (T-01285 / MONITOR_PROPOSAL.md §5)
// ===================================================================

const monitorSelectorCases = [
  {
    raw: 'cody@agent-spaces',
    kind: 'target',
    canonicalSelector: 'session:agent:cody:project:agent-spaces/lane:main',
    expected: {
      raw: 'cody@agent-spaces',
      scopeRef: 'agent:cody:project:agent-spaces',
      sessionRef: 'agent:cody:project:agent-spaces/lane:main',
      scopeHandle: 'cody@agent-spaces',
      sessionHandle: 'cody@agent-spaces',
    },
  },
  {
    raw: 'cody@agent-spaces:T-01282',
    kind: 'target',
    canonicalSelector: 'session:agent:cody:project:agent-spaces:task:T-01282/lane:main',
    expected: {
      raw: 'cody@agent-spaces:T-01282',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01282',
      sessionRef: 'agent:cody:project:agent-spaces:task:T-01282/lane:main',
      scopeHandle: 'cody@agent-spaces:T-01282',
      sessionHandle: 'cody@agent-spaces:T-01282',
    },
  },
  {
    raw: 'cody@agent-spaces:T-01282~repair',
    kind: 'target',
    canonicalSelector: 'session:agent:cody:project:agent-spaces:task:T-01282/lane:repair',
    expected: {
      raw: 'cody@agent-spaces:T-01282~repair',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01282',
      sessionRef: 'agent:cody:project:agent-spaces:task:T-01282/lane:repair',
      scopeHandle: 'cody@agent-spaces:T-01282',
      sessionHandle: 'cody@agent-spaces:T-01282~repair',
    },
  },
  {
    raw: 'scope:agent:cody:project:agent-spaces:task:T-01282',
    kind: 'scope',
    canonicalSelector: 'scope:agent:cody:project:agent-spaces:task:T-01282',
    expected: {
      raw: 'scope:agent:cody:project:agent-spaces:task:T-01282',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01282',
      scopeHandle: 'cody@agent-spaces:T-01282',
    },
  },
  {
    raw: 'session:agent:cody:project:agent-spaces:task:T-01282/lane:repair',
    kind: 'session',
    canonicalSelector: 'session:agent:cody:project:agent-spaces:task:T-01282/lane:repair',
    expected: {
      raw: 'session:agent:cody:project:agent-spaces:task:T-01282/lane:repair',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01282',
      sessionRef: 'agent:cody:project:agent-spaces:task:T-01282/lane:repair',
      scopeHandle: 'cody@agent-spaces:T-01282',
      sessionHandle: 'cody@agent-spaces:T-01282~repair',
    },
  },
  {
    raw: 'host:hsid-abc-123',
    kind: 'host',
    canonicalSelector: 'host:hsid-abc-123',
    expected: { raw: 'host:hsid-abc-123', hostSessionId: 'hsid-abc-123' },
  },
  {
    raw: 'runtime:rt_abc123',
    kind: 'runtime',
    canonicalSelector: 'runtime:rt_abc123',
    expected: { raw: 'runtime:rt_abc123', runtimeId: 'rt_abc123' },
  },
  {
    raw: 'msg:msg-c3cce940-ba33-45e2-8ec0-36c2383f34b6',
    kind: 'message',
    canonicalSelector: 'msg:msg-c3cce940-ba33-45e2-8ec0-36c2383f34b6',
    expected: {
      raw: 'msg:msg-c3cce940-ba33-45e2-8ec0-36c2383f34b6',
      messageId: 'msg-c3cce940-ba33-45e2-8ec0-36c2383f34b6',
    },
  },
  {
    raw: 'seq:764',
    kind: 'message-seq',
    canonicalSelector: 'seq:764',
    expected: { raw: 'seq:764', messageSeq: 764 },
  },
] as const

describe('parseSelector monitor grammar (T-01285)', () => {
  for (const c of monitorSelectorCases) {
    test(`parses ${c.raw}`, () => {
      const selector = parseSelector(c.raw) as any

      expect(selector.kind).toBe(c.kind)
      expect(selector).toMatchObject(c.expected)
    })
  }

  test('canonical scopeRef serialization omits task for bare project scope and never includes lane', () => {
    expect(formatCanonicalScopeRef({ agentId: 'cody', projectId: 'agent-spaces' })).toBe(
      'agent:cody:project:agent-spaces'
    )
    expect(
      formatCanonicalScopeRef({
        agentId: 'cody',
        projectId: 'agent-spaces',
        taskId: 'T-01282',
        laneId: 'repair',
      } as any)
    ).toBe('agent:cody:project:agent-spaces:task:T-01282')
  })

  test('canonical sessionRef serialization always includes lane:main', () => {
    expect(
      formatCanonicalSessionRef({
        scopeRef: 'agent:cody:project:agent-spaces',
      })
    ).toBe('agent:cody:project:agent-spaces/lane:main')
    expect(
      formatCanonicalSessionRef({
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01282',
        laneId: 'repair',
      })
    ).toBe('agent:cody:project:agent-spaces:task:T-01282/lane:repair')
  })

  test('scope selector does not invent a session lane', () => {
    const selector = parseSelector('scope:agent:cody:project:agent-spaces') as any

    expect(selector.scopeRef).toBe('agent:cody:project:agent-spaces')
    expect(selector.sessionRef).toBeUndefined()
    expect(selector.scopeHandle).toBe('cody@agent-spaces')
    expect(selector.sessionHandle).toBeUndefined()
  })
})

describe('monitor selector canonical round trips (T-01285)', () => {
  for (const c of monitorSelectorCases) {
    test(`${c.raw} -> ${c.canonicalSelector} is stable`, () => {
      const first = parseSelector(c.raw)
      const serialized = formatSelector(first)
      const second = parseSelector(serialized)

      expect(serialized).toBe(c.canonicalSelector)
      expect(formatSelector(second)).toBe(c.canonicalSelector)
    })
  }
})

describe('parseSelector monitor grammar rejects invalid selectors with structured errors (T-01285)', () => {
  const invalidSelectors = [
    '',
    '   ',
    '@agent-spaces',
    'cody@',
    'cody@agent-spaces:',
    'cody@agent-spaces~',
    'scope:',
    'scope:project:agent-spaces',
    'session:agent:cody:project:agent-spaces',
    'session:agent:cody:project:agent-spaces/lane:',
    'host:',
    'runtime:',
    'msg:',
    'seq:',
    'seq:not-a-number',
    'unknown:value',
    'cody@agent-spaces:T-01282/lane:repair',
  ] as const

  for (const raw of invalidSelectors) {
    test(`rejects ${JSON.stringify(raw)}`, () => {
      let thrown: any
      try {
        parseSelector(raw)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeDefined()
      expect(thrown.code).toBe('invalid_selector')
      expect(thrown.detail).toEqual({
        kind: expect.any(String),
        position: expect.any(Number),
        reason: expect.any(String),
      })
    })
  }
})
