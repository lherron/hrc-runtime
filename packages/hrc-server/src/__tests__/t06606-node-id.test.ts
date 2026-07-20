/**
 * T-06606 — nodeId grammar (federation spec §3, reserved sentinel §5).
 */

import { describe, expect, test } from 'bun:test'

import {
  NODE_ID_PATTERN,
  describeNodeIdViolation,
  isReservedNodeId,
  isValidNodeId,
  parseNodeId,
} from '../federation/node-id.js'

describe('nodeId grammar', () => {
  test('accepts the §4 roster ids', () => {
    for (const id of ['svc', 'lab', 'max3']) {
      expect(isValidNodeId(id)).toBe(true)
      expect(parseNodeId(id, 'test')).toBe(id)
    }
  })

  test('accepts every character class in the grammar', () => {
    for (const id of ['a', 'A', '0', 'a.b', 'a_b', 'a-b', 'Node.1_x-Y', 'x'.repeat(64)]) {
      expect(isValidNodeId(id)).toBe(true)
    }
  })

  test('rejects empty and over-length ids', () => {
    expect(isValidNodeId('')).toBe(false)
    expect(describeNodeIdViolation('')).toBe('it is empty')

    const tooLong = 'x'.repeat(65)
    expect(isValidNodeId(tooLong)).toBe(false)
    expect(describeNodeIdViolation(tooLong)).toBe('it is 65 characters (maximum 64)')
  })

  test('rejects characters outside the token grammar and names them', () => {
    for (const id of ['a b', 'a/b', 'a:b', 'a@b', 'héllo', 'a\nb']) {
      expect(isValidNodeId(id)).toBe(false)
    }
    expect(describeNodeIdViolation('sv c/1')).toContain('disallowed character(s)')
    expect(describeNodeIdViolation('sv c/1')).toContain('" "')
    expect(describeNodeIdViolation('sv c/1')).toContain('"/"')
  })

  test('rejects the reserved placement sentinel "local" (§5)', () => {
    expect(NODE_ID_PATTERN.test('local')).toBe(true) // grammar-legal, reserved anyway
    expect(isValidNodeId('local')).toBe(false)
    expect(describeNodeIdViolation('local')).toContain('reserved placement sentinel')
    expect(() => parseNodeId('local', 'federation.json field "nodeId"')).toThrow(
      /reserved placement sentinel/
    )
  })

  test('rejects the reserved word case-insensitively', () => {
    // §5 compares against lowercase "local"; a node calling itself "Local"
    // would read as a distinct node to the compiler and as the sentinel to a
    // human. Rejecting the whole case-fold closes that gap.
    for (const id of ['Local', 'LOCAL', 'LoCaL']) {
      expect(isReservedNodeId(id)).toBe(true)
      expect(isValidNodeId(id)).toBe(false)
    }
  })

  test('does not reject ids that merely contain "local"', () => {
    for (const id of ['local1', 'my-local', 'localhost']) {
      expect(isValidNodeId(id)).toBe(true)
    }
  })

  test('parse errors name the configuration surface and the violation', () => {
    expect(() => parseNodeId('a b', 'federation.json field "nodeId"')).toThrow(
      /federation\.json field "nodeId" is not a valid nodeId \("a b"\): it contains disallowed/
    )
  })
})
