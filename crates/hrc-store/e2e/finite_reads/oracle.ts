import { realpathSync } from 'node:fs'
/** Uses the immutable, unchanged Bun producer. All writes are scratch fixture or controls. */
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [release, root, mode] = process.argv.slice(2)
const scratch = realpathSync(root)
if (!/^\/(private\/)?tmp\/hrcp1-finite-/.test(scratch)) throw Error('scratch required')
const producer = await import(
  pathToFileURL(join(resolve(release), 'packages/hrc-store-sqlite/src/index.ts')).href
)
const db = producer.openHrcDatabase(join(scratch, 'state.sqlite'), { migrate: mode === 'seed' })
const scope = 'agent:tabularasa:project:hrc-runtime:task:finite_%'
const at = '2026-10-23T00:00:00.000Z'
const later = '2026-10-23T01:00:00.000Z'
const activity = '2026-10-23T02:00:00.000Z'
try {
  if (mode === 'seed') {
    for (const host of ['finite-host', 'finite-other'])
      db.sessions.insert({
        hostSessionId: host,
        scopeRef: scope,
        laneRef: 'main',
        generation: 1,
        status: 'inactive',
        createdAt: at,
        updatedAt: at,
      })
    for (const [i, status] of [
      'ready',
      'busy',
      'dead',
      'stale',
      'starting',
      'detached',
    ].entries()) {
      const id = `finite-${String.fromCharCode(97 + i)}`
      db.runtimes.insert({
        runtimeId: id,
        hostSessionId: i === 5 ? 'finite-other' : 'finite-host',
        scopeRef: i === 5 ? `${scope}other` : scope,
        laneRef: 'main',
        generation: i === 1 ? 2 : 1,
        transport: 'tmux',
        harness: 'claude',
        provider: 'anthropic',
        status,
        supportsInflightInput: false,
        createdAt: at,
        updatedAt: at,
      })
      db.runs.insert({
        runId: id,
        hostSessionId: i === 5 ? 'finite-other' : 'finite-host',
        runtimeId: id,
        scopeRef: i === 5 ? `${scope}other` : scope,
        laneRef: 'main',
        generation: i === 1 ? 2 : 1,
        transport: 'tmux',
        status: i < 3 ? 'queued' : i === 3 ? 'completed' : 'running',
        acceptedAt: at,
        completedAt: i === 3 ? at : undefined,
        updatedAt: at,
        queuedInputSeq: i === 0 ? 2 : i === 1 ? 1 : undefined,
        dispatchIdempotencyKey: `key-${id}`,
        dispatchedInputId: `input-${id}`,
        brokerSubmissionId: `submission-${id}`,
        turnKey: `turn-${id}`,
        invocationId: 'finite-invocation',
      })
    }
    db.runs.insert({
      ...db.runs.getByRunId('finite-b'),
      runId: 'finite-app',
      scopeRef: 'app:finite',
      dispatchIdempotencyKey: undefined,
      dispatchedInputId: undefined,
      brokerSubmissionId: undefined,
      turnKey: undefined,
      queuedInputSeq: undefined,
    })
    db.sqlite
      .query(
        "UPDATE hrc_event_ledger_metadata SET ledger_incarnation_id='finite-original' WHERE id=1"
      )
      .run()
    db.runs.setCorrelationJson('finite-b', 'null')
    db.runs.setCorrelationJson('finite-d', '{}')
    for (let i = 1; i <= 10; i++)
      db.hrcEvents.append({
        ts: at,
        hostSessionId: i === 7 ? 'finite-other' : 'finite-host',
        scopeRef: i === 7 ? `${scope}other` : scope,
        laneRef: i === 8 ? 'lane:alt' : 'main',
        generation: i === 3 || i === 9 ? 2 : 1,
        runtimeId: i === 7 ? 'finite-f' : 'finite-a',
        runId: i === 7 ? 'finite-f' : 'finite-a',
        launchId: 'finite-launch',
        category: 'turn',
        eventKind: i === 6 ? 'turn.completed' : 'turn.message',
        evidenceOrigin: i === 9 ? 'retained' : undefined,
        payload: { text: `finite-${i}`, final: true },
      })
    db.sqlite
      .query('UPDATE hrc_events SET source_ref=?,origin_seq=? WHERE hrc_seq=?')
      .run('peer:finite', 4, 4)
    db.sqlite.query('UPDATE hrc_events SET source_ref=?,origin_seq=? WHERE hrc_seq=?').run('', 5, 5)
    db.sqlite.query('DELETE FROM hrc_events WHERE hrc_seq IN (2,10)').run()
    console.log(
      JSON.stringify({
        seeded: true,
        scope,
        at,
        allocated: db.hrcEvents.allocatedHrcSeq(),
        max: db.hrcEvents.maxHrcSeq(),
      })
    )
  } else if (mode === 'observe') {
    const e = db.hrcEvents
    const r = db.runtimes
    const n = db.runs
    const id = e.ledgerIncarnationId()
    const replay = (budget: number) => {
      const visited: unknown[] = []
      const accepted: unknown[] = []
      let bytes = 0
      const result = e.scanReplayNewestFirst(
        { afterHrcSeq: 0, expectedLedgerIncarnationId: id, filters: { scopeRef: scope } },
        (event) => {
          visited.push(event)
          const size = Buffer.byteLength(JSON.stringify(event))
          if (bytes + size > budget) return false
          bytes += size
          accepted.push(event)
          return true
        }
      )
      return { visited, accepted, bytes, ...result }
    }
    const mismatch = (call: () => unknown) => {
      try {
        call()
        return { rejected: false }
      } catch (error) {
        return {
          rejected: true,
          expected: (error as { expectedLedgerIncarnationId: string }).expectedLedgerIncarnationId,
          actual: (error as { currentLedgerIncarnationId: string }).currentLedgerIncarnationId,
        }
      }
    }
    console.log(
      JSON.stringify({
        result: {
          lifecycle: {
            repositoryPages: [0, -1, -2, 10001].map((limit) => ({
              limit,
              value: e.page({ afterSeq: 0, limit }),
            })),
            repositoryTails: [0, -1, -2, 10001].map((limit) => ({
              limit,
              value: e.tail(limit, { scopeRef: scope }),
            })),
            repositoryAfterNegative: e.page({ afterSeq: -1, limit: 2 }),
            repositoryTailNegativeBefore: e.tail(-2, { scopeRef: scope }, { beforeHrcSeq: 7 }),
            repositoryStale: mismatch(() =>
              e.page({ afterSeq: 0, limit: 0, expectedLedgerIncarnationId: 'finite-original' })
            ),
            incarnation: id,
            allocated: e.allocatedHrcSeq(),
            max: e.maxHrcSeq(),
            page1: e.page({ afterSeq: 0, limit: 1 }),
            page2: e.page({ afterSeq: 1, limit: 2 }),
            pageShort: e.page({ afterSeq: 0, limit: 100 }),
            pageAhead: e.page({ afterSeq: 999, limit: 2 }),
            tail: e.tail(2, { scopeRef: scope }),
            tailBefore: e.tail(2, { scopeRef: scope }, { beforeHrcSeq: 7 }),
            tailWrong: e.tail(2, { scopeRef: 'absent' }),
            tailGeneration: e.tail(2, { hostSessionId: 'finite-host', generation: 2 }),
            local: e.listFromHrcSeq(1, { sourceRef: null }),
            imported: e.listFromHrcSeq(1, { sourceRef: 'peer:finite' }),
            emptySource: e.listFromHrcSeq(1, { sourceRef: '' }),
            all: e.listFromHrcSeq(1, {}),
            from: e.listFromHrcSeq(4, { scopeRef: scope }),
            stream: e.listFromStreamSeq(4, { scopeRef: scope }),
            zero: e.listFromHrcSeq(1, { limit: 0 }),
            byRun: e.listByRun('finite-a', { generation: 1 }),
            byLaunch: e.listByLaunch('finite-launch', { generation: 2 }),
            byKind: e.listByKind('turn.completed'),
            byScope: e.listByScope(scope, { laneRef: 'main' }),
            latestKind: e.findLatestByKind('turn.message', { generation: 2 }),
            latestSession: e.findLatestBySession('finite-host', 2),
            latestWrong: e.findLatestBySession('finite-host', 99),
            latestLocal: e.findLatestLocalInScope(scope),
            latestLocalBefore: e.findLatestLocalInScope(scope, {
              beforeHrcSeq: 6,
              eventKind: 'turn.message',
            }),
            latestGroups: e.listLatestPerSession({ scopeRef: scope }),
            replay: replay(1000000),
            replayBytes: replay(700),
            originalFence: mismatch(() =>
              e.page({ afterSeq: 0, limit: 2, expectedLedgerIncarnationId: 'finite-original' })
            ),
            pageMismatch: mismatch(() =>
              e.page({ afterSeq: 0, limit: 2, expectedLedgerIncarnationId: 'wrong' })
            ),
            tailMismatch: mismatch(() => e.tail(2, {}, { expectedLedgerIncarnationId: 'wrong' })),
            replayMismatch: mismatch(() =>
              e.scanReplayNewestFirst(
                { afterHrcSeq: 0, expectedLedgerIncarnationId: 'wrong' },
                () => true
              )
            ),
          },
          runtime: {
            count: r.count(),
            one: r.getByRuntimeId('finite-a'),
            missing: r.getByRuntimeId('absent'),
            latest: r.getLatestByHostSessionId('finite-host'),
            host: r.listByHostSessionId('finite-host'),
            wrongHost: r.listByHostSessionId('absent'),
            scope: r.listByScopeRef(scope),
            all: r.listAll(),
            available: r.listAvailable(),
            statuses: r.listByStatus(['busy', 'ready']),
            emptyStatuses: r.listByStatus([]),
            live: r.listLiveSessionRefs(),
            liveRows: r.listLiveSessionRefRows(),
          },
          run: {
            one: n.getByRunId('finite-a'),
            missing: n.getByRunId('absent'),
            dispatch: n.getByDispatchIdempotencyKey('finite-host', 'key-finite-b'),
            wrongDispatch: n.getByDispatchIdempotencyKey('finite-other', 'key-finite-b'),
            input: n.getByDispatchedInputId('input-finite-c'),
            submission: n.getByBrokerSubmissionId('submission-finite-d'),
            turn: n.getByTurnKey('turn-finite-e'),
            runtime: n.listByRuntimeId('finite-a'),
            correlated: n.listCorrelatedByInvocationId('finite-invocation'),
            queue: n.listQueuedByHostSessionId('finite-host'),
            wrongQueue: n.listQueuedByHostSessionId('finite-other'),
            all: n.listRuns(),
            selectors: [
              n.listRuns({ runId: 'finite-c' }),
              n.listRuns({ runtimeId: 'finite-a' }),
              n.listRuns({ scopeRef: scope, laneRef: 'main', status: ['completed'] }),
              n.listRuns({ scopeRef: '' }),
              n.listRuns({ laneRef: '' }),
              n.listRuns({ hostSessionId: '' }),
              n.listRuns({ generation: 0 }),
            ],
            filtered: n.listRuns({
              hostSessionId: 'finite-host',
              generation: 2,
              status: ['queued'],
            }),
            zero: n.listRuns({ limit: 0 }),
            emptyStatuses: n.listRuns({ status: [] }),
            latest: n.getLatestForSession({ hostSessionId: 'finite-host' }),
            latestGeneration: n.getLatestForSession({
              hostSessionId: 'finite-host',
              generation: 2,
            }),
            wrongGeneration: n.getLatestForSession({
              hostSessionId: 'finite-host',
              generation: 99,
            }),
          },
        },
      })
    )
  } else if (mode === 'activity-control') {
    console.log(JSON.stringify({ result: db.runtimes.updateActivity('finite-a', activity, later) }))
  } else if (mode === 'zero-controls') {
    console.log(
      JSON.stringify({
        page: db.hrcEvents.page({ afterSeq: 0, limit: 0 }),
        tail: db.hrcEvents.tail(0),
      })
    )
  } else if (mode === 'mutate') {
    const r = db.runtimes
    const n = db.runs
    const outcomes: Record<string, unknown> = {}
    outcomes.before = { runtime: r.getByRuntimeId('finite-a'), run: n.getByRunId('finite-d') }
    outcomes.empty = r.update('finite-a', {})
    outcomes.patch = r.update('finite-a', {
      presentation: { label: 'finite' },
      runtimeStateJson: { stage: 1 },
      updatedAt: later,
    })
    outcomes.sameStatus = r.updateStatus('finite-a', 'ready', later)
    outcomes.status = r.updateStatus('finite-a', 'busy', later)
    outcomes.activity = r.updateActivity('finite-a', activity, later)
    outcomes.clear = r.update('finite-a', {
      presentation: null,
      runtimeStateJson: null,
      updatedAt: later,
    })
    outcomes.runId = r.updateRunId('finite-a', 'finite-a', later)
    outcomes.clearRunId = r.updateRunId('finite-a', undefined, later)
    outcomes.absent = r.updateActivity('absent', activity, later)
    try {
      r.updateRunId('finite-a', 'finite-app', later)
      outcomes.ownership = { rejected: false }
    } catch (error) {
      outcomes.ownership = { rejected: true, code: (error as { code: string }).code }
    }
    outcomes.ownershipAfter = r.getByRuntimeId('finite-a')
    outcomes.runEmpty = n.update('finite-d', {})
    outcomes.runMonotonic = n.update('finite-d', {
      status: 'running',
      startedAt: later,
      acceptedAt: later,
      updatedAt: later,
    })
    outcomes.runResurrect = n.update('finite-d', {
      status: 'running',
      completedAt: null,
      errorCode: 'finite-error',
      updatedAt: later,
    })
    outcomes.runStatus = n.updateStatus('finite-d', 'failed', later)
    outcomes.runClear = n.update('finite-d', {
      errorCode: null,
      errorMessage: null,
      updatedAt: later,
    })
    outcomes.runAbsent = n.updateStatus('absent', 'failed', later)
    outcomes.after = { runtime: r.getByRuntimeId('finite-a'), run: n.getByRunId('finite-d') }
    console.log(JSON.stringify({ result: outcomes }))
  } else throw Error('unknown explicit scenario')
} finally {
  db.close()
}
