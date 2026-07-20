import { test } from 'bun:test'

export const REQUIRE_LIVE_TAILNET_TESTS_ENV = 'HRC_REQUIRE_LIVE_TAILNET_TESTS'
export const LIVE_TAILNET_SKIP_MARKER = 'HRC_LIVE_TAILNET_SKIP'
export const LIVE_TAILNET_REQUIRED_MARKER = 'HRC_LIVE_TAILNET_REQUIRED_MISSING'

export type LiveTailnetDisposition = 'run' | 'skip' | 'fail'

export function liveTailnetDisposition(
  host: string | undefined,
  env: Record<string, string | undefined> = process.env
): LiveTailnetDisposition {
  if (host !== undefined) return 'run'
  return env[REQUIRE_LIVE_TAILNET_TESTS_ENV] === '1' ? 'fail' : 'skip'
}

export function selectLiveTailnetTest(
  file: string,
  host: string | undefined,
  options: {
    env?: Record<string, string | undefined> | undefined
    warn?: ((message: string) => void) | undefined
  } = {}
): typeof test {
  const disposition = liveTailnetDisposition(host, options.env)
  if (disposition === 'run') return test

  const marker = disposition === 'fail' ? LIVE_TAILNET_REQUIRED_MARKER : LIVE_TAILNET_SKIP_MARKER
  const message = `[${marker}] ${file}: no tailnet IPv4 interface is available`
  const warn = options.warn ?? console.warn
  warn(message)
  return disposition === 'fail' ? test : test.skip
}
