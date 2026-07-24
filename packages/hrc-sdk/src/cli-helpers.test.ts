import { describe, expect, test } from 'bun:test'

import { formatAgentNotFound, renderCommandRoster, writePlacementWarnings } from './cli-helpers.js'

describe('CLI helpers', () => {
  test('renders visible commands from the registry with aligned descriptions and omits help', () => {
    const commands = [
      { name: () => 'run', description: () => 'Run a target' },
      { name: () => 'status', description: () => 'Show status' },
      { name: () => 'help', description: () => 'Display help' },
    ]
    const program = {
      createHelp: () => ({
        visibleCommands: () => commands,
      }),
    }

    expect(renderCommandRoster(program)).toBe('  run     Run a target\n  status  Show status')
  })

  test('formats searched and unconfigured agent-root failures', () => {
    expect(formatAgentNotFound('cody', ['/agents/a', '/agents/b'])).toBe(
      'agent "cody" not found; searched: /agents/a, /agents/b'
    )
    expect(formatAgentNotFound('cody', undefined)).toBe(
      'agent "cody" not found; no agent roots configured.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.'
    )
  })

  test('writes each placement warning with the caller prefix and ignores empty inputs', () => {
    const originalStderrWrite = process.stderr.write
    const writes: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      writePlacementWarnings('hrcchat', ['first', 'second'])
      writePlacementWarnings('hrc', [])
      writePlacementWarnings('hrc', undefined)
    } finally {
      process.stderr.write = originalStderrWrite
    }

    expect(writes).toEqual(['[hrcchat] warning: first\n', '[hrcchat] warning: second\n'])
  })
})
