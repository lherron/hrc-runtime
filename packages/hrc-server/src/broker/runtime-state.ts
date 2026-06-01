import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { InvocationRuntimeContext } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import type { BrokerTmuxAllocation } from './controller'

export function runtimeStatusFromInvocationState(state: string): string {
  if (state === 'ready') return 'ready'
  if (state === 'turn_active') return 'busy'
  if (state === 'stopping') return 'stopping'
  if (state === 'exited') return 'stopped'
  if (state === 'failed') return 'failed'
  if (state === 'disposed') return 'disposed'
  return 'starting'
}

export function isBrokerTmuxProfile(profile: BrokerExecutionProfile): boolean {
  return (
    profile.interactionMode === 'interactive' &&
    profile.brokerTerminal?.host === 'tmux' &&
    typeof profile.brokerDriver === 'string'
  )
}

export function toDispatchRuntime(
  allocation: BrokerTmuxAllocation | undefined
): InvocationRuntimeContext | undefined {
  if (!allocation) {
    return undefined
  }
  if (allocation.lease) {
    return { terminalSurface: allocation.lease }
  }
  return { tmux: { socketPath: allocation.socketPath } }
}

export function toBrokerTmuxJson(
  brokerDriver: string,
  allocation: BrokerTmuxAllocation
): Record<string, unknown> {
  return {
    kind: 'broker-tmux-allocation',
    brokerDriver,
    socketPath: allocation.socketPath,
    allocatedAt: allocation.allocatedAt,
    ...paneIdsFromAllocation(allocation),
  }
}

export function toRuntimeStateTmux(
  brokerDriver: string,
  allocation: BrokerTmuxAllocation
): Record<string, unknown> {
  return {
    brokerDriver,
    socketPath: allocation.socketPath,
    allocatedAt: allocation.allocatedAt,
    ...paneIdsFromAllocation(allocation),
  }
}

export function extractRuntimeStateTmux(
  tmuxJson: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!tmuxJson) {
    return undefined
  }
  const brokerDriver = tmuxJson['brokerDriver']
  const socketPath = tmuxJson['socketPath']
  const allocatedAt = tmuxJson['allocatedAt']
  if (typeof brokerDriver !== 'string' || typeof socketPath !== 'string') {
    return undefined
  }
  const passthrough: Record<string, string> = {}
  for (const key of ['sessionId', 'windowId', 'paneId', 'sessionName', 'windowName']) {
    const value = tmuxJson[key]
    if (typeof value === 'string') {
      passthrough[key] = value
    }
  }
  const generation = tmuxJson['generation']
  return {
    brokerDriver,
    socketPath,
    ...(typeof allocatedAt === 'string' ? { allocatedAt } : {}),
    ...passthrough,
    ...(typeof generation === 'number' ? { generation } : {}),
  }
}

export function runtimeHarness(runtime: string): HrcRuntimeSnapshot['harness'] {
  if (runtime === 'codex-cli') return 'codex-cli'
  if (runtime === 'claude-code-cli') return 'claude-code'
  if (runtime === 'claude-agent-sdk') return 'agent-sdk'
  if (runtime === 'pi-cli') return 'pi-cli'
  if (runtime === 'pi-sdk') return 'pi-sdk'
  return 'codex-cli'
}

function paneIdsFromAllocation(allocation: BrokerTmuxAllocation): Record<string, string | number> {
  const lease = allocation.lease
  const ids: Record<string, string | number> = {}
  const sessionId = lease?.sessionId ?? allocation.sessionId
  const windowId = lease?.windowId ?? allocation.windowId
  const paneId = lease?.paneId ?? allocation.paneId
  const sessionName = lease?.sessionName ?? allocation.sessionName
  const windowName = lease?.windowName ?? allocation.windowName
  if (typeof sessionId === 'string') ids['sessionId'] = sessionId
  if (typeof windowId === 'string') ids['windowId'] = windowId
  if (typeof paneId === 'string') ids['paneId'] = paneId
  if (typeof sessionName === 'string') ids['sessionName'] = sessionName
  if (typeof windowName === 'string') ids['windowName'] = windowName
  if (typeof allocation.generation === 'number') ids['generation'] = allocation.generation
  return ids
}
