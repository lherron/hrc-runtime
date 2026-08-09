import { readFile } from 'node:fs/promises'

import { buildScopeRef, validateScopeRef, validateToken } from 'agent-scope'

export const HRC_REGISTRATION_CLASSES_FILE_ENV = 'HRC_REGISTRATION_CLASSES_FILE'
export const MAX_EXTERNAL_REGISTRATION_TTL_SECONDS = 300

export type RegistrationClassScopeTemplate = {
  agent: string
  project: string
}

export type RegistrationClassConfig = {
  classId: string
  scopeTemplate: RegistrationClassScopeTemplate
  maxInstances: number
  defaultTtl: number
  turnsAllowed: boolean
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unexpected !== undefined) {
    throw new Error(`${where} contains unsupported field "${unexpected}"`)
  }
}

function requireToken(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${where}.${field} must be a string`)
  }
  const normalized = value.trim()
  const diagnostic = validateToken(normalized, field)
  if (diagnostic !== undefined) {
    throw new Error(`${where}.${field} is invalid: ${diagnostic}`)
  }
  return normalized
}

function requirePositiveInteger(value: unknown, field: string, where: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${where}.${field} must be a positive integer`)
  }
  return value as number
}

export function validateRegistrationClassConfig(
  value: unknown,
  where: string
): RegistrationClassConfig {
  if (!isPlainRecord(value)) {
    throw new Error(`${where} must be an object`)
  }
  assertExactKeys(
    value,
    ['classId', 'scopeTemplate', 'maxInstances', 'defaultTtl', 'turnsAllowed'],
    where
  )

  const classId = requireToken(value['classId'], 'classId', where)
  const rawTemplate = value['scopeTemplate']
  if (!isPlainRecord(rawTemplate)) {
    throw new Error(`${where}.scopeTemplate must be an object`)
  }
  assertExactKeys(rawTemplate, ['agent', 'project'], `${where}.scopeTemplate`)
  const agent = requireToken(rawTemplate['agent'], 'agent', `${where}.scopeTemplate`)
  const project = requireToken(rawTemplate['project'], 'project', `${where}.scopeTemplate`)
  const maxInstances = requirePositiveInteger(value['maxInstances'], 'maxInstances', where)
  const defaultTtl = requirePositiveInteger(value['defaultTtl'], 'defaultTtl', where)
  if (defaultTtl > MAX_EXTERNAL_REGISTRATION_TTL_SECONDS) {
    throw new Error(`${where}.defaultTtl must not exceed ${MAX_EXTERNAL_REGISTRATION_TTL_SECONDS}`)
  }
  if (typeof value['turnsAllowed'] !== 'boolean') {
    throw new Error(`${where}.turnsAllowed must be a boolean`)
  }

  // Prove at daemon startup that this operator template can produce a valid,
  // node-free task-qualified ScopeRef. Request handling only supplies entropy.
  const probe = buildScopeRef({ agentId: agent, projectId: project, taskId: 'reg-probe' })
  const scopeValidation = validateScopeRef(probe)
  if (!scopeValidation.ok) {
    throw new Error(`${where}.scopeTemplate cannot derive a ScopeRef: ${scopeValidation.error}`)
  }

  return {
    classId,
    scopeTemplate: { agent, project },
    maxInstances,
    defaultTtl,
    turnsAllowed: value['turnsAllowed'],
  }
}

export function parseRegistrationClassesConfig(
  value: unknown,
  source: string
): RegistrationClassConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON array of registration classes`)
  }
  const classes = value.map((entry, index) =>
    validateRegistrationClassConfig(entry, `${source}[${index}]`)
  )
  const seen = new Set<string>()
  for (const registrationClass of classes) {
    if (seen.has(registrationClass.classId)) {
      throw new Error(`${source} contains duplicate classId "${registrationClass.classId}"`)
    }
    seen.add(registrationClass.classId)
  }
  return classes
}

export async function loadRegistrationClassesFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<RegistrationClassConfig[]> {
  const sourcePath = env[HRC_REGISTRATION_CLASSES_FILE_ENV]?.trim()
  if (!sourcePath) return []

  let raw: string
  try {
    raw = await readFile(sourcePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${HRC_REGISTRATION_CLASSES_FILE_ENV} is set to ${sourcePath}, but the file could not be read: ${message}`,
      { cause: error }
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${HRC_REGISTRATION_CLASSES_FILE_ENV} ${sourcePath} is not valid JSON: ${message}`,
      { cause: error }
    )
  }
  return parseRegistrationClassesConfig(
    parsed,
    `${HRC_REGISTRATION_CLASSES_FILE_ENV} ${sourcePath}`
  )
}

export async function resolveRegistrationClasses(
  configured: readonly RegistrationClassConfig[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<RegistrationClassConfig[]> {
  if (configured === undefined) return loadRegistrationClassesFromEnv(env)
  return parseRegistrationClassesConfig(configured, 'registrationClasses')
}
