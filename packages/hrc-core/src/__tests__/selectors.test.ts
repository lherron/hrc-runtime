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
    const result = parseSelector({ sessionRef: 'project:myproject/lane:default' })
    expect(result).toBeDefined()
    expect(result.kind).toBe('stable')
    expect(result.sessionRef).toBe('project:myproject/lane:default')
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
    expect(normalizeSessionRef('  project:foo/lane:bar  ')).toBe('project:foo/lane:bar')
  })

  test('preserves valid sessionRef as-is', () => {
    const ref = 'project:my-project/lane:default'
    expect(normalizeSessionRef(ref)).toBe(ref)
  })

  test('returns consistent output for equivalent refs', () => {
    const a = normalizeSessionRef('project:foo/lane:bar')
    const b = normalizeSessionRef('  project:foo/lane:bar  ')
    expect(a).toBe(b)
  })
})

// ===================================================================
// Selector kind guards
// ===================================================================

describe('Selector kind guards (T-00949)', () => {
  test('isStableSelector returns true for sessionRef selectors', () => {
    const sel: HrcSelector = { kind: 'stable', sessionRef: 'project:x/lane:y' }
    expect(isStableSelector(sel)).toBe(true)
    expect(isConcreteSelector(sel)).toBe(false)
  })

  test('isConcreteSelector returns true for hostSessionId selectors', () => {
    const sel: HrcSelector = { kind: 'concrete', hostSessionId: 'hsid-1' }
    expect(isConcreteSelector(sel)).toBe(true)
    expect(isStableSelector(sel)).toBe(false)
  })
})
