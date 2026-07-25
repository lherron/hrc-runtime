import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Shared `.env.local` context loader for the HRC CLIs.
 *
 * Contract (2026-07-25 env-hygiene ruling): repo-local env files carry
 * project CONTEXT only — project routing, ports, paths. Credential- and
 * principal-class keys are never applied from them; secrets travel through
 * real environment variables or *_FILE indirection (e.g. WRKQD_TOKEN_FILE).
 * A `.env.secrets` file, outside every auto-load set, holds dev-stack
 * credentials for consumers that opt in explicitly.
 */

const CREDENTIAL_KEY_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL/i
const PRINCIPAL_KEYS = new Set(['WRKQ_ACTOR', 'WRKF_ACTOR'])

export function isCredentialClassKey(key: string): boolean {
  // A *_FILE key is a path to a secret, not the secret — that indirection is
  // exactly what this contract steers toward, so it stays context-class.
  if (key.endsWith('_FILE')) return false
  return PRINCIPAL_KEYS.has(key) || CREDENTIAL_KEY_PATTERN.test(key)
}

export function parseDotEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (key) parsed[key] = value
  }
  return parsed
}

type WarnSink = (message: string) => void

const defaultWarn: WarnSink = (message) => {
  process.stderr.write(`${message}\n`)
}

function readDotEnvFile(envPath: string): Record<string, string> | undefined {
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return undefined
  }
  return parseDotEnvContent(content)
}

/**
 * Apply a single .env file into `env`. Existing vars are never overwritten
 * (real environment wins), and credential-class keys are never applied —
 * each refusal is reported once per file through `warn`.
 */
export function applyDotEnvFile(
  envPath: string,
  env: Record<string, string | undefined> = process.env,
  warn: WarnSink = defaultWarn
): void {
  const parsed = readDotEnvFile(envPath)
  if (!parsed) return
  const refused: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) continue
    if (isCredentialClassKey(key)) {
      refused.push(key)
      continue
    }
    env[key] = value
  }
  if (refused.length > 0) {
    warn(
      `env-hygiene: refusing credential-class keys from ${envPath}: ${refused.join(', ')} (env files carry context only; use real env or *_FILE indirection, see .env.secrets)`
    )
  }
}

/**
 * Bun auto-loads cwd `.env`/`.env.local` into process.env before any of our
 * code runs, so refusal above cannot catch the cwd case. Detect it instead:
 * a credential-class env var whose value byte-matches the file almost
 * certainly came from auto-load rather than the operator.
 */
export function warnAutoLoadedCredentials(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  warn: WarnSink = defaultWarn
): void {
  for (const name of ['.env', '.env.local']) {
    const parsed = readDotEnvFile(join(cwd, name))
    if (!parsed) continue
    const leaked = Object.entries(parsed)
      .filter(([key, value]) => isCredentialClassKey(key) && value.length > 0 && env[key] === value)
      .map(([key]) => key)
    if (leaked.length > 0) {
      warn(
        `env-hygiene: ${leaked.join(', ')} in process env matches ${join(cwd, name)} — repo-local credentials are leaking into tooling via bun .env auto-load; move them to .env.secrets or *_FILE indirection`
      )
    }
  }
}

/**
 * Walk up from cwd applying each .env.local found, stopping at — and
 * including — the nearest git root. Nearer files win (visited first; a key is
 * only set while still unset) and real environment variables win over all
 * files. This lets a CLI invoked from a subdir (e.g. var/agents/cody) inherit
 * ASP_PROJECT from a parent .env.local at the git root. The `.git` probe uses
 * existsSync so worktree dirs (where .git is a file, not a directory) are
 * recognized too.
 */
export function loadDotEnvLocal(
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    warn?: WarnSink
  } = {}
): void {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const warn = options.warn ?? defaultWarn
  warnAutoLoadedCredentials(cwd, env, warn)
  let dir = cwd
  while (true) {
    applyDotEnvFile(join(dir, '.env.local'), env, warn)
    if (existsSync(join(dir, '.git'))) break // nearest git root — boundary
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root — no git root found
    dir = parent
  }
}
