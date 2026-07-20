import { describe, expect, test } from 'bun:test'
import type { Command } from 'commander'

import { toLegacyArgv } from '../cli/argv.js'
import { buildProgram } from '../cli/build-program.js'

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap(allCommands)]
}

describe('T-06666 Commander to legacy argv guard', () => {
  test('rejects camelCase schema flags instead of silently emitting an unknown option', () => {
    expect(() =>
      toLegacyArgv([], { failOnSkew: true }, { strings: [], booleans: ['failOnSkew'] })
    ).toThrow('must be lowercase kebab-case')
  })

  test('every registered Commander long option satisfies the kebab-only precondition', () => {
    const longNames = allCommands(buildProgram()).flatMap((command) =>
      command.options
        .map((option) => option.long)
        .filter((name): name is string => name !== undefined)
    )
    expect(longNames.length).toBeGreaterThan(0)
    for (const name of longNames) {
      expect(name).toMatch(/^--[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })
})
