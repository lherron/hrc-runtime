/**
 * CHARACTERIZATION TESTS — do NOT change source; these pin current behavior.
 *
 * Covers two refactor tasks sharing app-sessions.ts:
 *   T-04748  optional-string projections (reason, inputType)
 *   T-04750  requireSelector preamble: 6×'selector is required' vs 2×'selector must be an object'
 *            + error precedence where selector parse runs AFTER other field validation
 */

import { describe, expect, it } from 'bun:test'
import { HrcBadRequestError } from 'hrc-core'

import {
  parseAppHarnessInFlightInputRequest,
  parseClearAppSessionContextRequest,
  parseDispatchAppHarnessTurnRequest,
  parseEnsureAppSessionRequest,
  parseInterruptAppSessionRequest,
  parseRemoveAppSessionRequest,
  parseSendLiteralInputRequest,
  parseTerminateAppSessionRequest,
} from '../parsers/app-sessions.js'

// ---------------------------------------------------------------------------
// Minimal valid selector for tests that need to pass selector validation
// ---------------------------------------------------------------------------
const VALID_SELECTOR = { appId: 'app1', appSessionKey: 'sess1' }

// ---------------------------------------------------------------------------
// T-04748: optional-string projections
// parseClearAppSessionContextRequest — 'reason' field
// ---------------------------------------------------------------------------
describe('T-04748: parseClearAppSessionContextRequest — reason optional-string projection', () => {
  const base = { selector: VALID_SELECTOR }

  it('reason undefined → omitted from output', () => {
    const result = parseClearAppSessionContextRequest(base)
    expect(Object.hasOwn(result, 'reason')).toBe(false)
  })

  it("reason '' (empty string) → accepted, omitted from output (NOT rejected)", () => {
    const result = parseClearAppSessionContextRequest({ ...base, reason: '' })
    expect(Object.hasOwn(result, 'reason')).toBe(false)
  })

  it("reason '   ' (whitespace) → accepted, omitted from output", () => {
    const result = parseClearAppSessionContextRequest({ ...base, reason: '   ' })
    expect(Object.hasOwn(result, 'reason')).toBe(false)
  })

  it("reason '  x  ' → trimmed to 'x' in output", () => {
    const result = parseClearAppSessionContextRequest({ ...base, reason: '  x  ' })
    expect(result.reason).toBe('x')
  })

  it('reason non-string (number) → throws exact error: "reason must be a string", field=reason', () => {
    let caught: unknown
    try {
      parseClearAppSessionContextRequest({ ...base, reason: 42 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('reason must be a string')
    expect(err.detail).toEqual({ field: 'reason' })
  })
})

// ---------------------------------------------------------------------------
// T-04748: optional-string projections
// parseAppHarnessInFlightInputRequest — 'inputType' field
// ---------------------------------------------------------------------------
describe('T-04748: parseAppHarnessInFlightInputRequest — inputType optional-string projection', () => {
  // Minimal valid input (prompt is required by parsePromptPayload)
  const base = { selector: VALID_SELECTOR, prompt: 'test prompt' }

  it('inputType undefined → omitted from output', () => {
    const result = parseAppHarnessInFlightInputRequest(base)
    expect(Object.hasOwn(result, 'inputType')).toBe(false)
  })

  it("inputType '' (empty string) → accepted, omitted from output (NOT rejected)", () => {
    const result = parseAppHarnessInFlightInputRequest({ ...base, inputType: '' })
    expect(Object.hasOwn(result, 'inputType')).toBe(false)
  })

  it("inputType '   ' (whitespace) → accepted, omitted from output", () => {
    const result = parseAppHarnessInFlightInputRequest({ ...base, inputType: '   ' })
    expect(Object.hasOwn(result, 'inputType')).toBe(false)
  })

  it("inputType '  x  ' → trimmed to 'x' in output", () => {
    const result = parseAppHarnessInFlightInputRequest({ ...base, inputType: '  x  ' })
    expect(result.inputType).toBe('x')
  })

  it('inputType non-string (number) → throws exact error: "inputType must be a string", field=inputType', () => {
    let caught: unknown
    try {
      parseAppHarnessInFlightInputRequest({ ...base, inputType: 99 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('inputType must be a string')
    expect(err.detail).toEqual({ field: 'inputType' })
  })
})

// ---------------------------------------------------------------------------
// T-04750: missing selector — the SIX parsers that throw 'selector is required'
// ---------------------------------------------------------------------------
describe('T-04750: missing selector — "selector is required" sites (6 parsers)', () => {
  function assertSelectorRequired(
    fn: (input: unknown) => unknown,
    extraFields: Record<string, unknown> = {}
  ): void {
    let caught: unknown
    try {
      fn({ ...extraFields })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('selector is required')
    expect(err.detail).toEqual({ field: 'selector' })
  }

  it('parseEnsureAppSessionRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseEnsureAppSessionRequest, {
      spec: { kind: 'command', command: { argv: ['echo', 'hi'] } },
    })
  })

  it('parseDispatchAppHarnessTurnRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseDispatchAppHarnessTurnRequest, { prompt: 'hello' })
  })

  it('parseAppHarnessInFlightInputRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseAppHarnessInFlightInputRequest, { prompt: 'hello' })
  })

  it('parseClearAppSessionContextRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseClearAppSessionContextRequest)
  })

  it('parseRemoveAppSessionRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseRemoveAppSessionRequest)
  })

  it('parseSendLiteralInputRequest: missing selector → "selector is required"', () => {
    assertSelectorRequired(parseSendLiteralInputRequest, { text: 'hi' })
  })
})

// ---------------------------------------------------------------------------
// T-04750: missing selector — the TWO divergent parsers that throw
//          'selector must be an object' (no explicit undefined guard)
// ---------------------------------------------------------------------------
describe('T-04750: missing selector — "selector must be an object" sites (interrupt + terminate)', () => {
  function assertSelectorMustBeObject(fn: (input: unknown) => unknown): void {
    let caught: unknown
    try {
      fn({})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('selector must be an object')
    expect(err.detail).toEqual({ field: 'selector' })
  }

  it('parseInterruptAppSessionRequest: missing selector → "selector must be an object" (diverges from the six)', () => {
    assertSelectorMustBeObject(parseInterruptAppSessionRequest)
  })

  it('parseTerminateAppSessionRequest: missing selector → "selector must be an object" (diverges from the six)', () => {
    assertSelectorMustBeObject(parseTerminateAppSessionRequest)
  })
})

// ---------------------------------------------------------------------------
// T-04750: error PRECEDENCE — selector parse runs AFTER other field validation
// In these parsers the selector undefined-check fires first, but parseAppSessionSelector
// is called later, so a non-object selector (not undefined) loses to an earlier field error.
// ---------------------------------------------------------------------------
describe('T-04750: error precedence — "selector must be an object" loses to earlier field errors', () => {
  it('parseDispatchAppHarnessTurnRequest: non-object selector + missing prompt → prompt error wins', () => {
    // selector = 123 (not undefined → passes undefined guard; not an object → would throw 'selector must be an object')
    // prompt missing → parsePromptPayload fires BEFORE parseAppSessionSelector call → 'prompt is required' wins
    let caught: unknown
    try {
      parseDispatchAppHarnessTurnRequest({ selector: 123 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('prompt is required')
    expect(err.detail).toEqual({ field: 'prompt' })
  })

  it('parseAppHarnessInFlightInputRequest: non-object selector + missing prompt → prompt error wins', () => {
    // Same pattern: selector = 123, no prompt → parsePromptPayload fires before parseAppSessionSelector
    let caught: unknown
    try {
      parseAppHarnessInFlightInputRequest({ selector: 123 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('prompt is required')
    expect(err.detail).toEqual({ field: 'prompt' })
  })

  it('parseSendLiteralInputRequest: non-object selector + missing text → text error wins', () => {
    // selector = 123, no text → text check fires before parseAppSessionSelector → 'text must be a string' wins
    let caught: unknown
    try {
      parseSendLiteralInputRequest({ selector: 123 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('text must be a string')
    expect(err.detail).toEqual({ field: 'text' })
  })

  it('parseDispatchAppHarnessTurnRequest: selector undefined → "selector is required" beats everything (checked first)', () => {
    // Confirm the undefined guard fires before prompt validation
    let caught: unknown
    try {
      parseDispatchAppHarnessTurnRequest({})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HrcBadRequestError)
    const err = caught as HrcBadRequestError
    expect(err.message).toBe('selector is required')
  })
})
