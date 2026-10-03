import { describe, expect, test } from 'bun:test'
import {
  flattenSessionMetadata,
  nestSessionMetadata,
  truncateMetadataUpdatedBy,
  validateSessionMetadataEntry,
} from '../session-metadata.js'

describe('session metadata validation', () => {
  test('flattens open nested leaves and reports invalid values without losing valid ones', () => {
    const result = flattenSessionMetadata({
      appearance: { terminalFg: '#FFFFFF' },
      tags: ['a', 1, null],
      bad: [{ x: 1 }],
    })
    expect(result.values).toEqual({ 'appearance.terminalFg': '#FFFFFF', tags: ['a', 1, null] })
    expect(result.rejected.map((row) => row.key)).toEqual(['bad'])
    expect(nestSessionMetadata(result.values)).toEqual({
      appearance: { terminalFg: '#FFFFFF' },
      tags: ['a', 1, null],
    })
  })
  test('registered text is trimmed and controls/colors are rejected', () => {
    expect(validateSessionMetadataEntry('title', '  A title  ')).toEqual({ value: 'A title' })
    expect(validateSessionMetadataEntry('title', 'bad\ntext').reason).toBeDefined()
    expect(validateSessionMetadataEntry('appearance.color', 'red').reason).toBeDefined()
    expect(validateSessionMetadataEntry('appearance.terminalFg', 'red')).toEqual({ value: 'red' })
  })
  test('bounds keys and serialized values', () => {
    for (const key of ['a'.repeat(65), ['a'.repeat(64), 'b'.repeat(64)].join('.'), 'a.b.c.d.e']) {
      expect(validateSessionMetadataEntry(key, 'value').reason).toBeDefined()
    }
    expect(validateSessionMetadataEntry('a', 'x'.repeat(4096)).reason).toBeDefined()
    expect(validateSessionMetadataEntry('a', Number.POSITIVE_INFINITY).reason).toBeDefined()
  })
  test('open keys that shadow object builtins stay unregistered and safe', () => {
    expect(validateSessionMetadataEntry('constructor', 'open')).toEqual({ value: 'open' })
    expect(validateSessionMetadataEntry('toString', 'open')).toEqual({ value: 'open' })
  })
  test('rejects excessive nested depth before recursive descent overflows', () => {
    let value: unknown = 'leaf'
    for (let depth = 0; depth < 20000; depth++) value = { a: value }
    expect(flattenSessionMetadata(value)).toEqual({
      values: {},
      rejected: [
        {
          key: 'a.a.a.a.a',
          reason:
            'key must have 1–4 valid segments (at most 64 characters each) and at most 128 bytes',
        },
      ],
    })
  })
  test('rejects ambiguous prefixes and bounds attribution by UTF-8 bytes', () => {
    const result = flattenSessionMetadata({ appearance: 'x', 'appearance.color': '#FFFFFF' })
    expect(result.rejected.length).toBe(1)
    expect(
      new TextEncoder().encode(truncateMetadataUpdatedBy('é'.repeat(256))).length
    ).toBeLessThanOrEqual(256)
    expect(truncateMetadataUpdatedBy('é'.repeat(256)).endsWith('…')).toBe(true)
  })
})
