import { describe, expect, test } from 'bun:test'

import { agentHarnessGuardMessage, detectAgentHarnessEnv } from '../harness-guard.js'

describe('detectAgentHarnessEnv', () => {
  test('returns the harness vars that are set, in stable order', () => {
    expect(
      detectAgentHarnessEnv({
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        PATH: '/usr/bin',
      })
    ).toEqual(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'])
  })

  test('detects Codex harness vars too', () => {
    expect(detectAgentHarnessEnv({ CODEX_SANDBOX: 'seatbelt' })).toEqual(['CODEX_SANDBOX'])
  })

  test('ignores empty-string values (treated as unset)', () => {
    expect(detectAgentHarnessEnv({ CLAUDECODE: '' })).toEqual([])
  })

  test('returns [] for a clean (launchd-style) env', () => {
    expect(
      detectAgentHarnessEnv({ HOME: '/Users/lherron', PATH: '/usr/bin', HRC_FOO: '1' })
    ).toEqual([])
  })
})

describe('agentHarnessGuardMessage', () => {
  test('returns null when no harness vars are present', () => {
    expect(agentHarnessGuardMessage({ HOME: '/Users/lherron' })).toBeNull()
  })

  test('returns a guide message naming the detected vars when tripped', () => {
    const msg = agentHarnessGuardMessage({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' })
    expect(msg).not.toBeNull()
    const text = msg as string
    expect(text).toContain('refusing to boot in the foreground')
    expect(text).toContain('CLAUDECODE, CLAUDE_CODE_ENTRYPOINT')
    expect(text).toContain('hrc server restart')
    expect(text).toContain('ghostmux')
    // Not bypassable: no env escape hatch advertised.
    expect(text).not.toContain('HRC_ALLOW')
  })
})
