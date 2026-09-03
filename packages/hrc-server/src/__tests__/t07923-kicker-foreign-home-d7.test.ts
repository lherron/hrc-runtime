import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { MailKicker } from 'hrc-mail-kicker'
import { openBindingRegistry } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { FederationConfig, PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PeerToken } from '../federation/peer-token.js'
import { resolveBindingRegistryPath } from '../federation/registry-endpoint.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  installMailKickerAgentHome,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

const AGENT = 'kicker-foreign-d7'
const SCOPE = `agent:${AGENT}:project:hrc-runtime:task:T-07923`
const TARGET = `${SCOPE}/lane:main`
const SENDER = 'mable@hrc-runtime:T-07923'
const LOCAL_NODE = 'lab'
const HOME_NODE = 'max3'
const NOW = '2026-09-02T20:40:00.000Z'

type KickerInternals = HrcServer & {
  db: HrcDatabase
  federationRegistryClient: {
    consult: (scopeRef: string) => Promise<unknown>
  }
  mailKicker: MailKicker
  ensureTargetSession: (...args: unknown[]) => Promise<unknown>
}

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-kicker-foreign-d7-')
  ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, AGENT)
  await writeFile(join(home.agentsRoot, AGENT, 'SOUL.md'), `# ${AGENT}\n`)
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

function reserveLoopbackBind(): string {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  return `http://127.0.0.1:${port}`
}

function federationConfig(): FederationConfig {
  const peer = parseNodeId(HOME_NODE, 'test peer')
  const peers = new Map<string, PeerEntry>([
    [
      peer,
      {
        nodeId: peer,
        endpoint: 'http://max3.example.ts.net:18490/',
        token: new PeerToken('t07923-test-token'),
      },
    ],
  ])
  return {
    nodeId: parseNodeId(LOCAL_NODE, 'test node'),
    nodeIdProvenance: 'declared',
    sourcePath: `${fixture.stateRoot}/federation.json`,
    sourceExists: true,
    peers,
    registry: { bind: reserveLoopbackBind() },
    gate: { mode: 'enforce', registryHost: parseNodeId(LOCAL_NODE, 'test registry host') },
    warnings: [],
  } as FederationConfig
}

function bindScopeToForeignHome(): void {
  const registry = openBindingRegistry(resolveBindingRegistryPath(fixture.stateRoot))
  try {
    registry.establish({ scopeRef: SCOPE, homeNodeId: HOME_NODE, now: NOW })
  } finally {
    registry.close()
  }
}

async function startServer(): Promise<KickerInternals> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      federationConfig: federationConfig(),
    })
  )
  return server as KickerInternals
}

function say() {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: SENDER,
    roomKey: 'T-07923',
    body: 'must remain pending on the node that actually homes this scope',
  })
}

function refuseNextBirth(hrc: KickerInternals, reason = 'routed-elsewhere'): void {
  hrc.ensureTargetSession = async (): Promise<never> => {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, `${SCOPE} routes elsewhere`, {
      scopeRef: SCOPE,
      path: 'ensure-target',
      reason,
      retryable: false,
      homeNodeId: HOME_NODE,
    })
  }
}

function seedRefusedBirth(hrc: KickerInternals, envelopeId: string): void {
  const claimed = hrc.db.mailDrives.claim(TARGET, 'insert', { envelopeIds: [envelopeId] })
  if (claimed.outcome !== 'acquired') throw new Error('failed to seed refused birth')
  hrc.db.mailDrives.failWithoutStart(claimed.attempt.driveAttemptId, 'seeded birth refusal')
}

function eventLines(lines: readonly string[], event: string): string[] {
  return lines.filter((line) => line.includes(event))
}

describe("T-07923 — foreign-home scopes are outside this node's D7 authority", () => {
  it('does not charge a routed-elsewhere insert refusal after the registry binds elsewhere', async () => {
    const hrc = await startServer()
    refuseNextBirth(hrc)
    await hrc.mailKicker.runTailOnce()

    const envelope = say()
    await hrc.mailKicker.runTailOnce()
    await waitUntil(
      () => hrc.db.mailDrives.listAttempts(TARGET)[0]?.state === 'failed',
      'insert wake recorded its routed-elsewhere refusal'
    )
    const refused = hrc.db.mailDrives.listAttempts(TARGET)[0]
    expect(refused?.state).toBe('failed')
    expect(refused?.hostSessionId).toBeUndefined()

    bindScopeToForeignHome()
    const { lines } = await captureServerLog(async () => {
      await hrc.mailKicker.runSweepOnce()
      await hrc.mailKicker.runSweepOnce()
      await hrc.mailKicker.runSweepOnce()
    })

    expect(eventLines(lines, 'wrkq.kicker.unborn_birth_retry')).toHaveLength(0)
    expect(eventLines(lines, 'wrkq.kicker.birth_refusals_exhausted')).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(hrc.db.mailDrives.listRefusedBirthTargets()).toEqual([])
  })

  it('durably prunes a pre-existing refused row on the first foreign-home sweep', async () => {
    bindScopeToForeignHome()
    const hrc = await startServer()
    const envelope = say()
    seedRefusedBirth(hrc, envelope.id)
    expect(hrc.db.mailDrives.listRefusedBirthTargets()).toEqual([TARGET])

    const { lines } = await captureServerLog(async () => {
      await hrc.mailKicker.runSweepOnce()
    })

    expect(eventLines(lines, 'wrkq.kicker.unborn_birth_retry')).toHaveLength(0)
    expect(hrc.db.mailDrives.listRefusedBirthTargets()).toEqual([])
    expect(hrc.db.mailDrives.listAttempts(TARGET).at(-1)?.state).toBe('withdrawn')
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
  })

  it('re-consults home authority at D7 and never calls envelope.fail for a foreign scope', async () => {
    bindScopeToForeignHome()
    const hrc = await startServer()
    const envelope = say()
    seedRefusedBirth(hrc, envelope.id)
    hrc.mailKicker.mailKickerBirthSweepBackoff.set(TARGET, { attempts: 4, nextAtMs: 0 })
    refuseNextBirth(hrc, 'simulated-local-refusal')

    const realConsult = hrc.federationRegistryClient.consult.bind(hrc.federationRegistryClient)
    let consults = 0
    hrc.federationRegistryClient.consult = async (scopeRef: string) => {
      consults += 1
      if (consults === 1) return { outcome: 'unbound' }
      return realConsult(scopeRef)
    }

    const { lines } = await captureServerLog(async () => {
      await hrc.mailKicker.runSweepOnce()
    })

    expect(consults).toBe(2)
    expect(eventLines(lines, 'wrkq.kicker.undeliverable_skipped_foreign_home')).toHaveLength(1)
    expect(eventLines(lines, 'wrkq.kicker.birth_refusals_exhausted')).toHaveLength(0)
    expect(ledger.failRequests).toHaveLength(0)
    expect(ledger.envelopes.get(envelope.id)?.state).toBe('pending')
    expect(hrc.db.mailDrives.listRefusedBirthTargets()).toEqual([])
  })
})
