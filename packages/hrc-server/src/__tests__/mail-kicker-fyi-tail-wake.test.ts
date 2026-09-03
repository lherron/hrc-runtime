import { afterEach, beforeEach, expect, it } from 'bun:test'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  installDeterministicStart,
  installMailKickerAgentHome,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * A fyi never summons, but it IS injected into a seated addressee (the
 * `wrkc say --fyi` contract). Before this, the ledger tail skipped every fyi
 * and the only path to a seated addressee was the thirty-tick periodic sweep,
 * so a fyi to an idle seat landed up to thirty seconds after it was sent
 * (observed at 29s, mable@hcs:fixall -> mable@hcs:primary, 2026-09-02 12:03Z).
 * The unseated case is unchanged and stays covered in
 * `server-hrcmail-kicker.test.ts` ("never summons for a fyi").
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07615/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07615'
const SENDER = 'mable@hrc-runtime:T-07615'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-kicker-fyi-')
  ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')
  restoreAgentHome = home.restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

it('wakes a seated addressee for a fyi from the tail, without waiting for the sweep', async () => {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  const resolved = await fixture.resolveSession(SCOPE)
  const db = (server as any).db as HrcDatabase
  const now = timestamp()
  db.runtimes.insert({
    runtimeId: 'rt-fyi-tail-seat',
    runtimeKind: 'harness',
    hostSessionId: resolved.hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: resolved.generation,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    statusChangedAt: now,
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  const deterministic = installDeterministicStart(server)
  // Establish the cursor first: a virgin daemon starts at "now".
  await (server as any).mailKicker.runTailOnce()
  const envelope = ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: SENDER,
    obligation: 'fyi',
    body: 'seated fyi lands now',
  })

  // The tail alone — no sweep — must present it, because the addressee is
  // seated.
  await (server as any).mailKicker.runTailOnce()
  await waitUntil(
    () => ledger.envelopes.get(envelope.id)?.state === 'acked',
    'fyi presented from the tail'
  )
  expect(deterministic.calls()).toBe(1)
  expect(deterministic.prompts()[0]).toContain('seated fyi lands now')
  const attempts = db.mailDrives.listAttempts(TARGET)
  expect(attempts).toHaveLength(1)
  expect(attempts[0]?.wakeReason).toBe('insert')
})
