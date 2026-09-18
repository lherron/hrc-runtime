/**
 * T-08597 — frozen harness-catalog snapshot for the frozen old-engine fake only.
 *
 * Origin: verbatim rows of spaces-config `HARNESS_CATALOG`
 * (core/types/harness.js at ASP 0.1.1-dev.20260917231122): six entries across
 * the claude / pi / codex / muse families, cli vs sdk transports. The lookup
 * semantics below mirror `resolveHarnessCatalogEntry` (match by id, alias, or
 * frontend), `resolveHarnessProvider`, and `normalizeHarnessFrontend`.
 *
 * Production code never touches this file: the daemon reads catalog facts from
 * the aspd provisioning observation (ASP T-08600 `transport`). If the upstream
 * catalog gains a row, these doubles keep serving the frozen six — update them
 * deliberately, never by re-adding the spaces-config import.
 */

export type FixtureHarnessProvider = 'anthropic' | 'openai' | 'meta'

export type FixtureHarnessTransport = 'cli' | 'sdk'

export type FixtureHarnessFrontend =
  | 'agent-sdk'
  | 'pi-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi-cli'
  | 'muse-cli'

export interface FixtureHarnessCatalogEntry {
  id: string
  aliases: readonly string[]
  provider: FixtureHarnessProvider
  transport: FixtureHarnessTransport
  frontend?: FixtureHarnessFrontend | undefined
}

export const FIXTURE_HARNESS_CATALOG: readonly FixtureHarnessCatalogEntry[] = [
  {
    id: 'claude',
    aliases: ['claude-code'],
    provider: 'anthropic',
    transport: 'cli',
    frontend: 'claude-code',
  },
  {
    id: 'claude-agent-sdk',
    aliases: ['agent-sdk'],
    provider: 'anthropic',
    transport: 'sdk',
    frontend: 'agent-sdk',
  },
  {
    id: 'pi',
    aliases: ['pi-cli'],
    provider: 'openai',
    transport: 'cli',
    frontend: 'pi-cli',
  },
  {
    id: 'pi-sdk',
    aliases: [],
    provider: 'openai',
    transport: 'sdk',
    frontend: 'pi-sdk',
  },
  {
    id: 'codex',
    aliases: ['codex-cli'],
    provider: 'openai',
    transport: 'cli',
    frontend: 'codex-cli',
  },
  {
    id: 'muse',
    aliases: ['muse-cli'],
    provider: 'meta',
    transport: 'cli',
    frontend: 'muse-cli',
  },
]

const BY_NAME = new Map<string, FixtureHarnessCatalogEntry>()
for (const entry of FIXTURE_HARNESS_CATALOG) {
  BY_NAME.set(entry.id, entry)
  for (const alias of entry.aliases) BY_NAME.set(alias, entry)
  if (entry.frontend) BY_NAME.set(entry.frontend, entry)
}

/** Frozen mirror of spaces-config `resolveHarnessCatalogEntry`. */
export function resolveFixtureHarnessCatalogEntry(
  value: string | undefined
): FixtureHarnessCatalogEntry | undefined {
  if (value === undefined) return undefined
  return BY_NAME.get(value)
}

/** Frozen mirror of spaces-config `resolveHarnessProvider`. */
export function resolveFixtureHarnessProvider(
  value: string | undefined
): FixtureHarnessProvider | undefined {
  return resolveFixtureHarnessCatalogEntry(value)?.provider
}

/** Frozen mirror of spaces-config `normalizeHarnessFrontend`. */
export function normalizeFixtureHarnessFrontend(
  value: string | undefined
): FixtureHarnessFrontend | undefined {
  return resolveFixtureHarnessCatalogEntry(value)?.frontend
}
