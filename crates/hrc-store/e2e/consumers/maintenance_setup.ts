/** Historical setup SQL is explicitly NOT native write evidence. Real canonical schema only. */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [release, path, mode] = process.argv.slice(2)
const real = realpathSync(path)
if (!/^\/(private\/)?tmp\/hrcp1-consumers-/.test(real)) throw Error('scratch required')
const store = await import(pathToFileURL(`${release}/packages/hrc-store-sqlite/src/index.ts`).href)
const core = await import(pathToFileURL(`${release}/packages/hrc-core/src/index.ts`).href)
const db = store.openHrcDatabase(real, { migrate: false })
const ts = '2026-08-27T04:00:00Z'
const scope = 'agent:tabularasa:project:hrc-runtime:task:consumer-maintenance'
const expected: Record<string, unknown> = {}
function broker(id: string, result: unknown, envelope?: unknown) {
  db.sqlite
    .query(`INSERT INTO broker_invocation_events
    (invocation_id,seq,time,type,runtime_id,broker_event_json,broker_envelope_json,projection_status,created_at)
    VALUES (?,1,?,'tool.call.completed',?,?,?,'applied',?)`)
    .run(
      id,
      ts,
      id,
      JSON.stringify({ toolCallId: id, result }),
      envelope === undefined ? null : JSON.stringify(envelope),
      ts
    )
}
function lifecycle(id: string, result: unknown) {
  const stream = db.sqlite
    .query(
      'UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1 AS n'
    )
    .get().n
  db.sqlite
    .query(`INSERT INTO hrc_events
    (stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,category,event_kind,replayed,payload_json)
    VALUES (?,?,'p1-host',?,'main',1,?,'tool','turn.tool_result',0,?)`)
    .run(stream, ts, scope, id, JSON.stringify({ toolUseId: id, result }))
}
try {
  if (mode === 'spill') {
    for (const name of ['shared', 'different']) {
      const id = `consumer-maint-${name}`
      const raw = { output: `${name}:${'🫠'.repeat(20000)}`, exitCode: 0 }
      const canonical = core.toolResultFromBrokerResult(raw)
      if (name === 'different')
        canonical.details = { output: 'intentionally different', exitCode: 0 }
      broker(id, raw)
      lifecycle(id, canonical)
      expected[id] = { broker: raw, lifecycle: canonical }
    }
    broker('consumer-maint-small', { output: 'small', exitCode: 0 })
    lifecycle(
      'consumer-maint-small',
      core.toolResultFromBrokerResult({ output: 'small', exitCode: 0 })
    )
  } else if (mode === 'restub') {
    const raw = {
      content: [{ type: 'text', text: 'full result' }],
      details: { stdout: 'z'.repeat(80000), exitCode: 0, durationMs: 42 },
    }
    const resultJson = JSON.stringify(raw)
    for (const name of ['valid', 'missing', 'incomplete', 'mismatch', 'invalid']) {
      const id = `consumer-restub-${name}`
      const descriptor = {
        blobId: core.brokerToolResultBlobId(id, id),
        bytes: Buffer.byteLength(resultJson),
        kind: 'broker_raw',
      }
      if (name !== 'missing' && name !== 'invalid')
        db.sqlite
          .query(
            'INSERT INTO tool_result_blobs (blob_id,runtime_id,kind,bytes,complete,result_json,created_at) VALUES (?,?,?,?,?,?,?)'
          )
          .run(
            descriptor.blobId,
            id,
            name === 'mismatch' ? 'lifecycle_canonical' : 'broker_raw',
            descriptor.bytes,
            name === 'incomplete' ? 0 : 1,
            resultJson,
            ts
          )
      const stub = {
        content: [{ type: 'text', text: `existing ${name} excerpt` }],
        details: {
          spill: name === 'invalid' ? { nope: true } : descriptor,
          stdout: 'inline duplicate'.repeat(5000),
          exitCode: 0,
          durationMs: 42,
        },
      }
      broker(id, stub)
      lifecycle(id, stub)
      expected[id] = { broker: raw, lifecycle: core.toolResultFromBrokerResult(raw), descriptor }
    }
  } else if (mode === 'strip') {
    for (const name of ['payload', 'null', 'stripped']) {
      const id = `consumer-strip-${name}`
      const payload = { output: `authoritative ${name}`, exitCode: 0 }
      const envelope: Record<string, unknown> = {
        invocationId: id,
        seq: 1,
        type: 'tool.call.completed',
        time: ts,
        retained: 'keep',
      }
      if (name !== 'stripped')
        envelope.payload = name === 'null' ? null : { toolCallId: id, result: payload }
      broker(id, payload, envelope)
      expected[id] = envelope
    }
  } else if (mode === 'buffers') {
    for (const name of ['old', 'recent', 'live-run', 'live-runtime', 'active-run']) {
      const id = `consumer-buffer-${name}`
      db.sqlite
        .query(`INSERT INTO runtimes (runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,harness,provider,status,supports_inflight_input,created_at,updated_at,active_run_id)
        SELECT ?,host_session_id,scope_ref,lane_ref,generation,transport,harness,provider,?,supports_inflight_input,created_at,updated_at,? FROM runtimes WHERE runtime_id='p1-runtime'`)
        .run(id, name === 'live-runtime' ? 'busy' : 'dead', name === 'active-run' ? id : null)
      db.sqlite
        .query(`INSERT INTO runs (run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,updated_at)
        SELECT ?,host_session_id,?,scope_ref,lane_ref,generation,transport,?,updated_at FROM runs WHERE run_id='p1-run'`)
        .run(id, id, name === 'live-run' ? 'started' : 'completed')
      db.sqlite
        .query(
          'INSERT INTO runtime_buffers (runtime_id,run_id,chunk_seq,text,created_at) VALUES (?,?,1,?,?)'
        )
        .run(
          id,
          id,
          `buffer ${name}`,
          name === 'recent' ? '2099-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z'
        )
      expected[id] = name === 'old' ? 'delete' : 'preserve'
    }
  } else if (mode === 'hydrate') {
    const invocations = db.sqlite
      .query(
        `SELECT DISTINCT invocation_id AS id FROM broker_invocation_events WHERE invocation_id LIKE 'consumer-%' ORDER BY invocation_id`
      )
      .all()
    for (const { id } of invocations)
      expected[id] = JSON.parse(
        db.brokerInvocationEvents.getByInvocationAndSeq(id, 1)?.brokerEventJson
      )
    expected.lifecycle = db.hrcEvents.listFromHrcSeq(1)
  } else throw Error('unknown fixed historical setup mode')
  console.log(
    JSON.stringify({
      provenance:
        mode === 'hydrate'
          ? 'unchanged Bun typed read'
          : 'canonical historical setup SQL; NOT native writer',
      mode,
      expected,
    })
  )
} finally {
  db.close()
}
