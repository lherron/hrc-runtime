/**
 * T-08597 — minimal agent-profile.toml reader for TEST doubles only.
 *
 * Origin: minimal faithful subset of spaces-config `parseAgentProfile`
 * (core/config/agent-profile-toml.js at ASP 0.1.1-dev.20260917231122).
 * Upstream parses with `@iarna/toml`; this fixture parses with the runtime's
 * `Bun.TOML` (same TOML spec, no new dependency — hrc-cli declares no TOML
 * parser). Only the semantic validation is narrowed. Production code never
 * touches this file: the daemon reads profile facts from the aspd declaration
 * observation.
 *
 * Validation kept (behavior the doubles rely on — each throws):
 * TOML syntax errors, non-table documents, `version !== 3`, mistyped
 * operator/claims_task, unknown harness ids (checked against the frozen
 * `./fixture-catalog.js` snapshot), `node: "local"` / malformed node ids, and
 * malformed role tokens (via agent-scope `validateToken`, as upstream does).
 * Everything else structural that upstream validates strictly (unknown
 * top-level tables, job shapes, space refs) is passed through unvalidated:
 * no double reads those fields.
 */

import { readFileSync } from 'node:fs'

import { PROVISIONING_SCALAR_KEYS, PROVISIONING_SCALAR_KINDS, validateToken } from 'agent-scope'

import { resolveFixtureHarnessCatalogEntry } from './fixture-catalog.js'

export interface FixtureAgentIdentity {
  display?: string | undefined
  role?: string | undefined
}

export interface FixtureAgentProfile {
  identity?: FixtureAgentIdentity | undefined
  operator?: boolean | undefined
  claims_task?: boolean | undefined
  provisioning?: Record<string, unknown> | undefined
  placement?: { pins?: Record<string, string>; homes?: Record<string, string> } | undefined
  priming?: string | undefined
  priming_file?: string | undefined
}

export class FixtureProfileError extends Error {}

const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(profilePath: string, message: string): never {
  throw new FixtureProfileError(`Invalid agent-profile.toml ${profilePath}: ${message}`)
}

function parseIdentity(value: unknown, profilePath: string): FixtureAgentIdentity | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail(profilePath, '/identity must be a table')
  const identity: FixtureAgentIdentity = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key !== 'display' && key !== 'role') fail(profilePath, `/identity/${key} is not supported`)
    if (typeof raw !== 'string') fail(profilePath, `/identity/${key} must be a string`)
    if (key === 'role') {
      const error = validateToken(raw, 'role')
      if (error !== undefined) fail(profilePath, `/identity/role ${error}`)
      identity.role = raw
    } else {
      identity.display = raw
    }
  }
  return identity
}

function parseProvisioning(
  value: unknown,
  profilePath: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail(profilePath, '/provisioning must be a table')
  const settings: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'claude' || key === 'codex') {
      if (!isPlainObject(raw)) fail(profilePath, `/provisioning/${key} must be a table`)
      settings[key] = raw
      continue
    }
    if (key === 'default_scope_role') {
      if (typeof raw !== 'string')
        fail(profilePath, '/provisioning/default_scope_role must be a string')
      settings[key] = raw
      continue
    }
    if (!(PROVISIONING_SCALAR_KEYS as readonly string[]).includes(key)) {
      fail(profilePath, `/provisioning/${key} is not a known provisioning key`)
    }
    const kind = (PROVISIONING_SCALAR_KINDS as Record<string, string>)[key]
    if (kind === 'boolean') {
      if (typeof raw !== 'boolean') fail(profilePath, `/provisioning/${key} must be a boolean`)
    } else if (typeof raw !== 'string') {
      fail(profilePath, `/provisioning/${key} must be a string`)
    }
    if (key === 'harness' && typeof raw === 'string' && !resolveFixtureHarnessCatalogEntry(raw)) {
      fail(profilePath, `/provisioning/harness unsupported harness "${raw}"`)
    }
    if (key === 'node' && typeof raw === 'string') {
      if (raw === 'local') fail(profilePath, '/provisioning/node "local" is not a registry node id')
      if (!NODE_ID_PATTERN.test(raw)) fail(profilePath, '/provisioning/node must be a node id')
    }
    settings[key] = raw
  }
  return settings
}

function parsePlacement(value: unknown, profilePath: string): FixtureAgentProfile['placement'] {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail(profilePath, '/placement must be a table')
  const placement: { pins?: Record<string, string>; homes?: Record<string, string> } = {}
  for (const key of ['pins', 'homes'] as const) {
    const table = value[key]
    if (table === undefined) continue
    if (!isPlainObject(table)) fail(profilePath, `/placement/${key} must be a table`)
    const out: Record<string, string> = {}
    for (const [entryKey, entryValue] of Object.entries(table)) {
      if (typeof entryValue !== 'string')
        fail(profilePath, `/placement/${key}/${entryKey} must be a string`)
      out[entryKey] = entryValue
    }
    placement[key] = out
  }
  return placement
}

function parseToml(content: string): unknown {
  const runtime = globalThis as unknown as {
    Bun?: { TOML?: { parse(input: string): unknown } } | undefined
  }
  const toml = runtime.Bun?.TOML
  if (!toml) throw new Error('Bun.TOML is unavailable in this runtime')
  return toml.parse(content)
}

/** Parse (not read) an agent-profile.toml document; throws FixtureProfileError. */
export function parseFixtureAgentProfile(
  content: string,
  profilePath: string
): FixtureAgentProfile {
  let parsed: unknown
  try {
    parsed = parseToml(content)
  } catch (error) {
    throw new FixtureProfileError(
      `Invalid agent-profile.toml ${profilePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isPlainObject(parsed)) fail(profilePath, 'document must be a table')
  if (parsed['version'] !== 3) fail(profilePath, 'unsupported profile version; expected 3')
  const profile: FixtureAgentProfile = {}
  if (parsed['operator'] !== undefined) {
    if (typeof parsed['operator'] !== 'boolean') fail(profilePath, '/operator must be a boolean')
    profile.operator = parsed['operator']
  }
  if (parsed['claims_task'] !== undefined) {
    if (typeof parsed['claims_task'] !== 'boolean')
      fail(profilePath, '/claims_task must be a boolean')
    profile.claims_task = parsed['claims_task']
  }
  const placement = parsePlacement(parsed['placement'], profilePath)
  if (placement !== undefined) profile.placement = placement
  const provisioning = parseProvisioning(parsed['provisioning'], profilePath)
  if (provisioning !== undefined) profile.provisioning = provisioning
  const identity = parseIdentity(parsed['identity'], profilePath)
  if (identity !== undefined) profile.identity = identity
  if (parsed['priming'] !== undefined) {
    if (typeof parsed['priming'] !== 'string') fail(profilePath, '/priming must be a string')
    profile.priming = parsed['priming']
  }
  if (parsed['priming_file'] !== undefined) {
    if (typeof parsed['priming_file'] !== 'string')
      fail(profilePath, '/priming_file must be a string')
    profile.priming_file = parsed['priming_file']
  }
  return profile
}

/** Read + parse an agent-profile.toml file; throws FixtureProfileError. */
export function readFixtureAgentProfile(profilePath: string): FixtureAgentProfile {
  return parseFixtureAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
}
