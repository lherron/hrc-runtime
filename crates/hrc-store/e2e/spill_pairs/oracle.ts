import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [release, root, mode] = process.argv.slice(2)
const scratch = realpathSync(root)
if (!/^\/(private\/)?tmp\/hrcp1-pairs-/.test(scratch)) throw Error('scratch required')
const { openHrcDatabase } = await import(
  pathToFileURL(join(release, 'packages/hrc-store-sqlite/src/index.ts')).href
)
const db = openHrcDatabase(join(scratch, 'state.sqlite'), { migrate: false })
try {
  if (mode === 'historical') {
    const result = db.brokerInvocationEvents.appendEvent({
      invocationId: 'p1-json',
      seq: 2,
      time: '2026-10-23T00:00:00.000Z',
      type: 'tool.call.completed',
      runtimeId: 'p1-runtime',
      payload: { toolCallId: 'p1-tool', result: `X${'🫠'.repeat(20000)}` },
    })
    console.log(JSON.stringify(result))
  } else if (mode === 'write') {
    const emoji = '🫠'.repeat(20000)
    const loneHead = Array(35000).fill(97)
    loneHead[4095] = 0xd800
    const loneTail = Array(36024).fill(97)
    loneTail[35000] = 0xdc00
    const bodies = [
      `X${emoji}`,
      `${emoji}Z`,
      `X${emoji}Z`,
      emoji,
      String.fromCharCode(...loneHead),
      String.fromCharCode(...loneTail),
    ]
    for (const [i, result] of bodies.entries()) {
      const input = {
        invocationId: 'p1-pairs',
        seq: i + 1,
        time: '2026-10-23T00:00:00.000Z',
        type: 'tool.call.completed',
        runtimeId: 'p1-runtime',
        payload: { toolCallId: `pair-${i}`, result },
      }
      db.brokerInvocationEvents.appendEvent(input)
      if (!db.brokerInvocationEvents.appendEvent(input).idempotent) throw Error('repeat failed')
    }
  }
  if (mode !== 'historical')
    console.log(
      JSON.stringify({ events: db.brokerInvocationEvents.listByInvocationId('p1-pairs') })
    )
} finally {
  db.close()
}
