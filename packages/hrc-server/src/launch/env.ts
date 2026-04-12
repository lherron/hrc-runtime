const SCRUB_EXACT_KEYS = new Set([
  'BUILD_NUMBER',
  'CI',
  'CLICOLOR_FORCE',
  'CONTINUOUS_INTEGRATION',
  'FORCE_COLOR',
  'GITHUB_ACTIONS',
  'NO_COLOR',
  'RUN_ID',
] as const)

const SCRUB_PREFIXES = ['AGENTCHAT_', 'AGENT_', 'CODEX_', 'HRC_'] as const

export function shouldScrubInheritedEnvKey(key: string): boolean {
  if (SCRUB_EXACT_KEYS.has(key as typeof SCRUB_EXACT_KEYS extends Set<infer T> ? T : never)) {
    return true
  }

  return SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function scrubInheritedEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string> {
  const scrubbed: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldScrubInheritedEnvKey(key)) {
      continue
    }
    scrubbed[key] = value
  }

  return scrubbed
}

export function listInheritedEnvKeysToScrub(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string[] {
  const keys = new Set<string>(SCRUB_EXACT_KEYS)

  for (const key of Object.keys(env)) {
    if (shouldScrubInheritedEnvKey(key)) {
      keys.add(key)
    }
  }

  return [...keys].sort()
}

function isCodexEphemeralPathEntry(entry: string): boolean {
  return (
    entry.includes('/tmp/arg0/codex-arg0') ||
    entry.includes('/node_modules/@openai/codex/') ||
    entry.includes('/node_modules/@openai/codex-darwin-arm64/vendor/')
  )
}

export function sanitizeTmuxServerPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) {
    return undefined
  }

  const seen = new Set<string>()
  const entries = pathValue
    .split(':')
    .filter((entry) => entry.length > 0)
    .filter((entry) => !isCodexEphemeralPathEntry(entry))
    .filter((entry) => {
      if (seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })

  return entries.length > 0 ? entries.join(':') : undefined
}

export function sanitizeTmuxClientEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): Record<string, string> {
  const sanitized = scrubInheritedEnv(env)
  const sanitizedPath = sanitizeTmuxServerPath(sanitized['PATH'])

  if (!sanitizedPath) {
    const { PATH: _discardedPath, ...withoutPath } = sanitized
    return withoutPath
  }

  sanitized['PATH'] = sanitizedPath
  return sanitized
}
