import { createHash } from 'node:crypto'

import type { ErrorObject, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  HRC_MAIL_REPLY_SCHEMA_DIALECT,
  HRC_MAIL_REPLY_SCHEMA_MAX_BYTES,
  type HrcMailReplySchema,
} from 'hrc-core'

export type HrcMailSchemaValidationError = {
  instancePath: string
  keyword: string
  message: string
  params: Record<string, unknown>
}

export type HrcMailReplyValidationResult =
  | { valid: true }
  | { valid: false; errors: HrcMailSchemaValidationError[] }

const validator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
})
const compiledSchemas = new Map<string, ValidateFunction>()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return result
}

export function canonicalHrcMailJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function fingerprintHrcMailJson(value: unknown): string {
  return createHash('sha256').update(canonicalHrcMailJson(value)).digest('hex')
}

function schemaErrors(errors: ErrorObject[] | null | undefined): HrcMailSchemaValidationError[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'validation failed',
    params: error.params,
  }))
}

function collectRemoteRefs(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectRemoteRefs(item, `${path}[${index}]`))
  }
  if (value === null || typeof value !== 'object') return []

  const refs: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (
      (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') &&
      typeof child === 'string' &&
      !child.startsWith('#')
    ) {
      refs.push(`${childPath}: ${child}`)
    }
    refs.push(...collectRemoteRefs(child, childPath))
  }
  return refs
}

export function compileHrcMailReplySchema(schema: HrcMailReplySchema): ValidateFunction {
  const encoded = canonicalHrcMailJson(schema)
  const sizeBytes = Buffer.byteLength(encoded, 'utf8')
  if (sizeBytes > HRC_MAIL_REPLY_SCHEMA_MAX_BYTES) {
    throw new Error(
      `reply schema is ${sizeBytes} bytes; maximum is ${HRC_MAIL_REPLY_SCHEMA_MAX_BYTES}`
    )
  }

  const declaredDialect = schema['$schema']
  if (
    declaredDialect !== undefined &&
    declaredDialect !== HRC_MAIL_REPLY_SCHEMA_DIALECT &&
    declaredDialect !== `${HRC_MAIL_REPLY_SCHEMA_DIALECT}#`
  ) {
    throw new Error(
      `reply schema dialect must be ${HRC_MAIL_REPLY_SCHEMA_DIALECT}; received ${String(
        declaredDialect
      )}`
    )
  }

  const remoteRefs = collectRemoteRefs(schema)
  if (remoteRefs.length > 0) {
    throw new Error(
      `reply schema must be self-contained; remote references: ${remoteRefs.join(', ')}`
    )
  }

  const cached = compiledSchemas.get(encoded)
  if (cached) return cached

  const compiled = validator.compile(schema)
  compiledSchemas.set(encoded, compiled)
  return compiled
}

export function validateHrcMailReply(
  schema: HrcMailReplySchema,
  response: unknown
): HrcMailReplyValidationResult {
  const compiled = compileHrcMailReplySchema(schema)
  return compiled(response)
    ? { valid: true }
    : { valid: false, errors: schemaErrors(compiled.errors) }
}
