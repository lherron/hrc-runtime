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

/**
 * T-01814 (T-01801 Phase 5) — the FULL operator-facing control surface for a
 * durable broker IPC runtime. Layers three DISTINCT sections on top of the
 * minimal {mode,brokerAttached}:
 *   (1) brokerIpc      — broker control over Unix IPC (socket + REDACTED token ref)
 *   (2) operatorAttach — the `tui` pane a human attaches to (NEVER the broker pane)
 *   (3) brokerProcess  — the broker child diagnostics (the `broker` pane)
 * The raw attach token is NEVER read into the output; only the redacted ref from
 * the endpoint is exposed.
 */
export type BrokerWindowView = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}

export type BrokerIpcControlView = {
  socketPath: string
  attachTokenRef: BrokerAttachTokenRef
  eventHighWaterSeq: number | null
  replayStatus: string | null
  degradedReason: string | null
  lastAttachError: { code: string; message: string } | null
}

export type OperatorAttachView = BrokerWindowView & { attachCommand: string }

export type BrokerProcessView = BrokerWindowView & {
  command: string
  pid: number | null
  generation: number | null
}

export type FullRuntimeControlState = RuntimeControlState & {
  brokerIpc?: BrokerIpcControlView
  operatorAttach?: OperatorAttachView
  brokerProcess?: BrokerProcessView
}

function extractBrokerWindow(value: unknown): BrokerWindowView | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const fields: (keyof BrokerWindowView)[] = [
    'socketPath',
    'sessionName',
    'windowName',
    'sessionId',
    'windowId',
    'paneId',
  ]
  const out: Record<string, string> = {}
  for (const key of fields) {
    const v = value[key]
    if (typeof v !== 'string') {
      return undefined
    }
    out[key] = v
  }
  return out as unknown as BrokerWindowView
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function extractAttachError(
  value: unknown
): { code: string; message: string } | null {
  if (!isRecord(value)) {
    return null
  }
  const code = value['code']
  const message = value['message']
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null
  }
  return { code, message }
}

export function extractFullRuntimeControlState(
  runtimeStateJson: Record<string, unknown> | undefined,
  eventHighWaterSeq: number | null
): FullRuntimeControlState | undefined {
  const base = extractRuntimeControlState(runtimeStateJson)
  if (!base) {
    return undefined
  }
  const result: FullRuntimeControlState = { ...base }
  const broker = runtimeStateJson?.['broker']
  const control = isRecord(runtimeStateJson?.['control'])
    ? (runtimeStateJson?.['control'] as Record<string, unknown>)
    : undefined
  if (isRecord(broker)) {
    // (1) Broker control over Unix IPC. Token exposed by REDACTED ref only.
    const endpoint = extractBrokerEndpoint(
      isRecord(broker['endpoint']) ? (broker['endpoint'] as Record<string, unknown>) : undefined
    )
    if (endpoint && endpoint.kind === 'unix-jsonrpc-ndjson') {
      result.brokerIpc = {
        socketPath: endpoint.socketPath,
        attachTokenRef: endpoint.attachTokenRef,
        eventHighWaterSeq,
        replayStatus: stringOrNull(control?.['replayStatus']),
        degradedReason: stringOrNull(control?.['degradedReason']),
        lastAttachError: extractAttachError(control?.['lastAttachError']),
      }
    }
    // (2) Operator TUI attach — the `tui` window.
    const tuiWindow = extractBrokerWindow(broker['tuiWindow'])
    if (tuiWindow) {
      result.operatorAttach = {
        ...tuiWindow,
        attachCommand: `tmux -S ${tuiWindow.socketPath} attach -t ${tuiWindow.sessionName}:${tuiWindow.windowName}`,
      }
    }
    // (3) Broker PROCESS diagnostics — the `broker` window child.
    const brokerWindow = extractBrokerWindow(broker['brokerWindow'])
    if (brokerWindow) {
      result.brokerProcess = {
        ...brokerWindow,
        command: typeof broker['brokerCommand'] === 'string' ? broker['brokerCommand'] : '',
        pid: typeof broker['brokerPid'] === 'number' ? broker['brokerPid'] : null,
        generation: typeof broker['generation'] === 'number' ? broker['generation'] : null,
      }
    }
  }
  return result
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
