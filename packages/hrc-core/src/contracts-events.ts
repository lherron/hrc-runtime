export type HrcProvider = 'anthropic' | 'openai' | 'meta'
/**
 * Producer-owned label recorded with a durable continuation. This is distinct
 * from {@link HrcProvider}, which is HRC's closed runtime-selection domain:
 * the harness-broker protocol permits providers to add continuation labels
 * without asking HRC to select that provider for a new runtime. Resume gates
 * must narrow this opaque label for the driver they own.
 */
export type HrcContinuationProvider = string
export type HrcHarness =
  | 'agent-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi'
  | 'pi-cli'
  | 'pi-sdk'
  | 'muse-cli'
export type HrcEventSource = 'agent-spaces' | 'hook' | 'hrc' | 'otel' | 'tmux' | 'broker'
export type HrcExecutionMode = 'headless' | 'interactive' | 'nonInteractive'
export type HrcIoMode = 'inherit' | 'pipes' | 'pty'

export type HrcTurnResponseFormat =
  | { kind: 'text' }
  | { kind: 'json_schema'; schema: Record<string, unknown> }

export type HrcContinuationRef = {
  provider: HrcContinuationProvider
  /**
   * Continuation kind, when the provider distinguishes resume key shapes.
   * For Codex this is `'session'` when `key` is a resume-compatible session
   * UUID (vs a rollout-file path or thread key). Claude rows historically
   * omit it and stay compatible. Persisted through HRC continuation storage so
   * the interactive tmux recreate gate can safely emit `codex resume <uuid>`.
   */
  kind?: string | undefined
  key?: string | undefined
}

export type HrcEventEnvelope = {
  seq: number
  streamSeq: number
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runId?: string | undefined
  runtimeId?: string | undefined
  source: HrcEventSource
  eventKind: string
  eventJson: unknown
}

export type HrcEventCategory =
  | 'session'
  | 'runtime'
  | 'launch'
  | 'turn'
  | 'input'
  | 'inflight'
  | 'surface'
  | 'bridge'
  | 'context'
  | 'app_session'
  /** The store itself, not any seat: `store.migrated` attribution rows (T-08118). */
  | 'store'
  /** The daemon itself, not any seat: `server.*` lifecycle provenance rows (T-08137). */
  | 'server'

export type HrcLifecycleTransport = 'sdk' | 'tmux' | 'headless'

export type HrcLifecycleEvent = {
  hrcSeq: number
  streamSeq: number
  /** Claimed origin label for observational rows imported from another HRC ledger. */
  sourceRef?: string | undefined
  /** Sequence in the source ledger. Present iff sourceRef is present. */
  originSeq?: number | undefined
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  category: HrcEventCategory
  eventKind: string
  transport?: HrcLifecycleTransport | undefined
  errorCode?: string | undefined
  replayed: boolean
  /**
   * Durable evidence origin (T-08566). `'retained'` marks a row projected from a
   * dead worker's retained ledger; such rows are observable history and never
   * actuate current-run completion, delivery, activity or timeout. Omitted for
   * live and ordinary rows. Distinct from `replayed` (transport replay state).
   */
  evidenceOrigin?: 'retained' | undefined
  payload: unknown
}

/**
 * Control/data records emitted by the bounded lifecycle-event observation
 * route. Controls deliberately stay outside {@link HrcLifecycleEvent}: they
 * describe delivery, not lifecycle facts.
 */
export type HrcBoundedEventStreamRecord =
  | {
      type: 'ready'
      ledgerIncarnationId: string
      acceptedAfterHrcSeq: number
      replayHeadHrcSeq: number
    }
  | {
      type: 'event'
      ledgerIncarnationId: string
      event: HrcLifecycleEvent
    }
  | {
      type: 'gap'
      ledgerIncarnationId: string
      reason: 'replay_window' | 'live_queue' | 'event_oversize'
      afterHrcSeq: number
      beforeHrcSeq: number
      dropped: number | null
    }
  | {
      type: 'ledger_replaced'
      expectedLedgerIncarnationId: string
      currentLedgerIncarnationId: string
    }

export type HrcEventTail = {
  events: HrcLifecycleEvent[]
  ledgerIncarnationId: string
  headHrcSeq: number
  truncated: boolean
}
