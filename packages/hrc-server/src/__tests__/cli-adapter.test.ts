/**
 * RED/GREEN tests for hrc-adapter-agent-spaces Slice 1B — CLI adapter (T-00961 / T-00960)
 *
 * Tests the cli-adapter/ surface of hrc-adapter-agent-spaces:
 *   - buildCliInvocation for claude-code harness (anthropic provider)
 *   - buildCliInvocation for codex-cli harness (openai provider)
 *   - unsupported harness rejection (non-interactive)
 *   - mergeEnv: override, unsetEnv, pathPrepend
 *   - correlation env vars (HRC_SESSION_REF, HRC_HOST_SESSION_ID, HRC_RUN_ID)
 *   - resolvedBundle metadata preservation from agent-spaces response
 *
 * Pass conditions for Curly (T-00960):
 *   1. buildCliInvocation({ harness: { provider: 'anthropic', interactive: true }, ... }) resolves with argv containing 'claude'
 *   2. buildCliInvocation({ harness: { provider: 'openai', interactive: true }, ... }) resolves with argv containing 'codex'
 *   3. buildCliInvocation({ harness: { interactive: false }, ... }) rejects with UnsupportedHarnessError
 *   4. mergeEnv applies launch.env overrides to base env
 *   5. mergeEnv removes keys listed in launch.unsetEnv
 *   6. mergeEnv prepends launch.pathPrepend entries to PATH
 *   7. Correlation env vars (HRC_SESSION_REF, HRC_HOST_SESSION_ID, HRC_RUN_ID) are set on the returned env
 *   8. resolvedBundle from agent-spaces response is preserved in CliInvocationResult
 *   9. cwd comes from the agent-spaces spec response (placement-derived)
 *  10. argv is a proper array (not a shell string)
 *  11. provider and frontend fields are set correctly on result
 *  12. UnsupportedHarnessError has a .code field for programmatic matching
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import {
  type SpecBuilder,
  UnsupportedHarnessError,
  buildCliInvocation,
  mergeEnv,
} from '../agent-spaces-adapter/index'

// ---------------------------------------------------------------------------
// Stub SpecBuilder — returns a deterministic response without needing
// a real agent-spaces installation. The adapter's value-add (env merge,
// correlation injection, harness resolution) is exercised on top of this.
// ---------------------------------------------------------------------------

const stubSpecBuilder: SpecBuilder = async (req) => ({
  spec: {
    provider: req.provider ?? 'anthropic',
    frontend: req.frontend ?? 'claude-code',
    argv: [req.frontend === 'codex-cli' ? 'codex' : 'claude', '--interactive'],
    cwd: (req.placement as any)?.targetDir ?? '/tmp/test',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/user' },
    interactionMode: req.interactionMode ?? 'interactive',
    ioMode: req.ioMode ?? 'pty',
  },
  resolvedBundle: {
    bundleIdentity: 'test-bundle',
    runMode: 'task',
    cwd: '/tmp/test',
    instructions: [],
    spaces: [],
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntent(
  overrides: {
    provider?: 'anthropic' | 'openai'
    interactive?: boolean
    model?: string
    initialPrompt?: string
    targetDir?: string
    env?: Record<string, string>
    unsetEnv?: string[]
    pathPrepend?: string[]
    correlation?: {
      sessionRef?: { scopeRef: string; laneRef: string }
      hostSessionId?: string
      runId?: string
    }
  } = {}
): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      targetDir: overrides.targetDir ?? '/tmp/test-project',
      correlation: overrides.correlation ?? {
        sessionRef: { scopeRef: 'project:myapp', laneRef: 'default' },
        hostSessionId: 'hsid-test-001',
        runId: 'run-test-001',
      },
    } as any,
    harness: {
      provider: overrides.provider ?? 'anthropic',
      interactive: overrides.interactive ?? true,
      model: overrides.model,
    },
    ...(overrides.initialPrompt !== undefined ? { initialPrompt: overrides.initialPrompt } : {}),
    launch:
      overrides.env || overrides.unsetEnv || overrides.pathPrepend
        ? {
            env: overrides.env,
            unsetEnv: overrides.unsetEnv,
            pathPrepend: overrides.pathPrepend,
          }
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// 1. mergeEnv — pure function tests
// ---------------------------------------------------------------------------
describe('mergeEnv', () => {
  it('applies launch.env overrides to base env', () => {
    const result = mergeEnv(
      { BASE: 'original', PATH: '/usr/bin' },
      { env: { CUSTOM: 'value', BASE: 'overridden' } }
    )
    expect(result['CUSTOM']).toBe('value')
    expect(result['BASE']).toBe('overridden')
  })

  it('removes keys listed in unsetEnv', () => {
    const result = mergeEnv(
      { KEEP: 'yes', REMOVE: 'no', PATH: '/usr/bin' },
      { unsetEnv: ['REMOVE'] }
    )
    expect(result['KEEP']).toBe('yes')
    expect(result['REMOVE']).toBeUndefined()
  })

  it('prepends paths to PATH', () => {
    const result = mergeEnv(
      { PATH: '/usr/bin:/bin' },
      { pathPrepend: ['/opt/custom/bin', '/usr/local/special/bin'] }
    )
    const parts = result['PATH']!.split(':')
    expect(parts[0]).toBe('/opt/custom/bin')
    expect(parts[1]).toBe('/usr/local/special/bin')
    expect(parts[2]).toBe('/usr/bin')
  })

  it('handles empty PATH with pathPrepend', () => {
    const result = mergeEnv({}, { pathPrepend: ['/opt/bin'] })
    expect(result['PATH']).toBe('/opt/bin')
  })

  it('returns base env unchanged when no launch config', () => {
    const base = { FOO: 'bar', PATH: '/usr/bin' }
    const result = mergeEnv(base)
    expect(result).toEqual(base)
  })

  it('applies override, unset, and pathPrepend in correct order', () => {
    const result = mergeEnv(
      { A: '1', B: '2', C: '3', PATH: '/usr/bin' },
      {
        env: { A: 'overridden', D: 'new' },
        unsetEnv: ['B'],
        pathPrepend: ['/opt/bin'],
      }
    )
    expect(result['A']).toBe('overridden')
    expect(result['B']).toBeUndefined()
    expect(result['C']).toBe('3')
    expect(result['D']).toBe('new')
    expect(result['PATH']!.startsWith('/opt/bin')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. UnsupportedHarnessError — structure tests
// ---------------------------------------------------------------------------
describe('UnsupportedHarnessError', () => {
  it('has a code field for programmatic matching', () => {
    const err = new UnsupportedHarnessError('bad-harness')
    expect(err.code).toBe('unsupported_harness')
    expect(err.harness).toBe('bad-harness')
    expect(err.name).toBe('UnsupportedHarnessError')
  })

  it('has a descriptive message', () => {
    const err = new UnsupportedHarnessError('pi-sdk')
    expect(err.message).toContain('pi-sdk')
    expect(err.message).toContain('claude-code')
    expect(err.message).toContain('codex-cli')
  })
})

// ---------------------------------------------------------------------------
// 3. buildCliInvocation — non-interactive rejection
// ---------------------------------------------------------------------------
describe('buildCliInvocation non-interactive rejection', () => {
  it('rejects non-interactive harness with UnsupportedHarnessError', async () => {
    const intent = makeIntent({ interactive: false })
    await expect(buildCliInvocation(intent, { specBuilder: stubSpecBuilder })).rejects.toThrow(
      UnsupportedHarnessError
    )
  })

  it('error has code and harness fields', async () => {
    const intent = makeIntent({ interactive: false })
    try {
      await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })
      expect.unreachable('should have thrown')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(UnsupportedHarnessError)
      expect((err as UnsupportedHarnessError).code).toBe('unsupported_harness')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. buildCliInvocation — claude-code (anthropic provider)
// ---------------------------------------------------------------------------
describe('buildCliInvocation for claude-code', () => {
  it('resolves with argv containing claude binary', async () => {
    const intent = makeIntent({ provider: 'anthropic' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.argv).toBeArray()
    expect(result.argv.length).toBeGreaterThan(0)
    const joined = result.argv.join(' ').toLowerCase()
    expect(joined).toContain('claude')
  })

  it('sets provider to anthropic', async () => {
    const intent = makeIntent({ provider: 'anthropic' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.provider).toBe('anthropic')
  })

  it('sets frontend to claude-code', async () => {
    const intent = makeIntent({ provider: 'anthropic' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.frontend).toBe('claude-code')
  })

  it('returns cwd from placement resolution', async () => {
    const intent = makeIntent({ targetDir: '/home/user/project' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.cwd).toBeString()
    expect(result.cwd.length).toBeGreaterThan(0)
  })

  it('returns env as a Record<string, string>', async () => {
    const intent = makeIntent()
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(typeof result.env).toBe('object')
    expect(result.env).not.toBeNull()
  })

  it('argv is a proper array, not a shell string', async () => {
    const intent = makeIntent()
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(Array.isArray(result.argv)).toBe(true)
    for (const arg of result.argv) {
      expect(typeof arg).toBe('string')
    }
  })

  it('passes intent.initialPrompt through as placementReq.prompt', async () => {
    let capturedPrompt: string | undefined
    const intent = makeIntent({ initialPrompt: 'Fix the bug' })

    await buildCliInvocation(intent, {
      specBuilder: async (req) => {
        capturedPrompt = req.prompt
        return stubSpecBuilder(req)
      },
    })

    expect(capturedPrompt).toBe('Fix the bug')
  })

  it('omits placementReq.prompt when intent.initialPrompt is undefined', async () => {
    let sawPrompt = false
    const intent = makeIntent()

    await buildCliInvocation(intent, {
      specBuilder: async (req) => {
        sawPrompt = Object.hasOwn(req, 'prompt')
        return stubSpecBuilder(req)
      },
    })

    expect(sawPrompt).toBe(false)
  })

  it('resolves placementReq.aspHome from ASP_HOME instead of sending empty string', async () => {
    // T-01022 RED/GREEN guard: placement-based invocation must still pass a real
    // aspHome through the public client contract because empty string is preserved
    // by the client and breaks materialization in future sessions.
    const originalAspHome = process.env.ASP_HOME
    const sentinelAspHome = '/tmp/hrc-cli-adapter-asp-home-sentinel'
    let capturedAspHome: string | undefined

    process.env.ASP_HOME = sentinelAspHome

    try {
      await buildCliInvocation(makeIntent(), {
        specBuilder: async (req) => {
          capturedAspHome = req.aspHome
          return stubSpecBuilder(req)
        },
      })
    } finally {
      if (originalAspHome === undefined) {
        process.env.ASP_HOME = undefined
      } else {
        process.env.ASP_HOME = originalAspHome
      }
    }

    expect(capturedAspHome).toBe(sentinelAspHome)
  })
})

// ---------------------------------------------------------------------------
// 5. buildCliInvocation — codex-cli (openai provider)
// ---------------------------------------------------------------------------
describe('buildCliInvocation for codex-cli', () => {
  it('resolves with argv containing codex binary', async () => {
    const intent = makeIntent({ provider: 'openai' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.argv).toBeArray()
    const joined = result.argv.join(' ').toLowerCase()
    expect(joined).toContain('codex')
  })

  it('sets frontend to codex-cli', async () => {
    const intent = makeIntent({ provider: 'openai' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.frontend).toBe('codex-cli')
  })

  it('returns cwd from placement', async () => {
    const intent = makeIntent({ provider: 'openai', targetDir: '/opt/codex-project' })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.cwd).toBeString()
    expect(result.cwd.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. buildCliInvocation — env merging with launch config
// ---------------------------------------------------------------------------
describe('buildCliInvocation env merging', () => {
  it('includes launch.env overrides in returned env', async () => {
    const intent = makeIntent({ env: { CUSTOM_VAR: 'custom_value' } })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['CUSTOM_VAR']).toBe('custom_value')
  })

  it('removes unsetEnv keys from returned env', async () => {
    // HOME is in the stub base env; unsetEnv should remove it
    const intent = makeIntent({ unsetEnv: ['HOME'] })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['HOME']).toBeUndefined()
  })

  it('prepends pathPrepend to PATH in returned env', async () => {
    const intent = makeIntent({ pathPrepend: ['/opt/custom/bin'] })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['PATH']).toBeDefined()
    expect(result.env['PATH']!.startsWith('/opt/custom/bin')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. Correlation env vars — injected via placement.correlation
// ---------------------------------------------------------------------------
describe('correlation env vars', () => {
  it('sets HRC_SESSION_REF in env from placement.correlation', async () => {
    const intent = makeIntent({
      correlation: {
        sessionRef: { scopeRef: 'project:myapp', laneRef: 'default' },
        hostSessionId: 'hsid-test-001',
        runId: 'run-test-001',
      },
    })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['HRC_SESSION_REF']).toBe('project:myapp/default')
  })

  it('sets HRC_HOST_SESSION_ID in env from placement.correlation', async () => {
    const intent = makeIntent({
      correlation: {
        sessionRef: { scopeRef: 'project:myapp', laneRef: 'default' },
        hostSessionId: 'hsid-test-001',
        runId: 'run-test-001',
      },
    })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['HRC_HOST_SESSION_ID']).toBe('hsid-test-001')
  })

  it('sets HRC_RUN_ID in env from placement.correlation', async () => {
    const intent = makeIntent({
      correlation: {
        sessionRef: { scopeRef: 'project:myapp', laneRef: 'default' },
        hostSessionId: 'hsid-test-001',
        runId: 'run-test-001',
      },
    })
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['HRC_RUN_ID']).toBe('run-test-001')
  })

  it('omits correlation vars when placement.correlation is absent', async () => {
    const intent = makeIntent({ correlation: undefined })
    // Remove correlation from placement
    ;(intent.placement as any).correlation = undefined
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.env['HRC_SESSION_REF']).toBeUndefined()
    expect(result.env['HRC_HOST_SESSION_ID']).toBeUndefined()
    expect(result.env['HRC_RUN_ID']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8. resolvedBundle metadata
// ---------------------------------------------------------------------------
describe('resolvedBundle metadata', () => {
  it('preserves resolvedBundle from agent-spaces response', async () => {
    const intent = makeIntent()
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(result.resolvedBundle).toBeDefined()
    expect((result.resolvedBundle as any).bundleIdentity).toBe('test-bundle')
  })

  it('passes undefined resolvedBundle when spec builder returns none', async () => {
    const noBundle: SpecBuilder = async (req) => ({
      spec: {
        provider: req.provider ?? 'anthropic',
        frontend: req.frontend ?? 'claude-code',
        argv: ['claude'],
        cwd: '/tmp',
        env: {},
        interactionMode: 'interactive',
        ioMode: 'pty',
      },
    })
    const intent = makeIntent()
    const result = await buildCliInvocation(intent, { specBuilder: noBundle })

    expect(result.resolvedBundle).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9. argv shape validation
// ---------------------------------------------------------------------------
describe('argv shape', () => {
  it('argv is a proper array with string elements', async () => {
    const intent = makeIntent()
    const result = await buildCliInvocation(intent, { specBuilder: stubSpecBuilder })

    expect(Array.isArray(result.argv)).toBe(true)
    for (const arg of result.argv) {
      expect(typeof arg).toBe('string')
      // No shell metacharacters suggesting a joined command string
      expect(arg).not.toContain('&&')
      expect(arg).not.toContain('||')
    }
  })
})
