/**
 * Project the daemon's host-authoritative wrkq transport contract.
 *
 * WRKQ_DB is locator-shaped and may be either a local path or an rpc:// URL.
 * The path-named compatibility aliases remain local-path-only, so an explicit
 * canonical locator clears them instead of copying the locator into them.
 */
export function wrkqAuthorityEnvironment(
  source: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  const db = source['HRC_WRKQ_DB']?.trim()
  if (db) {
    env['WRKQ_DB'] = db
    env['WRKQ_DB_PATH'] = undefined
    env['WRKQ_DB_PATH_FILE'] = undefined
  }
  const tokenFile = source['HRC_WRKQD_TOKEN_FILE']?.trim()
  if (tokenFile) {
    // wrkq intentionally gives WRKQD_TOKEN precedence over the file. A stale
    // operator-shell token must not shadow the daemon's explicit credential.
    // Keep the key present-but-empty for command processes so dotenv cannot
    // restore an inline token before wrkq resolves the explicit file.
    env['WRKQD_TOKEN'] = ''
    env['WRKQD_TOKEN_FILE'] = tokenFile
  }
  return env
}

/**
 * Apply host wrkq reachability to every managed broker runtime.
 *
 * Broker dispatch env carries strings, not deletion markers, and rejects
 * inline credential keys by design. The token file path is safe to project;
 * token contents never enter the dispatch envelope.
 */
export function injectRuntimeWrkqAuthority(
  env: Record<string, string>,
  source: Record<string, string | undefined> = process.env
): Record<string, string> {
  const authorityEnv = Object.fromEntries(
    Object.entries(wrkqAuthorityEnvironment(source))
      .filter(([key]) => key !== 'WRKQD_TOKEN')
      .map(([key, value]) => [key, value ?? ''])
  )
  const { WRKQD_TOKEN: _discardedInlineToken, ...runtimeEnv } = env
  return { ...runtimeEnv, ...authorityEnv }
}
