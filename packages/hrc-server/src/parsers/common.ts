import { HrcBadRequestError, HrcErrorCode, parseFence } from 'hrc-core'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

export function pickOptionalQuery(url: URL, key: string): Record<string, string> {
  const normalized = normalizeOptionalQuery(url.searchParams.get(key))
  return normalized !== undefined ? { [key]: normalized } : {}
}

export function parseOptionalNonNegativeIntegerQuery(
  raw: string | null,
  field: string
): number | undefined {
  const normalized = normalizeOptionalQuery(raw)
  if (normalized === undefined) {
    return undefined
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a non-negative integer`,
      { field, value: normalized }
    )
  }

  return parsed
}

export function parseOptionalBooleanQuery(raw: string | null, field: string): boolean | undefined {
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

export function parseDurationMs(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'olderThan must be a duration like 30m, 2h, or 24h',
      { field: 'olderThan', value: input }
    )
  }

  const amount = Number.parseFloat(match[1] ?? '')
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  const UNIT_MS: Record<'ms' | 's' | 'm' | 'h' | 'd', number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }
  const durationMs = amount * UNIT_MS[unit]
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'olderThan must be positive', {
      field: 'olderThan',
      value: input,
    })
  }
  return Math.floor(durationMs)
}

export function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
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

export function requireTrimmedStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }

  return value.trim()
}

export function requireStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }

  return value
}

export function readBooleanField(input: Record<string, unknown>, field: string): boolean {
  const value = input[field]
  if (typeof value !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a boolean`, {
      field,
    })
  }

  return value
}

export function readOptionalBooleanField(
  input: Record<string, unknown>,
  field: string
): boolean | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a boolean`, {
      field,
    })
  }

  return value
}

export function readOptionalStringField(
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

export function readOptionalNonEmptyStringField(
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

export function parsePromptPayload(input: Record<string, unknown>): string {
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

export function parseOptionalStringArray(input: unknown, field: string): string[] | undefined {
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

export function isStringRecord(input: unknown): input is Record<string, string> {
  if (!isRecord(input)) {
    return false
  }

  return Object.values(input).every((value) => typeof value === 'string')
}

export function parseFenceInput(input: unknown): import('hrc-core').HrcFence {
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
