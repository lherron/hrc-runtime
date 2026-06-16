/**
 * T-04747 — CHARACTERIZATION TESTS (Phase: pin-current-behavior)
 *
 * Pins the CURRENT (as-is, no changes) semantics of parseTerminateRuntimeRequest's
 * optional-string handling for the reason, source, and actor fields.
 *
 * The local `stringField` closure (runtime.ts:428) has DIFFERENT semantics from
 * the shared `readOptionalNonEmptyStringField` helper — they must NOT be swapped
 * without first understanding (and deliberately choosing to change) the behavior
 * pinned here. Divergences noted where surprising.
 *
 * Pinned semantics:
 *   undefined    → key OMITTED from result (not present in returned object at all)
 *   ''           → ACCEPTED; key present with value '' (⚠ SURPRISING: empty accepted)
 *   '  x  '     → ACCEPTED; value is '  x  ' (⚠ SURPRISING: whitespace preserved, no trim)
 *   non-string   → throws HrcBadRequestError with message '<field> must be a string',
 *                  code 'malformed_request', detail { field }
 */

import { describe, expect, it } from 'bun:test'

import { HrcBadRequestError } from 'hrc-core'

import { parseTerminateRuntimeRequest } from '../server-parsers.js'

/** Minimal valid base — runtimeId is required by parseRuntimeActionBody. */
const BASE = { runtimeId: 'r' } as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function terminateWith(extra: Record<string, unknown>) {
  return parseTerminateRuntimeRequest({ ...BASE, ...extra })
}

function expectStringFieldThrows(
  field: 'reason' | 'source' | 'actor',
  value: unknown
) {
  let thrown: unknown
  try {
    terminateWith({ [field]: value })
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(HrcBadRequestError)
  const err = thrown as HrcBadRequestError
  expect(err.message).toBe(`${field} must be a string`)
  expect(err.code).toBe('malformed_request')
  expect(err.detail).toEqual({ field })
}

// ---------------------------------------------------------------------------
// reason
// ---------------------------------------------------------------------------

describe('parseTerminateRuntimeRequest — reason field characterization', () => {
  it('reason=undefined → key OMITTED from result', () => {
    const result = terminateWith({})
    expect(Object.prototype.hasOwnProperty.call(result, 'reason')).toBe(false)
    expect(result).toEqual({ runtimeId: 'r' })
  })

  it('reason="" → ACCEPTED; key present with empty string value', () => {
    // ⚠ SURPRISING: empty string is accepted (local closure does not reject '').
    // readOptionalNonEmptyStringField would throw here — they are NOT equivalent.
    const result = terminateWith({ reason: '' })
    expect(result.reason).toBe('')
    expect(result).toEqual({ runtimeId: 'r', reason: '' })
  })

  it('reason="  x  " → ACCEPTED; whitespace PRESERVED (no trim)', () => {
    // ⚠ SURPRISING: value is returned as-is with leading/trailing spaces.
    // readOptionalNonEmptyStringField would trim this to 'x'.
    const result = terminateWith({ reason: '  x  ' })
    expect(result.reason).toBe('  x  ')
    expect(result).toEqual({ runtimeId: 'r', reason: '  x  ' })
  })

  it('reason=42 → throws HrcBadRequestError "reason must be a string"', () => {
    expectStringFieldThrows('reason', 42)
  })

  it('reason=null → throws HrcBadRequestError "reason must be a string"', () => {
    expectStringFieldThrows('reason', null)
  })

  it('reason={} → throws HrcBadRequestError "reason must be a string"', () => {
    expectStringFieldThrows('reason', {})
  })
})

// ---------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------

describe('parseTerminateRuntimeRequest — source field characterization', () => {
  it('source=undefined → key OMITTED from result', () => {
    const result = terminateWith({})
    expect(Object.prototype.hasOwnProperty.call(result, 'source')).toBe(false)
    expect(result).toEqual({ runtimeId: 'r' })
  })

  it('source="" → ACCEPTED; key present with empty string value', () => {
    const result = terminateWith({ source: '' })
    expect(result.source).toBe('')
    expect(result).toEqual({ runtimeId: 'r', source: '' })
  })

  it('source="  x  " → ACCEPTED; whitespace PRESERVED (no trim)', () => {
    const result = terminateWith({ source: '  x  ' })
    expect(result.source).toBe('  x  ')
    expect(result).toEqual({ runtimeId: 'r', source: '  x  ' })
  })

  it('source=42 → throws HrcBadRequestError "source must be a string"', () => {
    expectStringFieldThrows('source', 42)
  })

  it('source=null → throws HrcBadRequestError "source must be a string"', () => {
    expectStringFieldThrows('source', null)
  })

  it('source={} → throws HrcBadRequestError "source must be a string"', () => {
    expectStringFieldThrows('source', {})
  })
})

// ---------------------------------------------------------------------------
// actor
// ---------------------------------------------------------------------------

describe('parseTerminateRuntimeRequest — actor field characterization', () => {
  it('actor=undefined → key OMITTED from result', () => {
    const result = terminateWith({})
    expect(Object.prototype.hasOwnProperty.call(result, 'actor')).toBe(false)
    expect(result).toEqual({ runtimeId: 'r' })
  })

  it('actor="" → ACCEPTED; key present with empty string value', () => {
    const result = terminateWith({ actor: '' })
    expect(result.actor).toBe('')
    expect(result).toEqual({ runtimeId: 'r', actor: '' })
  })

  it('actor="  x  " → ACCEPTED; whitespace PRESERVED (no trim)', () => {
    const result = terminateWith({ actor: '  x  ' })
    expect(result.actor).toBe('  x  ')
    expect(result).toEqual({ runtimeId: 'r', actor: '  x  ' })
  })

  it('actor=42 → throws HrcBadRequestError "actor must be a string"', () => {
    expectStringFieldThrows('actor', 42)
  })

  it('actor=null → throws HrcBadRequestError "actor must be a string"', () => {
    expectStringFieldThrows('actor', null)
  })

  it('actor={} → throws HrcBadRequestError "actor must be a string"', () => {
    expectStringFieldThrows('actor', {})
  })
})

// ---------------------------------------------------------------------------
// All three fields present together
// ---------------------------------------------------------------------------

describe('parseTerminateRuntimeRequest — combined field characterization', () => {
  it('all three fields present with valid strings → all preserved as-is', () => {
    const result = terminateWith({
      reason: 'test reason',
      source: 'test-source',
      actor: 'test-actor',
    })
    expect(result).toEqual({
      runtimeId: 'r',
      reason: 'test reason',
      source: 'test-source',
      actor: 'test-actor',
    })
  })

  it('all three fields as empty strings → all present with empty value', () => {
    const result = terminateWith({ reason: '', source: '', actor: '' })
    expect(result).toEqual({ runtimeId: 'r', reason: '', source: '', actor: '' })
  })

  it('all three fields with whitespace-padded values → all preserved unstripped', () => {
    const result = terminateWith({
      reason: '  why  ',
      source: '  who  ',
      actor: '  agent  ',
    })
    expect(result).toEqual({
      runtimeId: 'r',
      reason: '  why  ',
      source: '  who  ',
      actor: '  agent  ',
    })
  })

  it('non-string on a later field short-circuits with correct field name in error', () => {
    // reason valid, source valid, actor is non-string → throws with actor in detail
    expectStringFieldThrows('actor', true)
  })
})
