/**
 * One-time legacy HRC-event payload normalization helpers used by the
 * `0009_backfill_legacy_hrc_events` and `0017_*` permission-identity migrations.
 *
 * These are internal to the migration runner — they are not re-exported through
 * the package's public `index.ts`. They live in their own module so the schema
 * DDL migration definitions in `migrations.ts` stay focused on the registry +
 * runner concerns.
 */

/** Shape of a legacy `events` row that still carried HRC lifecycle JSON. */
export type LegacyHrcEventRow = {
  seq: number
  stream_seq: number | null
  ts: string
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  runtime_id: string | null
  run_id: string | null
  event_kind: string
  event_json: string
}

export function parseLegacyEventJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLifecycleTransport(value: unknown): 'sdk' | 'tmux' | 'ghostty' | undefined {
  return value === 'sdk' || value === 'tmux' || value === 'ghostty' ? value : undefined
}

export function categoryForLegacyHrcEventKind(eventKind: string): string {
  if (eventKind.startsWith('session.')) {
    return 'session'
  }
  if (eventKind.startsWith('runtime.')) {
    return 'runtime'
  }
  if (eventKind.startsWith('launch.')) {
    return 'launch'
  }
  if (eventKind.startsWith('turn.')) {
    return 'turn'
  }
  if (eventKind.startsWith('inflight.')) {
    return 'inflight'
  }
  if (eventKind.startsWith('surface.')) {
    return 'surface'
  }
  if (eventKind.startsWith('bridge.')) {
    return 'bridge'
  }
  if (eventKind.startsWith('context.')) {
    return 'context'
  }
  if (eventKind.startsWith('app-session.') || eventKind.startsWith('target.')) {
    return 'app_session'
  }
  throw new Error(`unknown legacy hrc event kind: ${eventKind}`)
}

export function normalizeLegacyHrcPayload(eventJson: unknown): {
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  transport?: 'sdk' | 'tmux' | 'ghostty' | undefined
  errorCode?: string | undefined
  replayed?: boolean | undefined
  payload: unknown
} {
  if (!isRecord(eventJson)) {
    return { payload: eventJson ?? {} }
  }

  const {
    ts: _ts,
    hostSessionId: _hostSessionId,
    scopeRef: _scopeRef,
    laneRef: _laneRef,
    generation: _generation,
    runtimeId: _runtimeId,
    runId: _runId,
    launchId: rawLaunchId,
    appId: rawAppId,
    appSessionKey: rawAppSessionKey,
    source: _source,
    eventKind: _eventKind,
    category: _category,
    seq: _seq,
    streamSeq: _streamSeq,
    transport: rawTransport,
    errorCode: rawErrorCode,
    replayed: rawReplayed,
    ...payload
  } = eventJson
  const launchId =
    typeof rawLaunchId === 'string' && rawLaunchId.length > 0 ? rawLaunchId : undefined
  const appId = typeof rawAppId === 'string' && rawAppId.length > 0 ? rawAppId : undefined
  const appSessionKey =
    typeof rawAppSessionKey === 'string' && rawAppSessionKey.length > 0
      ? rawAppSessionKey
      : undefined
  const transport = readLifecycleTransport(rawTransport)
  const errorCode =
    typeof rawErrorCode === 'string' && rawErrorCode.length > 0 ? rawErrorCode : undefined
  const replayed = typeof rawReplayed === 'boolean' ? rawReplayed : undefined
  const normalizedPayload =
    rawTransport !== undefined && transport === undefined
      ? { ...payload, transport: rawTransport }
      : payload

  return {
    ...(launchId ? { launchId } : {}),
    ...(appId ? { appId } : {}),
    ...(appSessionKey ? { appSessionKey } : {}),
    ...(transport ? { transport } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(replayed !== undefined ? { replayed } : {}),
    payload: normalizedPayload,
  }
}

export function computeMigrationPermissionIdentityKey(input: {
  invocationId: string
  harnessGeneration?: number | null | undefined
  turnAttempt?: number | null | undefined
  permissionRequestId: string
}): string {
  return JSON.stringify([
    input.invocationId,
    input.harnessGeneration ?? null,
    input.turnAttempt ?? null,
    input.permissionRequestId,
  ])
}
