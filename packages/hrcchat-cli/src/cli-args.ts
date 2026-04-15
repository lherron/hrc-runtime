export function fatal(message: string): never {
  process.stderr.write(`hrcchat: ${message}\n`)
  process.exit(1)
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

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

export function parseIntegerFlag(
  args: string[],
  flag: string,
  options: { defaultValue: number; min?: number | undefined }
): number {
  const raw = parseFlag(args, flag)
  if (raw === undefined) return options.defaultValue
  const value = Number.parseInt(raw, 10)
  const min = options.min ?? 0
  if (!Number.isFinite(value) || value < min) {
    fatal(`${flag} must be an integer >= ${min}`)
  }
  return value
}

/**
 * Consume the body argument: either positional, stdin (-), or --file.
 */
export function consumeBody(args: string[], startIndex: number): string | undefined {
  const filePath = parseFlag(args, '--file')
  if (filePath) {
    const { readFileSync } = require('node:fs')
    return readFileSync(filePath, 'utf8')
  }

  const positional = args[startIndex]
  if (positional === '-') {
    // Read from stdin
    const { readFileSync } = require('node:fs')
    return readFileSync('/dev/stdin', 'utf8')
  }

  return positional
}

/**
 * Parse a duration string like "5m", "30s", "1h" into milliseconds.
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(ms|s|m|h)$/)
  if (!match || !match[1] || !match[2]) {
    fatal(`invalid duration: ${input} (expected e.g. 30s, 5m, 1h)`)
  }
  const value = Number.parseInt(match[1], 10)
  switch (match[2]) {
    case 'ms':
      return value
    case 's':
      return value * 1000
    case 'm':
      return value * 60_000
    case 'h':
      return value * 3_600_000
    default:
      fatal(`unknown duration unit: ${match[2]}`)
  }
}
