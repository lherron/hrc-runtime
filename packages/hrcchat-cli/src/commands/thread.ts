import { CliUsageError } from 'cli-kit'
import type {
  HrcCollectiveMessageRecord,
  HrcMessageHistoryStatus,
  ListMessagesResponse,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { formatAddress } from '../normalize.js'
import { printJson } from '../print.js'
import { resolveMessageSelector } from './message-selector.js'

export type ThreadOptions = {
  json?: boolean | undefined
}

export type ThreadOutput = {
  readonly schema: 1
  readonly anchor: {
    readonly input: string
    readonly messageId: string
    readonly messageSeq: number
    readonly collectiveSeq?: number | undefined
  }
  readonly rootMessageId: string
  readonly ordering: 'reply-topological-asc'
  readonly count: number
  readonly history?: HrcMessageHistoryStatus | undefined
  readonly messages: HrcCollectiveMessageRecord[]
}

function writeHistoryWarning(history: HrcMessageHistoryStatus | undefined): void {
  if (history === undefined || history.complete) return
  process.stderr.write(
    `hrcchat: history incomplete (${history.degraded?.code ?? 'collective_lagging'}): ${
      history.degraded?.message ?? 'collective history has not caught up'
    }\n`
  )
}

function renderMessage(record: HrcCollectiveMessageRecord): void {
  const seq =
    record.collectiveSeq === undefined
      ? `#${record.messageSeq}`
      : `@${record.collectiveSeq}/#${record.messageSeq}`
  const phase =
    record.phase === 'response' ? 'response' : record.phase === 'oneway' ? 'oneway' : 'request'
  process.stdout.write(
    `${seq} ${record.createdAt} ${formatAddress(record.from)} → ${formatAddress(record.to)} ` +
      `${phase} [${record.messageId}]\n`
  )
  process.stdout.write(record.body)
  if (!record.body.endsWith('\n')) process.stdout.write('\n')
}

function threadOutput(
  input: string,
  anchor: HrcCollectiveMessageRecord,
  result: ListMessagesResponse
): ThreadOutput {
  return {
    schema: 1,
    anchor: {
      input,
      messageId: anchor.messageId,
      messageSeq: anchor.messageSeq,
      ...(anchor.collectiveSeq === undefined ? {} : { collectiveSeq: anchor.collectiveSeq }),
    },
    rootMessageId: anchor.rootMessageId,
    ordering: 'reply-topological-asc',
    count: result.messages.length,
    ...(result.history === undefined ? {} : { history: result.history }),
    messages: result.messages,
  }
}

export async function cmdThread(
  client: HrcClient,
  opts: ThreadOptions,
  positionals: string[]
): Promise<void> {
  const input = positionals[0]
  if (input === undefined) throw new CliUsageError('thread requires <seq-or-id>')

  const { record: anchor } = await resolveMessageSelector(client, input)
  const result = await client.listMessages({
    thread: { rootMessageId: anchor.rootMessageId },
    order: 'asc',
  })
  const output = threadOutput(input, anchor, result)

  if (opts.json) {
    printJson(output)
    return
  }

  writeHistoryWarning(result.history)
  process.stdout.write(
    `Thread ${output.rootMessageId} — ${output.count} message${output.count === 1 ? '' : 's'}\n\n`
  )
  for (const [index, message] of output.messages.entries()) {
    if (index > 0) process.stdout.write('\n')
    renderMessage(message)
  }
}
