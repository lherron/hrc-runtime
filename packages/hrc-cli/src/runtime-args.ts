export { hasFlag } from './cli/argv.js'

/**
 * Hard-exit fatal for the daemon/launchctl paths in `cli-runtime.ts`, where a
 * direct `process.exit(1)` is the correct failure mode. Named distinctly from
 * the throwing `fatal` in `cli/shared.ts` (which reaches the commander error
 * handler) so the two divergent control-flow semantics never get swapped by an
 * import edit.
 */
export function fatalExit(message: string): never {
  process.stderr.write(`hrc: ${message}\n`)
  process.exit(1)
}
