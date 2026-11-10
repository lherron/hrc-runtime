import { listVerificationCandidates } from 'hrc-capture-verifier'
import { openSqliteCaptureVerificationStore } from 'hrc-capture-verifier/sqlite'
import { hasFlag, requireArg } from '../cli/argv.js'
import { printJson } from '../print.js'
import { renderCandidatesHuman } from './report.js'

export async function cmdBrokerVerifyCandidates(args: string[]): Promise<void> {
  const scopeRef = requireArg(args, 0, 'scope-ref')
  const json = hasFlag(args, '--json')
  const { store, close } = openSqliteCaptureVerificationStore()
  try {
    const candidates = await listVerificationCandidates({ store, scopeRef })
    if (json) {
      printJson({ scopeRef, candidates })
      return
    }
    process.stdout.write(renderCandidatesHuman(scopeRef, candidates))
  } finally {
    close()
  }
}
