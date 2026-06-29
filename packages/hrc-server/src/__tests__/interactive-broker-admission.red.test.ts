/**
 * T-01753 Wave B cutover — RED acceptance tests (smokey).
 *
 * Wave B makes the interactive-tmux dispatch tail of dispatchTurnForSession
 * FAIL CLOSED onto the Harness Broker. Today that tail ends in an UNCONDITIONAL
 * legacy fallback (handleLegacyInteractiveTmuxDispatchTurn @2378 of ../index)
 * plus two now-dead legacyTmux closures, and it can literal-deliver a turn into
 * a live NON-broker runtime. This file pins the NET-NEW behavior:
 *
 *   - T-01755: every intent that reaches the interactive dispatch tail either
 *     resolves to a broker action or errors (RUNTIME_UNAVAILABLE). No supported
 *     harness may produce a legacy outcome.
 *   - T-01756: a live runtime whose controllerKind is NOT 'harness-broker' is
 *     NEVER selected for harness input — it is staled and a fresh broker runtime
 *     is reprovisioned. No non-broker literal delivery.
 *   - T-01758: because the only non-error outcomes are broker-{start,reuse} and
 *     stale-and-reprovision (→ broker start), ensure/attach gated on this same
 *     decision can never rematerialize a legacy interactive tmux runtime.
 *
 * These are PURE/INJECTABLE seam tests. They do NOT spawn a broker, run a live
 * turn, or restart HRC — that is larry's installed-binary e2e (the closure gate).
 *
 * ── Seam contract larry must implement in ../index (exported, pure, no live deps):
 *
 *   export type InteractiveTmuxBrokerDriver = 'claude-code-tmux' | 'codex-cli-tmux'
 *
 *   // The (controllerKind / transport / status) view of the latest runtime the
 *   // decision consults, plus the two fields needed to match it to a driver.
 *   // larry derives this from HrcRuntimeSnapshot via getBrokerRuntimeDriver +
 *   // isRuntimeUnavailableStatus; null when no runtime exists for the session.
 *   export type LatestRuntimeAdmissionView = {
 *     controllerKind: HrcRuntimeControllerKind | undefined
 *     transport: string
 *     status: string
 *     provider: HrcProvider
 *     brokerDriver: InteractiveTmuxBrokerDriver | undefined
 *   } | null
 *
 *   export type InteractiveBrokerAdmissionDecision =
 *     // Reuse the live broker pane (executeInteractiveBrokerInputTurn).
 *     | { decision: 'broker-reuse'; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
 *     // No reusable runtime → start a fresh broker runtime
 *     // (runInteractiveTmuxRoute('broker', …), NO legacyTmux executor).
 *     | { decision: 'broker-start'; flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
 *     // A live but NON-broker (or wrong-driver) runtime exists: stale/terminate it,
 *     // then broker-start. NEVER literal-deliver into it.
 *     | { decision: 'stale-and-reprovision'; flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
 *     // Not broker-admissible → caller throws HrcRuntimeUnavailableError. NO legacy.
 *     | { decision: 'runtime-unavailable'; reason: string }
 *
 *   export function decideInteractiveBrokerAdmission(
 *     intent: HrcRuntimeIntent,           // POST T-01770 redirect (claude SDK-shaped already normalized)
 *     latestRuntime: LatestRuntimeAdmissionView,
 *     options: { claudeCodeTmuxBrokerEnabled: boolean; codexCliTmuxBrokerEnabled: boolean },
 *   ): InteractiveBrokerAdmissionDecision
 *
 * ── Decision semantics (the disposition for each C-03007 @2378 shape):
 *
 *   Step 1 — resolve the target broker driver for the intent:
 *     · GHOSTTY guard FIRST: if the intent is a Ghostty Claude intent
 *       (HRC_CLAUDE_GHOSTTY on, shouldUseGhosttyTransport(intent)) → NO driver.
 *       Ghostty is an operator-diagnostic surface only, never semantic dispatch
 *       /reuse  → 'runtime-unavailable'  [C-03007 shape 1].
 *     · provider 'anthropic' AND harness.id ∈ {undefined, 'claude-code'} AND
 *       claudeCodeTmuxBrokerEnabled → 'claude-code-tmux'.
 *     · provider 'openai' AND harness.id ∈ {undefined, 'codex-cli'} AND
 *       codexCliTmuxBrokerEnabled → 'codex-cli-tmux'  [shape 4: openai id-less is
 *       admissible HERE; the "only if it resolves to codex-cli-tmux, else
 *       RUNTIME_UNAVAILABLE" guarantee is enforced DOWNSTREAM by the broker
 *       compile/admission fail-close — see runInteractiveTmuxRoute('broker') in
 *       headless-execution-route.test.ts].
 *     · otherwise (pi, pi-cli, unknown ids; matching flag OFF) → NO driver
 *       → 'runtime-unavailable'  [shape 2; flag-OFF is test-only, NEVER legacy].
 *       NOTE the driver resolution keys on EXPLICIT provider+id; pi/pi-cli/unknown
 *       are NEVER silently normalized to claude-code/codex-cli.
 *       NOTE the interactive flag is NOT required here, so an SDK/noninteractive
 *       intent that falls through (because a live idle interactive runtime exists)
 *       is still broker-gated against that runtime  [shape 3].
 *
 *   Step 2 — given a resolved driver, consult latestRuntime:
 *     · live (status not terminated/dead/stale) AND controllerKind ===
 *       'harness-broker' AND transport === 'tmux' AND provider matches AND
 *       brokerDriver === resolved driver → 'broker-reuse'.
 *     · live but controllerKind !== 'harness-broker' OR brokerDriver mismatch
 *       → 'stale-and-reprovision'  [T-01756: never reuse a non-broker runtime].
 *     · none / unavailable status → 'broker-start'.
 *
 * ── Landmines this file guards (must NOT regress):
 *   · T-01770 redirect: anthropic id-less / claude-code / agent-sdk / pi-sdk are
 *     normalized to interactive claude-code BEFORE admission, so they must resolve
 *     BROKER-START, never runtime-unavailable. The "unsupported id" reds below use
 *     pi / pi-cli / unknown, NEVER claude-shaped intents.
 *   · The decision union has NO 'legacy' / 'legacy-tmux' / 'legacy-exec' member —
 *     a supported harness can never produce a legacy outcome.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import * as hrc from '../index'

type Harness = HrcRuntimeIntent['harness']
type InteractiveTmuxBrokerDriver = 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux'

type LatestRuntimeAdmissionView = {
  controllerKind: string | undefined
  transport: string
  status: string
  provider: 'anthropic' | 'openai'
  brokerDriver: InteractiveTmuxBrokerDriver | undefined
} | null

type InteractiveBrokerAdmissionDecision =
  | { decision: 'broker-reuse'; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
  | {
      decision: 'broker-start'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | {
      decision: 'stale-and-reprovision'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | { decision: 'runtime-unavailable'; reason: string }

const HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED = 'HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED'
const HRC_CODEX_CLI_TMUX_BROKER_ENABLED = 'HRC_CODEX_CLI_TMUX_BROKER_ENABLED'
const HRC_PI_TUI_TMUX_BROKER_ENABLED = 'HRC_PI_TUI_TMUX_BROKER_ENABLED'
const HRC_CLAUDE_GHOSTTY = 'HRC_CLAUDE_GHOSTTY'

const BOTH_FLAGS_ON = {
  claudeCodeTmuxBrokerEnabled: true,
  codexCliTmuxBrokerEnabled: true,
  piTuiTmuxBrokerEnabled: true,
}

// Minimal valid intent factory — only the fields the admission decision reads.
function intent(
  harness: Harness,
  preferredMode: 'headless' | 'interactive' | 'nonInteractive' = 'interactive'
): HrcRuntimeIntent {
  return {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    harness,
    execution: { preferredMode },
  }
}

function runtimeView(
  overrides: Partial<NonNullable<LatestRuntimeAdmissionView>> = {}
): LatestRuntimeAdmissionView {
  return {
    controllerKind: 'harness-broker',
    transport: 'tmux',
    status: 'running',
    provider: 'anthropic',
    brokerDriver: 'claude-code-tmux',
    inputDispatchable: true,
    ...overrides,
  }
}

// Typed handle to the seam under test (undefined until larry implements it).
const decideInteractiveBrokerAdmission = (
  hrc as unknown as {
    decideInteractiveBrokerAdmission?: (
      intent: HrcRuntimeIntent,
      latestRuntime: LatestRuntimeAdmissionView,
      options: {
        claudeCodeTmuxBrokerEnabled: boolean
        codexCliTmuxBrokerEnabled: boolean
        piTuiTmuxBrokerEnabled: boolean
      }
    ) => InteractiveBrokerAdmissionDecision
  }
).decideInteractiveBrokerAdmission

const claudeInteractive = intent({ provider: 'anthropic', interactive: true, id: 'claude-code' })
const codexInteractive = intent({ provider: 'openai', interactive: true, id: 'codex-cli' })
const piInteractive = intent({ provider: 'openai', interactive: true, id: 'pi' })

describe('Wave B admission seam — export exists', () => {
  it('exports decideInteractiveBrokerAdmission', () => {
    expect(typeof decideInteractiveBrokerAdmission).toBe('function')
  })
})

describe('decideInteractiveBrokerAdmission — supported happy paths → broker-start (no live runtime)', () => {
  it('interactive claude-code → broker-start (claude-code-tmux)', () => {
    expect(decideInteractiveBrokerAdmission!(claudeInteractive, null, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'claude-code-tmux',
    })
  })

  it('interactive codex-cli → broker-start (codex-cli-tmux)', () => {
    expect(decideInteractiveBrokerAdmission!(codexInteractive, null, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'codex-cli-tmux',
    })
  })

  it('interactive pi → broker-start (pi-tui-tmux)', () => {
    expect(decideInteractiveBrokerAdmission!(piInteractive, null, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_PI_TUI_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'pi-tui-tmux',
    })
  })

  it('interactive pi-cli → broker-start (pi-tui-tmux)', () => {
    expect(
      decideInteractiveBrokerAdmission!(
        intent({ provider: 'openai', interactive: true, id: 'pi-cli' }),
        null,
        BOTH_FLAGS_ON
      )
    ).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_PI_TUI_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'pi-tui-tmux',
    })
  })

  it('id-less anthropic interactive (post T-01770 redirect / ariadne-class) → broker-start, NOT runtime-unavailable', () => {
    const idless = intent({ provider: 'anthropic', interactive: true })
    expect(decideInteractiveBrokerAdmission!(idless, null, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'claude-code-tmux',
    })
  })

  it('id-less openai interactive (shape 4) → broker-start; the codex-only guarantee is the downstream compile fail-close', () => {
    const idless = intent({ provider: 'openai', interactive: true })
    expect(decideInteractiveBrokerAdmission!(idless, null, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-start',
      flagEnvName: HRC_CODEX_CLI_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'codex-cli-tmux',
    })
  })
})

describe('decideInteractiveBrokerAdmission — unsupported ids → runtime-unavailable (NEVER normalize, NEVER legacy)', () => {
  const unsupported: { name: string; harness: Harness }[] = [
    {
      name: 'anthropic pi (interactive)',
      harness: { provider: 'anthropic', interactive: true, id: 'pi' },
    },
    {
      name: 'unknown openai id (must NOT normalize to codex-cli)',
      harness: { provider: 'openai', interactive: true, id: 'frobnicate' } as unknown as Harness,
    },
    {
      name: 'unknown anthropic id (must NOT normalize to claude-code)',
      harness: { provider: 'anthropic', interactive: true, id: 'frobnicate' } as unknown as Harness,
    },
  ]
  for (const { name, harness } of unsupported) {
    it(`${name} → runtime-unavailable`, () => {
      const decision = decideInteractiveBrokerAdmission!(intent(harness), null, BOTH_FLAGS_ON)
      expect(decision.decision).toBe('runtime-unavailable')
    })
  }
})

describe('decideInteractiveBrokerAdmission — Ghostty Claude → runtime-unavailable (operator-diagnostic only)', () => {
  const prior = process.env[HRC_CLAUDE_GHOSTTY]
  afterEach(() => {
    if (prior === undefined) delete process.env[HRC_CLAUDE_GHOSTTY]
    else process.env[HRC_CLAUDE_GHOSTTY] = prior
  })

  it('Ghostty Claude interactive (HRC_CLAUDE_GHOSTTY on) is NOT semantic broker dispatch → runtime-unavailable [shape 1]', () => {
    process.env[HRC_CLAUDE_GHOSTTY] = '1'
    const decision = decideInteractiveBrokerAdmission!(claudeInteractive, null, BOTH_FLAGS_ON)
    expect(decision.decision).toBe('runtime-unavailable')
  })
})

describe('decideInteractiveBrokerAdmission — flag OFF fails closed (test-only flags, NEVER legacy)', () => {
  it('claude intent with claude flag OFF → runtime-unavailable (no legacy fallback)', () => {
    const decision = decideInteractiveBrokerAdmission!(claudeInteractive, null, {
      claudeCodeTmuxBrokerEnabled: false,
      codexCliTmuxBrokerEnabled: true,
    })
    expect(decision.decision).toBe('runtime-unavailable')
  })

  it('codex intent with codex flag OFF → runtime-unavailable (no legacy fallback)', () => {
    const decision = decideInteractiveBrokerAdmission!(codexInteractive, null, {
      claudeCodeTmuxBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: false,
    })
    expect(decision.decision).toBe('runtime-unavailable')
  })
})

describe('decideInteractiveBrokerAdmission — live broker runtime → broker-reuse', () => {
  it('matching live claude-code-tmux broker runtime → broker-reuse', () => {
    const live = runtimeView({
      controllerKind: 'harness-broker',
      provider: 'anthropic',
      brokerDriver: 'claude-code-tmux',
    })
    expect(decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-reuse',
      allowedBrokerDriver: 'claude-code-tmux',
    })
  })

  it('matching live codex-cli-tmux broker runtime → broker-reuse', () => {
    const live = runtimeView({
      controllerKind: 'harness-broker',
      provider: 'openai',
      brokerDriver: 'codex-cli-tmux',
    })
    expect(decideInteractiveBrokerAdmission!(codexInteractive, live, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-reuse',
      allowedBrokerDriver: 'codex-cli-tmux',
    })
  })

  it('live broker runtime with an unavailable status is NOT reused → broker-start', () => {
    for (const status of ['terminated', 'dead', 'stale']) {
      const live = runtimeView({ status })
      const decision = decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)
      expect(decision.decision).toBe('broker-start')
    }
  })

  it('T-05358: a matching runtime that is NOT input-dispatchable (starting/stopping) → stale-and-reprovision, NOT broker-reuse', () => {
    // Row status is `stopping` (a non-unavailable status, so the status gate
    // passes) but the active invocation cannot accept input. Must NOT be reused.
    const live = runtimeView({ status: 'stopping', inputDispatchable: false })
    const decision = decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)
    expect(decision.decision).toBe('stale-and-reprovision')
  })

  it('T-05358: the SAME matching runtime IS reused when input-dispatchable', () => {
    const live = runtimeView({ status: 'running', inputDispatchable: true })
    const decision = decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)
    expect(decision.decision).toBe('broker-reuse')
  })
})

describe('decideInteractiveBrokerAdmission — T-01756: non-broker live runtime is NEVER reused', () => {
  const nonBrokerControllerKinds = [undefined, 'terminal', 'legacy-exec', 'embedded-sdk']
  for (const controllerKind of nonBrokerControllerKinds) {
    it(`live tmux runtime controllerKind=${String(controllerKind)} → stale-and-reprovision (no literal delivery)`, () => {
      const live = runtimeView({ controllerKind, brokerDriver: undefined })
      const decision = decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)
      expect(decision).toEqual({
        decision: 'stale-and-reprovision',
        flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED,
        allowedBrokerDriver: 'claude-code-tmux',
      })
      // Hard invariant: a non-broker runtime is never selected for harness input.
      expect(decision.decision).not.toBe('broker-reuse')
    })
  }

  it('live broker runtime but WRONG driver → stale-and-reprovision (reprovision the correct driver)', () => {
    const live = runtimeView({
      controllerKind: 'harness-broker',
      provider: 'anthropic',
      brokerDriver: 'codex-cli-tmux',
    })
    const decision = decideInteractiveBrokerAdmission!(claudeInteractive, live, BOTH_FLAGS_ON)
    expect(decision).toEqual({
      decision: 'stale-and-reprovision',
      flagEnvName: HRC_CLAUDE_CODE_TMUX_BROKER_ENABLED,
      allowedBrokerDriver: 'claude-code-tmux',
    })
  })
})

describe('decideInteractiveBrokerAdmission — shape 3: SDK/noninteractive fallthrough is still broker-gated', () => {
  // An intent that reached the interactive tail only because a live idle interactive
  // runtime exists (harness.interactive === false). It must NOT literal-deliver into
  // a non-broker runtime; it reuses ONLY a matching broker runtime.
  const sdkShapedOpenai = intent({ provider: 'openai', interactive: false }, 'nonInteractive')

  it('live matching broker (codex-cli-tmux) → broker-reuse', () => {
    const live = runtimeView({
      controllerKind: 'harness-broker',
      provider: 'openai',
      brokerDriver: 'codex-cli-tmux',
    })
    expect(decideInteractiveBrokerAdmission!(sdkShapedOpenai, live, BOTH_FLAGS_ON)).toEqual({
      decision: 'broker-reuse',
      allowedBrokerDriver: 'codex-cli-tmux',
    })
  })

  it('live NON-broker tmux runtime → stale-and-reprovision (no non-broker literal delivery)', () => {
    const live = runtimeView({
      controllerKind: undefined,
      provider: 'openai',
      brokerDriver: undefined,
    })
    const decision = decideInteractiveBrokerAdmission!(sdkShapedOpenai, live, BOTH_FLAGS_ON)
    expect(decision.decision).toBe('stale-and-reprovision')
    expect(decision.decision).not.toBe('broker-reuse')
  })
})

describe('decideInteractiveBrokerAdmission — NEVER a legacy outcome for any input', () => {
  const legacyDiscriminants = new Set(['legacy', 'legacy-tmux', 'legacy-exec'])
  const matrix: { name: string; intent: HrcRuntimeIntent; runtime: LatestRuntimeAdmissionView }[] =
    [
      { name: 'claude start', intent: claudeInteractive, runtime: null },
      { name: 'codex start', intent: codexInteractive, runtime: null },
      {
        name: 'claude reuse',
        intent: claudeInteractive,
        runtime: runtimeView({ brokerDriver: 'claude-code-tmux' }),
      },
      {
        name: 'claude vs legacy runtime',
        intent: claudeInteractive,
        runtime: runtimeView({ controllerKind: undefined, brokerDriver: undefined }),
      },
      {
        name: 'pi unsupported',
        intent: intent({ provider: 'openai', interactive: true, id: 'pi' }),
        runtime: null,
      },
    ]
  for (const { name, intent: i, runtime } of matrix) {
    it(`${name} → decision discriminant is never legacy`, () => {
      const decision = decideInteractiveBrokerAdmission!(i, runtime, BOTH_FLAGS_ON)
      expect(legacyDiscriminants.has(decision.decision)).toBe(false)
    })
  }
})
