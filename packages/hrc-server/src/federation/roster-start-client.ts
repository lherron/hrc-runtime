import type { StartRuntimeResponse, SuffixStartRuntimeRequest } from 'hrc-core'

import type { PeerEntry } from './federation-config.js'
import { sendPeerClaimStart } from './peer-claim-start-client.js'

export type SendRemoteRosterStartOptions = {
  readonly peer: PeerEntry
  readonly request: SuffixStartRuntimeRequest
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * One synchronous, capability-gated suffix-roster provisioning attempt
 * (T-07118). Transport, capability gate, and response validation are shared
 * with the exact verb in peer-claim-start-client.ts.
 */
export async function sendRemoteRosterStart(
  options: SendRemoteRosterStartOptions
): Promise<StartRuntimeResponse> {
  return await sendPeerClaimStart({
    peer: options.peer,
    request: options.request,
    capability: 'rosterStart',
    path: '/v1/federation/roster-start',
    label: 'suffix-roster provisioning',
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  })
}
