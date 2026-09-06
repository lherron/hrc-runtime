import { realpathSync } from 'node:fs'

import { resolveDatabasePath, resolveIngestSocketPath } from 'hrc-core'
import { drainEventDatabase } from 'hrc-server'

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

export async function cmdEventsDrain(options: {
  dbPath: string
  sourceRef: string
  json?: boolean
}): Promise<void> {
  // Drain reads a DEAD container ledger, so it must migrate the path it is
  // given in order to read it at all. Pointed at the live store it would be the
  // T-08118 hazard with a bigger hammer: refuse that one path by name.
  if (sameFile(options.dbPath, resolveDatabasePath())) {
    throw new Error(
      `refusing to drain the live HRC store (${options.dbPath}); drain reads dead container ledgers, and opening the live store here would apply this release's migrations under the running daemon`
    )
  }
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
