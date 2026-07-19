import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  type HrcActiveRunContributionRequest,
  type HrcActiveRunContributionResponse,
  type HrcAppSessionRecord,
  type HrcAppSessionSpec,
  type HrcCommandLaunchSpec,
  type HrcContinuationRef,
  type HrcContinuityRecord,
  type HrcEventEnvelope,
  type HrcLaunchRecord,
  type HrcLifecycleEvent,
  type HrcLocalBridgeRecord,
  type HrcManagedSessionRecord,
  type HrcRunRecord,
  type HrcRuntimeIntent,
  type HrcRuntimeSnapshot,
  type HrcSessionRecord,
  type HrcSurfaceBindingRecord,
  normalizeSessionRef,
} from 'hrc-core'
import type {
  ActiveInputDeliveryRow,
  AppManagedSessionRow,
  AppSessionRow,
  EventRow,
  HrcEventRow,
  LaunchRow,
  LocalBridgeRow,
  RunRow,
  RuntimeBufferRow,
  RuntimeRow,
  SessionRow,
  SurfaceBindingRow,
} from './rows.js'

export type HrcLifecycleQueryFilters = {
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  eventKind?: string | undefined
  category?: HrcLifecycleEvent['category'] | undefined
  fromHrcSeq?: number | undefined
  fromStreamSeq?: number | undefined
  limit?: number | undefined
}

/**
 * Filters for the monitor-watch server-side event query (T-04232).
 *
 * Combines the existing identity/scope narrowing (delegated to
 * {@link buildLifecycleWhere}) with monitor-specific event-kind / tool-name /
 * payload predicates so the full `hrc_events` firehose is never materialized in
 * the CLI process. `milestone` is a curated preset that supersedes
 * `eventKinds`/`toolNames`/`payloadContains` when true.
 */
export type HrcLifecycleMonitorFilters = {
  scopeRef?: string | undefined
  /** Match any event whose scopeRef is exactly one of these values. */
  scopeRefs?: string[] | undefined
  /** Match any event whose scopeRef begins with one of these values. */
  scopeRefPrefixes?: string[] | undefined
  /** Match complete `:task:<id>:` scopeRef segments. */
  taskIds?: string[] | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined

  // Event-kind set filter (SQL: event_kind IN (?,...))
  eventKinds?: string[] | undefined

  // Tool-name filter on turn.tool_call payload
  // (SQL: event_kind = 'turn.tool_call' AND json_extract(payload_json,'$.toolName') IN (?,...))
  toolNames?: string[] | undefined

  // Payload substring match (parameterized LIKE '%<value>%')
  payloadContains?: string | undefined

  // Milestone curated preset (supersedes eventKinds/toolNames/payloadContains).
  milestone?: boolean | undefined

  limit?: number | undefined
}

export type HrcRuntimeBufferRecord = {
  runtimeId: string
  runId: string
  chunkSeq: number
  text: string
  createdAt: string
}

export type HrcActiveInputDeliveryRecord = {
  inputApplicationId: string
  inputAttemptId: string
  idempotencyKey?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  status: HrcActiveRunContributionResponse['status'] | 'ambiguous' | 'failed'
  request: HrcActiveRunContributionRequest
  response?: HrcActiveRunContributionResponse | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  createdAt: string
  updatedAt: string
}

export type ContinuityUpsertInput = Pick<
  HrcContinuityRecord,
  'scopeRef' | 'laneRef' | 'activeHostSessionId' | 'updatedAt'
>

export type EventQueryFilters = {
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  fromSeq?: number | undefined
  limit?: number | undefined
}

export type RunListFilters = {
  runId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status?: string[] | undefined
  limit?: number | undefined
}

export type SurfaceBindingBindInput = Omit<
  HrcSurfaceBindingRecord,
  'boundAt' | 'reason' | 'unboundAt'
> & {
  boundAt: string
}

export type AppSessionApplyInput = {
  appSessionKey: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export type AppSessionBulkApplyResult = {
  inserted: number
  updated: number
  removed: number
}

export type AppManagedSessionRecord = HrcManagedSessionRecord & {
  lastAppliedSpec?: HrcAppSessionSpec | undefined
}

export type AppManagedSessionFindOptions = {
  includeRemoved?: boolean | undefined
  kind?: HrcManagedSessionRecord['kind'] | undefined
}

export type LocalBridgeStatus = 'active' | 'closed'

export type SessionListFilters = {
  scopeRef: string
  laneRef?: string | undefined
}

export type RuntimeUpdatePatch = Partial<Omit<HrcRuntimeSnapshot, 'runtimeId'>>
export type RunUpdatePatch = Partial<Omit<HrcRunRecord, 'runId'>>
export type LaunchUpdatePatch = Partial<Omit<HrcLaunchRecord, 'launchId'>>

export function serializeJson(value: unknown): string | null {
  if (value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

/**
 * Parse a JSON column value from SQLite. The `as T` cast is intentionally
 * unchecked — the trust boundary is the hrc-server write path which validates
 * all inbound payloads before they reach the store. Consumers of repository
 * records should treat the returned shape as pre-validated.
 */
export function parseJson<T>(value: string | null, column?: string): T | undefined {
  if (value === null) {
    return undefined
  }

  try {
    return JSON.parse(value) as T
  } catch (err) {
    const snippet = value.length > 80 ? `${value.slice(0, 80)}…` : value
    console.error(
      `[hrc-store-sqlite] Corrupt JSON in column ${column ?? 'unknown'}: ${err instanceof Error ? err.message : err} — raw: ${snippet}`
    )
    return undefined
  }
}

export function parseRequiredJson<T>(value: string, column: string): T {
  const parsed = parseJson<T>(value, column)
  if (parsed === undefined) {
    throw new Error(`${column} is required`)
  }
  return parsed
}

export function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0
}

export function fromSqliteBoolean(value: number): boolean {
  return value !== 0
}

export function toSessionRef(scopeRef: string, laneRef: string): string {
  return normalizeSessionRef(`${scopeRef}/lane:${laneRef}`)
}

// ── Canonical SQL column lists ──────────────────────────────────────────
// Each constant enumerates the columns for a given row shape exactly once.
// Every SELECT in the repository layer references these constants so that
// column additions/removals are a single-site change.

export const SESSION_COLUMNS = `
  host_session_id,
  scope_ref,
  lane_ref,
  generation,
  status,
  prior_host_session_id,
  created_at,
  updated_at,
  parsed_scope_json,
  ancestor_scope_refs_json,
  last_applied_intent_json,
  continuation_json`

export const RUNTIME_COLUMNS = `
  runtime_id,
  runtime_kind,
  host_session_id,
  scope_ref,
  lane_ref,
  generation,
  launch_id,
  transport,
  harness,
  provider,
  status,
  status_changed_at,
  tmux_json,
  surface_json,
  wrapper_pid,
  child_pid,
  harness_session_json,
  command_spec_json,
  continuation_json,
  supports_inflight_input,
  adopted,
  active_run_id,
  last_activity_at,
  controller_kind,
  active_operation_id,
  active_invocation_id,
  compile_id,
  plan_hash,
  selected_profile_hash,
  runtime_state_json,
  lifecycle_policy_hash,
  current_harness_generation,
  current_turn_attempt,
  lifecycle_terminal_reason,
  last_lifecycle_escalation_json,
  created_at,
  updated_at`

export const RUN_COLUMNS = `
  run_id,
  host_session_id,
  runtime_id,
  scope_ref,
  lane_ref,
  generation,
  transport,
  status,
  accepted_at,
  started_at,
  completed_at,
  updated_at,
  error_code,
  error_message,
  operation_id,
  invocation_id,
  dispatched_input_id,
  broker_input_fenced_at,
  broker_input_fence_reason`

export const LAUNCH_COLUMNS = `
  launch_id,
  host_session_id,
  generation,
  runtime_id,
  harness,
  provider,
  launch_artifact_path,
  tmux_json,
  surface_json,
  wrapper_pid,
  child_pid,
  harness_session_json,
  continuation_json,
  wrapper_started_at,
  child_started_at,
  exited_at,
  exit_code,
  signal,
  status,
  created_at,
  updated_at`

export const EVENT_COLUMNS = `
  seq,
  stream_seq,
  ts,
  host_session_id,
  scope_ref,
  lane_ref,
  generation,
  run_id,
  runtime_id,
  source,
  event_kind,
  event_json`

export const HRC_EVENT_COLUMNS = `
  hrc_seq,
  stream_seq,
  ts,
  host_session_id,
  scope_ref,
  lane_ref,
  generation,
  runtime_id,
  run_id,
  launch_id,
  app_id,
  app_session_key,
  category,
  event_kind,
  transport,
  error_code,
  replayed,
  payload_json`

export const APP_SESSION_COLUMNS = `
  app_id,
  app_session_key,
  host_session_id,
  label,
  metadata_json,
  created_at,
  updated_at,
  removed_at`

export const APP_MANAGED_SESSION_COLUMNS = `
  app_id,
  app_session_key,
  kind,
  label,
  metadata_json,
  active_host_session_id,
  generation,
  status,
  last_applied_spec_json,
  created_at,
  updated_at,
  removed_at`

export const LOCAL_BRIDGE_COLUMNS = `
  bridge_id,
  host_session_id,
  runtime_id,
  transport,
  target,
  expected_host_session_id,
  expected_generation,
  status,
  created_at,
  closed_at`

export const SURFACE_BINDING_COLUMNS = `
  surface_kind,
  surface_id,
  host_session_id,
  runtime_id,
  generation,
  window_id,
  tab_id,
  pane_id,
  bound_at,
  unbound_at,
  reason`

export const RUNTIME_BUFFER_COLUMNS = `
  runtime_id,
  run_id,
  chunk_seq,
  text,
  created_at`

export const ACTIVE_INPUT_DELIVERY_COLUMNS = `
  input_application_id,
  input_attempt_id,
  idempotency_key,
  host_session_id,
  generation,
  runtime_id,
  run_id,
  status,
  request_json,
  response_json,
  error_code,
  error_message,
  created_at,
  updated_at`

export function execute(db: Database, sql: string, ...params: SQLQueryBindings[]): void {
  db.prepare<never, SQLQueryBindings[]>(sql).run(...params)
}

export function requireRecord<T>(record: T | null, message: string): T {
  if (record === null) {
    throw new Error(message)
  }

  return record
}

export function buildSetClause(entries: Array<[column: string, value: string | number | null]>): {
  clause: string
  values: Array<string | number | null>
} {
  return {
    clause: entries.map(([column]) => `${column} = ?`).join(', '),
    values: entries.map(([, value]) => value),
  }
}

/**
 * Spec entry for {@link collectPatchEntries}: maps a defined patch field to its
 * SQL column, with an optional `transform` for null-coercion / serialization /
 * boolean encoding. Behavior mirrors the hand-rolled
 * `if (patch.x !== undefined) entries.push([...])` ladders. The transform
 * receives the (already non-undefined) patch value as `unknown`; each spec
 * knows the field's concrete type.
 */
export type PatchEntrySpec<P> = {
  readonly key: keyof P & string
  readonly column: string
  readonly transform?: (value: unknown) => string | number | null
}

/**
 * Collect `[column, value]` entries for every patch field that is not
 * `undefined`, in spec order, applying each spec's optional transform. This is
 * the shared, behavior-preserving replacement for the per-repository
 * `update(patch)` column ladders.
 *
 * Null handling is native: only `undefined` fields are skipped, so an explicit
 * `null` is always emitted and binds to SQL `NULL`. A transform is therefore
 * only needed for genuine value coercion (e.g. `serializeJson`,
 * `toSqliteBoolean`); a pass-through `value ?? null` transform would be a no-op
 * here and is intentionally not provided.
 */
export function collectPatchEntries<P>(
  patch: P,
  specs: ReadonlyArray<PatchEntrySpec<P>>
): Array<[column: string, value: string | number | null]> {
  const entries: Array<[column: string, value: string | number | null]> = []
  for (const { key, column, transform } of specs) {
    const value = patch[key]
    if (value !== undefined) {
      entries.push([
        column,
        transform ? transform(value) : (value as unknown as string | number | null),
      ])
    }
  }
  return entries
}

/**
 * Append the shared `events` filter predicates (host_session_id, generation,
 * runtime_id, run_id) to the provided `where`/`values` accumulators in the
 * canonical order. The seq predicate (`seq >= ?`) is owned by each caller
 * because it differs (a default-1 range scan vs an optional count filter).
 */
export function buildEventWhere(
  filters: Pick<EventQueryFilters, 'hostSessionId' | 'generation' | 'runtimeId' | 'runId'>,
  where: string[],
  values: Array<string | number>
): void {
  if (filters.hostSessionId !== undefined) {
    where.push('host_session_id = ?')
    values.push(filters.hostSessionId)
  }
  if (filters.generation !== undefined) {
    where.push('generation = ?')
    values.push(filters.generation)
  }
  if (filters.runtimeId !== undefined) {
    where.push('runtime_id = ?')
    values.push(filters.runtimeId)
  }
  if (filters.runId !== undefined) {
    where.push('run_id = ?')
    values.push(filters.runId)
  }
}

/**
 * Append the `runs` filter predicates to the provided `where`/`values`
 * accumulators in canonical order. Owns the run-table column set
 * (run_id, host_session_id, generation, runtime_id, scope_ref, lane_ref,
 * status) so it stays decoupled from {@link buildEventWhere}, which is named
 * and documented for `events`/`hrc_events` fields.
 *
 * `runId`, `scopeRef`, and `laneRef` are exact-match equality predicates.
 * `status` is a one-or-more set filter (`status IN (?,...)`), matching the
 * `/v1/runtimes?status=ready,busy` convention; an empty array contributes no
 * predicate. The seq/limit clauses remain owned by the caller.
 */
export function buildRunWhere(
  filters: RunListFilters,
  where: string[],
  values: Array<string | number>
): void {
  if (filters.runId !== undefined) {
    where.push('run_id = ?')
    values.push(filters.runId)
  }
  if (filters.hostSessionId !== undefined) {
    where.push('host_session_id = ?')
    values.push(filters.hostSessionId)
  }
  if (filters.generation !== undefined) {
    where.push('generation = ?')
    values.push(filters.generation)
  }
  if (filters.runtimeId !== undefined) {
    where.push('runtime_id = ?')
    values.push(filters.runtimeId)
  }
  if (filters.scopeRef !== undefined) {
    where.push('scope_ref = ?')
    values.push(filters.scopeRef)
  }
  if (filters.laneRef !== undefined) {
    where.push('lane_ref = ?')
    values.push(filters.laneRef)
  }
  if (filters.status !== undefined && filters.status.length > 0) {
    const placeholders = filters.status.map(() => '?').join(', ')
    where.push(`status IN (${placeholders})`)
    values.push(...filters.status)
  }
}

/**
 * Assemble the WHERE predicates + ordered bound values for `hrc_events` queries.
 *
 * When `includeSeqPredicates` is true the seq-range predicates
 * (`hrc_seq >= ?`, `stream_seq >= ?`) are emitted first (matching `runQuery`'s
 * original ordering); when false they are skipped entirely (matching
 * `listLatestPerSession`, which ignores seq/limit). The 9 shared field
 * predicates follow in their canonical order so the bound-value list stays
 * positionally identical to the previous inlined blocks.
 */
export function buildLifecycleWhere(
  filters: HrcLifecycleQueryFilters,
  options: { includeSeqPredicates: boolean }
): { where: string[]; values: Array<string | number> } {
  const where: string[] = []
  const values: Array<string | number> = []

  if (options.includeSeqPredicates) {
    if (filters.fromHrcSeq !== undefined) {
      where.push('hrc_seq >= ?')
      values.push(filters.fromHrcSeq)
    }
    if (filters.fromStreamSeq !== undefined) {
      where.push('stream_seq >= ?')
      values.push(filters.fromStreamSeq)
    }
  }
  if (filters.hostSessionId !== undefined) {
    where.push('host_session_id = ?')
    values.push(filters.hostSessionId)
  }
  if (filters.generation !== undefined) {
    where.push('generation = ?')
    values.push(filters.generation)
  }
  if (filters.scopeRef !== undefined) {
    where.push('scope_ref = ?')
    values.push(filters.scopeRef)
  }
  if (filters.laneRef !== undefined) {
    where.push('lane_ref = ?')
    values.push(filters.laneRef)
  }
  if (filters.runtimeId !== undefined) {
    where.push('runtime_id = ?')
    values.push(filters.runtimeId)
  }
  if (filters.runId !== undefined) {
    where.push('run_id = ?')
    values.push(filters.runId)
  }
  if (filters.launchId !== undefined) {
    where.push('launch_id = ?')
    values.push(filters.launchId)
  }
  if (filters.eventKind !== undefined) {
    where.push('event_kind = ?')
    values.push(filters.eventKind)
  }
  if (filters.category !== undefined) {
    where.push('category = ?')
    values.push(filters.category)
  }

  return { where, values }
}

export function mapSessionRow(row: SessionRow): HrcSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    status: row.status,
    priorHostSessionId: row.prior_host_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedScopeJson: parseJson<Record<string, unknown>>(row.parsed_scope_json, 'parsed_scope_json'),
    ancestorScopeRefs:
      parseJson<string[]>(row.ancestor_scope_refs_json, 'ancestor_scope_refs_json') ?? [],
    lastAppliedIntentJson: parseJson<HrcRuntimeIntent>(
      row.last_applied_intent_json,
      'last_applied_intent_json'
    ),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json, 'continuation_json'),
  }
}

export function mapRuntimeRow(row: RuntimeRow): HrcRuntimeSnapshot {
  return {
    runtimeId: row.runtime_id,
    runtimeKind: row.runtime_kind ?? 'harness',
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    launchId: row.launch_id ?? undefined,
    transport: row.transport,
    harness: row.harness,
    provider: row.provider,
    status: row.status,
    statusChangedAt: row.status_changed_at ?? 'unknown',
    tmuxJson: parseJson<Record<string, unknown>>(row.tmux_json, 'tmux_json'),
    surfaceJson: parseJson<Record<string, unknown>>(row.surface_json, 'surface_json'),
    wrapperPid: row.wrapper_pid ?? undefined,
    childPid: row.child_pid ?? undefined,
    harnessSessionJson: parseJson<Record<string, unknown>>(
      row.harness_session_json,
      'harness_session_json'
    ),
    commandSpec: parseJson<HrcCommandLaunchSpec>(row.command_spec_json, 'command_spec_json'),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json, 'continuation_json'),
    supportsInflightInput: fromSqliteBoolean(row.supports_inflight_input),
    adopted: fromSqliteBoolean(row.adopted),
    activeRunId: row.active_run_id ?? undefined,
    lastActivityAt: row.last_activity_at ?? undefined,
    controllerKind: row.controller_kind ?? undefined,
    activeOperationId: row.active_operation_id ?? undefined,
    activeInvocationId: row.active_invocation_id ?? undefined,
    compileId: row.compile_id ?? undefined,
    planHash: row.plan_hash ?? undefined,
    selectedProfileHash: row.selected_profile_hash ?? undefined,
    runtimeStateJson: parseJson<Record<string, unknown>>(
      row.runtime_state_json,
      'runtime_state_json'
    ),
    lifecyclePolicyHash: row.lifecycle_policy_hash ?? undefined,
    currentHarnessGeneration: row.current_harness_generation ?? undefined,
    currentTurnAttempt: row.current_turn_attempt ?? undefined,
    lifecycleTerminalReason: row.lifecycle_terminal_reason ?? undefined,
    lastLifecycleEscalationJson: row.last_lifecycle_escalation_json ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapRunRow(row: RunRow): HrcRunRecord {
  return {
    runId: row.run_id,
    hostSessionId: row.host_session_id,
    runtimeId: row.runtime_id ?? undefined,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    transport: row.transport,
    status: row.status,
    acceptedAt: row.accepted_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    operationId: row.operation_id ?? undefined,
    invocationId: row.invocation_id ?? undefined,
    dispatchedInputId: row.dispatched_input_id ?? undefined,
    brokerInputFencedAt: row.broker_input_fenced_at ?? undefined,
    brokerInputFenceReason: row.broker_input_fence_reason ?? undefined,
  }
}

export function mapSurfaceBindingRow(row: SurfaceBindingRow): HrcSurfaceBindingRecord {
  return {
    surfaceKind: row.surface_kind,
    surfaceId: row.surface_id,
    hostSessionId: row.host_session_id,
    runtimeId: row.runtime_id,
    generation: row.generation,
    windowId: row.window_id ?? undefined,
    tabId: row.tab_id ?? undefined,
    paneId: row.pane_id ?? undefined,
    boundAt: row.bound_at,
    unboundAt: row.unbound_at ?? undefined,
    reason: row.reason ?? undefined,
  }
}

export function mapAppSessionRow(row: AppSessionRow): HrcAppSessionRecord {
  return {
    appId: row.app_id,
    appSessionKey: row.app_session_key,
    hostSessionId: row.host_session_id,
    label: row.label ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, 'metadata_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at ?? undefined,
  }
}

export function mapAppManagedSessionRow(row: AppManagedSessionRow): AppManagedSessionRecord {
  return {
    appId: row.app_id,
    appSessionKey: row.app_session_key,
    kind: row.kind,
    label: row.label ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, 'metadata_json'),
    activeHostSessionId: row.active_host_session_id,
    generation: row.generation,
    status: row.status,
    lastAppliedSpec: parseJson<HrcAppSessionSpec>(
      row.last_applied_spec_json,
      'last_applied_spec_json'
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at ?? undefined,
  }
}

export function mapLocalBridgeRow(row: LocalBridgeRow): HrcLocalBridgeRecord {
  return {
    bridgeId: row.bridge_id,
    hostSessionId: row.host_session_id,
    runtimeId: row.runtime_id ?? undefined,
    transport: row.transport,
    target: row.target,
    expectedHostSessionId: row.expected_host_session_id ?? undefined,
    expectedGeneration: row.expected_generation ?? undefined,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
    status: row.status,
  }
}

export function mapLaunchRow(row: LaunchRow): HrcLaunchRecord {
  return {
    launchId: row.launch_id,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    runtimeId: row.runtime_id ?? undefined,
    harness: row.harness,
    provider: row.provider,
    launchArtifactPath: row.launch_artifact_path,
    tmuxJson: parseJson<Record<string, unknown>>(row.tmux_json, 'tmux_json'),
    surfaceJson: parseJson<Record<string, unknown>>(row.surface_json, 'surface_json'),
    wrapperPid: row.wrapper_pid ?? undefined,
    childPid: row.child_pid ?? undefined,
    harnessSessionJson: parseJson<Record<string, unknown>>(
      row.harness_session_json,
      'harness_session_json'
    ),
    continuation: parseJson<HrcContinuationRef>(row.continuation_json, 'continuation_json'),
    wrapperStartedAt: row.wrapper_started_at ?? undefined,
    childStartedAt: row.child_started_at ?? undefined,
    exitedAt: row.exited_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapEventRow(row: EventRow): HrcEventEnvelope {
  return {
    seq: row.seq,
    streamSeq: row.stream_seq,
    ts: row.ts,
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    runId: row.run_id ?? undefined,
    runtimeId: row.runtime_id ?? undefined,
    source: row.source,
    eventKind: row.event_kind,
    eventJson: parseJson<unknown>(row.event_json, 'event_json'),
  }
}

export function mapHrcEventRow(row: HrcEventRow): HrcLifecycleEvent {
  return {
    hrcSeq: row.hrc_seq,
    streamSeq: row.stream_seq,
    ts: row.ts,
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    runtimeId: row.runtime_id ?? undefined,
    runId: row.run_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    appId: row.app_id ?? undefined,
    appSessionKey: row.app_session_key ?? undefined,
    category: row.category,
    eventKind: row.event_kind,
    transport: row.transport ?? undefined,
    errorCode: row.error_code ?? undefined,
    replayed: row.replayed !== 0,
    payload: parseJson<unknown>(row.payload_json, 'payload_json'),
  }
}

export function allocateStreamSeq(db: Database): number {
  const row = db
    .query<{ next_seq: number }, []>('SELECT next_seq FROM event_stream_cursor WHERE id = 1')
    .get()
  if (!row) {
    throw new Error('event_stream_cursor singleton missing; run migrations')
  }
  const allocated = row.next_seq
  execute(db, 'UPDATE event_stream_cursor SET next_seq = next_seq + 1 WHERE id = 1')
  return allocated
}

export function mapRuntimeBufferRow(row: RuntimeBufferRow): HrcRuntimeBufferRecord {
  return {
    runtimeId: row.runtime_id,
    runId: row.run_id,
    chunkSeq: row.chunk_seq,
    text: row.text,
    createdAt: row.created_at,
  }
}

export function mapActiveInputDeliveryRow(
  row: ActiveInputDeliveryRow
): HrcActiveInputDeliveryRecord {
  return {
    inputApplicationId: row.input_application_id,
    inputAttemptId: row.input_attempt_id,
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.host_session_id !== null ? { hostSessionId: row.host_session_id } : {}),
    ...(row.generation !== null ? { generation: row.generation } : {}),
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    status: row.status,
    request: parseRequiredJson<HrcActiveRunContributionRequest>(row.request_json, 'request_json'),
    ...(row.response_json !== null
      ? {
          response: parseJson<HrcActiveRunContributionResponse>(row.response_json, 'response_json'),
        }
      : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
