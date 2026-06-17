import { printJson } from '../print.js'
import { CliStatusExit, fatal } from '../cli/shared.js'
import { hasFlag, parseFlag, requireArg } from '../cli/argv.js'
import { readProviderJsonl } from './adapters.js'
import { verifyInvocation } from './comparator.js'
import { renderCandidatesHuman, renderReportHuman } from './report.js'
import { BrokerVerifyStore } from './store.js'

export async function cmdBrokerVerifyCandidates(args: string[]): Promise<void> {
  const scopeRef = requireArg(args, 0, 'scope-ref')
  const json = hasFlag(args, '--json')
  const store = new BrokerVerifyStore()
  try {
    const candidates = store.listCandidates(scopeRef)
    if (json) {
      printJson({ scopeRef, candidates })
      return
    }
    process.stdout.write(renderCandidatesHuman(scopeRef, candidates))
  } finally {
    store.close()
  }
}

export async function cmdBrokerVerifyRun(args: string[]): Promise<void> {
  const invocationId = parseFlag(args, '--invocation')
  if (!invocationId) fatal('--invocation is required')
  const jsonl = parseFlag(args, '--jsonl')
  const strictText = hasFlag(args, '--strict-text')
  const json = hasFlag(args, '--json')

  const store = new BrokerVerifyStore()
  try {
    const invocation = store.getInvocation(invocationId)
    if (invocation === undefined) {
      fatal(`broker invocation not found: ${invocationId}`)
    }
    const events = store.listBrokerEvents(invocationId)
    const transcript = jsonl !== undefined ? await readProviderJsonl(jsonl) : undefined
    const report = verifyInvocation({ store, invocation, events, transcript, strictText })
    if (json) {
      printJson(report)
    } else {
      process.stdout.write(renderReportHuman(report))
    }
    if (!report.ok) {
      throw new CliStatusExit(1)
    }
  } finally {
    store.close()
  }
}
