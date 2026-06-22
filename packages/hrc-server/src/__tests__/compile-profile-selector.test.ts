/**
 * RED tests (T-01695 / T-01690 Wave W2) for the broker profile SELECTOR.
 *
 * These tests are EXPECTED TO FAIL until curly implements
 *   packages/hrc-server/src/agent-spaces-adapter/compile-profile-selector.ts
 *
 * The selector performs STATIC admission + hash verification over a compiled
 * plan. For T-01690 it admits ONLY a headless codex-app-server harness-broker
 * profile, and REJECTS (never silently falls back) otherwise.
 *
 * Public API under test (see final reply / API contract):
 *   selectBrokerExecutionProfile(response, identity): BrokerProfileSelection
 */

import { describe, expect, it } from 'bun:test'
import { selectBrokerExecutionProfile } from '../agent-spaces-adapter/compile-profile-selector'

import {
  makeBrokerProfile,
  makeCompileResponse,
  makeFailedCompileResponse,
  makeIdentity,
  makeInteractiveTmuxProfile,
  neutralSpecHash,
  neutralStartRequestHash,
} from './broker-compile-fixtures'

describe('selectBrokerExecutionProfile (W2 admission)', () => {
  it('admits exactly ONE valid headless codex-app-server broker profile', () => {
    const identity = makeIdentity()
    const { profile, startRequest } = makeBrokerProfile(identity)
    const response = makeCompileResponse(identity, [profile])

    const selection = selectBrokerExecutionProfile(response, identity)

    expect(selection.admitted).toBe(true)
    if (!selection.admitted) return // narrow

    expect(selection.profile.kind).toBe('harness-broker')
    expect(selection.profile.interactionMode).toBe('headless')
    expect(selection.profile.brokerProtocol).toBe('harness-broker/0.2')
    expect(selection.profile.brokerDriver).toBe('codex-app-server')
    // verified hashes echoed through
    expect(selection.specHash).toBe(profile.harnessInvocation.specHash)
    expect(selection.startRequestHash).toBe(profile.harnessInvocation.startRequestHash)
    // selected startRequest is the compiled one
    expect(selection.startRequest.spec.invocationId).toBe(startRequest.spec.invocationId)
  })

  it('freezes the admitted startRequest so it can never be mutated downstream', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity)
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )

    expect(selection.admitted).toBe(true)
    if (!selection.admitted) return
    expect(Object.isFrozen(selection.startRequest)).toBe(true)
    expect(Object.isFrozen(selection.startRequest.spec)).toBe(true)
  })

  it('REJECTS when the compile response is not ok (no fallback)', () => {
    const identity = makeIdentity()
    const selection = selectBrokerExecutionProfile(makeFailedCompileResponse(), identity)
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('compile-not-ok')
  })

  it('admits an interactive claude-code-tmux broker profile by broker driver and terminal', () => {
    const identity = makeIdentity()
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    const selection = selectBrokerExecutionProfile(response, identity)

    expect(selection.admitted).toBe(true)
    if (!selection.admitted) return
    expect(selection.profile.brokerDriver).toBe('claude-code-tmux')
    expect(selection.profile.brokerTerminal).toEqual({ host: 'tmux' })
    expect(selection.startRequest).toBe(startRequest)
    expect((selection.startRequest as unknown as { runtime?: unknown }).runtime).toBeUndefined()
  })

  it('admits an interactive pi-tui-tmux broker profile by broker driver and terminal', () => {
    const identity = makeIdentity()
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity, {
      brokerDriver: 'pi-tui-tmux',
    })
    const response = makeCompileResponse(identity, [profile])
    const selection = selectBrokerExecutionProfile(response, identity)

    expect(selection.admitted).toBe(true)
    if (!selection.admitted) return
    expect(selection.profile.brokerDriver).toBe('pi-tui-tmux')
    expect(selection.profile.brokerTerminal).toEqual({ host: 'tmux' })
    expect(selection.startRequest).toBe(startRequest)
  })

  it('REJECTS a non-codex broker driver (does not admit other drivers)', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity, { brokerDriver: 'claude-code-tmux' })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('no-matching-profile')
  })

  it('REJECTS an interactive codex broker profile (headless-only for W2)', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity, { interactionMode: 'interactive' })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('no-matching-profile')
  })

  it('REJECTS when multiple ambiguous candidate profiles match', () => {
    const identity = makeIdentity()
    const { profile: a } = makeBrokerProfile(identity, { profileId: 'profile_a' })
    const { profile: b } = makeBrokerProfile(identity, { profileId: 'profile_b' })
    const selection = selectBrokerExecutionProfile(makeCompileResponse(identity, [a, b]), identity)
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('ambiguous-profiles')
  })

  it('REJECTS when the selected profile carries error diagnostics', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity, {
      diagnostics: [
        { level: 'error', code: 'driver-unavailable', message: 'no codex', plane: 'asp-compiler' },
      ],
    })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('profile-diagnostics-error')
  })

  it('REJECTS on specHash mismatch when the spec is mutated after compile', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity)
    // tamper with the spec without recomputing the hash
    profile.harnessInvocation.startRequest.spec.process.args = ['app-server', '--tampered']
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('spec-hash-mismatch')
  })

  it('REJECTS on startRequestHash mismatch when startRequest is mutated after compile', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity)
    // tamper at the startRequest level (spec untouched, so specHash still matches)
    ;(profile.harnessInvocation.startRequest as { runtime?: unknown }).runtime = {
      tmux: { socketPath: '/tmp/injected.sock' },
    }
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('start-request-hash-mismatch')
  })

  it('REJECTS when startRequest.spec.invocationId does not match the allocated identity', () => {
    const identity = makeIdentity()
    // compiler echoed a DIFFERENT invocationId; hashes are internally valid
    const { profile } = makeBrokerProfile(identity, { invocationId: 'invocation_other' })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('invocation-id-mismatch')
  })

  it('REJECTS when the initialInput id does not match the allocated initialInputId', () => {
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity, { initialInputId: 'input_other' })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )
    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('initial-input-id-mismatch')
  })

  it('ADMITS an interactive tmux profile primed via launch argv (no broker initialInput)', () => {
    // The launch-primed contract: an initial turn exists, so the caller still
    // allocates identity.initialInputId, but the compiler delivers the priming
    // via spec.launch.initialPrompt and drops startRequest.initialInput. There
    // is nothing to id-correlate — the priming is hash-bound through specHash
    // and invocationId — so the selector must admit rather than reject.
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux' as ReturnType<typeof makeIdentity>['runtimeId'],
      invocationId: 'invocation_tmux' as ReturnType<typeof makeIdentity>['invocationId'],
    })
    expect(identity.initialInputId).toBeDefined() // precondition: id WAS allocated
    const { profile } = makeInteractiveTmuxProfile(identity, {
      launchInitialPrompt: 'PRIMING: hello clod',
      withInitialInput: false,
    })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )

    expect(selection.admitted).toBe(true)
    if (!selection.admitted) return
    expect(selection.startRequest.initialInput).toBeUndefined()
    expect(selection.startRequest.spec.launch?.initialPrompt).toBe('PRIMING: hello clod')
  })

  it('REJECTS a launch-primed profile that ALSO carries a mismatched initialInput', () => {
    // The relaxation is guarded on initialInput === undefined. If a profile
    // both rides the launch argv AND echoes a (stale/forged) initialInput whose
    // id does not match, strict id-binding must still fire.
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux' as ReturnType<typeof makeIdentity>['runtimeId'],
      invocationId: 'invocation_tmux' as ReturnType<typeof makeIdentity>['invocationId'],
    })
    const { profile } = makeInteractiveTmuxProfile(identity, {
      launchInitialPrompt: 'PRIMING: hello clod',
      withInitialInput: true,
      initialInputId: 'input_other',
    })
    const selection = selectBrokerExecutionProfile(
      makeCompileResponse(identity, [profile]),
      identity
    )

    expect(selection.admitted).toBe(false)
    if (selection.admitted) return
    expect(selection.code).toBe('initial-input-id-mismatch')
  })

  it('verifies hashes with the exported project() helper (sanity on fixtures)', () => {
    // Guards the fixtures themselves: an unmutated profile must hash-verify.
    const identity = makeIdentity()
    const { profile } = makeBrokerProfile(identity)
    const recomputedSpec = neutralSpecHash(profile.harnessInvocation.startRequest.spec)
    const recomputedStart = neutralStartRequestHash(profile.harnessInvocation.startRequest)
    expect(recomputedSpec).toBe(profile.harnessInvocation.specHash)
    expect(recomputedStart).toBe(profile.harnessInvocation.startRequestHash)
  })
})
