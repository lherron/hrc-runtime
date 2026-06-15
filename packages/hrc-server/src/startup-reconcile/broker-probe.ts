import { readFile } from 'node:fs/promises'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { type BrokerLeaseProbe, parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { extractBrokerEndpoint } from '../broker/runtime-state.js'
import { type TmuxPaneState, createTmuxManager } from '../tmux.js'
import {
  getPersistedDurableBrokerEndpoint,
  getRecord,
  getRuntimeStateBrokerRecord,
} from './lease-identity.js'
import type { BrokerHealthState, BrokerReattachProbe } from './types.js'

export async function resolvePersistedBrokerAttachToken(
  runtime: HrcRuntimeSnapshot
): Promise<string | undefined> {
  const broker = getRuntimeStateBrokerRecord(runtime)
  const endpoint = extractBrokerEndpoint(getRecord(broker?.['endpoint']))
  if (endpoint?.kind !== 'unix-jsonrpc-ndjson') {
    return undefined
  }
  return (await readFile(endpoint.attachTokenRef.path, 'utf8')).trim()
}

export async function probePersistedBrokerLease(
  runtime: HrcRuntimeSnapshot
): Promise<BrokerReattachProbe> {
  const endpoint = getPersistedDurableBrokerEndpoint(runtime)
  // T-01884: derive the lease tmux socket/session from the hosting-state substrate
  // (durable headless AND interactive store it in runtime_state_json.broker, NOT the
  // legacy tmuxJson). A durable HEADLESS runtime has NO tmuxJson, so the legacy
  // getBrokerRuntimeTmuxSocketPath returned undefined → the broker window was never
  // inspected → brokerWindow=null → broker_lease_identity_mismatch, failing reattach
  // even though the leased broker is alive and accepting. Fall back to the legacy
  // tmuxJson helpers only for pre-durable rows. (Mirrors the sweeper claim source.)
  const hosting = parseBrokerRuntimeHostingState(runtime)
  const leasedSubstrate = hosting?.substrate.kind === 'leased-tmux' ? hosting.substrate : undefined
  const socketPath = leasedSubstrate?.tmuxSocketPath ?? getBrokerRuntimeTmuxSocketPath(runtime)
  const sessionName = leasedSubstrate?.sessionName ?? getBrokerRuntimeTmuxSessionName(runtime)
  let brokerWindow: TmuxPaneState | null = null
  let tuiWindow: TmuxPaneState | null = null
  if (socketPath) {
    const leaseTmux = createTmuxManager({ socketPath })
    brokerWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'broker' })
    tuiWindow = await leaseTmux.inspectWindow({ sessionName, windowName: 'tui' })
  }
  const brokerHealth: BrokerHealthState = endpoint
    ? await probeBrokerHealth(endpoint.socketPath)
    : 'unreachable'
  return {
    // `ok`/`degraded` are both attach-eligible; `shutting_down`/`unreachable` are
    // not "live" for binding purposes (callers special-case `shutting_down`).
    brokerSocketLive: brokerHealth === 'ok' || brokerHealth === 'degraded',
    brokerHealth,
    brokerWindow,
    tuiWindow,
  }
}

/**
 * Adapt a startup `BrokerReattachProbe` (TmuxPaneState windows) to the
 * hosting-state `BrokerLeaseProbe` (window-identity triples) consumed by
 * brokerLeaseIdentityMatches. The socket path + session name come from the
 * observed broker window. Returns undefined when no broker window was observed,
 * since identity cannot be fenced without it.
 */
export function toBrokerLeaseProbe(probe: BrokerReattachProbe): BrokerLeaseProbe | undefined {
  const broker = probe.brokerWindow
  if (!broker) {
    return undefined
  }
  return {
    tmuxSocketPath: broker.socketPath,
    sessionName: broker.sessionName,
    brokerWindow: {
      sessionId: broker.sessionId,
      windowId: broker.windowId,
      paneId: broker.paneId,
    },
    ...(probe.tuiWindow
      ? {
          tuiWindow: {
            sessionId: probe.tuiWindow.sessionId,
            windowId: probe.tuiWindow.windowId,
            paneId: probe.tuiWindow.paneId,
          },
        }
      : {}),
  }
}

/**
 * Application-level broker liveness via a `broker.health` round-trip. Replaces
 * the legacy raw `createConnection` probe (250ms), which only proved the kernel
 * accepted a unix-socket connect — it could not tell whether the JSON-RPC loop
 * was alive, and its tight timeout lost races under post-restart load (the
 * source of the spurious `broker_runtime_not_active` failures). `connectUnix`
 * performs a `broker.hello` handshake (already a real liveness signal) and the
 * follow-up `health()` returns the broker's drain state, so a draining broker
 * can be skipped rather than mistaken for dead. A generous budget is acceptable
 * here: this runs at boot and on the rare cold-binding dispatch, not on the hot
 * path. Any connect/timeout/RPC failure maps to `unreachable` (non-terminal for
 * durable runtimes), never to a false "dead" classification.
 */
const BROKER_HEALTH_PROBE_BUDGET_MS = 2000

export async function probeBrokerHealth(socketPath: string): Promise<BrokerHealthState> {
  let client: BrokerClient | undefined
  try {
    client = await BrokerClient.connectUnix({
      socketPath,
      timeoutMs: BROKER_HEALTH_PROBE_BUDGET_MS,
    })
    const response = await withTimeout(
      client.health(),
      BROKER_HEALTH_PROBE_BUDGET_MS,
      'broker_health_timeout'
    )
    switch (response.status) {
      case 'ok':
      case 'degraded':
      case 'shutting_down':
        return response.status
      default:
        return 'unreachable'
    }
  } catch {
    return 'unreachable'
  } finally {
    await client?.close().catch(() => undefined)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
