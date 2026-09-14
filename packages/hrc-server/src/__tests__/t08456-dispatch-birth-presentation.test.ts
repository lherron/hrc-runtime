/**
 * T-08456 — the interactive tmux dispatch door publishes presentation at BIRTH,
 * for every driver it admits.
 *
 * The defect: this publish was fenced to `claude-code-tmux` (T-08012), which
 * was then the only driver reaching this door. T-08338 routed dispatched Codex
 * through the same door and inherited the fence, so a codex-tui seat published
 * nothing at birth. Its first `runtime.presentation` then came from whichever
 * later door happened to touch the runtime — in practice the broker-reuse
 * publish that immediately precedes a SECOND turn. Measured on the live ledger
 * 2026-09-14: all 6 codex-tui presentation events landed 13-45ms before a later
 * `turn.accepted`, none at birth, while claude-code published at 0.5-0.9s from
 * birth on 11 of 11 runtimes regardless of turn count.
 *
 * The consequence a human sees: a dispatched codex seat is invisible in the
 * viewer for as long as it takes a second input to arrive (0.8-247s observed),
 * and permanently invisible when only one turn ever arrives — which is the
 * ordinary shape of a dispatch that does its work and closes.
 *
 * This test is driver-parameterized on purpose. The bug was not "codex was
 * forgotten"; it was that a birth publish keyed off a driver NAME at all, so
 * the next driver routed through this door would inherit the same silence.
 */
import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import type { InteractiveTmuxBrokerDriver } from '../broker-decisions'
import { handleInteractiveTmuxBrokerDispatchTurn } from '../broker-interactive-handlers'
import type { PublishPresentationOptions } from '../presentation-publish'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-08456'

function session(): HrcSessionRecord {
  return {
    hostSessionId: 'hsid-t08456',
    sessionRef: SCOPE,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'ready',
    createdAt: '2026-09-14T15:39:10.495Z',
    updatedAt: '2026-09-14T15:39:10.495Z',
  } as HrcSessionRecord
}

function intent(): HrcRuntimeIntent {
  return {
    placement: { kind: 'inline' },
    harness: { provider: 'openai', id: 'codex-cli', interactive: true },
    execution: { preferredMode: 'interactive' },
  } as HrcRuntimeIntent
}

function runtime(): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-t08456',
    hostSessionId: 'hsid-t08456',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    provider: 'openai',
    harnessId: 'codex-cli',
    transport: 'tmux',
    status: 'ready',
    createdAt: '2026-09-14T15:39:10.495Z',
    updatedAt: '2026-09-14T15:39:10.495Z',
  } as HrcRuntimeSnapshot
}

async function dispatchAndCapturePublishes(
  allowedBrokerDriver: InteractiveTmuxBrokerDriver,
  attachBeforeInvocationStart?: { pendingStartId: string }
): Promise<{ status: number; publishCalls: Array<PublishPresentationOptions | undefined> }> {
  const publishCalls: Array<PublishPresentationOptions | undefined> = []
  const mockThis = {
    startInteractiveTmuxBrokerRuntime: async () => runtime(),
    publishPresentation: async (
      _runtime: HrcRuntimeSnapshot,
      options?: PublishPresentationOptions
    ) => {
      publishCalls.push(options)
    },
  }

  const response = await handleInteractiveTmuxBrokerDispatchTurn.call(
    mockThis as Parameters<typeof handleInteractiveTmuxBrokerDispatchTurn.call>[0],
    session(),
    intent(),
    'do the work',
    `run-t08456-${allowedBrokerDriver}`,
    {
      flagEnvName: 'HRC_CODEX_CLI_TMUX_BROKER',
      allowedBrokerDriver,
      waitForCompletion: false,
      ...(attachBeforeInvocationStart ? { attachBeforeInvocationStart } : {}),
    }
  )

  return { status: response.status, publishCalls }
}

// Every driver this door admits. Adding a driver to the union without adding it
// here should be a deliberate act, not a silent inheritance of the old fence.
const DISPATCH_DRIVERS: InteractiveTmuxBrokerDriver[] = [
  'claude-code-tmux',
  'codex-app-server',
  'codex-cli-tmux',
  'pi-tui-tmux',
  'agent-harness-tmux',
]

describe('T-08456 dispatch-door birth presentation', () => {
  for (const driver of DISPATCH_DRIVERS) {
    it(`publishes presentation at birth for ${driver}, without a second turn`, async () => {
      const { status, publishCalls } = await dispatchAndCapturePublishes(driver)

      expect(status).toBe(200)
      // Exactly one publish, at birth. Before the fix, every driver except
      // claude-code-tmux produced [] here and waited for a reuse turn that a
      // one-shot dispatch never sends.
      expect(publishCalls).toEqual([{ operatorAttachPending: false }])
    })
  }

  it('still suppresses the viewer when an operator terminal is attaching (codex)', async () => {
    // Driver-blindness must not cost the T-05881 suppression: an attached
    // terminal is the one case where a pane should NOT be requested, and that
    // predicate is the attach option, never the driver name.
    const { status, publishCalls } = await dispatchAndCapturePublishes('codex-cli-tmux', {
      pendingStartId: 'attached-t08456',
    })

    expect(status).toBe(200)
    expect(publishCalls).toEqual([{ operatorAttachPending: true }])
  })
})
