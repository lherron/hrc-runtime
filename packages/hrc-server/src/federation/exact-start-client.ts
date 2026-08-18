import type { ExactStartRuntimeRequest, StartRuntimeResponse } from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { sendPeerClaimStart } from './peer-claim-start-client.js'

export type SendRemoteExactStartOptions = {
  readonly peer: PeerEntry
  readonly request: ExactStartRuntimeRequest
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * One synchronous, capability-gated exact-scope provisioning attempt (T-07302).
 *
 * The origin sends ONLY the canonical exact request — no node assertion, no
 * resolved home, no claim decision. Everything the receiver acts on it derives
 * itself, so a compromised or stale origin can ask, never instruct.
 */
export async function sendRemoteExactStart(
  options: SendRemoteExactStartOptions
): Promise<StartRuntimeResponse> {
  return await sendPeerClaimStart({
    peer: options.peer,
    request: options.request,
    capability: 'exactStart',
    path: '/v1/federation/exact-start',
    label: 'exact-scope provisioning',
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  })
}
