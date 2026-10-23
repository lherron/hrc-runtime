import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [release, root, mode] = process.argv.slice(2)
const scratch = realpathSync(root)
if (!/^\/(private\/)?tmp\/hrcp1-depth-/.test(scratch)) throw Error('scratch required')
const { openHrcDatabase } = await import(
  pathToFileURL(join(release, 'packages/hrc-store-sqlite/src/index.ts')).href
)
const db = openHrcDatabase(join(scratch, 'state.sqlite'), { migrate: false })
try {
  if (mode === 'write') {
    for (const [i, depth] of [128, 129, 256, 512].entries()) {
      const input = {
        invocationId: 'p1-depth',
        seq: i + 1,
        time: '2026-10-23T00:00:00.000Z',
        type: 'input.accepted',
        runtimeId: 'p1-runtime',
        payload: JSON.parse(`${'{"x":'.repeat(depth)}0${'}'.repeat(depth)}`),
      }
      db.brokerInvocationEvents.appendEvent(input)
      if (!db.brokerInvocationEvents.appendEvent(input).idempotent) throw Error('repeat failed')
    }
  }
  console.log(JSON.stringify({ events: db.brokerInvocationEvents.listByInvocationId('p1-depth') }))
} finally {
  db.close()
}
