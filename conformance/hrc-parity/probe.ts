/** External installed SDK/store probe. Never imports daemon/controller code. */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [releaseRoot, scratchRoot, socketPath, mode, hostSessionId, scopeRef, runtimeId] =
  process.argv.slice(2)
if (!releaseRoot || !scratchRoot || !socketPath || !mode)
  throw new Error('explicit release, scratch, socket and mode required')
const root = realpathSync(scratchRoot)
if (!root.startsWith('/private/tmp/hrcp0-') && !root.startsWith('/tmp/hrcp0-'))
  throw new Error('scratch root must be an admitted P0 root')
if (!realpathSync(join(root, 'run')).startsWith(root) || !socketPath.startsWith(`${scratchRoot}/`))
  throw new Error('socket outside scratch root')
if (mode === 'health') {
  const { HrcClient } = await import(
    pathToFileURL(join(releaseRoot, 'packages/hrc-sdk/src/index.ts')).href
  )
  const client = new HrcClient(socketPath)
  process.stdout.write(`${JSON.stringify(await client.getHealth())}\n`)
} else if (mode === 'seed') {
  if (
    !runtimeId ||
    !hostSessionId ||
    !scopeRef?.startsWith('agent:tabularasa:project:hrc-runtime:task:p0-')
  )
    throw new Error('fixture requires actual scratch host/scope')
  const { openHrcDatabase, createPlacementLedgerRepository } = await import(
    pathToFileURL(join(releaseRoot, 'packages/hrc-store-sqlite/src/index.ts')).href
  )
  const db = openHrcDatabase(join(root, 'state/state.sqlite'), { migrate: false })
  try {
    // This lazy canonical extension is not created by explicit-local startup.
    // Exercise its public constructor in deliberate scratch setup, before the
    // schema observation. Never hand-write its DDL or rows.
    const placementRows = createPlacementLedgerRepository(db.sqlite).list().length
    const base = {
      ts: new Date().toISOString(),
      hostSessionId,
      runtimeId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.tool_result',
      transport: 'tmux',
      payload: {
        type: 'tool_execution_end',
        toolUseId: 'p0-fixture',
        toolName: 'P0Fixture',
        result: { content: [{ type: 'text', text: 'fixture, not model execution' }] },
        isError: false,
      },
    }
    const a = db.hrcEvents.append(base)
    const hole = db.hrcEvents.append(base)
    const spill = db.hrcEvents.append({
      ...base,
      payload: {
        ...base.payload,
        result: { content: [{ type: 'text', text: 'x'.repeat(512 * 1024) }] },
      },
    })
    const highest = db.hrcEvents.append(base)
    db.sqlite
      .query('DELETE FROM hrc_events WHERE hrc_seq IN (?, ?)')
      .run(hole.hrcSeq, highest.hrcSeq)
    process.stdout.write(
      `${JSON.stringify({ fixtureOnly: true, canonicalLazySetup: 'placement_ledger', placementRows, first: a.hrcSeq, deleted: [hole.hrcSeq, highest.hrcSeq], spill: spill.hrcSeq })}\n`
    )
  } finally {
    db.close()
  }
} else throw new Error('unknown external probe mode')
