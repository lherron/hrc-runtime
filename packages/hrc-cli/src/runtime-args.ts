export function fatal(message: string): never {
  process.stderr.write(`hrc: ${message}\n`)
  process.exit(1)
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}
