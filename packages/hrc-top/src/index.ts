import { HrcClient, discoverSocket } from 'hrc-sdk'
import { buildReadModel, loadReadModel } from './read-model.js'
import type { HrcTopReadModel, HrcTopScope } from './read-model.js'

export type HrcTopOptions = HrcTopScope & {
  client?: Pick<HrcClient, 'listTargets'> | undefined
  socketPath?: string | undefined
  output?: NodeJS.WritableStream | undefined
}

export { buildReadModel, loadReadModel }
export type {
  HrcTopHeaderCounts,
  HrcTopLastActivity,
  HrcTopReadModel,
  HrcTopRow,
} from './read-model.js'

function renderReadModel(model: HrcTopReadModel): string {
  const lines = [`HRC TOP  ${model.counts.live} live  ${model.counts.dormant} dormant`]
  lines.push('target\tstate\tlast\truntime')
  for (const row of model.rows) {
    const runtime = row.runtime ? row.runtime.runtimeId : ''
    const last = row.last.at ?? 'unknown'
    lines.push(`${row.sessionRef}\t${row.state}\t${last}\t${runtime}`)
  }
  return `${lines.join('\n')}\n`
}

export async function runHrcTop(options: HrcTopOptions = {}): Promise<void> {
  const client = options.client ?? new HrcClient(options.socketPath ?? discoverSocket())
  const model = await loadReadModel(client, options)
  const output = options.output ?? process.stdout
  output.write(renderReadModel(model))
}
