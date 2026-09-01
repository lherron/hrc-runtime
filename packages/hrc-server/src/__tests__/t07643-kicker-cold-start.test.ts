import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { WrkqLedgerUnavailableError } from '../wrkq/ledger-client.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  installDeterministicStart,
  installMailKickerAgentHome,
  queryCount,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07643 — the cold-start gap.
 *
 * A first-ever start persists its tail cursor at the ledger's END, and the
 * periodic sweep only ever looks at seated scopes. Between the two, an envelope
 * that was ALREADY pending against a scope this node homes but is not seating
 * had no deliverer at all: it stayed `pending` with an empty `presentedTo`
 * until some unrelated later envelope to the same scope happened to sweep it
 * up. Observed on svc and lab at the T-07616 flag day, where exactly that
 * rescue is what made the first two readings of the bug wrong.
 *
 * The proof shape is mable's ruling: fresh node state, a NON-EMPTY ledger, a
 * pending envelope to an unseated homed scope, and the first start must present
 * it — with the ordinary floor and rounds untouched afterwards.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07643/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07643'
const SENDER = 'mable@hrc-runtime:T-07643'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-kicker-cold-start-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')).restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07643', ...overrides })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Long enough that only an explicit call drives anything: the proof is
      // about the FIRST tail, not about whichever timer happened to fire.
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
    })
  )
  return server
}

/** Bind the scope to this node the way a birth would, without seating it. */
function homeScopeHere(serverInstance: HrcServer, homeNodeId?: string): void {
  createPlacementLedgerRepository((serverInstance as any).db.sqlite).installActive({
    scopeRef: SCOPE,
    homeNodeId: homeNodeId ?? ((serverInstance as any).federationNodeId as string),
    placementSource: 'pin',
    updatedAt: timestamp(),
  })
}

/** Watch pendingView's scope lists, so "queried" can be asserted, not inferred. */
function recordPendingViewScopes(): string[][] {
  const seen: string[][] = []
  const real = ledger.pendingView.bind(ledger)
  ledger.pendingView = async (params) => {
    if (params.scopes !== undefined) seen.push(params.scopes)
    return real(params)
  }
  return seen
}

describe('T-07643 — a first start delivers the backlog for the scopes it homes', () => {
  it('presents an envelope that predates its very first tail', async () => {
    // Written before this node's kicker ever ran: it sits behind the cursor the
    // first tail mints, and its scope has no seat for the sweep to find.
    const envelope = say({ body: 'pending before this node ever tailed' })
    await startServer()
    homeScopeHere(server as HrcServer)
    const deterministic = installDeterministicStart(server as HrcServer)

    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'cold-start catch-up summoned the target')

    const db = (server as any).db as HrcDatabase
    expect(db.sessions.listByScopeRef(SCOPE, 'main')).toHaveLength(1)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    // The cursor still starts at the END. The catch-up is what reaches the
    // backlog; widening the tail's start would replay the whole log.
    expect(db.wrkqLedgerCursors.get()).toBeGreaterThan(0)
    expect(db.mailDrives.listAttempts(TARGET)[0]?.wakeReason).toBe('recovery')
  })

  it('runs exactly once, and not at all on a restart that already has a cursor', async () => {
    say({ body: 'the backlog' })
    await startServer()
    homeScopeHere(server as HrcServer)
    const scopes = recordPendingViewScopes()
    const deterministic = installDeterministicStart(server as HrcServer)

    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'catch-up ran once')
    expect(scopes.flat()).toContain(TARGET)

    scopes.length = 0
    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    // Disarmed: a second tail reads the event page and nothing else, so an
    // unseated homed scope is not re-queried every tick forever.
    expect(scopes.flat()).not.toContain(TARGET)

    await (server as unknown as HrcServer).stop()
    server = undefined
    await startServer()
    const afterRestart = recordPendingViewScopes()
    installDeterministicStart(server as HrcServer)
    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    expect(afterRestart.flat()).not.toContain(TARGET)
  })

  it('leaves the backlog of a scope another node homes alone', async () => {
    say({ body: 'not this node to deliver' })
    await startServer()
    homeScopeHere(server as HrcServer, 'some-other-node')
    const deterministic = installDeterministicStart(server as HrcServer)

    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    expect(deterministic.calls()).toBe(0)
    expect(queryCount((server as any).db as HrcDatabase, 'sessions')).toBe(0)
  })

  it('retries the catch-up rather than losing the backlog to one wrkq blink', async () => {
    const envelope = say({ body: 'written while wrkq was about to blink' })
    await startServer()
    homeScopeHere(server as HrcServer)
    const deterministic = installDeterministicStart(server as HrcServer)

    // The EVENT view answers, so the cursor is minted and "no cursor" will
    // never be true in this store again; only the catch-up's pendingView fails.
    // That is the case the armed intent exists for — re-detection cannot save
    // it, because by then there is nothing left to detect.
    const real = ledger.pendingView.bind(ledger)
    let blink = true
    ledger.pendingView = async (params) => {
      if (blink) {
        blink = false
        throw new WrkqLedgerUnavailableError('wrkq blinked', 'wrkq.envelope.pendingView')
      }
      return real(params)
    }

    await (server as any).runWrkqLedgerTail()
    await Bun.sleep(50)
    const db = (server as any).db as HrcDatabase
    expect(deterministic.calls()).toBe(0)
    expect(db.wrkqLedgerCursors.get()).toBeGreaterThan(0)

    await (server as any).runWrkqLedgerTail()
    await waitUntil(() => deterministic.calls() === 1, 'catch-up retried after recovery')
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('names the target it is talking about, instead of redacting it', async () => {
    say()
    await startServer()
    homeScopeHere(server as HrcServer)
    installDeterministicStart(server as HrcServer)

    const lines: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    try {
      await (server as any).runWrkqLedgerTail()
      await waitUntil(
        () => lines.some((line) => line.includes('wrkq.kicker.turn_dispatched')),
        'turn dispatched and logged'
      )
    } finally {
      process.stderr.write = original
    }

    const dispatched = lines.filter((line) => line.includes('wrkq.kicker.turn_dispatched'))
    expect(dispatched).toHaveLength(1)
    // `targetSessionRef` matched the log redactor's `session` pattern by
    // accident. Redacting it made every kicker line a log about nobody, which
    // is how a live delivery gap stayed unreadable while it was happening.
    expect(dispatched[0]).toContain(TARGET)
    expect(dispatched[0]).not.toContain('[REDACTED]')
  })
})
