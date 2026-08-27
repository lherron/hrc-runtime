import { describe, expect, test } from 'bun:test'

import { parseInstallOptions } from './install-options'

describe('parseInstallOptions', () => {
  test('reads no options as every option off', () => {
    expect(parseInstallOptions([])).toEqual({
      noSync: false,
      forceSync: false,
      forceLink: false,
      allowDirty: false,
    })
  })

  test('reads each option by name, not by position', () => {
    expect(parseInstallOptions(['allow-dirty=1'])).toMatchObject({
      allowDirty: true,
      noSync: false,
    })
    expect(parseInstallOptions(['force-link=1'])).toMatchObject({
      forceLink: true,
      noSync: false,
    })
  })

  test('reads several options in any order', () => {
    expect(parseInstallOptions(['allow-dirty=1', 'no-sync=1'])).toMatchObject({
      allowDirty: true,
      noSync: true,
    })
  })

  test('accepts the flag-style spelling', () => {
    expect(parseInstallOptions(['--no-sync=1']).noSync).toBe(true)
  })

  test('drops empty tokens from unset just parameters', () => {
    expect(parseInstallOptions(['', '  ', 'no-sync=1']).noSync).toBe(true)
  })

  test('reads explicit off values as off', () => {
    expect(parseInstallOptions(['no-sync=0', 'allow-dirty=false'])).toMatchObject({
      noSync: false,
      allowDirty: false,
    })
  })

  test('rejects an unknown option instead of silently ignoring it', () => {
    expect(() => parseInstallOptions(['allow-dity=1'])).toThrow(
      /Unknown install option: allow-dity=1/
    )
  })

  test('rejects a valueless option', () => {
    expect(() => parseInstallOptions(['allow-dirty'])).toThrow(/needs a value/)
  })
})
