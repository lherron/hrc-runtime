export function fatal(message: string): never {
  process.stderr.write(`hrc: ${message}\n`)
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
  options: {
    defaultValue: number
    min?: number | undefined
  }
): number {
  const raw = parseFlag(args, flag)
  if (raw === undefined) {
    return options.defaultValue
  }

  const value = Number.parseInt(raw, 10)
  const min = options.min ?? 0
  if (!Number.isFinite(value) || value < min) {
    fatal(`${flag} must be an integer >= ${min}`)
  }
  return value
}
