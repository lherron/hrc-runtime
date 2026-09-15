/**
 * T-08349 correction RED — C-22757 / EN-12315.
 *
 * Two negatives that the previously green happy-path lanes cannot express:
 *
 * 1. The writer HRC asks about must be the actual writer being replaced. The
 *    broker instance HRC committed at install acknowledgement is a bridge; it
 *    is not an application host incarnation, and its id must never be relabeled
 *    as one on the basis of the join direction. For `hrc-hosted` the evidence
 *    owner is HRC's own committed instance facts, so a legacy hosted adapter
 *    that exposes neither optional writer method still works.
 *
 * 2. Classification compares the candidate against the last ACTIVATED known
 *    evidence, not against whatever the immediately prior attempt happened to
 *    carry. An unknown attempt in between preserves the retained baseline, and
 *    an allocated-but-never-activated candidate never becomes that baseline.
 *
 * These cases drive the real HTTP registration handler. Activation itself needs
 * a real broker and is proved in the isolated installed both-join artifact; the
 * activation-owned commit is exercised here through the same repository call
 * the activation transaction makes.
 *
 * Every case waits for durable establishment exhaustion before touching the
 * store, so no background retry races the fixture's own transitions, and the
 * tmux double refuses to create any window: no real tmux server, broker process
 * or pane is produced by this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  ParticipantAdapter,
  WriterEvidence,
  WriterInspectionRequest,
  WriterRef,
  WriterRetirementRequest,
} from 'spaces-runtime-contracts'

import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions, RegistrationClassConfig } from '../index.js'
import { ParticipantAdapterRegistry } from '../participant-adapter-registry.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type GenericParticipantClass = {
  classId: string
  adapterId: string
  join: 'hrc-hosted' | 'participant-served'
  address: 'permanent-keyed'
  continuity: 'key-scoped'
  replaySemantics: 'none' | 'full-source-replay'
  scopeTemplate: { agent: string; project: string }
  maxInstances: number
  defaultTtl: number
}

const hostedClass: GenericParticipantClass = {
  classId: 't08349-writer-hosted',
  adapterId: 'controlled-participant',
  join: 'hrc-hosted',
  address: 'permanent-keyed',
  continuity: 'key-scoped',
  replaySemantics: 'none',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
}

const servedClass: GenericParticipantClass = {
  ...hostedClass,
  classId: 't08349-writer-served',
  join: 'participant-served',
  replaySemantics: 'full-source-replay',
}

const FIXED_NOW = '2026-09-15T15:00:00.000Z'

type ContinuityToken = 'first' | 'same' | 'changed'

function evidenceFor(token: ContinuityToken): { kind: 'controlled-continuity/v1'; token: string } {
  return { kind: 'controlled-continuity/v1', token }
}

function serializedEvidence(token: ContinuityToken): string {
  return JSON.stringify(evidenceFor(token))
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

/** Records every writerRef the adapter is asked about, verbatim. */
function capturingAdapter(
  adapterId: string,
  workspaceCwd: string,
  evidence: Pick<WriterEvidence, 'writePath' | 'liveness' | 'priorRecovery'>
): { adapter: ParticipantAdapter; asked: WriterRef[] } {
  const base = createControlledParticipantAdapter({ adapterId, workspaceCwd })
  const asked: WriterRef[] = []
  const answer = (request: WriterRetirementRequest | WriterInspectionRequest): WriterEvidence => {
    asked.push({ ...request.writerRef })
    return {
      schemaVersion: 'writer-evidence/v1',
      writerRef: { ...request.writerRef },
      observedAt: FIXED_NOW,
      ...evidence,
    }
  }
  return {
    asked,
    adapter: {
      adapterId: base.adapterId,
      admit: (input) => base.admit(input),
      prepare: (input) => base.prepare(input),
      retireWriter: answer,
      inspectWriter: answer,
    },
  }
}

/** A hosted adapter predating the writer-evidence seam: neither optional method. */
function legacyHostedAdapter(adapterId: string, workspaceCwd: string): ParticipantAdapter {
  const base = createControlledParticipantAdapter({ adapterId, workspaceCwd })
  return {
    adapterId: base.adapterId,
    admit: (input) => base.admit(input),
    prepare: (input) => base.prepare(input),
  }
}

type FakeWindow = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}
type FakePaneProcess = { command: string; pid: number; dead: boolean; commandLine?: string }

/**
 * A tmux double with two phases. `unavailable` makes hosted realization fail
 * fast, so the establishment chain exhausts without producing any resource.
 * `observing` then serves the one committed broker window that the writer
 * evidence path re-reads. It never creates a window in either phase.
 */
function fakeTmux() {
  const state: {
    mode: 'unavailable' | 'observing'
    window: FakeWindow | null
    process: FakePaneProcess | null
  } = { mode: 'unavailable', window: null, process: null }
  return {
    state,
    factory: (opts: { socketPath: string }) => ({
      initialize: async () => {
        if (state.mode === 'unavailable') {
          throw new Error('fixture tmux is unavailable for this phase')
        }
      },
      inspectWindow: async (input: { sessionName: string; windowName: string }) =>
        state.window !== null &&
        state.window.socketPath === opts.socketPath &&
        state.window.sessionName === input.sessionName &&
        state.window.windowName === input.windowName
          ? state.window
          : null,
      createWindowWithCommand: async () => {
        throw new Error('fixture tmux must never create a participant broker window')
      },
      createOrInspectWindow: async () => {
        throw new Error('fixture tmux must never create a participant window')
      },
      inspectPaneProcess: async (paneId: string) =>
        state.window?.paneId === paneId ? state.process : null,
    }),
  }
}

type SettledAttempt = {
  registrationId: string
  attemptId: string
  invocationId: string
  hostingIntentJson: string
}

/**
 * Waits for the durable establishment work item to exhaust. Exhaustion stops
 * rescheduling, which is what makes the following store edits race-free.
 */
async function settled(
  dbPath: string,
  classId: string,
  participantKey: string
): Promise<SettledAttempt> {
  for (let poll = 0; poll < 400; poll += 1) {
    const db = openHrcDatabase(dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        classId,
        participantKey
      )
      const attempt =
        registration === null
          ? null
          : db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
      if (
        registration !== null &&
        attempt !== null &&
        attempt.hostingIntentJson !== undefined &&
        attempt.establishmentWorkState === 'exhausted'
      ) {
        return {
          registrationId: registration.registrationId,
          attemptId: attempt.attemptId,
          invocationId: attempt.invocationId,
          hostingIntentJson: attempt.hostingIntentJson,
        }
      }
    } finally {
      db.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('participant establishment never exhausted its durable retries')
}

function realizedLease(window: FakeWindow): string {
  return JSON.stringify({
    schemaVersion: 'participant-realized-hosting/v1',
    endpoint: { kind: 'unix-jsonrpc-ndjson' },
    substrate: { kind: 'leased-tmux', brokerWindow: window, pid: 83_349, command: 'bun' },
    presentation: { kind: 'none' },
  })
}

/** Walks a stalled hosted attempt to the producer terminal HRC itself projects. */
function driveToProducerTerminal(
  db: HrcDatabase,
  attemptId: string,
  window: FakeWindow,
  brokerInstanceId: string
): void {
  const snapshots: Array<['realizedHostingJson' | 'dispatchJson' | 'brokerIdentityJson', string]> =
    [
      ['realizedHostingJson', realizedLease(window)],
      ['dispatchJson', '{}'],
      ['brokerIdentityJson', JSON.stringify({ brokerInstanceId })],
    ]
  for (const [field, value] of snapshots) {
    expect(
      db.participantRegistrations.setSnapshotIfAbsent(attemptId, field, value, FIXED_NOW)
    ).toBe(true)
  }
  const walk: Array<
    [
      from:
        | 'HOSTING_INTENT_PERSISTED'
        | 'REALIZED'
        | 'DISPATCH_FROZEN'
        | 'INSTALL_CONFIRMED'
        | 'INVOCATION_READY',
      to: 'REALIZED' | 'DISPATCH_FROZEN' | 'INSTALL_CONFIRMED' | 'INVOCATION_READY' | 'TERMINAL',
    ]
  > = [
    ['HOSTING_INTENT_PERSISTED', 'REALIZED'],
    ['REALIZED', 'DISPATCH_FROZEN'],
    ['DISPATCH_FROZEN', 'INSTALL_CONFIRMED'],
    ['INSTALL_CONFIRMED', 'INVOCATION_READY'],
    ['INVOCATION_READY', 'TERMINAL'],
  ]
  for (const [from, to] of walk) {
    expect(
      db.participantRegistrations.transitionAttempt(
        attemptId,
        [from],
        to,
        FIXED_NOW,
        to === 'TERMINAL' ? 'producer-terminal:process-exit' : undefined
      )
    ).toBe(true)
  }
}

describe('T-08349 exact writer identity', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08349-writer-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  /**
   * `brokerTmuxManagerFactory` is an instance seam, not a construction option,
   * so it is installed on the constructed daemon before the first registration.
   * Without it a hosted class realizes a real tmux window and a real broker.
   */
  async function start(
    options: Partial<HrcServerOptions>,
    tmuxFactory?: ReturnType<typeof fakeTmux>['factory']
  ): Promise<void> {
    const started = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses: [], ...options })
    )
    if (tmuxFactory !== undefined) {
      ;(started as unknown as { brokerTmuxManagerFactory: unknown }).brokerTmuxManagerFactory =
        tmuxFactory
    }
    server = started
  }

  test('asks the participant-served owner about the exact bridge writer', async () => {
    const capturing = capturingAdapter(servedClass.adapterId, fixture.tmpDir, {
      writePath: { state: 'retired', reason: 'bridge writer retired' },
      liveness: { state: 'dead', reason: 'bridge process exited' },
      priorRecovery: { state: 'recovered', reason: 'replay drained' },
    })
    await start({
      registrationClasses: [servedClass] as unknown as readonly RegistrationClassConfig[],
      participantAdapterRegistry: new ParticipantAdapterRegistry([capturing.adapter]),
    })

    const first = await body(
      await fixture.postJson('/v1/participants/register', {
        classId: servedClass.classId,
        processToken: 'first-process',
        participantKey: 'served-writer-key',
        socketPath: `${fixture.tmpDir}/served-first.sock`,
        evidence: evidenceFor('first'),
      })
    )
    expect(first).toMatchObject({ status: 'registered', created: true })
    const prior = await settled(fixture.dbPath, servedClass.classId, 'served-writer-key')

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      expect(
        db.participantRegistrations.setSnapshotIfAbsent(
          prior.attemptId,
          'brokerIdentityJson',
          JSON.stringify({ brokerInstanceId: 'served-bridge-instance' }),
          FIXED_NOW
        )
      ).toBe(true)
    } finally {
      db.close()
    }

    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: servedClass.classId,
        processToken: 'successor-process',
        participantKey: 'served-writer-key',
        socketPath: `${fixture.tmpDir}/served-successor.sock`,
        evidence: evidenceFor('changed'),
      })
    )

    expect(capturing.asked).toHaveLength(1)
    expect(capturing.asked[0]).toEqual({
      subject: 'bridge',
      classId: servedClass.classId,
      participantKey: 'served-writer-key',
      attemptId: prior.attemptId,
      invocationId: prior.invocationId as WriterRef['invocationId'],
      attachEpoch: 1,
      brokerInstanceId: 'served-bridge-instance',
    })
    expect(Object.hasOwn(capturing.asked[0] ?? {}, 'hostIncarnationId')).toBe(false)
  }, 60_000)

  test('never asks a hosted adapter to speak for the HRC-owned broker writer', async () => {
    const tmux = fakeTmux()
    const capturing = capturingAdapter(hostedClass.adapterId, fixture.tmpDir, {
      writePath: { state: 'retired', reason: 'adapter must not be consulted' },
      liveness: { state: 'dead', reason: 'adapter must not be consulted' },
      priorRecovery: { state: 'recovered', reason: 'adapter must not be consulted' },
    })
    await start(
      {
        registrationClasses: [hostedClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([capturing.adapter]),
      },
      tmux.factory
    )

    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'first-process',
        participantKey: 'hosted-writer-key',
        evidence: evidenceFor('first'),
      })
    )
    const prior = await settled(fixture.dbPath, hostedClass.classId, 'hosted-writer-key')
    const intent = JSON.parse(prior.hostingIntentJson) as {
      hrcHosted: { tmuxSocketPath: string; sessionName: string; brokerArgv: string[] }
    }
    const window: FakeWindow = {
      socketPath: intent.hrcHosted.tmuxSocketPath,
      sessionName: intent.hrcHosted.sessionName,
      windowName: 'broker',
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
    }
    tmux.state.window = window
    tmux.state.process = null
    tmux.state.mode = 'observing'

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      driveToProducerTerminal(db, prior.attemptId, window, 'hosted-broker-instance')
    } finally {
      db.close()
    }

    const successor = await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'successor-process',
        participantKey: 'hosted-writer-key',
        evidence: evidenceFor('changed'),
      })
    )

    // HRC owns the broker it launched; the adapter is never asked to speak for it.
    expect(capturing.asked).toEqual([])
    expect(successor).toMatchObject({ status: 'registered', created: false })

    const readback = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const evidence = JSON.parse(
        readback.participantRegistrations.getAttempt(prior.attemptId)?.writerEvidenceJson ?? '{}'
      ) as WriterEvidence
      expect(evidence.writerRef).toMatchObject({
        subject: 'bridge',
        brokerInstanceId: 'hosted-broker-instance',
        attemptId: prior.attemptId,
        attachEpoch: 1,
      })
      // A broker instance id is not an application host incarnation id.
      expect(Object.hasOwn(evidence.writerRef, 'hostIncarnationId')).toBe(false)
      // HRC observed only the process it launched. Nothing here claims anything
      // about an external application's fate.
      expect(evidence.liveness.state).toBe('dead')
      expect(evidence.writePath.state).toBe('retired')
    } finally {
      readback.close()
    }
  }, 60_000)

  test('admits a hosted successor for a legacy adapter with neither writer method', async () => {
    const tmux = fakeTmux()
    await start(
      {
        registrationClasses: [hostedClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          legacyHostedAdapter(hostedClass.adapterId, fixture.tmpDir),
        ]),
      },
      tmux.factory
    )

    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'first-process',
        participantKey: 'legacy-hosted-key',
        evidence: evidenceFor('first'),
      })
    )
    const prior = await settled(fixture.dbPath, hostedClass.classId, 'legacy-hosted-key')
    const intent = JSON.parse(prior.hostingIntentJson) as {
      hrcHosted: { tmuxSocketPath: string; sessionName: string }
    }
    const window: FakeWindow = {
      socketPath: intent.hrcHosted.tmuxSocketPath,
      sessionName: intent.hrcHosted.sessionName,
      windowName: 'broker',
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
    }
    tmux.state.window = window
    tmux.state.process = null
    tmux.state.mode = 'observing'

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      driveToProducerTerminal(db, prior.attemptId, window, 'legacy-hosted-instance')
    } finally {
      db.close()
    }

    const successor = await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'successor-process',
        participantKey: 'legacy-hosted-key',
        evidence: evidenceFor('changed'),
      })
    )
    expect(successor).toMatchObject({ status: 'registered', created: false })

    const readback = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const attempts = readback.participantRegistrations.listAttemptsByRegistrationId(
        prior.registrationId
      )
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toMatchObject({ attachEpoch: 2 })
    } finally {
      readback.close()
    }
  }, 60_000)

  test('holds a hosted successor while the committed broker process is still live', async () => {
    const tmux = fakeTmux()
    await start(
      {
        registrationClasses: [hostedClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          legacyHostedAdapter(hostedClass.adapterId, fixture.tmpDir),
        ]),
      },
      tmux.factory
    )

    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'first-process',
        participantKey: 'live-hosted-key',
        evidence: evidenceFor('first'),
      })
    )
    const prior = await settled(fixture.dbPath, hostedClass.classId, 'live-hosted-key')
    const intent = JSON.parse(prior.hostingIntentJson) as {
      hrcHosted: { tmuxSocketPath: string; sessionName: string; brokerArgv: string[] }
    }
    const window: FakeWindow = {
      socketPath: intent.hrcHosted.tmuxSocketPath,
      sessionName: intent.hrcHosted.sessionName,
      windowName: 'broker',
      sessionId: '$1',
      windowId: '@1',
      paneId: '%1',
    }
    tmux.state.window = window
    tmux.state.process = {
      command: 'bun',
      pid: 83_349,
      dead: false,
      commandLine: `bun ${intent.hrcHosted.brokerArgv.join(' ')}`,
    }
    tmux.state.mode = 'observing'

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      expect(
        db.participantRegistrations.setSnapshotIfAbsent(
          prior.attemptId,
          'realizedHostingJson',
          realizedLease(window),
          FIXED_NOW
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.setSnapshotIfAbsent(
          prior.attemptId,
          'brokerIdentityJson',
          JSON.stringify({ brokerInstanceId: 'live-hosted-instance' }),
          FIXED_NOW
        )
      ).toBe(true)
    } finally {
      db.close()
    }

    const successor = await body(
      await fixture.postJson('/v1/participants/register', {
        classId: hostedClass.classId,
        processToken: 'successor-process',
        participantKey: 'live-hosted-key',
        evidence: evidenceFor('changed'),
      })
    )
    // No projected producer terminal and a live committed process: an unknown
    // write path with a live writer holds. HRC claims nothing about any
    // external application.
    expect(successor).toMatchObject({ status: 'pending', reason: 'host_retirement_unproven' })

    const readback = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      expect(
        readback.participantRegistrations.listAttemptsByRegistrationId(prior.registrationId)
      ).toHaveLength(1)
      const evidence = JSON.parse(
        readback.participantRegistrations.getAttempt(prior.attemptId)?.writerEvidenceJson ?? '{}'
      ) as WriterEvidence
      expect(evidence.writerRef.subject).toBe('bridge')
      expect(evidence.liveness.state).toBe('live')
      expect(evidence.writePath.state).toBe('unknown')
    } finally {
      readback.close()
    }
  }, 60_000)
})

describe('T-08349 activation-owned known continuity evidence', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08349-classification-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function startServed(): Promise<void> {
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        registrationClasses: [servedClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          createControlledParticipantAdapter({
            adapterId: servedClass.adapterId,
            workspaceCwd: fixture.tmpDir,
            writerEvidence: {
              observedAt: FIXED_NOW,
              writePath: { state: 'retired', reason: 'bridge writer retired' },
              liveness: { state: 'dead', reason: 'bridge process exited' },
              priorRecovery: { state: 'recovered', reason: 'replay drained' },
            },
          }),
        ]),
      })
    )
  }

  function withDb<T>(read: (db: HrcDatabase) => T): T {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }

  /**
   * Registers, waits for durable exhaustion, then gives the resulting attempt a
   * committed broker identity so the next call can ask about a real writer.
   */
  async function register(
    key: string,
    token: ContinuityToken | 'unknown',
    nonce: string
  ): Promise<SettledAttempt> {
    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: servedClass.classId,
        processToken: `process-${nonce}`,
        participantKey: key,
        socketPath: `${fixture.tmpDir}/${key}-${nonce}.sock`,
        ...(token === 'unknown' ? {} : { evidence: evidenceFor(token) }),
      })
    )
    const current = await settled(fixture.dbPath, servedClass.classId, key)
    withDb((db) => {
      db.participantRegistrations.setSnapshotIfAbsent(
        current.attemptId,
        'brokerIdentityJson',
        JSON.stringify({ brokerInstanceId: `bridge-${nonce}` }),
        FIXED_NOW
      )
    })
    return current
  }

  /** An unknown successor only exists after the prior attempt is absorbing. */
  function absorb(attemptId: string): void {
    withDb((db) => {
      const attempt = db.participantRegistrations.getAttempt(attemptId)
      if (attempt === null) throw new Error('attempt disappeared before absorption')
      expect(
        db.participantRegistrations.transitionAttempt(
          attemptId,
          [attempt.state],
          'ABANDONED',
          FIXED_NOW,
          'fixture-absorbed'
        )
      ).toBe(true)
    })
  }

  /** The commit activation owns; an allocated attempt must never do this itself. */
  function activate(key: string): void {
    withDb((db) => {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        servedClass.classId,
        key
      )
      const attempt = db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )
      if (registration === null || attempt?.continuityEvidenceJson === undefined) {
        throw new Error('no candidate evidence to accept')
      }
      expect(
        db.participantRegistrations.acceptContinuityEvidence({
          registrationId: registration.registrationId,
          continuityEvidenceJson: attempt.continuityEvidenceJson,
          updatedAt: FIXED_NOW,
        })
      ).toBe(true)
    })
  }

  function classification(key: string): string | undefined {
    return withDb((db) => {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        servedClass.classId,
        key
      )
      return db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )?.activationClassification
    })
  }

  function accepted(key: string): string | undefined {
    return withDb(
      (db) =>
        db.participantRegistrations.getRegistrationByClassAndKey(servedClass.classId, key)
          ?.continuityEvidenceJson
    )
  }

  test('registration alone never advances the accepted known evidence', async () => {
    await startServed()
    await register('accept-gate-key', 'first', '1')

    expect(accepted('accept-gate-key')).toBeUndefined()
    expect(classification('accept-gate-key')).toBe('attached')
  }, 60_000)

  test('an unknown attempt preserves the retained known baseline for a replacement', async () => {
    await startServed()
    const first = await register('a-unknown-a-key', 'first', '1')
    activate('a-unknown-a-key')
    absorb(first.attemptId)

    await register('a-unknown-a-key', 'unknown', '2')
    expect(classification('a-unknown-a-key')).toBe('attached_unknown')
    expect(accepted('a-unknown-a-key')).toBe(serializedEvidence('first'))

    await register('a-unknown-a-key', 'first', '3')
    expect(classification('a-unknown-a-key')).toBe('replacement')
  }, 60_000)

  test('an unknown attempt preserves the retained known baseline for a resume', async () => {
    await startServed()
    const first = await register('a-unknown-b-key', 'first', '1')
    activate('a-unknown-b-key')
    absorb(first.attemptId)

    await register('a-unknown-b-key', 'unknown', '2')
    expect(classification('a-unknown-b-key')).toBe('attached_unknown')

    await register('a-unknown-b-key', 'changed', '3')
    expect(classification('a-unknown-b-key')).toBe('resume')
  }, 60_000)

  test('an unactivated candidate never advances the accepted known evidence', async () => {
    await startServed()
    await register('unactivated-key', 'first', '1')
    activate('unactivated-key')

    await register('unactivated-key', 'changed', '2')
    expect(classification('unactivated-key')).toBe('resume')
    // The candidate was allocated but never activated.
    expect(accepted('unactivated-key')).toBe(serializedEvidence('first'))

    await register('unactivated-key', 'first', '3')
    expect(classification('unactivated-key')).toBe('replacement')
    expect(accepted('unactivated-key')).toBe(serializedEvidence('first'))
  }, 60_000)

  test('resumes exactly once across repeated activation of the same known evidence', async () => {
    await startServed()
    await register('resume-once-key', 'first', '1')
    activate('resume-once-key')

    const second = await register('resume-once-key', 'changed', '2')
    expect(classification('resume-once-key')).toBe('resume')
    activate('resume-once-key')
    absorb(second.attemptId)

    await register('resume-once-key', 'changed', '3')
    expect(classification('resume-once-key')).toBe('replacement')
  }, 60_000)
})
