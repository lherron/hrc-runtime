import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { failEnvelopeWithAudit } from 'hrc-mail-kicker'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { captureServerLog, serverInternals } from './fixtures/mail-kicker-harness.js'

const SCOPE = 'agent:terminal-audit:project:hrc-runtime:task:T-07917'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME_ID = 'rt-terminal-audit-live'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-envelope-terminal-')
  ledger = new FakeWrkqLedger()
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: false,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  await fixture.cleanup()
})

async function seedLiveRuntime(): Promise<void> {
  const active = server as HrcServer
  const session = await fixture.resolveSession(SCOPE)
  const now = timestamp()
  serverInternals(active).db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: session.generation,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    statusChangedAt: now,
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
}

describe('T-07917 envelope terminal boundary', () => {
  it('suppresses undeliverable while the target has a non-runtime-dead local runtime', async () => {
    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromPrincipalRef: 'agent:lance',
      roomKey: 'T-07917',
      body: 'held behind a live busy seat',
    })
    await seedLiveRuntime()

    const captured = await captureServerLog(async () => {
      await failEnvelopeWithAudit((server as any).mailKicker, {
        envelope: envelope.id,
        reason: 'undeliverable',
        targetSessionRef: TARGET,
        callSite: 'birth_refusals_exhausted',
      })
    })

    expect(ledger.envelopes.get(envelope.id)).toMatchObject({ state: 'pending', terminal: false })
    expect(ledger.failRequests).toEqual([])
    expect(
      captured.lines.some(
        (line) =>
          line.includes('wrkq.kicker.envelope_terminal_suppressed') &&
          line.includes(`"envelope":"${envelope.id}"`) &&
          line.includes('"reason":"undeliverable"') &&
          line.includes('"callSite":"birth_refusals_exhausted"') &&
          line.includes(`"targetSessionRef":"${TARGET}"`) &&
          line.includes(`"runtimeId":"${RUNTIME_ID}"`) &&
          line.includes('"runtimeStatus":"busy"')
      )
    ).toBe(true)
  })

  it('logs the envelope, reason, target, and call site before the terminal RPC', async () => {
    const envelope = ledger.say({ toScopeRef: SCOPE, roomKey: 'T-07917' })

    const captured = await captureServerLog(async () => {
      await failEnvelopeWithAudit((server as any).mailKicker, {
        envelope: envelope.id,
        reason: 'undeliverable',
        targetSessionRef: TARGET,
        callSite: 'birth_refusals_exhausted',
      })
    })

    const before = captured.lines.findIndex((line) =>
      line.includes('wrkq.kicker.envelope_terminal_call')
    )
    const after = captured.lines.findIndex((line) => line.includes('wrkq.kicker.envelope_failed'))
    expect(before).toBeGreaterThanOrEqual(0)
    expect(after).toBeGreaterThan(before)
    expect(captured.lines[before]).toContain(`"envelope":"${envelope.id}"`)
    expect(captured.lines[before]).toContain('"reason":"undeliverable"')
    expect(captured.lines[before]).toContain('"callSite":"birth_refusals_exhausted"')
    expect(captured.lines[before]).toContain(`"targetSessionRef":"${TARGET}"`)
    expect(captured.lines[before]).toContain('"phase":"before_rpc"')
    const jsonStart = captured.lines[before]?.indexOf('{') ?? -1
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    const audit = JSON.parse(captured.lines[before]?.slice(jsonStart) ?? '{}') as Record<
      string,
      unknown
    >
    expect(audit).toMatchObject({
      processId: process.pid,
      processArgv0: process.argv0,
      operation: 'fail',
      callSite: 'birth_refusals_exhausted',
      envelope: envelope.id,
    })
    expect(typeof audit.processRole).toBe('string')
    expect((audit.processRole as string).length).toBeGreaterThan(0)
    expect(typeof audit.serverInstanceId).toBe('string')
    expect((audit.serverInstanceId as string).length).toBeGreaterThan(0)
  })
})
