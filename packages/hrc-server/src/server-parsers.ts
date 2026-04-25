import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError, parseFence } from 'hrc-core'
import type {
  AppSessionFreshnessFence,
  ApplyAppManagedSessionsRequest,
  ApplyAppSessionInput,
  ApplyAppSessionsRequest,
  AttachRuntimeRequest,
  BindSurfaceRequest,
  ClearAppSessionContextRequest,
  ClearContextRequest,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DispatchAppHarnessTurnRequest,
  DispatchTurnRequest,
  DropContinuationRequest,
  EnsureAppSessionRequest,
  EnsureRuntimeRequest,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcProvider,
  HrcRuntimeIntent,
  InspectRuntimeRequest,
  InterruptAppSessionRequest,
  RestartStyle,
  SendAppHarnessInFlightInputRequest,
  SendLiteralInputRequest,
  StartRuntimeRequest,
  SweepRuntimeTransport,
  SweepRuntimesRequest,
  TerminateAppSessionRequest,
  TerminateRuntimeRequest,
  UnbindSurfaceRequest,
} from 'hrc-core'
import { parseAgentProfile, resolveHarnessProvider } from 'spaces-config'

export type InFlightInputRequest = {
  runtimeId: string
  runId: string
  prompt: string
  inputType?: string | undefined
}

export type ParsedDispatchAppHarnessTurnRequest = DispatchAppHarnessTurnRequest & {
  prompt: string
  runtimeIntent?: HrcRuntimeIntent | undefined
}

export type ParsedAppHarnessInFlightInputRequest = SendAppHarnessInFlightInputRequest & {
  prompt: string
}

export type ParsedClearAppSessionContextRequest = ClearAppSessionContextRequest & {
  reason?: string | undefined
  spec?: HrcAppSessionSpec | undefined
}

export type BridgeSelector =
  | { sessionRef: string }
  | { hostSessionId: string }
  | { appSession: { appId: string; appSessionKey: string } }

export type BridgeTargetRequest = {
  hostSessionId?: string | undefined
  bridge?: string | undefined
  transport?: string | undefined
  target?: string | undefined
  runtimeId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  selector?: BridgeSelector | undefined
}

export type DeliverTextRequest = {
  bridgeId: string
  text: string
  enter: boolean
  oobSuffix?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type ListRuntimesFilter = {
  hostSessionId?: string | undefined
  transport?: 'tmux' | 'headless' | 'sdk' | undefined
  status?: string[] | undefined
  scope?: string | undefined
  stale?: boolean | undefined
  olderThan?: string | undefined
  olderThanMs?: number | undefined
  json?: boolean | undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function resolveHarnessFromPlacement(
  placement: unknown,
  execution: unknown
): HrcRuntimeIntent['harness'] {
  if (!isRecord(placement)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required unless placement.agentRoot can resolve it',
      { field: 'runtimeIntent.harness' }
    )
  }

  const agentRoot = placement['agentRoot']
  if (typeof agentRoot !== 'string' || agentRoot.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required unless placement.agentRoot can resolve it',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required when agent-profile.toml is missing',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
  const provider = resolveHarnessProvider(profile.identity?.harness)
  if (!provider) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required when agent-profile identity.harness is missing',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  const preferredMode =
    isRecord(execution) && typeof execution['preferredMode'] === 'string'
      ? execution['preferredMode']
      : undefined

  return {
    provider,
    interactive: preferredMode !== 'nonInteractive',
  }
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be valid JSON')
  }
}

export function parseFromSeq(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) {
    return 1
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'fromSeq must be >= 1')
  }

  return parsed
}

export function normalizeOptionalQuery(value: string | null): string | undefined {
  if (value === null) {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

export function parseListRuntimesFilter(url: URL): ListRuntimesFilter {
  const transport = normalizeOptionalQuery(url.searchParams.get('transport'))
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport must be one of: tmux, headless, sdk',
      { field: 'transport', value: transport }
    )
  }

  const statusRaw = normalizeOptionalQuery(url.searchParams.get('status'))
  const status = statusRaw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const stale = parseOptionalBooleanQuery(url.searchParams.get('stale'), 'stale')
  const json = parseOptionalBooleanQuery(url.searchParams.get('json'), 'json')
  const olderThan = normalizeOptionalQuery(url.searchParams.get('olderThan'))

  return {
    ...(normalizeOptionalQuery(url.searchParams.get('hostSessionId'))
      ? { hostSessionId: normalizeOptionalQuery(url.searchParams.get('hostSessionId')) }
      : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(status !== undefined && status.length > 0 ? { status } : {}),
    ...(normalizeOptionalQuery(url.searchParams.get('scope'))
      ? { scope: normalizeOptionalQuery(url.searchParams.get('scope')) }
      : {}),
    ...(stale !== undefined ? { stale } : {}),
    ...(olderThan !== undefined ? { olderThan, olderThanMs: parseDurationMs(olderThan) } : {}),
    ...(json !== undefined ? { json } : {}),
  }
}

function parseOptionalBooleanQuery(raw: string | null, field: string): boolean | undefined {
  const normalized = normalizeOptionalQuery(raw)
  if (normalized === undefined) {
    return undefined
  }

  if (normalized === 'true' || normalized === '1') {
    return true
  }
  if (normalized === 'false' || normalized === '0') {
    return false
  }

  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a boolean`, {
    field,
    value: normalized,
  })
}

function parseDurationMs(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a duration like 30m, 2h, or 24h',
      { field: 'olderThan', value: input }
    )
  }

  const amount = Number.parseFloat(match[1] ?? '')
  const unit = match[2]
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60 * 1000
          : unit === 'h'
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000
  const durationMs = amount * multiplier
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'olderThan must be positive', {
      field: 'olderThan',
      value: input,
    })
  }
  return Math.floor(durationMs)
}

function parseApplyAppSessionInput(input: unknown, index: number): ApplyAppSessionInput {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `sessions[${index}] must be an object`,
      {
        field: `sessions[${index}]`,
      }
    )
  }

  const metadata = input['metadata']
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `sessions[${index}].metadata must be an object`,
      {
        field: `sessions[${index}].metadata`,
      }
    )
  }

  return {
    appSessionKey: requireTrimmedStringField(input, 'appSessionKey'),
    ...readOptionalStringField(input, 'label'),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  }
}

function parseAppSessionSelector(input: unknown): { appId: string; appSessionKey: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector must be an object', {
      field: 'selector',
    })
  }
  return {
    appId: requireTrimmedStringField(input, 'appId'),
    appSessionKey: requireTrimmedStringField(input, 'appSessionKey'),
  }
}

function parseCommandLaunchSpec(input: unknown): HrcCommandLaunchSpec {
  if (input !== undefined && !isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spec.command must be an object', {
      field: 'spec.command',
    })
  }

  const command = (input ?? {}) as Record<string, unknown>
  const launchMode = command['launchMode']
  if (launchMode !== undefined && launchMode !== 'shell' && launchMode !== 'exec') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.command.launchMode must be "shell" or "exec"',
      { field: 'spec.command.launchMode' }
    )
  }

  const argvRaw = command['argv']
  if (argvRaw !== undefined && !Array.isArray(argvRaw)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.command.argv must be an array',
      {
        field: 'spec.command.argv',
      }
    )
  }
  const argv = argvRaw?.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `spec.command.argv[${index}] must be a non-empty string`,
        { field: `spec.command.argv[${index}]` }
      )
    }
    return entry
  })

  const effectiveLaunchMode = (launchMode ?? 'exec') as 'shell' | 'exec'
  if (effectiveLaunchMode === 'exec' && (!argv || argv.length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.command.argv is required when launchMode is "exec"',
      { field: 'spec.command.argv' }
    )
  }

  const env = command['env']
  if (env !== undefined && !isStringRecord(env)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.command.env must be an object',
      {
        field: 'spec.command.env',
      }
    )
  }

  const unsetEnv = parseOptionalStringArray(command['unsetEnv'], 'spec.command.unsetEnv')
  const pathPrepend = parseOptionalStringArray(command['pathPrepend'], 'spec.command.pathPrepend')

  const shell = command['shell']
  if (shell !== undefined && !isRecord(shell)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.command.shell must be an object',
      {
        field: 'spec.command.shell',
      }
    )
  }

  return {
    launchMode: effectiveLaunchMode,
    ...(argv ? { argv } : {}),
    ...readOptionalStringField(command, 'cwd'),
    ...(env !== undefined ? { env: env as Record<string, string> } : {}),
    ...(unsetEnv ? { unsetEnv } : {}),
    ...(pathPrepend ? { pathPrepend } : {}),
    ...(shell !== undefined
      ? {
          shell: {
            ...readOptionalStringField(shell, 'executable'),
            ...(typeof shell['login'] === 'boolean' ? { login: shell['login'] } : {}),
            ...(typeof shell['interactive'] === 'boolean'
              ? { interactive: shell['interactive'] }
              : {}),
          },
        }
      : {}),
  }
}

function parseRuntimeIntent(input: Record<string, unknown>): HrcRuntimeIntent {
  const placement = input['placement'] ?? 'workspace'
  const execution = input['execution']
  const harness = input['harness']
  const launch = input['launch']
  const initialPrompt = input['initialPrompt']
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const resolvedHarness = isRecord(harness)
    ? (() => {
        const provider = requireTrimmedStringField(harness, 'provider')
        if (provider !== 'anthropic' && provider !== 'openai') {
          throw new HrcBadRequestError(
            HrcErrorCode.MALFORMED_REQUEST,
            'harness.provider must be "anthropic" or "openai"',
            { field: 'harness.provider' }
          )
        }

        const interactive = harness['interactive']
        if (typeof interactive !== 'boolean') {
          throw new HrcBadRequestError(
            HrcErrorCode.MALFORMED_REQUEST,
            'harness.interactive must be a boolean',
            { field: 'harness.interactive' }
          )
        }

        return {
          provider: provider as HrcProvider,
          interactive,
          ...(harness['model'] !== undefined ? { model: String(harness['model']) } : {}),
          ...(harness['yolo'] === true ? { yolo: true } : {}),
        }
      })()
    : resolveHarnessFromPlacement(placement, execution)

  return {
    placement: placement as import('spaces-config').RuntimePlacement,
    harness: resolvedHarness,
    ...(isRecord(execution) ? { execution: execution as HrcRuntimeIntent['execution'] } : {}),
    ...(isRecord(launch) ? { launch: launch as HrcRuntimeIntent['launch'] } : {}),
    ...(typeof initialPrompt === 'string' ? { initialPrompt } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
}

function parseOptionalAttachmentRefs(
  input: Record<string, unknown>,
  field: string
): HrcRuntimeIntent['attachments'] | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an array`, {
      field,
    })
  }
  return value.map((entry, index) => parseAttachmentRef(entry, `${field}[${index}]`))
}

function parseAttachmentRef(
  input: unknown,
  field: string
): NonNullable<HrcRuntimeIntent['attachments']>[number] {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an object`, {
      field,
    })
  }
  const kind = input['kind']
  if (kind !== 'url' && kind !== 'file') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.kind must be "url" or "file"`,
      { field: `${field}.kind` }
    )
  }

  const url = readOptionalNonEmptyStringField(input, 'url')
  const path = readOptionalNonEmptyStringField(input, 'path')
  if (kind === 'url' && url === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.url is required for url attachments`,
      { field: `${field}.url` }
    )
  }
  if (kind === 'file' && path === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.path is required for file attachments`,
      { field: `${field}.path` }
    )
  }

  const filename = readOptionalNonEmptyStringField(input, 'filename')
  const contentType = readOptionalNonEmptyStringField(input, 'contentType')
  const sizeBytes = input['sizeBytes']
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.sizeBytes must be a non-negative safe integer`,
      { field: `${field}.sizeBytes` }
    )
  }

  return {
    kind,
    ...(url !== undefined ? { url } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(filename !== undefined ? { filename } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes: sizeBytes as number } : {}),
  }
}

function parseAppSessionSpec(input: unknown): HrcAppSessionSpec {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spec must be an object', {
      field: 'spec',
    })
  }
  const kind = requireTrimmedStringField(input, 'kind')
  if (kind !== 'harness' && kind !== 'command') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spec.kind must be "harness" or "command"',
      { field: 'spec.kind' }
    )
  }

  if (kind === 'harness') {
    const runtimeIntent = input['runtimeIntent']
    if (!isRecord(runtimeIntent)) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'spec.runtimeIntent is required for harness sessions',
        { field: 'spec.runtimeIntent' }
      )
    }
    return {
      kind: 'harness',
      runtimeIntent: parseRuntimeIntent(runtimeIntent),
    }
  }

  return {
    kind: 'command',
    command: parseCommandLaunchSpec(input['command']),
  }
}

export function parseResolveSessionRequest(input: unknown): { sessionRef: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = input['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  parseSessionRef(sessionRef)
  return { sessionRef: sessionRef.trim() }
}

export function parseApplyAppSessionsRequest(input: unknown): ApplyAppSessionsRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const appId = requireTrimmedStringField(input, 'appId')
  const hostSessionId = requireTrimmedStringField(input, 'hostSessionId')
  const sessions = input['sessions']
  if (!Array.isArray(sessions)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessions must be an array', {
      field: 'sessions',
    })
  }

  return {
    appId,
    hostSessionId,
    sessions: sessions.map((session, index) => parseApplyAppSessionInput(session, index)),
  }
}

export function parseEnsureAppSessionRequest(input: unknown): EnsureAppSessionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }
  const selector = parseAppSessionSelector(selectorRaw)

  const specRaw = input['spec']
  if (specRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spec is required', {
      field: 'spec',
    })
  }
  const spec = parseAppSessionSpec(specRaw)

  const metadata = input['metadata']
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'metadata must be an object', {
      field: 'metadata',
    })
  }

  const restartStyle = input['restartStyle']
  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'restartStyle must be "reuse_pty" or "fresh_pty"',
      { field: 'restartStyle' }
    )
  }

  return {
    selector,
    spec,
    ...(typeof input['label'] === 'string' ? { label: input['label'] } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
    ...(restartStyle !== undefined ? { restartStyle: restartStyle as RestartStyle } : {}),
    ...(typeof input['forceRestart'] === 'boolean' ? { forceRestart: input['forceRestart'] } : {}),
    ...(typeof input['initialPrompt'] === 'string'
      ? { initialPrompt: input['initialPrompt'] }
      : {}),
    ...(input['dryRun'] === true ? { dryRun: true } : {}),
  }
}

export function parseDispatchAppHarnessTurnRequest(
  input: unknown
): ParsedDispatchAppHarnessTurnRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }

  const prompt = parsePromptPayload(input)
  const runtimeIntent = input['runtimeIntent']
  const runId = readOptionalNonEmptyStringField(input, 'runId')
  const canonicalFence =
    Object.hasOwn(input, 'fence') && input['fence'] !== undefined
      ? parseFenceInput(input['fence'])
      : undefined
  const legacyFences =
    Object.hasOwn(input, 'fences') && input['fences'] !== undefined
      ? parseFenceInput(input['fences'])
      : undefined

  return {
    selector: parseAppSessionSelector(selectorRaw),
    prompt,
    ...(runId !== undefined ? { runId } : {}),
    ...(canonicalFence !== undefined
      ? { fence: canonicalFence, fences: canonicalFence }
      : legacyFences !== undefined
        ? { fences: legacyFences }
        : {}),
    ...(isRecord(runtimeIntent) ? { runtimeIntent: runtimeIntent as HrcRuntimeIntent } : {}),
  }
}

export function parseAppHarnessInFlightInputRequest(
  input: unknown
): ParsedAppHarnessInFlightInputRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }

  const runId = readOptionalNonEmptyStringField(input, 'runId')
  const prompt = parsePromptPayload(input)
  if (input['inputType'] !== undefined && typeof input['inputType'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'inputType must be a string', {
      field: 'inputType',
    })
  }

  return {
    selector: parseAppSessionSelector(selectorRaw),
    prompt,
    ...(runId !== undefined ? { runId } : {}),
    ...(typeof input['inputType'] === 'string' && input['inputType'].trim().length > 0
      ? { inputType: input['inputType'].trim() }
      : {}),
    ...(Object.hasOwn(input, 'fence') ? { fence: parseAppSessionFence(input['fence']) } : {}),
  }
}

export function parseClearAppSessionContextRequest(
  input: unknown
): ParsedClearAppSessionContextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }
  if (input['relaunch'] !== undefined && typeof input['relaunch'] !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'relaunch must be a boolean', {
      field: 'relaunch',
    })
  }
  if (input['reason'] !== undefined && typeof input['reason'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'reason must be a string', {
      field: 'reason',
    })
  }

  return {
    selector: parseAppSessionSelector(selectorRaw),
    ...(typeof input['relaunch'] === 'boolean' ? { relaunch: input['relaunch'] } : {}),
    ...(typeof input['reason'] === 'string' && input['reason'].trim().length > 0
      ? { reason: input['reason'].trim() }
      : {}),
    ...(Object.hasOwn(input, 'spec') ? { spec: parseAppSessionSpec(input['spec']) } : {}),
  }
}

export function parseRemoveAppSessionRequest(input: unknown): {
  selector: { appId: string; appSessionKey: string }
  terminateRuntime?: boolean
} {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }

  return {
    selector: parseAppSessionSelector(selectorRaw),
    ...(typeof input['terminateRuntime'] === 'boolean'
      ? { terminateRuntime: input['terminateRuntime'] }
      : {}),
  }
}

export function parseSendLiteralInputRequest(input: unknown): SendLiteralInputRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const selectorRaw = input['selector']
  if (selectorRaw === undefined) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required', {
      field: 'selector',
    })
  }

  if (typeof input['text'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'text must be a string', {
      field: 'text',
    })
  }

  return {
    selector: parseAppSessionSelector(selectorRaw),
    text: input['text'],
    ...(typeof input['enter'] === 'boolean' ? { enter: input['enter'] } : {}),
    ...(Object.hasOwn(input, 'fence') ? { fence: parseAppSessionFence(input['fence']) } : {}),
  }
}

export function parseInterruptAppSessionRequest(input: unknown): InterruptAppSessionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    selector: parseAppSessionSelector(input['selector']),
    ...(typeof input['hard'] === 'boolean' ? { hard: input['hard'] } : {}),
  }
}

export function parseTerminateAppSessionRequest(input: unknown): TerminateAppSessionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    selector: parseAppSessionSelector(input['selector']),
  }
}

function parseAppSessionFence(input: unknown): AppSessionFreshnessFence {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'fence must be an object', {
      field: 'fence',
    })
  }

  return {
    ...(typeof input['expectedHostSessionId'] === 'string'
      ? { expectedHostSessionId: input['expectedHostSessionId'].trim() }
      : {}),
    ...(typeof input['expectedGeneration'] === 'number'
      ? { expectedGeneration: input['expectedGeneration'] }
      : {}),
  }
}

export function parseApplyManagedAppSessionsRequest(
  input: unknown
): ApplyAppManagedSessionsRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const appId = requireTrimmedStringField(input, 'appId')
  const sessions = input['sessions']
  if (!Array.isArray(sessions)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessions must be an array', {
      field: 'sessions',
    })
  }

  return {
    appId,
    ...(typeof input['pruneMissing'] === 'boolean' ? { pruneMissing: input['pruneMissing'] } : {}),
    sessions: sessions.map((session, index) => {
      if (!isRecord(session)) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          `sessions[${index}] must be an object`,
          { field: `sessions[${index}]` }
        )
      }
      const specRaw = session['spec']
      if (specRaw === undefined) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          `sessions[${index}].spec is required`,
          { field: `sessions[${index}].spec` }
        )
      }
      const metadata = session['metadata']
      if (metadata !== undefined && !isRecord(metadata)) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          `sessions[${index}].metadata must be an object`,
          { field: `sessions[${index}].metadata` }
        )
      }
      return {
        appSessionKey: requireTrimmedStringField(session, 'appSessionKey'),
        spec: parseAppSessionSpec(specRaw),
        ...(typeof session['label'] === 'string' ? { label: session['label'] } : {}),
        ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
      }
    }),
  }
}

export function parseEnsureRuntimeRequest(input: unknown): EnsureRuntimeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const intent = input['intent']
  if (!isRecord(intent)) {
    throw new HrcUnprocessableEntityError(HrcErrorCode.MISSING_RUNTIME_INTENT, 'intent is required')
  }

  const restartStyle = input['restartStyle']
  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'restartStyle must be "reuse_pty" or "fresh_pty"'
    )
  }

  const allowStaleGeneration = input['allowStaleGeneration']
  if (allowStaleGeneration !== undefined && typeof allowStaleGeneration !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'allowStaleGeneration must be a boolean',
      { field: 'allowStaleGeneration' }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    intent: parseRuntimeIntent(intent),
    restartStyle,
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

export function parseStartRuntimeRequest(input: unknown): StartRuntimeRequest {
  return parseEnsureRuntimeRequest(input)
}

export function parseDispatchTurnRequest(input: unknown): DispatchTurnRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const prompt = input['prompt']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }

  const runtimeIntent = input['runtimeIntent']
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const fences = input['fences']
  const allowStaleGeneration = input['allowStaleGeneration']
  if (allowStaleGeneration !== undefined && typeof allowStaleGeneration !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'allowStaleGeneration must be a boolean',
      { field: 'allowStaleGeneration' }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    prompt: prompt.trim(),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

export function parseInFlightInputRequest(input: unknown): InFlightInputRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  const runId = input['runId']
  const promptValue = typeof input['prompt'] === 'string' ? input['prompt'] : input['input']
  const inputType = input['inputType']

  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runId is required', {
      field: 'runId',
    })
  }
  if (typeof promptValue !== 'string' || promptValue.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }
  if (inputType !== undefined && typeof inputType !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'inputType must be a string', {
      field: 'inputType',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
    runId: runId.trim(),
    prompt: promptValue.trim(),
    ...(typeof inputType === 'string' && inputType.trim().length > 0
      ? { inputType: inputType.trim() }
      : {}),
  }
}

export function parseClearContextRequest(input: unknown): ClearContextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const relaunch = input['relaunch']
  const dropContinuation = input['dropContinuation']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (relaunch !== undefined && typeof relaunch !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'relaunch must be a boolean', {
      field: 'relaunch',
    })
  }
  if (dropContinuation !== undefined && typeof dropContinuation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'dropContinuation must be a boolean',
      {
        field: 'dropContinuation',
      }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    ...(typeof relaunch === 'boolean' ? { relaunch } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
  }
}

export function parseRuntimeActionBody(input: unknown): { runtimeId: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
  }
}

export function parseTerminateRuntimeRequest(input: unknown): TerminateRuntimeRequest {
  const body = parseRuntimeActionBody(input)
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const dropContinuation = input['dropContinuation']
  if (dropContinuation !== undefined && typeof dropContinuation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'dropContinuation must be a boolean',
      {
        field: 'dropContinuation',
      }
    )
  }

  return {
    runtimeId: body.runtimeId,
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
  }
}

export function parseInspectRuntimeRequest(input: unknown): InspectRuntimeRequest {
  return parseRuntimeActionBody(input)
}

export function parseDropContinuationRequest(input: unknown): DropContinuationRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    hostSessionId: requireTrimmedStringField(input, 'hostSessionId'),
    ...readOptionalStringField(input, 'reason'),
  }
}

export function parseSweepRuntimesRequest(input: unknown): SweepRuntimesRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const transport = input['transport']
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport must be one of: tmux, headless, sdk',
      { field: 'transport' }
    )
  }

  const status = input['status']
  if (status !== undefined && !Array.isArray(status)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'status must be an array', {
      field: 'status',
    })
  }
  const parsedStatus = status?.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `status[${index}] must be a non-empty string`,
        { field: `status[${index}]` }
      )
    }
    return entry.trim()
  })

  const olderThan = input['olderThan']
  if (olderThan !== undefined && (typeof olderThan !== 'string' || olderThan.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a non-empty string',
      { field: 'olderThan' }
    )
  }

  const scope = input['scope']
  if (scope !== undefined && (typeof scope !== 'string' || scope.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'scope must be a non-empty string',
      { field: 'scope' }
    )
  }

  const dropContinuation = input['dropContinuation']
  if (dropContinuation !== undefined && typeof dropContinuation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'dropContinuation must be a boolean',
      { field: 'dropContinuation' }
    )
  }

  const dryRun = input['dryRun']
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'dryRun must be a boolean', {
      field: 'dryRun',
    })
  }

  const yes = input['yes']
  if (yes !== undefined && typeof yes !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'yes must be a boolean', {
      field: 'yes',
    })
  }

  return {
    ...(transport ? { transport: transport as SweepRuntimeTransport } : {}),
    ...(olderThan ? { olderThan: olderThan.trim() } : {}),
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(scope ? { scope: scope.trim() } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
    ...(typeof dryRun === 'boolean' ? { dryRun } : {}),
    ...(typeof yes === 'boolean' ? { yes } : {}),
  }
}

export function parseAttachRuntimeRequest(input: unknown): AttachRuntimeRequest {
  return parseRuntimeActionBody(input)
}

export function parseBindSurfaceRequest(input: unknown): BindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const surfaceKind = requireTrimmedStringField(input, 'surfaceKind')
  const surfaceId = requireTrimmedStringField(input, 'surfaceId')
  const runtimeId = requireTrimmedStringField(input, 'runtimeId')
  const hostSessionId = requireTrimmedStringField(input, 'hostSessionId')
  const generation = input['generation']
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'generation is required', {
      field: 'generation',
    })
  }

  return {
    surfaceKind,
    surfaceId,
    runtimeId,
    hostSessionId,
    generation,
    ...readOptionalStringField(input, 'windowId'),
    ...readOptionalStringField(input, 'tabId'),
    ...readOptionalStringField(input, 'paneId'),
  }
}

export function parseUnbindSurfaceRequest(input: unknown): UnbindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    surfaceKind: requireTrimmedStringField(input, 'surfaceKind'),
    surfaceId: requireTrimmedStringField(input, 'surfaceId'),
    ...readOptionalStringField(input, 'reason'),
  }
}

export function parseBridgeTargetRequest(input: unknown): BridgeTargetRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])
  const hostSessionId = readOptionalNonEmptyStringField(input, 'hostSessionId')
  const bridge = readOptionalNonEmptyStringField(input, 'bridge')
  const transport = readOptionalNonEmptyStringField(input, 'transport')
  const target = readOptionalNonEmptyStringField(input, 'target')
  const selector = Object.hasOwn(input, 'selector')
    ? parseBridgeSelector(input['selector'])
    : undefined
  const hasExplicitBinding = transport !== undefined || target !== undefined

  if (hasExplicitBinding && (transport === undefined || target === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport and target must be provided together'
    )
  }
  if (!hasExplicitBinding && (selector === undefined || bridge === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport and target are required unless selector and bridge are provided'
    )
  }

  return {
    ...(hostSessionId !== undefined ? { hostSessionId } : {}),
    ...(bridge !== undefined ? { bridge } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(target !== undefined ? { target } : {}),
    ...readOptionalStringField(input, 'runtimeId'),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(selector !== undefined ? { selector } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseDeliverBridgeRequest(input: unknown): DeliverBridgeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
    text: requireStringField(input, 'text'),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseDeliverTextRequest(input: unknown): DeliverTextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const expectedGeneration = parseOptionalNonNegativeInteger(input['expectedGeneration'])

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
    text: requireStringField(input, 'text'),
    enter: readBooleanField(input, 'enter'),
    ...(typeof input['oobSuffix'] === 'string' ? { oobSuffix: input['oobSuffix'] } : {}),
    ...readOptionalStringField(input, 'expectedHostSessionId'),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  }
}

export function parseCloseBridgeRequest(input: unknown): CloseBridgeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    bridgeId: requireTrimmedStringField(input, 'bridgeId'),
  }
}

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'expectedGeneration must be a non-negative integer',
      {
        field: 'expectedGeneration',
      }
    )
  }

  return value
}

function requireTrimmedStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }

  return value.trim()
}

function requireStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }

  return value
}

function readBooleanField(input: Record<string, unknown>, field: string): boolean {
  const value = input[field]
  if (typeof value !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a boolean`, {
      field,
    })
  }

  return value
}

function readOptionalStringField(
  input: Record<string, unknown>,
  field: string
): Record<string, string> {
  const value = input[field]
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a string`, {
      field,
    })
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? { [field]: trimmed } : {}
}

function readOptionalNonEmptyStringField(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a string`, {
      field,
    })
  }

  return value.trim()
}

function parsePromptPayload(input: Record<string, unknown>): string {
  const prompt = input['prompt']
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt.trim()
  }

  const nestedInput = input['input']
  if (isRecord(nestedInput)) {
    const text = nestedInput['text']
    if (typeof text === 'string' && text.trim().length > 0) {
      return text.trim()
    }
  }

  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
    field: 'prompt',
  })
}

function parseOptionalStringArray(input: unknown, field: string): string[] | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!Array.isArray(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an array`, {
      field,
    })
  }

  return input.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}[${index}] must be a non-empty string`,
        {
          field: `${field}[${index}]`,
        }
      )
    }

    return entry
  })
}

function isStringRecord(input: unknown): input is Record<string, string> {
  if (!isRecord(input)) {
    return false
  }

  return Object.values(input).every((value) => typeof value === 'string')
}

export function parseBridgeSelector(input: unknown): BridgeSelector {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'selector must be an object')
  }

  const hasSessionRef = Object.hasOwn(input, 'sessionRef')
  const hasHostSessionId = Object.hasOwn(input, 'hostSessionId')
  const hasAppSession = Object.hasOwn(input, 'appSession')
  const variantCount = Number(hasSessionRef) + Number(hasHostSessionId) + Number(hasAppSession)

  if (variantCount !== 1) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      'selector must include exactly one of sessionRef, hostSessionId, or appSession'
    )
  }

  if (hasSessionRef) {
    return {
      sessionRef: requireTrimmedStringField(input, 'sessionRef'),
    }
  }

  if (hasHostSessionId) {
    return {
      hostSessionId: requireTrimmedStringField(input, 'hostSessionId'),
    }
  }

  const appSession = input['appSession']
  if (!isRecord(appSession)) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, 'appSession must be an object')
  }

  return {
    appSession: {
      appId: requireTrimmedStringField(appSession, 'appId'),
      appSessionKey: requireTrimmedStringField(appSession, 'appSessionKey'),
    },
  }
}

export function parseAppSessionSelectorFromQuery(url: URL): HrcAppSessionRef {
  const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
  const appSessionKey = normalizeOptionalQuery(url.searchParams.get('appSessionKey'))

  if (!appId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
      field: 'appId',
    })
  }

  if (!appSessionKey) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appSessionKey is required', {
      field: 'appSessionKey',
    })
  }

  return { appId, appSessionKey }
}

export function parseSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const normalized = sessionRef.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith('lane:')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must use "<scopeRef>/lane:<laneRef>" format',
      { sessionRef }
    )
  }

  const scopeRef = parts[0]?.trim() ?? ''
  const laneRef = parts[1].slice('lane:'.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must include scopeRef and laneRef',
      { sessionRef }
    )
  }

  return { scopeRef, laneRef }
}

function parseFenceInput(input: unknown): import('hrc-core').HrcFence {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'fence must be an object')
  }

  try {
    return parseFence(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid fence'
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, message, { fence: input })
  }
}
