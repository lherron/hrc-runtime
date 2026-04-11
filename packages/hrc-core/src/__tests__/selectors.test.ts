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
