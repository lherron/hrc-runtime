#!/usr/bin/env bun
import { installCliMetricsRecorder } from 'hrc-core'
import { loadDotEnvLocal } from 'hrc-sdk'

import { runProgram } from './cli/program.js'

// Shared context-only .env.local loader (hrc-sdk): walks up to the nearest
// git root, real env wins, credential-class keys are refused with a warning.
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
