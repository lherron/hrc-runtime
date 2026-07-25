import { CliUsageError } from 'cli-kit'
import type { HrcMessageExecution, TraceMessageResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { printJson } from '../print.js'
import { resolveMessageId } from './message-selector.js'

export type TraceOptions = {
  json?: boolean | undefined
}

function executionFields(execution: HrcMessageExecution): string {
  return [
    `execution=${execution.state}`,
    execution.runtimeId === undefined ? undefined : `runtime=${execution.runtimeId}`,
    execution.runId === undefined ? undefined : `run=${execution.runId}`,
    execution.transport === undefined ? undefined : `transport=${execution.transport}`,
    execution.errorCode === undefined ? undefined : `error=${execution.errorCode}`,
  ]
    .filter((field): field is string => field !== undefined)
    .join(' ')
}

export function renderMessageTrace(trace: TraceMessageResponse): string {
  const observations = trace.message.collectiveHistory?.observations ?? []
  const origin = observations.find((observation) => observation.role === 'origin')
  const lines = [
    `message ${trace.message.messageId} phase=${trace.message.phase} root=${trace.message.rootMessageId}`,
    `origin ${origin?.nodeId ?? trace.localNodeId} #${origin?.messageSeq ?? trace.message.messageSeq} ${executionFields(origin?.execution ?? trace.message.execution)}`,
  ]

  if (trace.outbox !== undefined) {
    const expected =
      trace.outbox.stage === 'delivering' ? trace.outbox.envelope.expected : undefined
    lines.push(
      [
        `outbox ${trace.outbox.state}`,
        `peer=${trace.outbox.peerNodeId}`,
        `attempts=${trace.outbox.totalAttempts}`,
        expected === undefined ? undefined : `home=${expected.homeNodeId}`,
        expected === undefined ? undefined : `epoch=${expected.placementEpoch}`,
        trace.outbox.lastErrorCode === undefined
          ? undefined
          : `lastError=${trace.outbox.lastErrorCode}`,
      ]
        .filter((field): field is string => field !== undefined)
        .join(' ')
    )
  }

  if (trace.acceptance !== undefined) {
    lines.push(
      `ack ${trace.acceptance.outcome ?? 'acknowledged'} by=${trace.acceptance.acceptedByNodeId} destinationMessageId=${trace.message.messageId}`
    )
  }

  if (trace.destination !== undefined) {
    lines.push(
      [
        `destination ${trace.destination.nodeId} #${trace.destination.messageSeq}`,
        trace.destination.delivery === undefined
          ? 'delivery=pending'
          : `delivery=${trace.destination.delivery.outcome}`,
        trace.destination.delivery?.outcome === 'store_only'
          ? `reason=${trace.destination.delivery.reason}`
          : undefined,
        executionFields(trace.destination.execution),
      ]
        .filter((field): field is string => field !== undefined)
        .join(' ')
    )
  }

  lines.push(
    `history authority=${trace.history.authorityNodeId} complete=${String(trace.history.complete)} pending=${trace.history.pendingReplicationCount}`
  )
  lines.push(`verdict ${trace.verdict.summary}`)
  return `${lines.join('\n')}\n`
}

export async function cmdTrace(
  client: HrcClient,
  opts: TraceOptions,
  positionals: string[]
): Promise<void> {
  const seqOrId = positionals[0]
  if (!seqOrId) throw new CliUsageError('trace requires <seq-or-id>')
  const { messageId } = await resolveMessageId(client, seqOrId)
  const trace = await client.traceMessage({ messageId })
  if (opts.json) {
    printJson(trace)
    return
  }
  process.stdout.write(renderMessageTrace(trace))
}
