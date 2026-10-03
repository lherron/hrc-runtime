import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type FederationNodeRuntimeProjection,
  type FederationPeerHealthObservation,
  type FederationRetirementRequest,
  type FederationRuntimeProjectionReport,
  HRC_API_VERSION,
  HrcBadRequestError,
  type HrcCapabilityStatus,
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  type HrcStatusResponse,
  type HrcStatusSummaryResponse,
  type ScopeLocation,
} from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import { projectAspdServiceStatus } from './agent-spaces-adapter/aspd-preparation-client.js'
import { projectAspToolchainStatus } from './asp-toolchain.js'
import { timeLoopActivity } from './event-loop-lag.js'
import {
  deriveNodeIdFromHostname,
  resolveFederationConfigPath,
  summarizeFederationConfig,
} from './federation/federation-config.js'
import { locateScopeOnServer, scanServerLedgerForSkew } from './federation/locate-server.js'
import { locatePeerScope, probePeerHealth } from './federation/peer-observer.js'
import { peerRuntimeProjectionCacheKey } from './federation/peer-runtime-projection-cache.js'
import { retireFederationScope } from './federation/retirement.js'
import type { HrcServerInstance } from './index.js'
import { projectServerRelease } from './release-provenance.js'
import { listRuntimesForProjection } from './runtime-list-handlers.js'
import { projectLastRestart } from './server-lifecycle.js'
import { writeServerLog } from './server-log.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { toStatusSessionView } from './status-views.js'
import { detectTmuxBackend } from './tmux-socket.js'

const HRC_SERVER_PACKAGE_PATH = realpathSync(resolve(import.meta.dir, '..'))
const HRC_SERVER_BINARY_PATH = realpathSync(resolve(process.argv[1] ?? process.execPath))

export const serverStatusMethods = {
  handleHealth(this: HrcServerInstance): Response {
    return json({ ok: true })
  },

  /**
   * Non-secret projection of this node's identity and peer table for status
   * responses. Falls back to a derived single-node identity if the daemon was
   * constructed without a resolved config (embedders/tests); the normal boot
   * path always supplies one.
   */
  nodeStatus(this: HrcServerInstance): HrcCapabilityStatus['node'] {
    const config = this.options.federationConfig
    if (config === undefined) {
      return {
        nodeId: deriveNodeIdFromHostname(),
        nodeIdProvenance: 'derived',
        mode: 'single-node',
        configPath: resolveFederationConfigPath(this.options.stateRoot),
        configExists: false,
        peerCount: 0,
        peers: [],
      }
    }
    return summarizeFederationConfig(config)
  },

  /** Bounded, concurrent peer health probes; one sleeping node never serializes the others. */
  async collectFederationPeerHealth(
    this: HrcServerInstance,
    options: { includeRuntimes?: boolean; filter?: URLSearchParams } = {}
  ): Promise<
    Array<{
      health: FederationPeerHealthObservation
      runtimes?: readonly HrcRuntimeSnapshot[] | undefined
    }>
  > {
    const config = this.options.federationConfig
    if (config === undefined || config.peers.size === 0) return []
    return Promise.all(
      [...config.peers.values()].map(async (peer) => {
        const probe = await probePeerHealth(peer, options)
        writeServerLog(
          probe.health.state === 'healthy' ? 'INFO' : 'WARN',
          'federation.peer.probe',
          {
            localNodeId: config.nodeId,
            peerNodeId: peer.nodeId,
            state: probe.health.state,
            latencyMs: probe.health.latencyMs,
            answeredAt: probe.health.answeredAt,
            detail: probe.health.detail,
            includeRuntimes: options.includeRuntimes === true,
          }
        )
        return probe
      })
    )
  },

  async handleFederationPeerHealth(this: HrcServerInstance): Promise<Response> {
    return json((await this.collectFederationPeerHealth()).map((probe) => probe.health))
  },

  async handleFederationRetirement(this: HrcServerInstance, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (
      !isRecord(body) ||
      typeof body['scopeRef'] !== 'string' ||
      typeof body['reason'] !== 'string'
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'retirement requires scopeRef and reason'
      )
    }
    const config = this.options.federationConfig
    const registry = this.federationRegistryClient
    if (config === undefined || registry === undefined) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'federation retirement requires a configured federation registry'
      )
    }
    const dependencies = {
      owner: this,
      localNodeId: config.nodeId,
      ledger: createPlacementLedgerRepository(this.db.sqlite),
      registry,
      liveRuntimeIds: (scopeRef: string) =>
        this.db.runtimes
          .listAll()
          .filter(
            (runtime) =>
              runtime.scopeRef === scopeRef && !isRuntimeUnavailableStatus(runtime.status)
          )
          .map((runtime) => runtime.runtimeId),
      fenceContinuities: (scopeRef: string) => {
        this.db.sqlite.transaction(() => {
          const continuities = this.db.continuities.disassociateScope(scopeRef)
          const fencedAt = timestamp()
          for (const continuity of continuities) {
            this.db.sessions.setContinuationReuseDisabled(
              continuity.activeHostSessionId,
              true,
              fencedAt
            )
          }
        })()
      },
      log: writeServerLog,
    }
    return json(await retireFederationScope(dependencies, body as FederationRetirementRequest))
  },

  async handleFederationRuntimeProjection(this: HrcServerInstance, url: URL): Promise<Response> {
    const config = this.options.federationConfig
    const localNodeId = config?.nodeId ?? deriveNodeIdFromHostname()
    const checkedAt = new Date().toISOString()
    const localRuntimes = await listRuntimesForProjection(this, url)
    const localAnsweredAt = new Date().toISOString()
    const nodes: FederationNodeRuntimeProjection[] = [
      {
        nodeId: localNodeId,
        state: 'answered',
        checkedAt,
        answeredAt: localAnsweredAt,
        latencyMs: Math.max(0, Date.parse(localAnsweredAt) - Date.parse(checkedAt)),
        runtimes: localRuntimes,
      },
    ]
    const probes = await this.collectFederationPeerHealth({
      includeRuntimes: true,
      filter: url.searchParams,
    })
    for (const probe of probes) {
      const cacheKey = peerRuntimeProjectionCacheKey(probe.health.nodeId, url)
      if (probe.health.state === 'healthy' && probe.runtimes !== undefined) {
        const answeredAt = probe.health.answeredAt ?? new Date().toISOString()
        this.peerRuntimeProjectionCache.set(cacheKey, {
          answeredAt,
          runtimes: probe.runtimes,
        })
        nodes.push({
          nodeId: probe.health.nodeId,
          state: 'answered',
          checkedAt: probe.health.checkedAt,
          answeredAt,
          latencyMs: probe.health.latencyMs,
          runtimes: probe.runtimes,
        })
        continue
      }
      const cached = this.peerRuntimeProjectionCache.get(cacheKey)
      nodes.push({
        nodeId: probe.health.nodeId,
        state: probe.health.state === 'healthy' ? 'invalid-response' : probe.health.state,
        checkedAt: probe.health.checkedAt,
        ...(cached === undefined ? {} : { answeredAt: cached.answeredAt }),
        latencyMs: probe.health.latencyMs,
        runtimes: cached?.runtimes ?? [],
        detail: probe.health.detail ?? 'peer omitted the requested runtime projection',
      })
    }
    const report: FederationRuntimeProjectionReport = {
      localNodeId,
      generatedAt: new Date().toISOString(),
      nodes,
    }
    return json(report)
  },

  /**
   * `GET /v1/federation/locate?scopeRef=…` (T-06613).
   *
   * Read-only. Answers on an unconfigured daemon too — an operator setting
   * federation up needs "nothing is bound here, and this is what policy would
   * say" before the gate is ever live.
   */
  async handleFederationLocate(this: HrcServerInstance, url: URL): Promise<Response> {
    const scopeRef = url.searchParams.get('scopeRef')?.trim()
    if (!scopeRef) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'scopeRef is required', {
        field: 'scopeRef',
      })
    }
    try {
      const location = await locateScopeOnServer(this, scopeRef)
      const authorityNodeId =
        location.authority.state === 'bound' ? location.authority.record.homeNodeId : undefined
      if (authorityNodeId === undefined || authorityNodeId === location.localNodeId) {
        return json(location)
      }
      const peer = this.options.federationConfig?.peers.get(authorityNodeId as never)
      const peerResolution =
        peer === undefined
          ? {
              nodeId: authorityNodeId,
              state: 'unconfigured' as const,
              checkedAt: new Date().toISOString(),
              latencyMs: 0,
              detail: `authoritative node ${authorityNodeId} is not in this node's peer table`,
            }
          : await locatePeerScope(peer, scopeRef)
      writeServerLog(
        peerResolution.state === 'answered' ? 'INFO' : 'WARN',
        'federation.locate.peer',
        {
          localNodeId: location.localNodeId,
          peerNodeId: authorityNodeId,
          scopeRef,
          state: peerResolution.state,
          latencyMs: peerResolution.latencyMs,
          ...(peerResolution.state === 'answered' ? {} : { detail: peerResolution.detail }),
        }
      )
      return json({ ...location, peerResolution } satisfies ScopeLocation)
    } catch (error) {
      // A scope that will not canonicalize is a caller error, not a daemon
      // fault: report it as such rather than as a 500.
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `could not locate "${scopeRef}": ${error instanceof Error ? error.message : String(error)}`,
        { field: 'scopeRef' }
      )
    }
  },

  /** `GET /v1/federation/bindings` — the whole-ledger skew sweep behind `hrc doctor`. */
  async handleFederationBindings(this: HrcServerInstance): Promise<Response> {
    return json(await scanServerLedgerForSkew(this))
  },

  async handleStatus(this: HrcServerInstance, url?: URL): Promise<Response> {
    // T-08785: the summary is the default. The full session listing (~38 MB on
    // the live ledger) is built only for an explicit includeSessions=true.
    const includeSessions = url?.searchParams.get('includeSessions') ?? null
    if (includeSessions !== null && includeSessions !== 'true' && includeSessions !== 'false') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'includeSessions must be "true" or "false"',
        { includeSessions }
      )
    }
    const peerHealth =
      url?.searchParams.get('includePeerHealth') === 'true'
        ? (await this.collectFederationPeerHealth()).map((probe) => probe.health)
        : undefined
    const release = projectServerRelease(this.capturedRelease)
    const aspToolchain = projectAspToolchainStatus()
    const aspd = await projectAspdServiceStatus()
    const uptimeMs = Date.now() - new Date(this.startedAt).getTime()
    const tmuxStatus = await detectTmuxBackend()
    const summary = {
      ok: true,
      uptime: Math.floor(uptimeMs / 1000),
      startedAt: this.startedAt,
      runtimeRoot: this.options.runtimeRoot,
      stateRoot: this.options.stateRoot,
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      cwd: process.cwd(),
      binaryPath: HRC_SERVER_BINARY_PATH,
      packagePath: HRC_SERVER_PACKAGE_PATH,
      release,
      aspToolchain,
      aspd,
      sessionCount: this.db.sessions.count(),
      runtimeCount: this.db.runtimes.count(),
      apiVersion: HRC_API_VERSION,
      ...(this.eventLoopLag ? { eventLoop: this.eventLoopLag.snapshot() } : {}),
      lastRestart: projectLastRestart(this.db),
      node: this.nodeStatus(),
      mailKicker: 'absent' as const,
      ...(peerHealth === undefined ? {} : { peerHealth }),
      capabilities: {
        semanticCore: {
          sessions: true,
          ensureRuntime: true,
          dispatchTurn: true,
          inFlightInput: true,
          capture: true,
          attach: true,
          clearContext: true,
        },
        platform: {
          // The app-session routes are retired (T-10146).
          appOwnedSessions: false,
          appHarnessSessions: false,
          commandSessions: this.options.localPersonaAllowlist === undefined,
          literalInput: this.options.localPersonaAllowlist === undefined,
          surfaceBindings: true,
          legacyLocalBridges: ['legacy-agentchat'],
        },
        bridgeDelivery: {
          actualPtyInjection: true,
          enter: true,
          oobSuffix: true,
          freshnessFence: true,
        },
        backend: {
          tmux: tmuxStatus,
        },
        serverLifecycle: this.lifecycleController.capable,
        selfRestart: true,
      },
    } satisfies HrcStatusSummaryResponse
    if (includeSessions !== 'true') return json(summary)

    return timeLoopActivity('status:full_listing', () => {
      const sessions = this.listAllSessions()
      return json({
        ...summary,
        sessionCount: sessions.length,
        sessions: sessions.map((session) => toStatusSessionView(this.db, session)),
      } satisfies HrcStatusResponse)
    })
  },
}

export type ServerStatusMethods = typeof serverStatusMethods
