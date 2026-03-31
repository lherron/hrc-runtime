/**
 * RED/GREEN TDD tests for HRC fence validation (T-00949)
 *
 * Spec reference: HRC_IMPLEMENTATION_PLAN.md § Fences
 *
 * Fences guard dispatch and in-flight mutation requests:
 *   - expectedHostSessionId: must match the current active hostSessionId
 *   - expectedGeneration: must match the current generation
 *   - followLatest: when true, skips stale checks and uses current active session
 *
 * Rules:
 *   - stale requests are rejected, never silently redirected, unless followLatest is set
 *   - missing fence fields are treated as "don't check" for that dimension
 *   - a fence with both expectedHostSessionId and followLatest is invalid (contradictory)
 */

import { describe, expect, test } from 'bun:test'

import { HrcErrorCode, parseFence, validateFence } from '../fences.js'

// ===================================================================
// Fence parsing
// ===================================================================

describe('parseFence (T-00949)', () => {
  test('parses fence with expectedHostSessionId only', () => {
    const fence = parseFence({ expectedHostSessionId: 'hsid-1' })
    expect(fence.expectedHostSessionId).toBe('hsid-1')
    expect(fence.expectedGeneration).toBeUndefined()
    expect(fence.followLatest).toBeUndefined()
  })

  test('parses fence with expectedGeneration only', () => {
    const fence = parseFence({ expectedGeneration: 3 })
    expect(fence.expectedGeneration).toBe(3)
    expect(fence.expectedHostSessionId).toBeUndefined()
  })

  test('parses fence with followLatest: true', () => {
    const fence = parseFence({ followLatest: true })
    expect(fence.followLatest).toBe(true)
  })

  test('parses empty/undefined fence as no-op fence', () => {
    const fence = parseFence(undefined)
    expect(fence.expectedHostSessionId).toBeUndefined()
    expect(fence.expectedGeneration).toBeUndefined()
    expect(fence.followLatest).toBeUndefined()
  })

  test('parses empty object as no-op fence', () => {
    const fence = parseFence({})
    expect(fence.expectedHostSessionId).toBeUndefined()
    expect(fence.expectedGeneration).toBeUndefined()
    expect(fence.followLatest).toBeUndefined()
  })

  test('rejects fence with both expectedHostSessionId and followLatest', () => {
    expect(() => parseFence({ expectedHostSessionId: 'hsid-1', followLatest: true })).toThrow()
  })

  test('rejects non-integer expectedGeneration', () => {
    expect(() => parseFence({ expectedGeneration: 1.5 })).toThrow()
  })

  test('rejects negative expectedGeneration', () => {
    expect(() => parseFence({ expectedGeneration: -1 })).toThrow()
  })

  test('rejects non-string expectedHostSessionId', () => {
    expect(() => parseFence({ expectedHostSessionId: 42 } as any)).toThrow()
  })
})

// ===================================================================
// Fence validation against session state
// ===================================================================

describe('validateFence (T-00949)', () => {
  const currentState = {
    activeHostSessionId: 'hsid-current',
    generation: 5,
  }

  test('matching expectedHostSessionId passes', () => {
    const result = validateFence({ expectedHostSessionId: 'hsid-current' }, currentState)
    expect(result.ok).toBe(true)
  })

  test('stale expectedHostSessionId is rejected', () => {
    const result = validateFence({ expectedHostSessionId: 'hsid-old' }, currentState)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  test('matching expectedGeneration passes', () => {
    const result = validateFence({ expectedGeneration: 5 }, currentState)
    expect(result.ok).toBe(true)
  })

  test('stale expectedGeneration is rejected', () => {
    const result = validateFence({ expectedGeneration: 3 }, currentState)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  test('both expectedHostSessionId and expectedGeneration must match', () => {
    const result = validateFence(
      { expectedHostSessionId: 'hsid-current', expectedGeneration: 5 },
      currentState
    )
    expect(result.ok).toBe(true)
  })

  test('matching hostSessionId but stale generation is rejected', () => {
    const result = validateFence(
      { expectedHostSessionId: 'hsid-current', expectedGeneration: 2 },
      currentState
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(HrcErrorCode.STALE_CONTEXT)
  })

  test('followLatest bypasses stale checks', () => {
    const result = validateFence({ followLatest: true }, currentState)
    expect(result.ok).toBe(true)
  })

  test('no-op fence (empty) passes', () => {
    const result = validateFence({}, currentState)
    expect(result.ok).toBe(true)
  })

  test('result includes resolved hostSessionId and generation on success', () => {
    const result = validateFence({ followLatest: true }, currentState)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolvedHostSessionId).toBe('hsid-current')
      expect(result.resolvedGeneration).toBe(5)
    }
  })

  test('result includes error detail on stale rejection', () => {
    const result = validateFence({ expectedHostSessionId: 'hsid-old' }, currentState)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe(HrcErrorCode.STALE_CONTEXT)
      expect(typeof result.message).toBe('string')
      expect(result.message.length).toBeGreaterThan(0)
    }
  })
})
