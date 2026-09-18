/**
 * T-08597 — minimal asp-targets.toml reader for the frozen old-engine fake.
 *
 * Origin: minimal faithful subset of spaces-config `parseTargetsToml`
 * (core/config/targets-toml.js at ASP 0.1.1-dev.20260917231122). Upstream
 * validates the manifest against an AJV schema; this fixture keeps only what
 * the old intent assembler reads — the top-level `agents-root` declaration
 * and each target's `provisioning` table — plus the one conflict upstream
 * rejects explicitly (`priming` + `priming_append` on the same target).
 * TOML syntax errors throw, as upstream. Production code never touches this
 * file: the daemon reads target facts from the aspd declaration observation.
 */

export interface FixtureProjectTarget {
  provisioning?: Record<string, unknown> | undefined
  priming?: string | undefined
  priming_append?: string | undefined
  description?: string | undefined
}

export interface FixtureProjectManifest {
  agentsRoot?: string | undefined
  targets: Record<string, FixtureProjectTarget>
}

export class FixtureTargetsError extends Error {}

function parseToml(content: string): unknown {
  const runtime = globalThis as unknown as {
    Bun?: { TOML?: { parse(input: string): unknown } } | undefined
  }
  const toml = runtime.Bun?.TOML
  if (!toml) throw new Error('Bun.TOML is unavailable in this runtime')
  return toml.parse(content)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an asp-targets.toml document; throws FixtureTargetsError. */
export function parseFixtureTargetsToml(content: string, filePath: string): FixtureProjectManifest {
  let parsed: unknown
  try {
    parsed = parseToml(content)
  } catch (error) {
    throw new FixtureTargetsError(
      `Invalid asp-targets.toml ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isPlainObject(parsed)) {
    throw new FixtureTargetsError(`Invalid asp-targets.toml ${filePath}: document must be a table`)
  }
  const manifest: FixtureProjectManifest = { targets: {} }
  if (parsed['agents-root'] !== undefined) {
    if (typeof parsed['agents-root'] !== 'string') {
      throw new FixtureTargetsError(
        `Invalid asp-targets.toml ${filePath}: agents-root must be a string`
      )
    }
    manifest.agentsRoot = parsed['agents-root']
  }
  const targets = parsed['targets']
  if (targets !== undefined) {
    if (!isPlainObject(targets)) {
      throw new FixtureTargetsError(`Invalid asp-targets.toml ${filePath}: targets must be a table`)
    }
    for (const [name, raw] of Object.entries(targets)) {
      if (!isPlainObject(raw)) {
        throw new FixtureTargetsError(
          `Invalid asp-targets.toml ${filePath}: /targets/${name} must be a table`
        )
      }
      if (raw['priming'] !== undefined && raw['priming_append'] !== undefined) {
        throw new FixtureTargetsError(
          `Invalid asp-targets.toml ${filePath}: /targets/${name} cannot set both priming and priming_append`
        )
      }
      const target: FixtureProjectTarget = {}
      if (raw['provisioning'] !== undefined) {
        if (!isPlainObject(raw['provisioning'])) {
          throw new FixtureTargetsError(
            `Invalid asp-targets.toml ${filePath}: /targets/${name}/provisioning must be a table`
          )
        }
        target.provisioning = raw['provisioning']
      }
      if (raw['priming'] !== undefined) target.priming = raw['priming'] as string
      if (raw['priming_append'] !== undefined)
        target.priming_append = raw['priming_append'] as string
      if (typeof raw['description'] === 'string') target.description = raw['description']
      manifest.targets[name] = target
    }
  }
  return manifest
}
