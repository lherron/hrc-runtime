// Real native owner + actual Foundry join/waiter, absent participant endpoint.
// Failure modes: an exhausted attempt looks pending forever; unknown runtimes
// look terminal; waiter traffic exceeds its retry budget; failure loses identity.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
const [socket, foundry, log, out, state] = process.argv.slice(2)
assert.ok(socket.startsWith('/tmp/hv/') && state?.startsWith('/tmp/hv/'), 'fixture writes require a private hv daemon and state file')
process.env.FOUNDRY_HRC_SOCKET = socket
const { registerFleetSeat, fleetDescriptor, fleetEstablishment } = await import(join(foundry, 'hrc.js'))
const { SeatHrcJoin } = await import(join(foundry, 'seat-hrc.js'))
const root = mkdtempSync(join(tmpdir(), 'participant-wait-'))
const seatDir = join(root, 'seat'); mkdirSync(seatDir)
const project = `foundry-wait-${Date.now()}`
const joined = await registerFleetSeat({ home: root, project, hostIncarnationId: project,
  root, socketPath: join(root, 'absent.sock'), continuation: 'fresh' })
assert.equal((await fleetEstablishment(root, joined)).state, 'pending')
const descriptor = fleetDescriptor(joined, { project, root, agentRoot: root, aspHome: root,
  provider: 'openai-codex', modelId: 'gpt-6.1-sol', authMode: 'oauth', thinkingLevel: 'medium' })
const seat = { record: { seatId: 'primary', generation: 1, state: 'spawning', childPid: process.pid } }
const waiter = new SeatHrcJoin(seat, { home: root, seatDir, closing: () => false,
  observe: () => {}, changed: () => {} })
const before = readFileSync(log, 'utf8').split('\n').length
const began = Date.now()
let failure
try { await waiter.attach(joined, join(root, 'absent.sock'), descriptor) }
catch (error) { failure = { code: error.code, message: error.message } }
const elapsedMs = Date.now() - began
const observed = await fleetEstablishment(root, joined)
const lines = readFileSync(log, 'utf8').split('\n').slice(before - 1).filter(Boolean).map(line => JSON.parse(line))
const inspections = lines.filter(line => line.event === 'http.request' && JSON.stringify(line.data).includes('/v1/runtimes/inspect')).length
const result = { joined, elapsedMs, failure, observed, inspections }
await Bun.write(out, JSON.stringify(result, null, 2) + '\n')
assert.equal(failure?.code, 'hrc_not_established')
assert.match(failure.message, /participant_establishment_exhausted/)
assert.equal(observed.state, 'refused')
assert.ok(elapsedMs < 8000, `terminal refusal took ${elapsedMs}ms`)
assert.ok(inspections > 0 && inspections <= 20, `${inspections} inspect calls`)
// Exhaustion changes inspect only while the runtime has no row. Simulate the
// persisted terminated and partial ready rows the injector reconciles; preserve
// their views rather than aborting the whole safety-net sweep with a 409.
const db = new Database(state)
const id = joined.identity
const call = async (runtimeId) => {
  const response = await fetch('http://hrc/v1/runtimes/inspect', { unix: socket,
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtimeId }) })
  return { status: response.status, body: await response.json() }
}
db.query(`INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,
  supports_inflight_input,created_at,updated_at,active_invocation_id,runtime_state_json)
  VALUES(?,?,?,?,?,'native-worker','terminated',0,?,?,?,'{}')`).run(id.runtimeId, joined.hostSessionId,
  joined.scopeRef, 'main', joined.generation, new Date().toISOString(), new Date().toISOString(), id.invocationId)
result.existingTerminated = await call(id.runtimeId)
await Bun.write(out, JSON.stringify(result, null, 2) + '\n')
assert.equal(result.existingTerminated.status, 200)
assert.equal(result.existingTerminated.body.status, 'terminated')
db.query("UPDATE runtimes SET status='ready' WHERE runtime_id=?").run(id.runtimeId)
result.existingReady = await call(id.runtimeId)
assert.equal(result.existingReady.status, 200)
assert.equal(result.existingReady.body.activeInvocationId, id.invocationId)
assert.equal((await fleetEstablishment(root, joined)).state, 'established')
result.unknown = await call('rt-unrelated-missing')
assert.equal(result.unknown.status, 404)
assert.equal(result.unknown.body.error.code, 'unknown_runtime')
db.query("UPDATE runtimes SET status='terminated' WHERE runtime_id=?").run(id.runtimeId)
db.close()
await Bun.write(out, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
