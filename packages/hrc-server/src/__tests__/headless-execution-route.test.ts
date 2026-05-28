/**
 * T-01690 Wave W4 cutover — RED acceptance tests (smokey).
 *
 * These tests pin the CLEANLY-TESTABLE cutover seam that gates the headless
 * OpenAI Codex dispatch onto the Harness Broker behind
 * HRC_HEADLESS_CODEX_BROKER_ENABLED. They do NOT exercise a live codex turn,
 * a real broker spawn, or HRC restart — that is larry's manual installed-binary
 * e2e (the closure gate). Here we assert the two pure/injectable functions that
 * make the routing decision and dispatch it fail-closed.
 *
 * Seam contract larry must implement in ../index (exported, pure, no live deps):
 *
 *   export type HeadlessExecutionRoute = 'sdk' | 'broker' | 'legacy-exec'
 *
 *   export function decideHeadlessExecutionRoute(
 *     intent: HrcRuntimeIntent,
 *     options: { brokerFlagEnabled: boolean },
 *   ): HeadlessExecutionRoute
 *
 *   export async function runHeadlessRoute<T>(
 *     route: HeadlessExecutionRoute,
 *     executors: {
 *       sdk: () => Promise<T>
 *       broker: () => Promise<T>
 *       legacyExec: () => Promise<T>
 *     },
 *   ): Promise<T>
 *
 * Routing semantics (decideHeadlessExecutionRoute):
 *   - 'sdk'         iff shouldUseHeadlessSdkExecutor(intent.harness) — flag-independent,
 *                   preserves today's SDK path (agent-sdk / pi-sdk / id-less anthropic).
 *   - 'broker'      iff brokerFlagEnabled AND the intent is a headless OpenAI Codex
 *                   candidate: NOT sdk-executor, NOT interactive, provider 'openai',
 *                   harness.id in { 'codex-cli', undefined } (codex-app-server shares the
 *                   'codex-cli' harness id — app-server is a launch detail, not an intent id).
 *   - 'legacy-exec' otherwise (includes: flag OFF + codex; pi-cli/pi; interactive codex).
 *
 * Invariant the wording "flag OFF => legacy ALWAYS" encodes: with the flag OFF the
 * broker route is NEVER selected. Non-codex harnesses keep their existing route
 * (SDK stays 'sdk'); routing the SDK path to 'legacy-exec' would itself be a
 * regression, so flag-OFF + SDK => 'sdk' (unchanged), not 'legacy-exec'.
 *
 * runHeadlessRoute is the dispatch seam that localizes cody's FAIL-CLOSED rule:
 * for route 'broker' it invokes ONLY the broker executor and lets its rejection
 * propagate — it must NOT catch the error and fall back to legacyExec (which would
 * silently re-enter the launch-artifact / exec.ts path and defeat the cutover).
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import * as hrc from '../index'
import { makeInteractiveTmuxProfile } from './broker-compile-fixtures'

type Harness = HrcRuntimeIntent['harness']
type HeadlessExecutionRoute = 'sdk' | 'broker' | 'legacy-exec'
type InteractiveTmuxExecutionRoute = 'broker' | 'legacy-tmux'

// Minimal valid intent factory — only the fields the routing decision reads.
function intent(
  harness: Harness,
  preferredMode: 'headless' | 'interactive' | 'nonInteractive' = 'headless'
): HrcRuntimeIntent {
  return {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    harness,
    execution: { preferredMode },
  }
}

// Typed handles to the seam under test (undefined until larry implements them).
const decideHeadlessExecutionRoute = (
  hrc as unknown as {
    decideHeadlessExecutionRoute?: (
      intent: HrcRuntimeIntent,
      options: { brokerFlagEnabled: boolean }
    ) => HeadlessExecutionRoute
  }
).decideHeadlessExecutionRoute

const runHeadlessRoute = (
  hrc as unknown as {
    runHeadlessRoute?: <T>(
      route: HeadlessExecutionRoute,
      executors: { sdk: () => Promise<T>; broker: () => Promise<T>; legacyExec: () => Promise<T> }
    ) => Promise<T>
  }
).runHeadlessRoute

const decideInteractiveTmuxExecutionRoute = (
  hrc as unknown as {
    decideInteractiveTmuxExecutionRoute?: (
      intent: HrcRuntimeIntent,
      profile: BrokerExecutionProfile,
      options: { brokerFlagEnabled: boolean }
    ) => InteractiveTmuxExecutionRoute
  }
).decideInteractiveTmuxExecutionRoute

const runInteractiveTmuxRoute = (
  hrc as unknown as {
    runInteractiveTmuxRoute?: <T>(
      route: InteractiveTmuxExecutionRoute,
      executors: { broker: () => Promise<T>; legacyTmux: () => Promise<T> }
    ) => Promise<T>
  }
).runInteractiveTmuxRoute

const filterBrokerDispatchEnvForLockedEnv = (
  hrc as unknown as {
    filterBrokerDispatchEnvForLockedEnv?: (
      dispatchEnv: Record<string, string> | undefined,
      startRequest: InvocationStartRequest
    ) => Record<string, string> | undefined
  }
).filterBrokerDispatchEnvForLockedEnv

describe('W4 cutover seam — exports exist', () => {
  it('exports decideHeadlessExecutionRoute', () => {
    expect(typeof decideHeadlessExecutionRoute).toBe('function')
  })

  it('exports runHeadlessRoute', () => {
    expect(typeof runHeadlessRoute).toBe('function')
  })

  it('exports filterBrokerDispatchEnvForLockedEnv', () => {
    expect(typeof filterBrokerDispatchEnvForLockedEnv).toBe('function')
  })

  it('exports decideInteractiveTmuxExecutionRoute', () => {
    expect(typeof decideInteractiveTmuxExecutionRoute).toBe('function')
  })

  it('exports runInteractiveTmuxRoute', () => {
    expect(typeof runInteractiveTmuxRoute).toBe('function')
  })
})

describe('decideHeadlessExecutionRoute — flag OFF never selects broker', () => {
  type Case = { name: string; harness: Harness; expected: HeadlessExecutionRoute }
  const cases: Case[] = [
    {
      name: 'codex-cli (openai, headless) → legacy-exec',
      harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
      expected: 'legacy-exec',
    },
    {
      name: 'id-less openai (codex target) → legacy-exec',
      harness: { provider: 'openai', interactive: false },
      expected: 'legacy-exec',
    },
    {
      name: 'anthropic agent-sdk → sdk (unchanged, NOT legacy-exec)',
      harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
      expected: 'sdk',
    },
    {
      name: 'id-less anthropic headless → sdk (unchanged)',
      harness: { provider: 'anthropic', interactive: false },
      expected: 'sdk',
    },
  ]
  for (const { name, harness, expected } of cases) {
    it(name, () => {
      expect(decideHeadlessExecutionRoute!(intent(harness), { brokerFlagEnabled: false })).toBe(
        expected
      )
    })
  }
})

describe('decideHeadlessExecutionRoute — flag ON', () => {
  type Case = { name: string; harness: Harness; expected: HeadlessExecutionRoute }
  const cases: Case[] = [
    {
      name: 'headless codex-cli (openai) → broker',
      harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
      expected: 'broker',
    },
    {
      name: 'headless id-less openai (codex-app-server / codex target) → broker',
      harness: { provider: 'openai', interactive: false },
      expected: 'broker',
    },
    {
      name: 'anthropic agent-sdk → sdk (NOT broker)',
      harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
      expected: 'sdk',
    },
    {
      name: 'openai pi-sdk → sdk (NOT broker)',
      harness: { provider: 'openai', interactive: false, id: 'pi-sdk' },
      expected: 'sdk',
    },
    {
      name: 'id-less anthropic headless SDK → sdk (NOT broker)',
      harness: { provider: 'anthropic', interactive: false },
      expected: 'sdk',
    },
    {
      name: 'openai pi-cli (not codex) → legacy-exec (NOT broker)',
      harness: { provider: 'openai', interactive: false, id: 'pi-cli' },
      expected: 'legacy-exec',
    },
  ]
  for (const { name, harness, expected } of cases) {
    it(name, () => {
      expect(decideHeadlessExecutionRoute!(intent(harness), { brokerFlagEnabled: true })).toBe(
        expected
      )
    })
  }
})

describe('decideHeadlessExecutionRoute — flag ON, interactive/tmux is NEVER broker', () => {
  const interactiveCases: { name: string; harness: Harness }[] = [
    {
      name: 'interactive codex-cli (tmux) → not broker',
      harness: { provider: 'openai', interactive: true, id: 'codex-cli' },
    },
    {
      name: 'interactive claude-code (tmux) → not broker',
      harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
    },
  ]
  for (const { name, harness } of interactiveCases) {
    it(name, () => {
      expect(decideHeadlessExecutionRoute!(intent(harness), { brokerFlagEnabled: true })).not.toBe(
        'broker'
      )
    })
  }
})

describe('runHeadlessRoute — dispatch + cody FAIL-CLOSED', () => {
  type Spies = {
    sdk: () => Promise<string>
    broker: () => Promise<string>
    legacyExec: () => Promise<string>
    calls: string[]
  }
  function makeSpies(
    overrides: Partial<Record<'sdk' | 'broker' | 'legacyExec', () => Promise<string>>> = {}
  ): Spies {
    const calls: string[] = []
    const wrap = (name: string, fn?: () => Promise<string>) => async () => {
      calls.push(name)
      return fn ? await fn() : name
    }
    return {
      calls,
      sdk: wrap('sdk', overrides.sdk),
      broker: wrap('broker', overrides.broker),
      legacyExec: wrap('legacyExec', overrides.legacyExec),
    }
  }

  it('route "broker" invokes ONLY the broker executor (no launch-artifact path)', async () => {
    const spies = makeSpies()
    const result = await runHeadlessRoute!('broker', {
      sdk: spies.sdk,
      broker: spies.broker,
      legacyExec: spies.legacyExec,
    })
    expect(result).toBe('broker')
    expect(spies.calls).toEqual(['broker'])
    // No legacy fallback was even reachable on the happy path.
    expect(spies.calls).not.toContain('legacyExec')
  })

  it('route "broker" that FAILS propagates the error and does NOT fall back to legacyExec', async () => {
    const failure = new Error('compile/selection/admission rejected')
    const spies = makeSpies({
      broker: async () => {
        throw failure
      },
    })
    await expect(
      runHeadlessRoute!('broker', {
        sdk: spies.sdk,
        broker: spies.broker,
        legacyExec: spies.legacyExec,
      })
    ).rejects.toThrow('compile/selection/admission rejected')
    // FAIL CLOSED: the turn fails; legacy exec.ts path is NOT silently entered.
    expect(spies.calls).toEqual(['broker'])
    expect(spies.calls).not.toContain('legacyExec')
    expect(spies.calls).not.toContain('sdk')
  })

  it('route "legacy-exec" invokes only the legacy executor', async () => {
    const spies = makeSpies()
    const result = await runHeadlessRoute!('legacy-exec', {
      sdk: spies.sdk,
      broker: spies.broker,
      legacyExec: spies.legacyExec,
    })
    expect(result).toBe('legacyExec')
    expect(spies.calls).toEqual(['legacyExec'])
    expect(spies.calls).not.toContain('broker')
  })

  it('route "sdk" invokes only the sdk executor', async () => {
    const spies = makeSpies()
    const result = await runHeadlessRoute!('sdk', {
      sdk: spies.sdk,
      broker: spies.broker,
      legacyExec: spies.legacyExec,
    })
    expect(result).toBe('sdk')
    expect(spies.calls).toEqual(['sdk'])
    expect(spies.calls).not.toContain('broker')
  })
})

describe('filterBrokerDispatchEnvForLockedEnv — broker dispatch contract', () => {
  it('removes compiler-locked keys and preserves dispatch-only correlation keys', () => {
    const startRequest = {
      spec: {
        process: {
          lockedEnv: {
            ASP_PROJECT: 'hrc-runtime',
            ASP_HOME: '/Users/lherron/praesidium/var/asp',
            AGENTCHAT_ID: 'locked-chat',
          },
        },
      },
    } as InvocationStartRequest

    expect(
      filterBrokerDispatchEnvForLockedEnv!(
        {
          ASP_PROJECT: 'shadow-project',
          ASP_HOME: 'shadow-home',
          AGENTCHAT_ID: 'shadow-chat',
          AGENT_SCOPE_REF: 'agent:larry:project:hrc-runtime:task:T-01698',
          AGENT_LANE_REF: 'main',
          AGENT_HOST_SESSION_ID: 'hostSession_w4',
          HRC_RUN_ID: 'run_w4',
        },
        startRequest
      )
    ).toEqual({
      AGENT_SCOPE_REF: 'agent:larry:project:hrc-runtime:task:T-01698',
      AGENT_LANE_REF: 'main',
      AGENT_HOST_SESSION_ID: 'hostSession_w4',
      HRC_RUN_ID: 'run_w4',
    })
  })
})

describe('decideInteractiveTmuxExecutionRoute — claude-code-tmux flag', () => {
  const interactiveClaudeIntent = intent(
    { provider: 'anthropic', interactive: true, id: 'claude-code' },
    'interactive'
  )

  it('flag OFF keeps interactive claude-code-tmux on the legacy tmux launch path', () => {
    const { profile } = makeInteractiveTmuxProfile()

    expect(
      decideInteractiveTmuxExecutionRoute!(interactiveClaudeIntent, profile, {
        brokerFlagEnabled: false,
      })
    ).toBe('legacy-tmux')
  })

  it('flag ON selects broker only by interactive tmux brokerDriver/terminal metadata', () => {
    const { profile } = makeInteractiveTmuxProfile()

    expect(
      decideInteractiveTmuxExecutionRoute!(interactiveClaudeIntent, profile, {
        brokerFlagEnabled: true,
      })
    ).toBe('broker')
  })

  it('does not let the claude-code-tmux flag affect the headless codex route', () => {
    const headlessCodex = intent({ provider: 'openai', interactive: false, id: 'codex-cli' })

    expect(decideHeadlessExecutionRoute!(headlessCodex, { brokerFlagEnabled: false })).toBe(
      'legacy-exec'
    )
  })

  it('does not select the claude-code-tmux route for another interactive tmux broker driver', () => {
    const { profile } = makeInteractiveTmuxProfile()
    const codexTmuxProfile = {
      ...profile,
      brokerDriver: 'codex-cli-tmux',
    } as BrokerExecutionProfile

    expect(
      decideInteractiveTmuxExecutionRoute!(interactiveClaudeIntent, codexTmuxProfile, {
        brokerFlagEnabled: true,
      })
    ).toBe('legacy-tmux')
  })
})

describe('runInteractiveTmuxRoute — dispatch + fail-closed', () => {
  function makeSpies(
    overrides: Partial<Record<'broker' | 'legacyTmux', () => Promise<string>>> = {}
  ): {
    broker: () => Promise<string>
    legacyTmux: () => Promise<string>
    calls: string[]
  } {
    const calls: string[] = []
    const wrap = (name: 'broker' | 'legacyTmux', fn?: () => Promise<string>) => async () => {
      calls.push(name)
      return fn ? await fn() : name
    }
    return {
      calls,
      broker: wrap('broker', overrides.broker),
      legacyTmux: wrap('legacyTmux', overrides.legacyTmux),
    }
  }

  it('route "broker" invokes only the broker executor', async () => {
    const spies = makeSpies()
    const result = await runInteractiveTmuxRoute!('broker', {
      broker: spies.broker,
      legacyTmux: spies.legacyTmux,
    })

    expect(result).toBe('broker')
    expect(spies.calls).toEqual(['broker'])
  })

  it('route "broker" that fails propagates the error and does not fall back to legacy tmux', async () => {
    const failure = new Error('interactive broker compile/admission rejected')
    const spies = makeSpies({
      broker: async () => {
        throw failure
      },
    })

    await expect(
      runInteractiveTmuxRoute!('broker', {
        broker: spies.broker,
        legacyTmux: spies.legacyTmux,
      })
    ).rejects.toThrow('interactive broker compile/admission rejected')
    expect(spies.calls).toEqual(['broker'])
  })

  it('route "legacy-tmux" invokes only the legacy tmux executor', async () => {
    const spies = makeSpies()
    const result = await runInteractiveTmuxRoute!('legacy-tmux', {
      broker: spies.broker,
      legacyTmux: spies.legacyTmux,
    })

    expect(result).toBe('legacyTmux')
    expect(spies.calls).toEqual(['legacyTmux'])
  })
})
