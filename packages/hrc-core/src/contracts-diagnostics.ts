import type { HrcRuntimePresentationRecord } from './contracts-records.js'
import type { AspContractPackage } from './contracts-status.js'
import type { SessionIdentity, SessionMetadata } from './session-metadata.js'

export const HRC_FIRST_TURN_MISSING_EVENT = 'first_turn_missing'
export const HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT = 'first_turn_missing.diagnostics'
export const HRC_FIRST_TURN_MISSING_LATE_START_EVENT = 'first_turn_missing.late_start'
export const HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND = 'first-turn-missing-bundle'
export const HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA = 'hrc.first-turn-missing-bundle/v1'

/**
 * Diagnostic-bundle manifest. Every prompt-bearing value is replaced BY
 * CONSTRUCTION with `sha256:<hex> (len N)` — the bundle writer never renders a
 * shell command line, and the `displayCommand` renderer is never invoked on
 * this path (it quotes argv and env verbatim, and the shared prompt-display
 * formatter is readability elision, not a secret boundary).
 */
export type HrcFirstTurnMissingBundle = {
  schema: typeof HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA
  correlation: {
    runtimeId: string
    scopeRef: string
    generation: number
    invocationId?: string | undefined
    runId?: string | undefined
    hostSessionId: string
  }
  timings: {
    provisionedAt?: string | undefined
    primingDispatchedAt?: string | undefined
    firstTurnDeadlineAt?: string | undefined
    trippedAt: string
    configuredTimeoutMs?: number | undefined
  }
  launchShape?:
    | {
        frontend?: string | undefined
        model?: string | undefined
        cwd?: string | undefined
        continuation: 'expected' | 'none'
        continuationKey?: string | undefined
        argv: string[]
        /** Prompt-bearing env values only, always hashed. Process env is never captured. */
        promptEnv: Record<string, string>
      }
    | undefined
  surfaces?:
    | {
        tmuxSocketPath?: string | undefined
        tmuxSessionName?: string | undefined
        tmuxWindowId?: string | undefined
        tmuxPaneId?: string | undefined
        hrcRole?: string | undefined
      }
    | undefined
  versions?:
    | {
        harnessVersion?: string | undefined
        hrcReleaseId?: string | undefined
        /** Pre-closure bundles only; post-closure bundles carry aspContracts. */
        agentSpacesVersion?: string | undefined
        /** T-08596: the thin ASP contract set installed in the serving release. */
        aspContracts?: AspContractPackage[] | undefined
      }
    | undefined
  paneCapture?:
    | {
        capturedAt: string
        text: string
      }
    | undefined
  /** Per-field failure map. Never silently absent when a field could not be built. */
  failures: Record<string, string>
}

export type HrcFirstTurnDiagnosticsTrip = {
  tripEventSeq: number
  runtimeId: string
  generation: number
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runId?: string | undefined
  invocationId?: string | undefined
  primingDispatchedAt?: string | undefined
  firstTurnDeadlineAt?: string | undefined
  trippedAt: string
  bundleDir?: string | undefined
  bundleAvailable: boolean
}

export type ListFirstTurnDiagnosticsResponse = {
  ok: true
  trips: HrcFirstTurnDiagnosticsTrip[]
}

export type GetFirstTurnDiagnosticsResponse = {
  ok: true
  trip: HrcFirstTurnDiagnosticsTrip
  bundle?: HrcFirstTurnMissingBundle | undefined
  bundleError?: string | undefined
}

/** Health detail projected onto `hrc runtime list` rows for a tripped runtime. */
export type HrcRuntimeHealthDetail = {
  firstTurnMissing: {
    trippedAt: string
    tripEventSeq: number
    generation: number
    bundleAvailable: boolean
    retrieval: string
  }
}

/** Event kind carrying one invocation's presentation decision (T-07594 §5.2). */
export const HRC_RUNTIME_PRESENTATION_EVENT = 'runtime.presentation'

/**
 * tmux coordinates an operator (or a viewer) attaches with. Present only when
 * the runtime is operator-attachable; derived from the persisted hosting state
 * at emit/projection time, never probed.
 */
export type HrcPresentationTmuxTarget = {
  socketPath: string
  attachTarget: string
}

/**
 * `runtime.presentation` payload — appended on EVERY start/reuse invocation
 * that would spawn a viewer today (T-07594 §5.2).
 *
 * `invocation.operatorAttachPending` is the invocation-local suppression
 * predicate; it appears here and nowhere else. `presentation` is the persisted
 * record AFTER this invocation folded into it.
 */
export type HrcRuntimePresentationEventPayload = {
  invocation: { operatorAttachPending: boolean }
  presentation: HrcRuntimePresentationRecord
  tmux?: HrcPresentationTmuxTarget | undefined
  title?: string | undefined
}

/**
 * One row of the presentation read model (T-07594 §5.3). Durable facts only:
 * no invocation-local field ever appears here, and the projection that builds
 * it reads the store and returns — it never reconciles liveness, probes tmux,
 * attaches, or appends events.
 */
export type HrcPresentationRuntimeRow = {
  metadata?: SessionMetadata | undefined
  identity?: SessionIdentity | undefined
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  status: string
  /** Absent for generations created before the record shipped (§5.5). */
  presentation?: HrcRuntimePresentationRecord | undefined
  tmux?: HrcPresentationTmuxTarget | undefined
  title?: string | undefined
  /** Active Ghostty bindings whose controlling terminal was captured at attach. */
  operatorSurfaces: Array<{ surfaceId: string; clientTty: string }>
}

export type ListPresentationRuntimesResponse = {
  ok: true
  runtimes: HrcPresentationRuntimeRow[]
}

export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA = 'hrc.provider-transcript-artifact/v1'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND = 'provider-transcript-jsonl'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE = 'application/x-ndjson'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND = 'file-path'
export const HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT = 'provider.transcript.reported'
export const HRC_ARTIFACT_REPORTED_EVENT = 'artifact.reported'

export type HrcProviderTranscriptArtifactMetadata = {
  schema: typeof HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA
  /**
   * The ASP producer transcript CONTENT schema (source of truth:
   * `spaces-harness-broker-protocol`'s `PROVIDER_TRANSCRIPT_SCHEMA`). Carried
   * alongside — and kept distinct from — the HRC-owned `schema` metadata
   * identifier. Optional so existing rows persisted before this field tolerate
   * absence.
   */
  sourceSchema?: string | undefined
  invocationId: string
  runtimeId: string
  runId?: string | undefined
  provider?: string | undefined
  brokerDriver: string
  harnessGeneration?: number | undefined
  brokerSeq: number
  hashAlgorithm: 'sha256'
  hashObservedAt?: string | undefined
}

export type HrcProviderTranscriptReportedPayload = {
  kind?: typeof HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND | string | undefined
  path?: string | undefined
  artifactPath?: string | undefined
  provider?: string | undefined
  harnessGeneration?: number | undefined
}

export type HrcPermissionDecisionRecord = {
  permissionIdentityKey?: string | undefined
  permissionRequestId: string
  invocationId: string
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  runtimeId: string
  runId?: string | undefined
  kind: string
  subjectDisplayJson: string
  defaultDecision: 'allow' | 'deny' | string
  decision: 'allow' | 'deny' | string
  decidedBy: 'policy' | 'user' | 'api' | 'timeout' | string
  policyJson: string
  requestedAt: string
  decidedAt: string
}

/** Event kind carrying a session-title write or clear (T-07594 §5.2). */
export const HRC_SESSION_RETITLED_EVENT = 'session.retitled'

/** `session.retitled` payload. `null` is an explicit clear, not an absence. */
export type HrcSessionRetitledEventPayload = {
  title: string | null
}
