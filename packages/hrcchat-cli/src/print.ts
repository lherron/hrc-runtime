/**
 * Shared output helpers for hrcchat-cli commands.
 *
 * Lives outside main.ts so command modules can import without triggering
 * the commander dispatch (which only runs under import.meta.main).
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
