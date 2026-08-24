import { describe, expect, test } from 'bun:test'
import type { Command } from 'commander'

import { buildProgram } from '../cli/build-program.js'

function child(parent: Command, name: string): Command {
  const command = parent.commands.find((candidate) => candidate.name() === name)
  if (!command) throw new Error(`missing command ${parent.name()} ${name}`)
  return command
}

function visibleChildren(parent: Command): string[] {
  return parent
    .createHelp()
    .visibleCommands(parent)
    .filter((command) => command.name() !== 'help')
    .map((command) => command.name())
}

describe('consolidated hrc command graph', () => {
  const program = buildProgram()

  test('exposes exactly seven top-level noun groups', () => {
    const visibleTop = visibleChildren(program)
    const nounGroups = ['server', 'session', 'monitor', 'admin', 'runtime', 'federation', 'target']

    expect(visibleTop.filter((name) => nounGroups.includes(name))).toEqual(nounGroups)
    expect(visibleTop).not.toContain('broker')
    expect(visibleTop).not.toContain('launch')
  })

  test('runtime, session, and monitor own their public verbs', () => {
    expect(visibleChildren(child(program, 'runtime'))).toEqual([
      'list',
      'inspect',
      // T-07235: read-only first_turn_missing bundle retrieval. Lives in the
      // runtime namespace per the T-07011 consolidation rather than adding a
      // top-level noun.
      'diagnostics',
      'capture',
      'send',
      'interrupt',
      'terminate',
      'sweep',
      'prune',
    ])
    expect(visibleChildren(child(program, 'session'))).toEqual([
      'resolve',
      'list',
      'get',
      'rotate',
      'retitle',
      'drop-continuation',
    ])
    expect(visibleChildren(child(program, 'monitor'))).toEqual([
      'session-report',
      'show',
      'wait',
      'watch',
      'events',
      'transcript',
      'stats',
    ])
  })

  test('admin --help owns the complete maintenance cellar', () => {
    expect(visibleChildren(child(program, 'admin'))).toEqual([
      'runs',
      'worktrees',
      'surface',
      'bridge',
      'runtime',
      'broker-verify',
      'events',
      'registrations',
      'metrics',
    ])
    expect(visibleChildren(child(child(program, 'admin'), 'worktrees'))).toEqual(['audit', 'prune'])
    expect(visibleChildren(child(child(program, 'admin'), 'registrations'))).toEqual(['gc'])
  })

  test('removed groups and spellings are hidden migration fences', () => {
    const visibleTop = visibleChildren(program)
    for (const removed of [
      'broker',
      'launch',
      'capture',
      'inflight',
      'surface',
      'bridge',
      'events',
      'metrics',
      'session-report',
    ]) {
      expect(visibleTop).not.toContain(removed)
      expect(program.commands.some((command) => command.name() === removed)).toBe(true)
    }
    expect(visibleChildren(child(program, 'runtime'))).not.toContain('ensure')
    expect(visibleChildren(child(program, 'runtime'))).not.toContain('adopt')
    expect(visibleChildren(child(program, 'session'))).not.toContain('clear-context')
  })
})
