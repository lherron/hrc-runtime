import { CliUsageError } from 'cli-kit'

/**
 * Match a `--name value` or `--name=value` string flag. Returns the parsed
 * value plus the index to resume from (so the caller advances past a consumed
 * positional value), or undefined when `arg` is not this flag.
 */
export function matchStringFlag(
  arg: string,
  name: string,
  args: string[],
  index: number
): { value: string; next: number } | undefined {
  if (arg === name) {
    const val = args[index + 1]
    if (val === undefined) throw new CliUsageError(`${name} requires a value`)
    return { value: val, next: index + 1 }
  }
  const prefix = `${name}=`
  if (arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length), next: index }
  }
  return undefined
}

export function parsePositiveInteger(flagName: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CliUsageError(`${flagName} must be a positive integer`)
  }
  return parsed
}

export function parseNonNegativeInteger(flagName: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliUsageError(`${flagName} must be a non-negative integer`)
  }
  return parsed
}
