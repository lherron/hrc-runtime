/**
 * One registry-selection rule shared by summon and locate.
 *
 * The registry host reads its own authority in-process. Every other node uses
 * its authenticated peer entry. Keeping this here prevents the operator
 * diagnostic and the summon gate from prescribing different configurations.
 */

import type { FederationConfig } from './federation-config.js'
import type { BindingRegistryClient } from './registry-client.js'
import { RegistryUnreachableError, createBindingRegistryClient } from './registry-client.js'

export function createUnavailableRegistryClient(reason: string): BindingRegistryClient {
  return {
    async consult() {
      throw new RegistryUnreachableError(reason)
    },
    async establish() {
      throw new RegistryUnreachableError(reason)
    },
    async compareAndSwap() {
      throw new RegistryUnreachableError(reason)
    },
  }
}

export function resolveFederationRegistryClient(
  config: FederationConfig,
  localRegistryClient?: BindingRegistryClient | undefined
): BindingRegistryClient {
  const declared = config.gate.registryHost

  if (declared === config.nodeId) {
    if (config.registry === undefined) {
      return createUnavailableRegistryClient(
        `gate.registryHost names this node ("${config.nodeId}"), but ${config.sourcePath} does not configure a local registry listener; add top-level "registry": {"bind": "<tailnet-url>"}`
      )
    }
    return (
      localRegistryClient ??
      createUnavailableRegistryClient(
        `the local binding registry on node "${config.nodeId}" is configured but unavailable`
      )
    )
  }

  if (declared === undefined && config.registry !== undefined) {
    return createUnavailableRegistryClient(
      `node "${config.nodeId}" hosts the local binding registry, but ${config.sourcePath} does not name it; set "gate": {"registryHost": "${config.nodeId}"}`
    )
  }

  const peers = [...config.peers.values()]
  const solePeer = peers[0]
  if (solePeer === undefined) {
    return createUnavailableRegistryClient(
      `node "${config.nodeId}" declares no peers, so the binding registry cannot be consulted; add the remote registry host to "peers" in ${config.sourcePath}`
    )
  }

  if (declared !== undefined) {
    const host = peers.find((peer) => peer.nodeId === declared)
    if (host === undefined) {
      return createUnavailableRegistryClient(
        `gate.registryHost is "${declared}" but no remote peer by that nodeId is declared in ${config.sourcePath}`
      )
    }
    return createBindingRegistryClient(host)
  }

  if (peers.length > 1) {
    return createUnavailableRegistryClient(
      `${config.sourcePath} declares ${peers.length} peers but no "gate.registryHost", so which node holds the binding registry is ambiguous. Fix: add "gate": {"registryHost": "<nodeId>"} naming the registry host.`
    )
  }
  return createBindingRegistryClient(solePeer)
}
