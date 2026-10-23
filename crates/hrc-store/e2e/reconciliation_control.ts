const [release, root] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const at = '2026-10-23T01:00:00.000Z'
async function query(file, functionName, marker) {
  const source = await Bun.file(`${release}/packages/hrc-server/src/${file}`).text()
  const start = source.indexOf(functionName)
  if (start < 0) throw Error('missing source function')
  const index = source.indexOf(marker, start)
  if (index < 0) throw Error('missing source predicate')
  const left = source.lastIndexOf(String.fromCharCode(96), index)
  const right = source.indexOf(String.fromCharCode(96), index)
  const sql = source.slice(left + 1, right)
  if (sql.includes('$' + '{')) throw Error('unresolved source interpolation')
  return { sql, file, functionName, marker }
}
const source = {
  aging: await query(
    'sweep-handlers.ts',
    'export function transitionRuntimeForAging',
    'UPDATE runtimes'
  ),
  orphan: await query('sweep-reconcile-active.ts', 'function finalizeAbandonedRun', 'UPDATE runs'),
  finalize: await query('sweep-reconcile-active.ts', 'function finalizeActiveRun', 'UPDATE runs'),
  reap: await query('sweep-reconcile-active.ts', 'function reapActiveRun', 'UPDATE runs'),
  zombie: await query('sweep-reconcile-zombie.ts', 'async function zombieRun', 'UPDATE runs'),
  release: await query(
    'sweep-reconcile-active.ts',
    'function finalizeActiveRun',
    'UPDATE runtimes'
  ),
}
const cases = JSON.parse(await Bun.file(`${root}/cases.json`).text())
const results = []
try {
  for (const item of cases) {
    const id = item.id
    const runtime = `${id}-runtime`
    const run = `${id}-run`
    let values: (string | number | null)[] = []
    if (item.family === 'aging') {
      const invocation =
        item.variant === 'invocationSkip'
          ? null
          : item.variant === 'invocationMissing'
            ? 'missing'
            : 'p1-process'
      values = [
        'stale',
        at,
        at,
        runtime,
        'ready',
        null,
        null,
        null,
        '2026-10-23T00:00:00.000Z',
        '{"v":1}',
        invocation,
        invocation,
        item.variant === 'pidWrong' ? 101 : 100,
        item.variant === 'childWrong' ? 201 : 200,
      ]
    } else if (item.family === 'orphan') {
      values = [at, at, 'fixture-error', 'fixture message', run, runtime, run]
    } else if (item.family === 'finalize') {
      values = ['completed', at, at, run, runtime, runtime, run]
    } else if (item.family === 'reap') {
      values = ['failed', at, at, 'fixture-error', 'fixture message', run, runtime, runtime, run]
    } else if (item.family === 'zombie') {
      values = ['zombie', at, at, 'fixture-error', 'fixture message', run]
    } else values = ['ready', at, at, runtime, run]
    results.push({
      id,
      changed: db.sqlite.query(source[item.family].sql).run(...values).changes > 0,
    })
  }
  const image = () =>
    JSON.stringify(
      [
        'runs',
        'runtimes',
        'session_index',
        'hrc_events',
        'event_stream_cursor',
        'sqlite_sequence',
      ].map((table) => db.sqlite.query(`SELECT * FROM ${table} ORDER BY 1`).all())
    )
  const before = image()
  const atomic = () => {
    if (
      db.sqlite
        .query(source.finalize.sql)
        .run('completed', at, at, 'atomic-run', 'atomic-runtime', 'atomic-runtime', 'atomic-run')
        .changes <= 0
    )
      throw Error('missing atomic run CAS')
    if (
      db.sqlite.query(source.release.sql).run('ready', at, at, 'atomic-runtime', 'atomic-run')
        .changes <= 0
    )
      throw Error('missing atomic runtime CAS')
    db.hrcEvents.append({
      ts: at,
      hostSessionId: 'p1-host',
      scopeRef: 'agent:tabularasa:project:hrc-runtime:task:p1-store',
      laneRef: 'main',
      generation: 1,
      runtimeId: 'atomic-runtime',
      runId: 'atomic-run',
      category: 'turn',
      eventKind: 'turn.completed',
      transport: 'headless',
      payload: { source: 'reconciliation', success: true },
    })
  }
  let rejected = false
  try {
    db.sqlite
      .transaction(() => {
        atomic()
        throw Error('fixture rollback')
      })
      .immediate()
  } catch (error) {
    if (error.message !== 'fixture rollback') throw error
    rejected = true
  }
  const atomicRolledBack = rejected && image() === before
  db.sqlite.transaction(atomic).immediate()
  console.log(JSON.stringify({ results, source, atomicRolledBack, atomicCommitted: true }))
} finally {
  db.close()
}
