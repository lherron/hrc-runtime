#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { installCliMetricsRecorder } from 'hrc-core'

import { runProgram } from './cli/program.js'

// -- .env.local loading -------------------------------------------------------

/**
 * Apply a single .env.local file into process.env.
 * Existing env vars are NOT overwritten (env takes precedence).
 */
function applyDotEnvFile(envPath: string): void {
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return // no file here — nothing to do
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

/**
 * Walk up from cwd applying each .env.local found, stopping at — and
 * including — the nearest git root. Nearer files win (visited first; a key is
 * only set while still unset) and real environment variables win over all
 * files. This lets the CLI invoked from a subdir (e.g. var/agents/cody)
 * inherit ASP_PROJECT from a parent .env.local at the git root
 * (var/agents/.env.local). The `.git` probe uses existsSync so worktree agent
 * dirs (where .git is a file, not a directory) are recognized too.
 */
function loadDotEnvLocal(): void {
  let dir = process.cwd()
  while (true) {
    applyDotEnvFile(join(dir, '.env.local'))
    if (existsSync(join(dir, '.git'))) break // nearest git root — boundary
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root — no git root found
    dir = parent
  }
}

loadDotEnvLocal()

// -- public surface re-exports ------------------------------------------------
// The CLI was decomposed into ./cli/* modules (big-file refactor). These
// re-exports preserve the historical import surface of this entrypoint so no
// other file in the repo needs an import change.

export {
  chooseDefaultProjectId,
  harnessStringToHarnessId,
  resolveAgentHarness,
} from './cli/scope.js'
export {
  attachWithRetry,
  selectLatestUsableRuntime,
} from './cli/runtime-select.js'
export { explainScopeCommandError } from './cli/errors.js'
export { main } from './cli/program.js'

// WHY exported: bin/hrc.js invokes this. `import.meta.main` is false when this
// module is imported from the bin wrapper, so the guard below cannot be the only
// entry — and calling `main` directly would skip the metrics recorder.
export async function runCli(): Promise<void> {
  const metrics = installCliMetricsRecorder({ bin: 'hrc', argv: process.argv })
  await runProgram(process.argv, metrics.setCommandTree)
}

if (import.meta.main) {
  await runCli()
}
