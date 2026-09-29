import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcExecutionFormat, HrcHarness, HrcProvider, HrcRuntimeIntent } from 'hrc-core'

import type { HrcRuntimePlacement } from 'hrc-core'

import {
  isRecord,
  readOptionalNonEmptyStringField,
  requireOneOf,
  requireOptionalOneOf,
} from './common.js'
import { parseOptionalProvisionBlock } from './provision.js'
import { resolveHarnessFromPlacement } from './runtime-harness-resolver.js'

function parseInlineHarness(harness: Record<string, unknown>): HrcRuntimeIntent['harness'] {
  const providerValue = readOptionalNonEmptyStringField(harness, 'provider')
  const provider =
    providerValue === undefined
      ? undefined
      : requireOneOf(
          providerValue,
          ['anthropic', 'openai', 'meta'],
          'harness.provider must be "anthropic", "openai", or "meta"',
          { field: 'harness.provider' }
        )

  const interactive = harness['interactive']
  if (typeof interactive !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'harness.interactive must be a boolean',
      { field: 'harness.interactive' }
    )
  }

  return {
    interactive,
    ...(provider !== undefined ? { provider: provider as HrcProvider } : {}),
    ...(typeof harness['id'] === 'string' ? { id: harness['id'] as HrcHarness } : {}),
    ...(typeof harness['fallback'] === 'string' ? { fallback: harness['fallback'] } : {}),
    ...(harness['model'] !== undefined ? { model: String(harness['model']) } : {}),
    ...(harness['yolo'] === true ? { yolo: true } : {}),
  }
}

export function parseRuntimeIntent(input: Record<string, unknown>): HrcRuntimeIntent {
  const placement = input['placement'] ?? 'workspace'
  const execution = input['execution']
  const harness = input['harness']
  const launch = input['launch']
  const initialPrompt = input['initialPrompt']
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const resolvedHarness = isRecord(harness)
    ? parseInlineHarness(harness)
    : resolveHarnessFromPlacement(placement, execution)

  const presentation = parseOptionalPresentationIntent(input['presentation'])
  const selection = parseOptionalHarnessSelection(input['selection'])
  const summonDirectives = parseOptionalSummonHarnessDirectives(input['summonDirectives'])
  // T-07398: re-validated HERE, at the dispatch boundary, then carried verbatim.
  // Every surface that already accepts a runtimeIntent therefore accepts a
  // directive block without a new request-body field of its own.
  const provision = parseOptionalProvisionBlock(input['provision'])

  return {
    placement: placement as HrcRuntimePlacement,
    harness: resolvedHarness,
    ...(selection === undefined ? {} : { selection }),
    ...(summonDirectives === undefined ? {} : { summonDirectives }),
    ...(provision === undefined ? {} : { provision }),
    ...(isRecord(execution) ? { execution: execution as HrcRuntimeIntent['execution'] } : {}),
    ...(isRecord(launch) ? { launch: launch as HrcRuntimeIntent['launch'] } : {}),
    ...(typeof initialPrompt === 'string' ? { initialPrompt } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
  }
}

function parseOptionalHarnessSelection(value: unknown): HrcRuntimeIntent['selection'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selection must be an object', {
      field: 'selection',
    })
  }
  const harness = value['harness']
  const modelProvider = readOptionalNonEmptyStringField(value, 'modelProvider')
  const model = readOptionalNonEmptyStringField(value, 'model')
  const reasoningEffort = value['reasoningEffort']
  const presentation = value['presentation']
  if (presentation !== undefined && typeof presentation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'selection.presentation must be a boolean',
      { field: 'selection.presentation' }
    )
  }
  return {
    ...(harness === undefined
      ? {}
      : {
          harness: requireOneOf(
            harness,
            ['agent-harness', 'claude', 'codex', 'muse'],
            'selection.harness must be "agent-harness", "claude", "codex", or "muse"',
            { field: 'selection.harness' }
          ) as NonNullable<HrcRuntimeIntent['selection']>['harness'],
        }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: requireOneOf(
            reasoningEffort,
            ['low', 'medium', 'high', 'xhigh'],
            'selection.reasoningEffort must be "low", "medium", "high", or "xhigh"',
            { field: 'selection.reasoningEffort' }
          ) as NonNullable<HrcRuntimeIntent['selection']>['reasoningEffort'],
        }),
    ...(presentation === undefined ? {} : { presentation }),
  }
}

function parseOptionalSummonHarnessDirectives(
  value: unknown
): HrcRuntimeIntent['summonDirectives'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'summonDirectives must be an object',
      { field: 'summonDirectives' }
    )
  }
  const harness = value['harness']
  const modelProvider = readOptionalNonEmptyStringField(value, 'model_provider')
  const model = readOptionalNonEmptyStringField(value, 'model')
  const reasoningEffort = value['reasoning_effort']
  const presentation = value['presentation']
  if (presentation !== undefined && typeof presentation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'summonDirectives.presentation must be a boolean',
      { field: 'summonDirectives.presentation' }
    )
  }
  return {
    ...(harness === undefined
      ? {}
      : {
          harness: requireOneOf(
            harness,
            ['agent-harness', 'claude', 'codex', 'muse'],
            'summonDirectives.harness must be "agent-harness", "claude", "codex", or "muse"',
            { field: 'summonDirectives.harness' }
          ) as NonNullable<HrcRuntimeIntent['summonDirectives']>['harness'],
        }),
    ...(modelProvider === undefined ? {} : { model_provider: modelProvider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined
      ? {}
      : {
          reasoning_effort: requireOneOf(
            reasoningEffort,
            ['low', 'medium', 'high', 'xhigh'],
            'summonDirectives.reasoning_effort must be "low", "medium", "high", or "xhigh"',
            { field: 'summonDirectives.reasoning_effort' }
          ) as NonNullable<HrcRuntimeIntent['summonDirectives']>['reasoning_effort'],
        }),
    ...(presentation === undefined ? {} : { presentation }),
  }
}

/**
 * Viewer placement hint (T-07118). Free-form key, validated only as a non-empty
 * string: the presentation layer normalizes it, and an absent/blank value is the
 * implicit default key, i.e. today's behavior.
 */
function parseOptionalPresentationIntent(
  value: unknown
): HrcRuntimeIntent['presentation'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'presentation must be an object', {
      field: 'presentation',
    })
  }
  // T-08553/T-08554: the request declines the operator viewer ('none') or selects
  // the app-server viewer ('tmux-tui'); the observer-pane renderer viewer
  // ('observer') is the muse-serve equivalent.
  const operator = value['operator']
  if (
    operator !== undefined &&
    operator !== 'none' &&
    operator !== 'tmux-tui' &&
    operator !== 'observer'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      "presentation.operator accepts only 'none', 'tmux-tui', or 'observer'",
      { field: 'presentation.operator' }
    )
  }
  const viewerWindow = value['viewerWindow']
  if (viewerWindow === undefined) return operator !== undefined ? { operator } : {}
  if (typeof viewerWindow !== 'string' || viewerWindow.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'presentation.viewerWindow must be a non-empty string',
      { field: 'presentation.viewerWindow' }
    )
  }
  if (operator === 'none') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      "presentation.operator 'none' declines the viewer, so presentation.viewerWindow cannot place one",
      { field: 'presentation.operator' }
    )
  }
  return { viewerWindow: viewerWindow.trim(), ...(operator !== undefined ? { operator } : {}) }
}

export function parseOptionalAttachmentRefs(
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

export function parseExecutionFormatSelector(
  input: Record<string, unknown>
): HrcExecutionFormat | undefined {
  return requireOptionalOneOf(
    input['executionFormat'],
    ['format1', 'format2'],
    'executionFormat must be "format1" or "format2"',
    { field: 'executionFormat' }
  )
}
