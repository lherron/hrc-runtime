/**
 * T-07047 live-substrate predicate: the recorded leased-tmux session exists and
 * its broker pane holds a live process. Shared by the semantic-DM reattach door
 * and T-10632's retained-evidence death evidence, so the door and the evidence
 * that the door is closed cannot drift apart. Probe errors propagate; each
 * caller decides what an unanswerable probe means.
 */

import { isLiveProcess } from '../server-lock.js'
import { createTmuxManager } from '../tmux.js'
import type { BrokerRuntimeSubstrate } from './runtime-hosting.js'

export type LiveSubstrateProbeDeps = {
  createTmuxManager(options: { socketPath: string }): {
    listSessionNames(): Promise<string[]>
    inspectPaneProcess(
      paneId: string
    ): Promise<{ command: string; pid: number; dead: boolean } | null>
  }
  isLiveProcess(pid: number): boolean
}

export async function leasedTmuxBrokerPaneLive(
  substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }>,
  deps: Partial<LiveSubstrateProbeDeps> = {}
): Promise<boolean> {
  const leaseTmux = (deps.createTmuxManager ?? createTmuxManager)({
    socketPath: substrate.tmuxSocketPath,
  })
  const sessionExists = (await leaseTmux.listSessionNames()).includes(substrate.sessionName)
  const paneProcess = sessionExists
    ? await leaseTmux.inspectPaneProcess(substrate.brokerWindow.paneId)
    : null
  return (
    paneProcess !== null &&
    paneProcess.pid > 0 &&
    !paneProcess.dead &&
    (deps.isLiveProcess ?? isLiveProcess)(paneProcess.pid)
  )
}
