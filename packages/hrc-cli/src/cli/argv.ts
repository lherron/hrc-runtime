import { parseIntegerValue } from 'cli-kit'
import type { Command } from 'commander'

import { fatal } from './shared.js'

export function requireArg(args: string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined) {
    fatal(`missing required argument: ${name}`)
  }
  return value
}

export function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === flag) {
      const value = args[i + 1]
      if (value === undefined) {
        fatal(`${flag} requires a value`)
      }
      return value
    }
    if (arg?.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1)
    }
  }
  return undefined
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Split a comma-separated list value into trimmed, non-empty entries (e.g.
 * `--status busy, dead ` → `['busy', 'dead']`). Shared by the runtime
 * list/sweep `--status` filters and the monitor `--kind`/`--tool` filters.
 */
export function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function parseIntegerFlag(
  args: string[],
  flag: string,
  options: {
    defaultValue: number
    min?: number | undefined
  }
): number {
  const raw = parseFlag(args, flag)
  if (raw === undefined) {
    return options.defaultValue
  }

  return parseIntegerValue(flag, raw, { min: options.min ?? 0 })
}

/**
 * Parse the optional `--expected-generation` flag shared by the bridge
 * handlers. Returns `undefined` when the flag is absent and fatals with the
 * canonical message when present but not a non-negative integer.
 */
export function parseExpectedGeneration(args: string[]): number | undefined {
  const raw = parseFlag(args, '--expected-generation')
  if (raw === undefined) {
    return undefined
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) {
    fatal('--expected-generation must be a non-negative integer')
  }
  return value
}

/**
 * Parse and validate the optional `--transport` flag shared by the runtime
 * list/sweep handlers. Returns `undefined` when absent and fatals with the
 * canonical message when present but not an allowed transport.
 */
export function parseTransportFlag(args: string[]): 'tmux' | 'headless' | 'sdk' | undefined {
  const transport = parseFlag(args, '--transport')
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    fatal('--transport must be one of: tmux, headless, sdk')
  }
  return transport
}

/**
 * Parse and validate the optional `--provider` flag (defaulting to
 * `anthropic`). Fatals with the canonical message when present but not an
 * allowed provider.
 */
export function parseProviderFlag(args: string[]): 'anthropic' | 'openai' {
  const provider = parseFlag(args, '--provider') ?? 'anthropic'
  if (provider !== 'anthropic' && provider !== 'openai') {
    fatal('--provider must be one of: anthropic, openai')
  }
  return provider
}

/**
 * Recover the raw argv slice for a commander action's verb.
 *
 * Commander does not expose the unparsed argv on a subcommand, so we walk up to
 * the root command, read its `rawArgs` (falling back to `process.argv`), and
 * slice from the verb onward. Scoping the scan to the active command path's raw
 * argv avoids surprise matches from global flags.
 *
 * @param cmd      The commander command passed to the action handler.
 * @param verb     The verb token to locate in the raw argv.
 * @param options  `offset` is added to the verb index before slicing (e.g. `1`
 *                 to drop the verb itself). `fallback` is returned when the verb
 *                 is not found; defaults to the full raw argv.
 */
export function rawArgvForVerb(
  cmd: Command,
  verb: string,
  options: { offset?: number; fallback?: string[] } = {}
): string[] {
  let root: Command = cmd
  while (root.parent) root = root.parent
  const fullRaw: string[] = (root as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv
  const idx = fullRaw.indexOf(verb)
  if (idx < 0) {
    return options.fallback ?? fullRaw
  }
  return fullRaw.slice(idx + (options.offset ?? 0))
}

// -- toLegacyArgv (transitional glue for commander → legacy handler bridge) ---

export type LegacyArgvSchema = {
  strings: string[]
  booleans: string[]
  negatedBooleans?: string[]
}

/**
 * Build a legacy-style `string[]` argv from commander-parsed positionals and
 * opts, so existing `(args: string[]): Promise<void>` handlers can be called
 * unchanged.
 *
 * Positionals come BEFORE flags in the emitted array (preserves the
 * runtimeId / hostSessionId positional contract that other groups rely on).
 *
 * `negatedBooleans` are detected from the raw `argv` slice (NOT from `opts`)
 * because commander's auto-negation collapses `--flag` and `--no-flag` into
 * the same attribute, destroying mutual-exclusion checks.
 *
 * @param positionals  Positional arguments forwarded verbatim.
 * @param opts         Parsed options from `cmd.opts()`.
 * @param schema       Declares which flags to emit and how.
 * @param rawArgv      The raw argv slice for the active command (used only for
 *                     negatedBooleans detection). Falls back to `process.argv`.
 */
export function toLegacyArgv(
  positionals: string[],
  opts: Record<string, unknown>,
  schema: LegacyArgvSchema,
  rawArgv?: string[]
): string[] {
  const out: string[] = [...positionals]

  // String flags: --flag value
  for (const flag of schema.strings) {
    const key = camelCase(flag)
    const value = opts[key]
    if (value !== undefined && value !== null) {
      out.push(`--${flag}`, String(value))
    }
  }

  // Boolean flags: --flag (emit only when truthy)
  for (const flag of schema.booleans) {
    const key = camelCase(flag)
    if (opts[key]) {
      out.push(`--${flag}`)
    }
  }

  // Negated booleans: detect from raw argv, not from opts.
  // Commander's auto-negation collapses --X and --no-X into one attribute,
  // so we scan the raw argv slice to preserve mutual-exclusion semantics.
  // Both the positive and negated forms are emitted when present in rawArgv,
  // enabling handlers to enforce mutual-exclusion checks.
  if (schema.negatedBooleans && schema.negatedBooleans.length > 0) {
    const argv = rawArgv ?? process.argv
    for (const flag of schema.negatedBooleans) {
      if (argv.includes(`--${flag}`)) {
        out.push(`--${flag}`)
      }
      if (argv.includes(`--no-${flag}`)) {
        out.push(`--no-${flag}`)
      }
    }
  }

  return out
}

/** Convert a kebab-case flag name to camelCase (e.g. "timeout-ms" → "timeoutMs"). */
export function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Build legacy argv for "scope commands" (start, run) that accept a
 * positional prompt and short flags like `-p`.
 *
 * These commands use `parseScopePrompt` which handles `-p <text>`,
 * `--prompt-file <path>`, and positional prompt text.  Commander
 * consumes declared options from `cmd.args`, so we must reconstruct
 * the complete legacy argv from both parsed positionals and opts,
 * while preserving `-p` (single-dash short flag) rather than `--p`.
 */
export function toLegacyArgvForScopeCommand(
  positionals: string[],
  opts: Record<string, unknown>,
  rawArgv: string[],
  schema: LegacyArgvSchema
): string[] {
  // Reuse the shared string/boolean/negated-boolean encoding, then append the
  // scope-only `-p <text>` short flag. `toLegacyArgv` falls back to
  // `process.argv` only when rawArgv is undefined; here it is always defined,
  // so the negated-boolean scan is identical to the previous inline copy.
  const out = toLegacyArgv(positionals, opts, schema, rawArgv)

  // Short option: -p <text> (must emit as -p, NOT --p)
  if (opts['p'] !== undefined && opts['p'] !== null) {
    out.push('-p', String(opts['p']))
  }

  return out
}
