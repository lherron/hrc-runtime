import type {
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcSurfaceBindingRecord,
} from './contracts-records.js'

/** Immutable producer identity staged in every canonical ASP/HRC package. */
export type PraesidiumBuild = {
  schema: 1
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setName: 'asp' | 'hrc'
  setVersion: string
  builtAt: string
}

/** A thin ASP contract package installed in the release, by installed version. */
export type AspContractPackage = {
  name: string
  version: string
}

/**
 * Install-time identity persisted at an atomic HRC release root.
 *
 * T-08596 (T-08569A closure): the locked ASP execution build (`aspBuild`) is
 * gone with the bundled closure. The manifest names the thin ASP contract
 * packages actually installed, instead of an ASP execution build.
 */
export type PraesidiumReleaseManifest = {
  schema: 1
  releaseId: string
  hrcBuild: PraesidiumBuild
  aspContracts: AspContractPackage[]
  installedAt: string
}

export type HrcReleaseStatus =
  | {
      mode: 'atomic'
      releaseId: string
      releasePath: string
      manifestPath: string
      hrcBuild: PraesidiumBuild
      aspContracts: AspContractPackage[]
      installedAt: string
      processStartedAt: string
      runningEqualsInstalled: boolean
    }
  | {
      mode: 'unmanaged'
      packagePath: string
      processStartedAt: string
      runningEqualsInstalled: false
    }

export type HrcAspToolchainBinaryKind = 'aspc-facade' | 'harness-broker' | 'harness-broker-pi'

export type HrcAspToolchainHelloObservation = {
  name: string
  version: string
  protocolVersion: string
  observedAt: string
}

export type HrcAspToolchainStatus = {
  configuredRoot?: string | undefined
  toolchainRootActive: boolean
  bundledAspBuild?: PraesidiumBuild | undefined
  binaries: Array<{
    kind: HrcAspToolchainBinaryKind
    name: string
    envVar: string
    source: 'bundled' | 'toolchain-root' | 'env-override'
    path: string
    available: boolean
    error?: string | undefined
    hello?: HrcAspToolchainHelloObservation | undefined
  }>
}

/**
 * T-08542 — the ACTIVE PREPARATION RELEASE: the node-local aspd endpoint this
 * daemon is configured with and what a bounded `aspc.hello` probe read back.
 * Distinct from `aspToolchain` (resolver-governed routes) and from each
 * runtime's frozen `runtimeStateJson.executionRelease`.
 */
export type HrcAspdServiceStatus = {
  configured: boolean
  endpoint?: string | undefined
  reachable?: boolean | undefined
  protocolVersion?: string | undefined
  release?: { releaseId: string; sourceCommit: string; builtAt: string } | undefined
  error?: { code: string; message: string } | undefined
  probedAt?: string | undefined
}

/** One event-loop stall: the tick that landed late and what ran before it. */
export type HrcEventLoopStallView = {
  at: string
  lagMs: number
  /** Tagged activities since the previous tick, heaviest synchronous span first. */
  activities: { tag: string; count: number; ms: number }[]
}

/** Event-loop lag observed by the daemon's self-timing monitor (T-08786). */
export type HrcEventLoopStatus = {
  intervalMs: number
  stallThresholdMs: number
  /** Window over which `maxLagMs` is the maximum observed tick lateness. */
  windowMs: number
  maxLagMs: number
  maxLagAt?: string | undefined
  /** Stalls since daemon start. */
  stallCount: number
  lastStall?: HrcEventLoopStallView | undefined
}

/**
 * T-08137: `at` is the `server.started` timestamp. `requestedBy`/`reason` carry
 * the attribution of the `server.stopped` that immediately preceded it, and are
 * both null for an unattributed predecessor or a no-intent (external) signal.
 */
export type HrcLastRestart = {
  at: string
  requestedBy: string | null
  reason: string | null
}

export type HrcCapabilityStatus = {
  ok: true
  uptime: number
  startedAt: string
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  dbPath: string
  cwd: string
  binaryPath: string
  packagePath: string
  release: HrcReleaseStatus
  aspToolchain: HrcAspToolchainStatus
  aspd: HrcAspdServiceStatus
  sessionCount: number
  runtimeCount: number
  apiVersion: string
  /** Absent from daemons that predate the lag monitor. */
  eventLoop?: HrcEventLoopStatus | undefined
  /**
   * T-08137: the latest daemon start and the completed stop immediately before
   * it, read solely from the local lifecycle ledger. `null` when this ledger has
   * no `server.started`; absent from daemons that predate the projection.
   */
  lastRestart?: HrcLastRestart | null | undefined
  /**
   * Node identity and static peer table (federation spec §3/§6).
   *
   * Peer bearer tokens are absent by construction — this projection is built
   * from non-secret fields only and never carries credentials.
   */
  node: {
    nodeId: string
    /** `declared` = read from the federation config; `derived` = from hostname. */
    nodeIdProvenance: 'declared' | 'derived'
    mode: 'single-node' | 'federated'
    configPath: string
    configExists: boolean
    peerCount: number
    peers: {
      nodeId: string
      /** Peer-protocol accept/locate/health origin. */
      endpoint: string
      /** Binding-registry origin when separate from the peer protocol. */
      registryEndpoint?: string | undefined
    }[]
  }
  /** Present only for an explicit on-demand peer-health status request. */
  peerHealth?: import('./federation-contracts.js').FederationPeerHealthObservation[] | undefined
  capabilities: {
    semanticCore: {
      sessions: boolean
      ensureRuntime: boolean
      dispatchTurn: boolean
      inFlightInput: boolean
      capture: boolean
      attach: boolean
      clearContext: boolean
    }
    platform: {
      appOwnedSessions: boolean
      appHarnessSessions: boolean
      commandSessions: boolean
      literalInput: boolean
      surfaceBindings: boolean
      legacyLocalBridges: string[]
    }
    bridgeDelivery: {
      actualPtyInjection: boolean
      enter: boolean
      oobSuffix: boolean
      freshnessFence: boolean
    }
    backend: {
      tmux: {
        available: boolean
        version?: string | undefined
      }
    }
    /**
     * T-09861: this daemon authorizes and performs `POST /v1/server/lifecycle`.
     * Absent on a pre-contract daemon, against which the CLI fails closed.
     */
    serverLifecycle?: boolean | undefined
    /** T-09872: this daemon serves `POST /v1/runtimes/restart-self` (`hrc restartme`). */
    selfRestart?: boolean | undefined
  }
}

export type HrcStatusTmuxView = {
  socketPath?: string | undefined
  sessionName?: string | undefined
  sessionId?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
}

export type HrcStatusActiveRuntimeView = {
  runtime: HrcRuntimeSnapshot
  tmux?: HrcStatusTmuxView | undefined
  surfaceBindings: HrcSurfaceBindingRecord[]
}

export type HrcStatusSessionView = {
  session: HrcSessionRecord
  activeRuntime?: HrcStatusActiveRuntimeView | undefined
}

/**
 * The default `GET /v1/status` body (T-08785): scalar counts, no session list.
 */
export type HrcStatusSummaryResponse = HrcCapabilityStatus & {
  /**
   * Mail-delivery ownership posture. The bridge can retain the package while
   * constructing no owner (`disabled`); the deletion release has no package
   * at all (`absent`). External injectors may run only in those two postures.
   */
  mailKicker: 'in-process' | 'disabled' | 'absent'
}

/** `GET /v1/status?includeSessions=true`: the summary plus every session view. */
export type HrcStatusResponse = HrcStatusSummaryResponse & {
  sessions: HrcStatusSessionView[]
}
