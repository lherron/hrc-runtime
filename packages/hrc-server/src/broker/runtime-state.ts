import type { HrcRuntimeSnapshot } from 'hrc-core'
import type { InvocationRuntimeContext } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import type { BrokerTmuxAllocation } from './controller'

export type RuntimeControlState = {
  mode: string
  brokerAttached: boolean
}

/**
 * T-01810 (T-01801 Phase 1) — a broker runtime endpoint persisted in
 * runtime_state_json. The SAME JSON-RPC/NDJSON broker protocol rides either a
 * stdio pipe (headless) or a Unix-domain socket (durable interactive, C-03078).
 * The attach token is persisted by REFERENCE (redacted) — never the raw secret.
 */
export type BrokerAttachTokenRef = {
  kind: 'file'
  path: string
  redacted: true
}

export type BrokerRuntimeEndpoint =
  | { kind: 'stdio-jsonrpc-ndjson' }
  | {
      kind: 'unix-jsonrpc-ndjson'
      socketPath: string
      attachTokenRef: BrokerAttachTokenRef
    }

export function toBrokerEndpointJson(
  endpoint: BrokerRuntimeEndpoint
): Record<string, unknown> {
  if (endpoint.kind === 'unix-jsonrpc-ndjson') {
    return {
      kind: 'unix-jsonrpc-ndjson',
      socketPath: endpoint.socketPath,
      attachTokenRef: {
        kind: endpoint.attachTokenRef.kind,
        path: endpoint.attachTokenRef.path,
        redacted: true,
      },
    }
  }
  return { kind: 'stdio-jsonrpc-ndjson' }
}

export function extractBrokerEndpoint(
  json: Record<string, unknown> | undefined
): BrokerRuntimeEndpoint | undefined {
  if (!json) {
    return undefined
  }
  const kind = json['kind']
  if (kind === 'stdio-jsonrpc-ndjson') {
    return { kind: 'stdio-jsonrpc-ndjson' }
  }
  if (kind === 'unix-jsonrpc-ndjson') {
    const socketPath = json['socketPath']
    const tokenRef = json['attachTokenRef']
    if (typeof socketPath !== 'string' || !isRecord(tokenRef)) {
      return undefined
    }
    const path = tokenRef['path']
    const tokenKind = tokenRef['kind']
    if (tokenKind !== 'file' || typeof path !== 'string') {
      return undefined
    }
    return {
      kind: 'unix-jsonrpc-ndjson',
      socketPath,
      attachTokenRef: { kind: 'file', path, redacted: true },
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function withDirectTmuxDegradedControlState(
  runtimeStateJson: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    ...(runtimeStateJson ?? {}),
    control: {
      mode: 'direct-tmux-degraded',
      brokerAttached: false,
    },
  }
}

export function extractRuntimeControlState(
  runtimeStateJson: Record<string, unknown> | undefined
): RuntimeControlState | undefined {
  const control = runtimeStateJson?.['control']
  if (!control || typeof control !== 'object' || Array.isArray(control)) {
    return undefined
  }
  const record = control as Record<string, unknown>
  const mode = record['mode']
  const brokerAttached = record['brokerAttached']
  if (typeof mode !== 'string' || typeof brokerAttached !== 'boolean') {
    return undefined
  }
  return { mode, brokerAttached }
}

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
