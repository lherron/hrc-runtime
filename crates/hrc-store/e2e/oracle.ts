/** Canonical installed Bun scratch oracle; never a native execution substitute. */
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [release, root, mode = 'seed'] = process.argv.slice(2)
if (!release || !root || !root.startsWith('/tmp/hrcp1-'))
  throw new Error('explicit installed release and /tmp/hrcp1- scratch required')
const scratch = realpathSync(root)
if (!scratch.startsWith('/private/tmp/hrcp1-') && !scratch.startsWith('/tmp/hrcp1-'))
  throw new Error('scratch escape')
const module = await import(
  pathToFileURL(join(resolve(release), 'packages/hrc-store-sqlite/src/index.ts')).href
)
const db = module.openHrcDatabase(join(scratch, 'state.sqlite'), { migrate: mode === 'seed' })
function seedHistoryCount(count: number, projection: boolean) {
  db.sqlite.exec("DELETE FROM broker_invocation_events WHERE type='continuation.updated'")
  for (let i = 0; i < count; i++) {
    const hostSessionId = `history-host-${i}`
    const runtimeId = `history-runtime-${i}`
    const scopeRef = `agent:tabularasa:project:hrc-runtime:task:history-${i}`
    const ts = '2026-10-23T00:00:00.000Z'
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'inactive',
      createdAt: ts,
      updatedAt: ts,
    })
    db.continuities.upsert({
      scopeRef,
      laneRef: 'main',
      activeHostSessionId: hostSessionId,
      updatedAt: ts,
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude',
      provider: 'anthropic',
      status: 'dead',
      supportsInflightInput: false,
      createdAt: ts,
      updatedAt: ts,
    })
    db.brokerInvocationEvents.appendEvent({
      invocationId: 'p1-history',
      seq: 100 + i,
      time: ts,
      type: 'continuation.updated',
      runtimeId,
      payload: { key: `provider-${i}` },
    })
  }
  if (!projection)
    db.sqlite.exec("DELETE FROM session_index WHERE host_session_id LIKE 'history-host-%'")
}
try {
  if (mode === 'seed') {
    const scopeRef = 'agent:tabularasa:project:hrc-runtime:task:p1-store'
    const ts = '2026-10-23T00:00:00.000Z'
    db.sessions.insert({
      hostSessionId: 'p1-host',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'inactive',
      createdAt: ts,
      updatedAt: ts,
    })
    db.continuities.upsert({
      scopeRef,
      laneRef: 'main',
      activeHostSessionId: 'p1-host',
      updatedAt: ts,
    })
    db.runtimes.insert({
      runtimeId: 'p1-runtime',
      hostSessionId: 'p1-host',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude',
      provider: 'anthropic',
      status: 'dead',
      supportsInflightInput: false,
      createdAt: ts,
      updatedAt: ts,
    })
    db.runs.insert({
      runId: 'p1-run',
      hostSessionId: 'p1-host',
      runtimeId: 'p1-runtime',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      status: 'completed',
      completedAt: ts,
      updatedAt: ts,
    })
    const events = [1, 2, 3, 4].map((i) =>
      db.hrcEvents.append({
        ts,
        hostSessionId: 'p1-host',
        scopeRef,
        laneRef: 'main',
        generation: 1,
        category: 'turn',
        eventKind: 'turn.message',
        payload: { text: `oracle-${i}`, final: true },
      })
    )
    db.sqlite
      .query('DELETE FROM hrc_events WHERE hrc_seq IN (?,?)')
      .run(events[1].hrcSeq, events[3].hrcSeq)
    console.log(
      JSON.stringify({
        migrations: db.migrations.applied,
        head: db.hrcEvents.allocatedHrcSeq(),
        page: db.hrcEvents.page({ afterSeq: 0, limit: 10 }),
        deleted: [events[1].hrcSeq, events[3].hrcSeq],
        fixtureOnly: true,
      })
    )
  } else if (mode === 'append-boundary-control') {
    const before = db.hrcEvents.page({ afterSeq: 0, limit: 100 })
    let afterCaught: unknown
    let rejected = false
    const bad = {
      ts: '2026-10-23T00:00:00.000Z',
      hostSessionId: 'p1-host',
      scopeRef: 'agent:tabularasa:project:hrc-runtime:task:p1-store',
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.tool_result',
      payload: { result: 'X'.repeat(40000) },
    }
    db.sqlite
      .transaction(() => {
        try {
          db.hrcEvents.append(bad)
        } catch {
          rejected = true
        }
        afterCaught = db.hrcEvents.page({ afterSeq: 0, limit: 100 })
        db.hrcEvents.append({
          ...bad,
          eventKind: 'turn.message',
          payload: { text: 'after caught repository error' },
        })
      })
      .immediate()
    const afterCommit = db.hrcEvents.page({ afterSeq: 0, limit: 100 })
    let withinCaught: unknown
    let callerRolledBack = false
    try {
      db.sqlite
        .transaction(() => {
          try {
            db.hrcEvents.appendWithinExistingTransaction(bad)
          } catch {}
          withinCaught = db.hrcEvents.page({ afterSeq: 0, limit: 100 })
          throw new Error('caller aborts encompassing transaction')
        })
        .immediate()
    } catch {
      callerRolledBack = true
    }
    console.log(
      JSON.stringify({
        before,
        rejected,
        afterCaught,
        afterCommit,
        withinCaught,
        callerRolledBack,
        afterRollback: db.hrcEvents.page({ afterSeq: 0, limit: 100 }),
      })
    )
  } else if (mode === 'placement') {
    const ledger = module.createPlacementLedgerRepository(db.sqlite)
    console.log(JSON.stringify(ledger.list()))
  } else if (mode === 'serialization-read') {
    const raw =
      '{"2":"two","1":"one","normal":1.0,"tiny":1e-7,"huge":1e21,"negativeZero":-0.0,"large":9007199254740993}'
    const payload = JSON.parse(raw)
    let numericIdempotent = false
    let numericError: string | undefined
    try {
      numericIdempotent = db.brokerInvocationEvents.appendEvent({
        invocationId: 'p1-json',
        seq: 1,
        time: '2026-10-23T00:00:00.000Z',
        type: 'input.accepted',
        runtimeId: 'p1-runtime',
        payload,
      }).idempotent
    } catch (error) {
      numericError = String(error)
    }
    const core = await import(
      pathToFileURL(join(resolve(release), 'packages/hrc-core/src/index.ts')).href
    )
    const result = `X${'🫠'.repeat(20000)}`
    const expectedSpill = JSON.stringify({
      toolCallId: 'p1-tool',
      result: core.createToolResultSpillStub(result, {
        blobId: 'tc:p1-runtime:p1-tool',
        bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
        kind: 'broker_raw',
      }),
    })
    const storedNumeric = db.sqlite
      .query(
        'SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id=? AND seq=1'
      )
      .get('p1-json') as { broker_event_json: string }
    const storedSpill = db.sqlite
      .query(
        'SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id=? AND seq=2'
      )
      .get('p1-json') as { broker_event_json: string }
    console.log(
      JSON.stringify({
        numericIdempotent,
        numericError,
        storedNumeric: storedNumeric.broker_event_json,
        expectedNumeric: JSON.stringify(payload),
        storedSpill: storedSpill.broker_event_json,
        expectedSpill,
      })
    )
  } else if (mode === 'serialization-bun-write') {
    const critical = JSON.parse('{"2":2,"1":1,"\\ud800":"\\udfff","x":1,"x":2,"01":3}')
    const base = {
      invocationId: 'p1-json',
      time: '2026-10-23T00:00:00.000Z',
      type: 'input.accepted',
      runtimeId: 'p1-runtime',
    }
    const repeat = db.brokerInvocationEvents.appendEvent({
      ...base,
      seq: 3,
      payload: critical,
    }).idempotent
    const conflict = Object.fromEntries(
      Object.entries(critical).filter(([key]) => key !== '\ud800')
    )
    conflict['\ud800'] = '\udfff'
    let conflictRefused = false
    try {
      db.brokerInvocationEvents.appendEvent({ ...base, seq: 3, payload: conflict })
    } catch {
      conflictRefused = true
    }
    const spillRepeat = db.brokerInvocationEvents.appendEvent({
      ...base,
      seq: 2,
      type: 'tool.call.completed',
      payload: { toolCallId: 'p1-tool', result: `X${'🫠'.repeat(20000)}` },
    }).idempotent
    const result = {
      output: `X${'🫠'.repeat(20000)}`,
      status: `\ud800${'中'.repeat(100)}`,
      details: { durationMs: 1.0, interrupted: true },
    }
    const core = await import(
      pathToFileURL(join(resolve(release), 'packages/hrc-core/src/index.ts')).href
    )
    const expectedDiagnostic = JSON.stringify({
      toolCallId: 'p1-diagnostic',
      result: core.createToolResultSpillStub(result, {
        blobId: 'tc:p1-runtime:p1-diagnostic',
        bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
        kind: 'broker_raw',
      }),
    })
    const storedDiagnostic = (
      db.sqlite
        .query(
          'SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id=? AND seq=4'
        )
        .get('p1-json') as { broker_event_json: string }
    ).broker_event_json
    const ts = '2026-10-23T00:00:00.000Z'
    const scopeRef = 'agent:tabularasa:project:hrc-runtime:task:p1-store'
    db.hrcEvents.append({
      ts,
      hostSessionId: 'p1-host',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.message',
      payload: critical,
    })
    db.brokerInvocationEvents.appendEvent({ ...base, seq: 10, payload: critical })
    const last = db.hrcEvents.append({
      ts,
      hostSessionId: 'p1-host',
      scopeRef,
      laneRef: 'main',
      generation: 1,
      runtimeId: 'p1-runtime',
      category: 'turn',
      eventKind: 'turn.tool_result',
      payload: { result: `X${'🫠'.repeat(20000)}` },
    })
    console.log(
      JSON.stringify({
        repeat,
        conflictRefused,
        spillRepeat,
        expectedDiagnostic,
        storedDiagnostic,
        lastSeq: last.hrcSeq,
      })
    )
  } else if (mode === 'serialization-observe') {
    const page = db.hrcEvents.page({ afterSeq: 0, limit: 100 })
    const hydrated = db.hrcEvents.findLatestByKind('turn.tool_result')
    console.log(
      JSON.stringify({
        page,
        hydrated,
        events: db.brokerInvocationEvents.listByInvocationId('p1-json'),
      })
    )
  } else if (mode === 'index-read') {
    console.log(
      JSON.stringify({
        page: db.sessionIndex.listPage({ limit: 100 }),
        facets: db.sessionIndex.facets({}),
        filteredFacets: db.sessionIndex.facets({ agentId: 'tabularasa' }),
        backfill: db.sessionIndex.getBackfillEvidence(),
      })
    )
  } else if (mode === 'registry-init') {
    const registry = module.openBindingRegistry(join(scratch, 'registry.sqlite'))
    try {
      console.log(JSON.stringify({ records: registry.list() }))
    } finally {
      registry.close()
    }
  } else if (mode === 'placement-read') {
    const registry = module.openBindingRegistry(join(scratch, 'registry.sqlite'))
    try {
      console.log(
        JSON.stringify({
          placement: module.readPlacementLedgerRows(db.sqlite),
          records: registry.list(),
          history: registry.designationHistory(
            'agent:tabularasa:project:hrc-runtime:task:T-11528-placement'
          ),
        })
      )
    } finally {
      registry.close()
    }
  } else if (mode === 'collective-read' || mode === 'collective-reconstruct') {
    let canonical: unknown
    let origin: unknown
    let originConflict = false
    if (mode === 'collective-reconstruct') {
      const inputs = JSON.parse(await Bun.file(process.env.P1_COLLECTIVE_INPUTS!).text())
      for (let i = 0; i < inputs.length; i++) {
        if (i === 3) {
          try {
            db.collectiveHistory.recordObservation(inputs[i])
          } catch {
            originConflict = true
          }
          continue
        }
        const r = db.collectiveHistory.recordObservation(inputs[i])
        if (i === 1) canonical = r
        if (i === 2) origin = r
      }
    }
    console.log(
      JSON.stringify({
        ...(canonical
          ? { canonical, origin, originConflict, count: db.collectiveHistory.count() }
          : {}),
        all: db.collectiveHistory.query({}, 'svc'),
        page: db.collectiveHistory.query({ limit: 1 }, 'svc'),
        reverse: db.collectiveHistory.query({ limit: 2, order: 'desc' }, 'svc'),
        filtered: db.collectiveHistory.query({ phases: ['response'] }, 'svc'),
      })
    )
  } else if (mode === 'outbox-read') {
    console.log(JSON.stringify(db.federationOutbox.list()))
  } else if (mode === 'replication-read') {
    const row = db.sqlite
      .query(
        'SELECT record_json,record_fingerprint FROM collective_history_replications WHERE message_id=?'
      )
      .get('p1-replicated') as { record_json: string; record_fingerprint: string }
    const { createHash } = await import('node:crypto')
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(JSON.parse(row.record_json)))
      .digest('hex')
    if (fingerprint !== row.record_fingerprint) throw new Error('fingerprint differs from Bun')
    console.log(
      JSON.stringify({
        pending: db.collectiveHistoryReplications.pendingCount(),
        due: db.collectiveHistoryReplications.listDue('2026-10-23T00:00:00.000Z'),
        fingerprint,
      })
    )
  } else if (mode === 'mail-delivery-read') {
    console.log(
      JSON.stringify({
        intent: db.mailDelivery.getIntent('EN-delivery'),
        presentation: db.mailDelivery.getPresentation('EN-delivery', 'p1-runtime'),
      })
    )
  } else if (mode === 'mail-accounting-read') {
    console.log(
      JSON.stringify({
        record: db.mailStopRefusals.get('p1-runtime'),
        notices: db.mailDelivery.failureNoticesForEnvelope('EN-notice'),
        birth: db.mailDelivery.getBirthRefusal('agent:tabularasa'),
      })
    )
  } else if (mode === 'active-read') {
    console.log(JSON.stringify(db.activeInputDeliveries.getByInputApplicationId('p1-application')))
  } else if (mode === 'seed-prune') {
    db.transcriptIndex.upsertTurn({
      invocationId: 'p1-invocation',
      runtimeId: 'p1-runtime',
      seqFrom: 1,
      seqTo: 2,
      startedAt: '2026-10-23T00:00:00Z',
      completedAt: '2026-10-23T00:00:01Z',
      terminalStatus: 'completed',
      messageCount: 1,
      truncated: false,
      userText: 'café prune target',
      finalText: 'answer',
      midText: '',
    })
    db.transcriptIndex.setInvocationMark({
      invocationId: 'p1-invocation',
      runtimeId: 'p1-runtime',
      lastTerminalSeq: 2,
      updatedAt: '2026-10-23T00:00:00Z',
    })
    db.toolResultBlobs.insert({
      blobId: 'p1-prune-blob',
      runtimeId: 'p1-runtime',
      kind: 'broker_raw',
      bytes: 2,
      resultJson: '{}',
    })
    db.toolResultBlobs.ingestPart({
      blobId: 'p1-prune-part',
      runtimeId: 'p1-runtime',
      kind: 'broker_raw',
      part: 0,
      parts: 2,
      bytes: 2,
      chunk: '{',
    })
    console.log(JSON.stringify({ fts: db.transcriptIndex.search('cafe', {}, { limit: 10 }) }))
  } else if (mode === 'share-plan') {
    const r = db.runtimes.getByRuntimeId('p1-runtime')
    if (!r) throw new Error('fixture runtime absent')
    db.runtimes.insert({ ...r, runtimeId: 'p1-survivor', planHash: 'p1-plan-hash' })
    db.events.append({
      ts: '2026-10-23T00:00:00.000Z',
      hostSessionId: 'p1-host',
      scopeRef: r.scopeRef,
      laneRef: 'main',
      generation: 1,
      runtimeId: 'p1-survivor',
      runId: 'p1-run',
      source: 'broker',
      eventKind: 'broker.fixture',
      eventJson: { fixture: true },
    })
    db.runtimeBuffers.append({
      runtimeId: 'p1-survivor',
      runId: 'p1-run',
      chunkSeq: 0,
      text: 'cross-runtime run edge',
      createdAt: '2026-10-23T00:00:00.000Z',
    })
    console.log(JSON.stringify({ survivor: db.runtimes.getByRuntimeId('p1-survivor') }))
  } else if (mode === 'prune-full' || mode === 'prune-minimal') {
    const includeLedgers = mode === 'prune-full'
    const beforeCounts = db.runtimes.countPruneRows(['p1-runtime'], { includeLedgers })
    const removed = db.runtimes.pruneRuntimes(['p1-runtime'], { includeLedgers })
    console.log(
      JSON.stringify({
        beforeCounts,
        removed,
        sqliteChanges: db.sqlite.query('SELECT changes() AS value').get(),
        remainingRuntimes: db.runtimes.count(),
        fts: db.transcriptIndex.search('cafe', {}, { limit: 10 }),
      })
    )
  } else if (mode === 'append-control') {
    const event = db.hrcEvents.append({
      ts: '2026-10-23T00:00:01.000Z',
      hostSessionId: 'p1-host',
      scopeRef: 'agent:tabularasa:project:hrc-runtime:task:p1-store',
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.message',
      payload: { text: 'Bun mutation control', final: true },
    })
    console.log(JSON.stringify(event))
  } else if (mode === 'ledgers-read') {
    console.log(
      JSON.stringify({
        legacy: db.events.listFromSeq(1, {}),
        filtered: db.hrcEvents.listFromHrcSeqFiltered(1, { taskIds: ['T-11528'] }),
      })
    )
  } else if (mode === 'messages-read') {
    console.log(JSON.stringify({ messages: db.messages.query({}) }))
  } else if (mode === 'participants-read') {
    console.log(
      JSON.stringify({
        attempt: db.participantRegistrations.getAttempt('p1-attempt'),
        binding: db.participantHostBindings.getBindingById('p1-binding'),
        registration: db.participantRegistrations.getRegistrationById('p1-registration'),
      })
    )
  } else if (mode === 'grants-read') {
    console.log(
      JSON.stringify({ grant: db.externalRegistrationGrants.getByRegistrationId('p1-grant') })
    )
  } else if (mode === 'recovery-read') {
    console.log(
      JSON.stringify({
        watch: db.firstTurnWatch.get('p1-runtime', 1),
        contribution: db.steerContributions.getById('p1-contribution'),
      })
    )
  } else if (mode === 'broker-read') {
    console.log(
      JSON.stringify({
        events: db.brokerInvocationEvents.listByInvocationId('p1-invocation'),
        invocation: db.brokerInvocations.getByInvocationId('p1-invocation'),
        disposition: db.brokerInvocationEvents.getProjectionDisposition('p1-invocation', 2),
      })
    )
  } else if (mode === 'transcript-read') {
    console.log(
      JSON.stringify({
        stats: db.transcriptIndex.stats(),
        hits: db.transcriptIndex.search('cafe', {}, { limit: 10 }),
      })
    )
  } else if (mode === 'continuation-maintenance-count-seed') {
    seedHistoryCount(Number(process.argv[5]), process.argv[6] === 'true')
    console.log(JSON.stringify({ seeded: true }))
  } else if (mode === 'continuation-maintenance-count-controls') {
    const helpers = await import(
      pathToFileURL(
        join(resolve(release), 'packages/hrc-server/src/session-resume-continuation.ts')
      ).href
    )
    const results = []
    for (const count of [0, 1, 3])
      for (const projection of [false, true]) {
        db.sqlite.exec('BEGIN IMMEDIATE')
        try {
          seedHistoryCount(count, projection)
          const before = db.sqlite.query('SELECT total_changes() AS value').get().value
          const repaired = helpers.repairContinuationHistory(db)
          const directChanges = db.sqlite.query('SELECT changes() AS value').get().value
          const totalDelta = db.sqlite.query('SELECT total_changes() AS value').get().value - before
          const restored = db.sqlite
            .query(
              "SELECT COUNT(*) AS value FROM sessions WHERE host_session_id LIKE 'history-host-%' AND continuation_json IS NOT NULL AND continuation_reuse_disabled=1"
            )
            .get().value
          const repeated = helpers.repairContinuationHistory(db)
          results.push({
            count,
            projection,
            repaired,
            directChanges,
            totalDelta,
            restored,
            repeated,
          })
        } finally {
          db.sqlite.exec('ROLLBACK')
        }
      }
    console.log(JSON.stringify(results))
  } else if (mode === 'continuation-maintenance-control') {
    const helpers = await import(
      pathToFileURL(
        join(resolve(release), 'packages/hrc-server/src/session-resume-continuation.ts')
      ).href
    )
    const backfilled = helpers.backfillLegacyContinuationClearBarriers(db)
    const repeatBackfill = helpers.backfillLegacyContinuationClearBarriers(db)
    const repaired = helpers.repairContinuationHistory(db)
    const repeatRepair = helpers.repairContinuationHistory(db)
    console.log(
      JSON.stringify({
        backfilled,
        repeatBackfill,
        repaired,
        repeatRepair,
        session: db.sessions.getByHostSessionId('p1-host'),
        reuseDisabled: db.sessions.isContinuationReuseDisabled('p1-host'),
        hasBarrier:
          helpers.detectResumeInvalidationBarrier(db, db.sessions.getByHostSessionId('p1-host'))
            ?.kind === 'broker_continuation_cleared',
        events: db.brokerInvocationEvents.listByInvocationId('p1-history'),
      })
    )
  } else if (mode === 'read') {
    console.log(
      JSON.stringify({
        page: db.hrcEvents.page({ afterSeq: 0, limit: 100 }),
        sessions: db.sessions.listByScopeRef('agent:tabularasa:project:hrc-runtime:task:p1-store'),
      })
    )
  } else throw new Error('unknown oracle mode')
} finally {
  db.close()
}
