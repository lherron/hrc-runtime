const [release, root] = process.argv.slice(2)
if (!root?.startsWith('/tmp/hrcp1-')) throw Error('scratch only')
const { openHrcDatabase } = await import(`${release}/packages/hrc-store-sqlite/src/index.ts`)
const { readScopedSelectorHostIds } = await import(
  `${release}/packages/hrc-cli/src/monitor/wait-selector-state.ts`
)
const db = openHrcDatabase(`${root}/state.sqlite`, { migrate: false })
const sources = {}
async function sql(file, marker, start = 0) {
  const source = await Bun.file(`${release}/packages/${file}`).text()
  const at = source.indexOf(marker, start)
  if (at < 0) throw Error('missing source query')
  const begin = source.lastIndexOf(String.fromCharCode(96), at)
  const end = source.indexOf(String.fromCharCode(96), at)
  const result = source.slice(begin + 1, end)
  sources[`${file}:${at}`] = result
  return { result, at, source }
}
try {
  const accepted = (
    await sql(
      'hrc-server/src/sweep-reconcile-active.ts',
      'SELECT seq FROM broker_invocation_events'
    )
  ).result
  const terminal = (
    await sql(
      'hrc-server/src/sweep-reconcile-active.ts',
      'SELECT type FROM broker_invocation_events'
    )
  ).result
  const absorbed = (
    await sql('hrc-server/src/broker/turn-ownership.ts', 'SELECT invocation_id AS invocationId')
  ).result
  const first = await sql('hrc-server/src/in-flight-work.ts', 'SELECT r.run_id')
  const second = await sql('hrc-server/src/in-flight-work.ts', 'SELECT r.run_id', first.at + 1)
  const inflight = (text: string, include: boolean, excluded: string[], self?: string) =>
    db.sqlite
      .query(text)
      .all(
        ...(include
          ? ['2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z']
          : ['2026-10-23T00:00:00.000Z'])
      )
      .filter((r) => r.run_id !== self && !excluded.includes(r.transport ?? ''))
      .map((r) => ({
        runId: r.run_id,
        scopeRef: r.scope_ref,
        laneRef: r.lane_ref,
        status: r.status,
        transport: r.transport ?? undefined,
        startedAt: r.started_at ?? undefined,
      }))
  const terminalRuntime = await sql(
    'hrc-server/src/terminal-runtime-runs.ts',
    'SELECT runtime_id, status, active_run_id'
  )
  const terminalSql = terminalRuntime.result.replace(/\$\{placeholders\}/g, '?,?,?')
  const role = await sql('hrc-cli/src/monitor-show.ts', 'SELECT host_session_id FROM sessions')
  function roleIds(scope, descendants) {
    const predicates = ['scope_ref = ?']
    const values = [scope]
    if (descendants) {
      predicates.push("scope_ref LIKE ? ESCAPE '\\'")
      values.push(
        `${scope.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}:role:%`
      )
    }
    const query = role.result.replace(/\$\{predicates\.join\([\s\S]*?\)\}/, predicates.join(' OR '))
    return db.sqlite
      .query(query)
      .all(...values)
      .map((r) => r.host_session_id)
  }
  const result = {
    accepted: ['chosen', 'missing'].map(
      (id) => db.sqlite.query(accepted).get('read-invocation', id)?.seq ?? null
    ),
    terminals: [0, 2, 3, 4, 5, 99].map(
      (seq) => db.sqlite.query(terminal).get('read-invocation', seq)?.type ?? null
    ),
    absorbedAll: db.sqlite.query(absorbed).all('p1-runtime', '', ''),
    absorbedOne: db.sqlite.query(absorbed).all('p1-runtime', 'read-invocation', 'read-invocation'),
    terminalRuntimes: db.sqlite.query(terminalSql).all('terminated', 'crashed', 'dead'),
    inFlight: inflight(second.result, false, []),
    acceptedInFlight: inflight(first.result, true, []),
    excluded: inflight(first.result, true, ['tmux'], 'flight-headless'),
    scoped: [
      readScopedSelectorHostIds([], db),
      readScopedSelectorHostIds([{ kind: 'scope-prefix', prefix: 'agent:literal_%\\' }], db),
      readScopedSelectorHostIds([{ kind: 'task', taskId: 'same-task' }], db),
      readScopedSelectorHostIds(
        [
          { kind: 'scope-prefix', prefix: 'agent:literal_%\\' },
          { kind: 'task', taskId: 'same-task' },
          { kind: 'task', taskId: 'same-task' },
        ],
        db
      ),
    ],
    roleTree: roleIds('agent:literal_%\\', true),
    roleExact: roleIds('agent:literal_%\\:role:review', false),
  }
  console.log(JSON.stringify({ result, sources }))
} finally {
  db.close()
}
