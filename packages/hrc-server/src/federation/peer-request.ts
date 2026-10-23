import { HRC_API_VERSION } from 'hrc-core'

import type { PeerEntry } from './federation-config.js'

/** The daemon's L3 client name on every federation request it sends. */
export const HRC_SERVER_USER_AGENT = `hrc-server/${HRC_API_VERSION}`

/**
 * Construct the authenticated headers shared by every outbound peer-protocol
 * request. Keeping secret egress here preserves one audited reveal site even
 * as the protocol gains additional read-only routes.
 */
export function buildPeerProtocolHeaders(
  peer: PeerEntry,
  options: { readonly contentType?: string | undefined } = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${peer.token.reveal()}`,
    'user-agent': HRC_SERVER_USER_AGENT,
    ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
  }
}
