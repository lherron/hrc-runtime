import type { CaptureVerificationReport, CaptureVerificationStore } from 'hrc-capture-verifier'
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

/**
 * Seam for command-level tests: lets a seeded sqlite store and an output sink be
 * injected without touching the real default DB or process stdout. Production
 * callers omit `deps` and get the real store + stdout.
 */
export type BrokerVerifyRunDeps = {
  openStore?: () => { store: CaptureVerificationStore; close(): void }
  emit?: (report: CaptureVerificationReport, json: boolean) => void
}

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

export async function cmdBrokerVerifyRun(
  args: string[],
  deps: BrokerVerifyRunDeps = {}
): Promise<void> {
  const invocationId = parseFlag(args, '--invocation')
  if (!invocationId) fatal('--invocation is required')
  const jsonl = parseFlag(args, '--jsonl')
  const strictText = hasFlag(args, '--strict-text')
  const json = hasFlag(args, '--json')

  const openStore = deps.openStore ?? openSqliteCaptureVerificationStore
  const emit =
    deps.emit ??
    ((report: CaptureVerificationReport, asJson: boolean): void => {
      if (asJson) {
        printJson(report)
      } else {
        process.stdout.write(renderReportHuman(report))
      }
    })

  const { store, close } = openStore()
  try {
    const transcript =
      jsonl !== undefined ? await parseProviderTranscript({ path: jsonl }) : undefined
    const report = await verifyInvocation({ store, invocationId, transcript, strictText })
    emit(report, json)
    if (!report.ok) {
      throw new CliStatusExit(1)
    }
  } finally {
    close()
  }
}
