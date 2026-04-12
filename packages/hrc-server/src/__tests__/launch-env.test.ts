import { describe, expect, it } from 'bun:test'

import {
  listInheritedEnvKeysToScrub,
  sanitizeTmuxClientEnv,
  sanitizeTmuxServerPath,
  scrubInheritedEnv,
  shouldScrubInheritedEnvKey,
} from '../launch/env'

describe('launch inherited env scrubbing', () => {
  it('removes color, ci, and hrc/codex correlation variables', () => {
    const scrubbed = scrubInheritedEnv({
      AGENTCHAT_ID: 'cody',
      CODEX_CI: '1',
      CODEX_HOME: '/tmp/stale-codex-home',
      COLORTERM: 'truecolor',
      HRC_RUN_ID: 'run-stale',
      NO_COLOR: '1',
      PATH: '/usr/bin',
      TERM: 'tmux-256color',
    })

    expect(scrubbed).toEqual({
      COLORTERM: 'truecolor',
      PATH: '/usr/bin',
      TERM: 'tmux-256color',
    })
  })

  it('identifies explicit and prefix-based scrub keys', () => {
    expect(shouldScrubInheritedEnvKey('NO_COLOR')).toBe(true)
    expect(shouldScrubInheritedEnvKey('CODEX_THREAD_ID')).toBe(true)
    expect(shouldScrubInheritedEnvKey('HRC_LAUNCH_ID')).toBe(true)
    expect(shouldScrubInheritedEnvKey('AGENT_SCOPE_REF')).toBe(true)
    expect(shouldScrubInheritedEnvKey('AGENTCHAT_ID')).toBe(true)
    expect(shouldScrubInheritedEnvKey('COLORTERM')).toBe(false)
  })

  it('returns a de-duplicated scrub list for tmux server cleanup', () => {
    const keys = listInheritedEnvKeysToScrub({
      AGENTCHAT_ID: 'cody',
      CODEX_CI: '1',
      PATH: '/usr/bin',
    })

    expect(keys).toContain('AGENTCHAT_ID')
    expect(keys).toContain('CODEX_CI')
    expect(keys).toContain('NO_COLOR')
    expect(keys.filter((key) => key === 'CODEX_CI')).toHaveLength(1)
  })

  it('removes codex ephemeral path entries from tmux server PATH', () => {
    const sanitized = sanitizeTmuxServerPath(
      [
        '/usr/bin',
        '/tmp/work/codex-homes/agent/tmp/arg0/codex-arg0abcd',
        '/opt/tools',
        '/Users/test/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path',
        '/usr/bin',
      ].join(':')
    )

    expect(sanitized).toBe('/usr/bin:/opt/tools')
  })

  it('sanitizes tmux client env before invoking tmux commands', () => {
    const sanitized = sanitizeTmuxClientEnv({
      CODEX_CI: '1',
      NO_COLOR: '1',
      PATH: [
        '/usr/bin',
        '/tmp/work/codex-homes/agent/tmp/arg0/codex-arg0abcd',
        '/opt/tools',
        '/Users/test/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path',
      ].join(':'),
      TERM: 'xterm-ghostty',
    })

    expect(sanitized).toEqual({
      PATH: '/usr/bin:/opt/tools',
      TERM: 'xterm-ghostty',
    })
  })
})
