import {
  listVerificationCandidates,
  parseProviderTranscript,
  verifyInvocation,
} from 'hrc-capture-verifier'
import { openSqliteCaptureVerificationStore } from 'hrc-capture-verifier/sqlite'
import { hasFlag, parseFlag, requireArg } from '../cli/argv.js'
import { CliStatusExit, fatal } from '../cli/shared.js'
import { printJson } from '../print.js'
import { renderCandidatesHuman, renderReportHuman } from './report.js'

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

export async function cmdBrokerVerifyRun(args: string[]): Promise<void> {
  const invocationId = parseFlag(args, '--invocation')
  if (!invocationId) fatal('--invocation is required')
  const jsonl = parseFlag(args, '--jsonl')
  const strictText = hasFlag(args, '--strict-text')
  const json = hasFlag(args, '--json')

  const { store, close } = openSqliteCaptureVerificationStore()
  try {
    const transcript =
      jsonl !== undefined ? await parseProviderTranscript({ path: jsonl }) : undefined
    const report = await verifyInvocation({ store, invocationId, transcript, strictText })
    if (json) {
      printJson(report)
    } else {
      process.stdout.write(renderReportHuman(report))
    }
    if (!report.ok) {
      throw new CliStatusExit(1)
    }
  } finally {
    close()
  }
}
