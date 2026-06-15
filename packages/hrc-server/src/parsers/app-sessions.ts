import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  AppSessionFreshnessFence,
  ApplyAppManagedSessionsRequest,
  ApplyAppSessionInput,
  ApplyAppSessionsRequest,
  ClearAppSessionContextRequest,
  DispatchAppHarnessTurnRequest,
  EnsureAppSessionRequest,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcRuntimeIntent,
  InterruptAppSessionRequest,
  RestartStyle,
  SendAppHarnessInFlightInputRequest,
  SendLiteralInputRequest,
  TerminateAppSessionRequest,
} from 'hrc-core'

import {
  isRecord,
  isStringRecord,
  normalizeOptionalQuery,
  parseFenceInput,
  parseOptionalStringArray,
  parsePromptPayload,
  readOptionalBooleanField,
  readOptionalNonEmptyStringField,
  readOptionalStringField,
  requireOneOf,
  requireOptionalOneOf,
  requireTrimmedStringField,
} from './common.js'
import { parseRuntimeIntent } from './runtime.js'

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
  const launchMode = requireOptionalOneOf(
    command['launchMode'],
    ['shell', 'exec', 'app-server'],
    'spec.command.launchMode must be "shell", "exec", or "app-server"',
    { field: 'spec.command.launchMode' }
  )

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

  const effectiveLaunchMode = launchMode ?? 'exec'
  if (effectiveLaunchMode !== 'shell' && (!argv || argv.length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `spec.command.argv is required when launchMode is "${effectiveLaunchMode}"`,
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

function parseAppSessionSpec(input: unknown): HrcAppSessionSpec {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spec must be an object', {
      field: 'spec',
    })
  }
  const kind = requireOneOf(
    requireTrimmedStringField(input, 'kind'),
    ['harness', 'command'],
    'spec.kind must be "harness" or "command"',
    { field: 'spec.kind' }
  )

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

  const restartStyle = requireOptionalOneOf(
    input['restartStyle'],
    ['reuse_pty', 'fresh_pty'],
    'restartStyle must be "reuse_pty" or "fresh_pty"',
    { field: 'restartStyle' }
  )

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
  const relaunch = readOptionalBooleanField(input, 'relaunch')
  if (input['reason'] !== undefined && typeof input['reason'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'reason must be a string', {
      field: 'reason',
    })
  }

  return {
    selector: parseAppSessionSelector(selectorRaw),
    ...(relaunch !== undefined ? { relaunch } : {}),
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
