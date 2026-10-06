import {
  HrcBadRequestError,
  HrcDomainError,
  HrcErrorCode,
  isExactStartRuntimeRequest,
  isSuffixStartRuntimeRequest,
} from 'hrc-core'
import { exactStartScope } from './exact-claim.js'
import { CollectiveHistoryCoordinator } from './federation/collective-history.js'
import { locateScopeOnServer } from './federation/locate-server.js'
import {
  type PeerProtocolEndpointControl,
  startPeerProtocolEndpoint,
} from './federation/peer-protocol.js'
import type { BindingRegistryClient } from './federation/registry-client.js'
import {
  type BindingRegistryEndpointControl,
  type RegistryAuthPeer,
  resolveBindingRegistryPath,
  startBindingRegistryEndpoint,
} from './federation/registry-endpoint.js'
import { resolveFederationRegistryClient } from './federation/registry-resolution.js'
import { localizeFederatedRuntimeIntent } from './federation/runtime-intent-localization.js'
import {
  establishRemotePolicyAuthority,
  preflightExactScope,
  preflightSuffixRosterFamily,
} from './federation/summon-gate-server.js'
import type { HrcServerInstance } from './index.js'
import { suffixRosterFamily } from './roster-claim.js'
import { handleListRuns, listRuntimesForProjection } from './runtime-list-handlers.js'
import { writeServerLog } from './server-log.js'
import { parseStartRuntimeRequest } from './server-parsers.js'
import type { HrcServerOptions } from './server-types.js'
import { errorResponse } from './server-util.js'
import {
  handleGetSessionContinuity,
  handleGetSessionMetadata,
  handlePatchSessionMetadata,
} from './session-metadata-handlers.js'
import { toStartRuntimeResponse } from './status-views.js'

/**
 * Peer-dispatched local reads answer HRC domain errors as HRC errors
 * (`cursor_invalid`, unknown continuity, a home refusal), so the origin relays
 * the home's real answer instead of a generic peer-protocol 500.
 */
async function localDomainAnswer(read: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof HrcDomainError) return errorResponse(error)
    throw error
  }
}

export type FederationServices = {
  readonly bindingRegistryEndpoint: BindingRegistryEndpointControl | undefined
  readonly federationRegistryEndpoint: string | undefined
  readonly federationRegistryClient: BindingRegistryClient | undefined
  readonly collectiveHistory: CollectiveHistoryCoordinator | undefined
  readonly peerProtocolEndpoint: PeerProtocolEndpointControl | undefined
  readonly federationPeerEndpoint: string | undefined
  readonly isPeerUrgentDeliveryAuthorized: ((nodeId: string) => boolean) | undefined
}

/**
 * Bring up the federation listeners (binding registry, peer protocol) and the
 * collective-history coordinator for a server whose main socket is already
 * bound. Runs inside the instance constructor; the caller assigns the result.
 */
export function startFederationServices(
  server: HrcServerInstance,
  options: HrcServerOptions
): FederationServices {
  let bindingRegistryEndpoint: BindingRegistryEndpointControl | undefined
  let federationRegistryEndpoint: string | undefined
  let peerProtocolEndpoint: PeerProtocolEndpointControl | undefined
  let federationPeerEndpoint: string | undefined
  const federationConfig = options.federationConfig
  if (federationConfig === undefined || federationConfig.registry === undefined) {
    bindingRegistryEndpoint = undefined
    federationRegistryEndpoint = undefined
  } else {
    const registryConfig = federationConfig.registry
    const peers = new Map<string, RegistryAuthPeer>()
    for (const [nodeId, peer] of federationConfig.peers) {
      // PeerToken.matches() is the only sanctioned receiving-side secret
      // comparison; the endpoint never receives a revealed bare secret.
      peers.set(nodeId, { nodeId, token: peer.token })
    }
    try {
      bindingRegistryEndpoint = startBindingRegistryEndpoint({
        listener: registryConfig,
        peers,
        registryPath: resolveBindingRegistryPath(options.stateRoot),
        localNodeId: federationConfig.nodeId,
        // Resolved at call time, not here: `server.wrkqLedger` is constructed
        // later in server same constructor, and the host reads the birth
        // envelope only when a designation is actually asked for (T-07655).
        birthEnvelopeFor: async (scopeRef: string) =>
          await server.wrkqLedger.birthEnvelope({ scopeRef }),
        sqliteBusyTimeoutMs: options.sqliteBusyTimeoutMs,
      })
      federationRegistryEndpoint = bindingRegistryEndpoint.url
      writeServerLog('INFO', 'server.start.binding_registry_listener', {
        endpoint: bindingRegistryEndpoint.url,
        registryPath: resolveBindingRegistryPath(options.stateRoot),
      })
    } catch (error) {
      server.server.stop(true)
      throw error
    }
  }

  const federationRegistryClient: BindingRegistryClient | undefined =
    federationConfig === undefined
      ? undefined
      : resolveFederationRegistryClient(federationConfig, bindingRegistryEndpoint?.registryClient)

  const collectiveHistory =
    federationConfig === undefined
      ? undefined
      : new CollectiveHistoryCoordinator({
          db: server.db,
          config: federationConfig,
          ...(options.collectiveHistoryPollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: options.collectiveHistoryPollIntervalMs }),
        })

  if (federationConfig === undefined || federationConfig.peerListener === undefined) {
    peerProtocolEndpoint = undefined
    federationPeerEndpoint = undefined
  } else {
    try {
      peerProtocolEndpoint = startPeerProtocolEndpoint({
        listener: federationConfig.peerListener,
        options: {
          localNodeId: federationConfig.nodeId,
          peers: federationConfig.peers,
          locate: (scopeRef) => locateScopeOnServer(server, scopeRef),
          health: async ({ includeRuntimes, url }) => ({
            startedAt: server.startedAt,
            observedAt: new Date().toISOString(),
            capabilities: {
              establish: true,
              rosterStart: true,
              exactStart: true,
              locate: true,
              health: true,
              runtimeProjection: true,
              collectiveHistory: collectiveHistory?.isAuthority === true,
              semanticTurnHandoff: true,
              serverLifecycle: server.lifecycleController.capable,
              federatedSessionRead: true,
            },
            ...(includeRuntimes ? { runtimes: await listRuntimesForProjection(server, url) } : {}),
          }),
          establish: ({ scopeRef, correlationId }) =>
            establishRemotePolicyAuthority(server, { scopeRef, correlationId }),
          serverLifecycle: (request) => server.lifecycleController.handlePeerRequest(request),
          rosterStart: async ({ body }) => {
            const parsed = parseStartRuntimeRequest(body)
            if (!isSuffixStartRuntimeRequest(parsed) || parsed.summonIntent !== 'implicit') {
              throw new HrcBadRequestError(
                HrcErrorCode.MALFORMED_REQUEST,
                'federated roster-start requires a suffix request with summonIntent "implicit"',
                { field: 'summonIntent' }
              )
            }
            const family = suffixRosterFamily(parsed.baseSessionRef)
            const capabilityHint = {
              placement: parsed.runtimeIntent.placement,
              harness: parsed.runtimeIntent.harness,
            }
            await preflightSuffixRosterFamily(server, {
              baseScopeRef: family.baseScopeRef,
              scopeRefs: family.scopeRefs,
              capabilityHint,
              origin: 'federated-ingress',
              // T-07398: re-derived here against THIS node's registry and
              // [placement]. The origin's resolution is a request, not
              // authority, so the forwarded directive is validated again.
              ...(parsed.runtimeIntent.provision === undefined
                ? {}
                : { provision: parsed.runtimeIntent.provision }),
            })
            const localized = await localizeFederatedRuntimeIntent(
              family.baseScopeRef,
              parsed.runtimeIntent
            )
            const { runtime, claim } = await server.startSuffixRosterRuntime({
              ...parsed,
              runtimeIntent: localized,
            })
            return { ...toStartRuntimeResponse(runtime), claim }
          },
          /**
           * T-07302 — exact-scope provisioning on the authoritative home.
           *
           * The origin's routing decision buys server request nothing here: the
           * receiver re-parses the canonical shape, re-derives authority for
           * that one scope from its OWN retirement marks, ledger, registry,
           * policy and capability observation, and only then localizes the
           * placement onto server node's real checkout and starts. A wrong-home
           * or bad-policy request is refused before any mutation.
           */
          exactStart: async ({ body }) => {
            const parsed = parseStartRuntimeRequest(body)
            if (!isExactStartRuntimeRequest(parsed) || parsed.summonIntent !== 'implicit') {
              throw new HrcBadRequestError(
                HrcErrorCode.MALFORMED_REQUEST,
                'federated exact-start requires a reject request with summonIntent "implicit"',
                { field: 'conflictPolicy' }
              )
            }
            const scope = exactStartScope(parsed)
            const capabilityHint = {
              placement: parsed.runtimeIntent.placement,
              harness: parsed.runtimeIntent.harness,
            }
            await preflightExactScope(server, {
              scopeRef: scope.scopeRef,
              capabilityHint,
              origin: 'federated-ingress',
              // T-07398: the receiver's half of dual validation — see above.
              ...(parsed.runtimeIntent.provision === undefined
                ? {}
                : { provision: parsed.runtimeIntent.provision }),
            })
            const localized = await localizeFederatedRuntimeIntent(
              scope.scopeRef,
              parsed.runtimeIntent
            )
            const { runtime, claim } = await server.startExactScopeRuntime({
              ...parsed,
              runtimeIntent: localized,
            })
            return { ...toStartRuntimeResponse(runtime), claim }
          },
          sessionMetadata: ({ request, url }) =>
            localDomainAnswer(() =>
              url.pathname === '/v1/sessions/get'
                ? handleGetSessionContinuity(server, url, true)
                : request.method === 'GET'
                  ? handleGetSessionMetadata(server, url, true)
                  : handlePatchSessionMetadata(server, request, true)
            ),
          // T-10418: the home answers forwarded reads localOnly (no second hop).
          sessionRead: (read) =>
            localDomainAnswer(() => {
              if (read.route === 'resolve') {
                return server.handleResolveSession(
                  new Request(read.url.toString(), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(read.body),
                  }),
                  true
                )
              }
              if (read.route === 'events-tail') return server.handleEventsTail(read.url)
              if (read.route === 'events-bounded-stream') {
                return server.handleBoundedEvents(read.url, read.request)
              }
              return handleListRuns(server, read.url)
            }),
          sessionPage: ({ url }) => {
            const localUrl = new URL(url)
            localUrl.searchParams.set('nodes', 'local')
            return server.handleSessionPage(localUrl)
          },
          sessionFacets: ({ url }) => {
            const localUrl = new URL(url)
            localUrl.searchParams.set('nodes', 'local')
            return server.handleSessionFacetsLocal(localUrl)
          },
          ...(collectiveHistory?.isAuthority !== true
            ? {}
            : {
                collectiveHistoryReplicate: ({ authenticatedNodeId, body }) =>
                  collectiveHistory.acceptReplication(authenticatedNodeId, body),
                collectiveHistoryCheckpoint: ({ authenticatedNodeId, body }) =>
                  collectiveHistory.acceptCheckpoint(authenticatedNodeId, body),
                collectiveHistoryQuery: ({ filter }) => collectiveHistory.queryAuthority(filter),
              }),
        },
      })
      federationPeerEndpoint = peerProtocolEndpoint.url
      writeServerLog('INFO', 'server.start.peer_protocol_listener', {
        endpoint: peerProtocolEndpoint.url,
        acceptEnabled: true,
        establishEnabled: true,
      })
    } catch (error) {
      try {
        bindingRegistryEndpoint?.stop()
      } catch {
        // Preserve the peer-listener startup error; registry cleanup is best-effort.
      }
      server.server.stop(true)
      throw error
    }
  }

  const isPeerUrgentDeliveryAuthorized: ((nodeId: string) => boolean) | undefined =
    federationConfig === undefined
      ? undefined
      : (nodeId: string) => {
          const peer = [...federationConfig.peers.values()].find(
            (candidate) => String(candidate.nodeId) === String(nodeId)
          )
          return peer?.allowUrgentDelivery === true
        }
  return {
    bindingRegistryEndpoint,
    federationRegistryEndpoint,
    federationRegistryClient,
    collectiveHistory,
    peerProtocolEndpoint,
    federationPeerEndpoint,
    isPeerUrgentDeliveryAuthorized,
  }
}
