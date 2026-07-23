/**
 * Regression: a headless-preferred dispatch (a cross-agent `hrcchat dm` / any
 * nonInteractive turn) for a scope that ALREADY has a live interactive broker
 * runtime (the open TUI) must be delivered INTO that runtime via broker-reuse —
 * never spawned as a competing headless run, and never rejected because the TUI
 * is mid-turn. A busy interactive broker queues the input (whenBusy:'queue')
 * and drains it on the next turn.completed.
 *
 * The original defect: dispatchTurnForSession's headless branch fired BEFORE
 * consulting the live interactive runtime, so a codex DM spawned a headless
 * codex-app-server that resumed the same continuation thread the live TUI owned,
 * found no rollout in its re-derived codex home, and wedged at `starting`
 * (the turn silently died). A first patch deferred only when the TUI was idle,
 * leaving busy TUIs (a non-finalized boot/priming turn) to still fork headless;
 * this drops the idle gate so any live interactive TUI receives the turn.
 *
 * shouldDeferHeadlessToInteractiveBrokerReuse is the pure seam the call site
 * gates on. true => skip headless, fall through to decideInteractiveBrokerAdmission.
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'

import {
  type LiveInteractiveRuntimeReuseView,
  shouldDeferHeadlessToInteractiveBrokerReuse,
} from '../index.js'

function codexIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/agents/cody',
      cwd: '/agents/cody',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: false,
    },
    harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
    execution: { preferredMode: 'nonInteractive' },
  }
}

function codexIntentWithSurfaceReuse(
  allowInteractiveSurfaceReuse: boolean | undefined
): HrcRuntimeIntent {
  return {
    ...codexIntent(),
    execution: {
      preferredMode: 'nonInteractive',
      ...(allowInteractiveSurfaceReuse !== undefined ? { allowInteractiveSurfaceReuse } : {}),
    },
  }
}

function liveCodexTui(
  overrides: Partial<NonNullable<LiveInteractiveRuntimeReuseView>> = {}
): LiveInteractiveRuntimeReuseView {
  return {
    controllerKind: 'harness-broker',
    transport: 'tmux',
    provider: 'openai',
    status: 'ready',
    hasLiveSurface: true,
    idle: true,
    ...overrides,
  }
}

describe('shouldDeferHeadlessToInteractiveBrokerReuse', () => {
  it('defers a headless codex DM into a live, idle codex-cli-tmux broker runtime', () => {
    expect(shouldDeferHeadlessToInteractiveBrokerReuse(codexIntent(), liveCodexTui())).toBe(true)
  })

  it('takes the headless route when no runtime exists (cron/autonomous dispatch)', () => {
    expect(shouldDeferHeadlessToInteractiveBrokerReuse(codexIntent(), null)).toBe(false)
  })

  it('DOES defer when the interactive runtime is busy (mid-turn) — the TUI queues the input', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(codexIntent(), liveCodexTui({ idle: false }))
    ).toBe(true)
  })

  it('does NOT defer an autonomous headless dispatch that explicitly vetoes interactive surface reuse', () => {
    // T-05177: autonomous one-shot producers stamp this flag so same-session
    // leftovers cannot capture the dispatch into an existing operator TUI.
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntentWithSurfaceReuse(false),
        liveCodexTui()
      )
    ).toBe(false)
  })

  it('preserves default and explicit-true live TUI reuse, including busy queue-capable runtimes', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntentWithSurfaceReuse(undefined),
        liveCodexTui()
      )
    ).toBe(true)
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(codexIntentWithSurfaceReuse(true), liveCodexTui())
    ).toBe(true)
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntentWithSurfaceReuse(undefined),
        liveCodexTui({ idle: false })
      )
    ).toBe(true)
  })

  it('does NOT defer when the runtime is in an unavailable status', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(codexIntent(), liveCodexTui({ status: 'stale' }))
    ).toBe(false)
  })

  it('does NOT defer to a non-broker (legacy) tmux runtime', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntent(),
        liveCodexTui({ controllerKind: undefined })
      )
    ).toBe(false)
  })

  it('does NOT defer when the runtime has no live surface', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntent(),
        liveCodexTui({ hasLiveSurface: false })
      )
    ).toBe(false)
  })

  it('does NOT defer to a headless runtime', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntent(),
        liveCodexTui({ transport: 'headless' })
      )
    ).toBe(false)
  })

  it('does NOT defer when the live runtime provider differs from the intent', () => {
    expect(
      shouldDeferHeadlessToInteractiveBrokerReuse(
        codexIntent(),
        liveCodexTui({ provider: 'anthropic' })
      )
    ).toBe(false)
  })
})
