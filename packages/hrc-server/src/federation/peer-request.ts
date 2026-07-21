import type { PeerEntry } from './federation-config.js'
import { PEER_PROTOCOL_VERSION_HEADER } from './peer-protocol.js'

/**
 * Construct the authenticated headers shared by every outbound peer-protocol
 * request. Keeping secret egress here preserves one audited reveal site even
 * as the protocol gains additional read-only routes.
 */
export function buildPeerProtocolHeaders(
  peer: PeerEntry,
  protocolVersion: string,
  options: { readonly contentType?: string | undefined } = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${peer.token.reveal()}`,
    [PEER_PROTOCOL_VERSION_HEADER]: protocolVersion,
    ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
  }
}
