import { resolveIngestSocketPath } from 'hrc-core'
import { drainEventDatabase } from 'hrc-server'

export async function cmdEventsDrain(options: {
  dbPath: string
  sourceRef: string
  json?: boolean
}): Promise<void> {
  const result = await drainEventDatabase({
    dbPath: options.dbPath,
    sourceRef: options.sourceRef,
    socketPath: resolveIngestSocketPath(),
  })
  const output = {
    sourceRef: options.sourceRef,
    databasePath: options.dbPath,
    forwarded: result.forwarded,
    cursors: result.cursors,
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return
  }
  process.stdout.write(
    `drained ${result.forwarded} event(s) from ${options.dbPath} as ${options.sourceRef}\n` +
      `  hrc_events cursor ${result.cursors.hrcEvents}\n` +
      `  broker_invocation_events cursor ${result.cursors.brokerInvocationEvents}\n`
  )
}
