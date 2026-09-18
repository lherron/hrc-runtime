/**
 * Shared preamble for the split T-07615 kicker suites
 * (`server-hrcmail-kicker.test.ts`, `server-hrcmail-kicker-2.test.ts`).
 *
 * The 1000-line test-size gate counts `*.test.ts` files only, so this sibling
 * module carries the fixture that both files need. State is per-file: each
 * test file owns its lets and registers its own beforeEach/afterEach against
 * `setupKickerPreamble` / `teardownKickerPreamble` (a top-level hook here
 * would fire once for the first importing file only — see the T-08596 split).
 */
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import type { MailKicker } from 'hrc-mail-kicker'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import {
  type AspdObservationDouble,
  startAspdObservationDouble,
} from './fixtures/aspd-observation-doubles.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { installMailKickerAgentHome, landSubmission } from './fixtures/mail-kicker-harness.js'

export const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07615/lane:main'
export const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07615'
export const SENDER = 'mable@hrc-runtime:T-07615'

export type KickerPreamble = {
  fixture: HrcServerTestFixture
  ledger: FakeWrkqLedger
  restoreAgentHome: () => void
  aspdDouble: AspdObservationDouble | undefined
  savedAspdSocket: string | undefined
}

export async function setupKickerPreamble(): Promise<KickerPreamble> {
  const fixture = await createHrcTestFixture('hrc-mail-kicker-')
  const ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')
  const restoreAgentHome = home.restore
  // Fixture homes are invisible to a real aspd: serve declarations from the
  // observation double with disk lookup over the fixture root (unknown agents
  // still answer agent_not_found, which the negative placement test needs).
  const savedAspdSocket = process.env['HRC_ASPD_SOCKET']
  const aspdSocket = join(fixture.tmpDir, 'aspd.sock')
  const aspdDouble = startAspdObservationDouble(
    aspdSocket,
    {
      releaseId: 'asp-kicker-fixture',
      sourceCommit: 'c'.repeat(40),
      builtAt: '2026-09-18T00:00:00.000Z',
      releaseRoot: fixture.tmpDir,
    },
    { agentsRoots: [home.agentsRoot] }
  )
  process.env['HRC_ASPD_SOCKET'] = aspdSocket
  return { fixture, ledger, restoreAgentHome, aspdDouble, savedAspdSocket }
}

export async function teardownKickerPreamble(input: {
  server: HrcServer | undefined
  fixture: HrcServerTestFixture
  aspdDouble: AspdObservationDouble | undefined
  savedAspdSocket: string | undefined
  restoreAgentHome: () => void
}): Promise<void> {
  if (input.server !== undefined) {
    await input.server.stop()
  }
  input.aspdDouble?.stop()
  if (input.savedAspdSocket === undefined) Reflect.deleteProperty(process.env, 'HRC_ASPD_SOCKET')
  else process.env['HRC_ASPD_SOCKET'] = input.savedAspdSocket
  input.restoreAgentHome()
  await input.fixture.cleanup()
}

export function sayToLedger(
  ledger: FakeWrkqLedger,
  overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}
) {
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, ...overrides })
}

export function kickerOf(server: HrcServer): MailKicker {
  return (server as any).mailKicker
}

export function farFuture(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString()
}

export async function buildKickerServer(
  fixture: HrcServerTestFixture,
  ledger: FakeWrkqLedger,
  options: Record<string, unknown> = {}
): Promise<HrcServer> {
  return await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      ...options,
    })
  )
}

/**
 * T-07612 rev 4: a busy seat is presented slot-less with the route's queue
 * policy. The double answers like the route does for a queued input: a run
 * row in `accepted`, `status:'started'`, an inputId.
 */
export function installQueuedDispatch(serverInstance: HrcServer): { calls: () => number } {
  let calls = 0
  ;(serverInstance as any).dispatchTurnForSession = async (
    session: HrcSessionRecord,
    _intent: unknown,
    _prompt: string
  ): Promise<Response> => {
    calls += 1
    const db = (serverInstance as any).db as HrcDatabase
    const runtime = db.runtimes.listByHostSessionId(session.hostSessionId).at(-1)
    const runId = `run-queued-${calls}`
    const now = timestamp()
    db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime?.runtimeId ?? 'rt-busy-v1',
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })
    const runtimeId = runtime?.runtimeId ?? 'rt-busy-v1'
    landSubmission(serverInstance, {
      runtimeId,
      submissionId: `input-${runId}`,
      type: 'submission.executed',
    })
    return Response.json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId,
      transport: 'headless',
      status: 'started',
      submissionId: `input-${runId}`,
      admission: 'admitted',
      inputId: `input-${runId}`,
      supportsInFlightInput: false,
    })
  }
  return { calls: () => calls }
}
