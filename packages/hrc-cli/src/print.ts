/**
 * Shared output helpers for hrc-cli commands.
 *
 * Lives outside cli.ts so future command modules can import without triggering
 * commander dispatch, which only runs under import.meta.main.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
