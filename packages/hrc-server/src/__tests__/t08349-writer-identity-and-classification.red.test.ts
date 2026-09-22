/**
 * T-08349 correction RED — C-22757 / EN-12315.
 *
 * Two negatives that the previously green happy-path lanes cannot express:
 *
 * 1. The writer HRC asks about must be the actual writer being replaced. The
 *    broker instance HRC committed at install acknowledgement is a bridge; it
 *    is not an application host incarnation, and its id must never be relabeled
 *    as one on the basis of the join direction.
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

import { openHrcDatabase } from 'hrc-store-sqlite'
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
import { isAbsorbingParticipantAttempt } from '../participant-writer-evidence.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

type GenericParticipantClass = {
  classId: string
  adapterId: string
  join: 'participant-served'
  address: 'permanent-keyed'
  continuity: 'key-scoped'
  replaySemantics: 'none' | 'full-source-replay'
  scopeTemplate: { agent: string; project: string }
  maxInstances: number
  defaultTtl: number
}

const servedClass: GenericParticipantClass = {
  classId: 't08349-writer-served',
  adapterId: 'controlled-participant',
  join: 'participant-served',
  address: 'permanent-keyed',
  continuity: 'key-scoped',
  replaySemantics: 'full-source-replay',
  scopeTemplate: { agent: 'smokey', project: 'hrc-runtime' },
  maxInstances: 2,
  defaultTtl: 60,
}

const FIXED_NOW = '2026-09-15T15:00:00.000Z'

type ContinuityToken = 'first' | 'same' | 'changed'

function evidenceFor(token: ContinuityToken): { kind: 'controlled-continuity/v1'; token: string } {
  return { kind: 'controlled-continuity/v1', token }
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
      adapterId,
      admit: () => ({ status: 'pending', reason: 'not used by direct registration' }),
      prepare: (input) => ({
        status: 'prepared',
        descriptor: makeParticipantBrokerDescriptor({
          requestId: input.identity.requestId,
          operationId: input.identity.operationId,
          hostSessionId: input.identity.hostSessionId,
          generation: input.identity.generation,
          runtimeId: input.identity.runtimeId,
          invocationId: input.identity.invocationId,
          cwd: workspaceCwd,
        }),
      }),
      retireWriter: answer,
      inspectWriter: answer,
    },
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
 * A tmux double with two phases. `unavailable` makes realization fail fast, so
 * the establishment chain exhausts without producing any resource. `observing`
 * then serves the one committed window that the writer evidence path re-reads.
 * It never creates a window in either phase.
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
        workspaceCwd: fixture.tmpDir,
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
      // Revision 6 R6.2 makes `evidence` ignored for continuation, so an
      // adapter-supplied token no longer asks for a successor. What still does
      // is the prior attempt reaching an absorbing disposition, and that is the
      // signal this case now uses to reach the same writer-identity gate.
      const priorRow = db.participantRegistrations.getAttempt(prior.attemptId)
      expect(priorRow).not.toBeNull()
      expect(
        db.participantRegistrations.transitionAttempt(
          prior.attemptId,
          [priorRow!.state],
          'ABANDONED',
          FIXED_NOW,
          'prior participant attempt abandoned by the fixture'
        )
      ).toBe(true)
    } finally {
      db.close()
    }

    await body(
      await fixture.postJson('/v1/participants/register', {
        classId: servedClass.classId,
        processToken: 'successor-process',
        workspaceCwd: fixture.tmpDir,
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
})

/**
 * REPLACES the five superseded `activation-owned known continuity evidence`
 * cases, which classified continuity from the `continuityEvidence` an adapter
 * returned from `admit`. R6.1 removes the `admit` call and R6.2 makes
 * `processToken` and `evidence` accepted compatibility fields that are ignored
 * for joining, identity, retry matching and continuation, so there is no
 * producer input left for those expectations to read.
 *
 * Replacement mapping, one active case per obsolete claim:
 *   registration alone never advances the accepted known evidence
 *   + an unactivated candidate never advances the accepted known evidence
 *     -> 'a varied compatibility token changes nothing about the registration'
 *   an unknown attempt preserves the retained known baseline for a replacement
 *   + ... for a resume
 *   + resumes exactly once across repeated activation of the same known evidence
 *     -> 'a changed compatibility token alone cannot replace the writer'
 *
 * Five mechanically equivalent cases are not five facts. The obsolete bodies
 * are removed rather than left dormant; the absorbing-attempt retirement and
 * recovery negatives they were adjacent to remain active above, and full
 * predecessor selection/clear/reuse coverage belongs to T-08517.
 */
describe('T-08349 compatibility fields after admission withdrawal', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let asked: WriterRef[]
  let admitCalls: number

  beforeEach(async () => {
    fixture = await createHrcTestFixture('t08349-compat-')
    admitCalls = 0
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await fixture.cleanup()
  })

  /**
   * An adapter that counts `admit` AND fails the request if it is reached.
   *
   * A counter alone is satisfied by an adapter that was never reachable, so it
   * cannot tell "never called" from "never wired". Throwing makes the
   * difference observable in the response.
   */
  async function startCountingAdmit(): Promise<void> {
    const capturing = capturingAdapter(servedClass.adapterId, fixture.tmpDir, {
      writePath: { state: 'unknown', reason: 'bridge writer not inspected' },
      liveness: { state: 'live', reason: 'bridge process still running' },
      priorRecovery: { state: 'outstanding', reason: 'replay not drained' },
    })
    asked = capturing.asked
    server = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        registrationClasses: [servedClass] as unknown as readonly RegistrationClassConfig[],
        participantAdapterRegistry: new ParticipantAdapterRegistry([
          {
            ...capturing.adapter,
            admit: () => {
              admitCalls += 1
              throw new Error('admit must never be called after R6.1')
            },
          } as ParticipantAdapter,
        ]),
      })
    )
  }

  function register(patch: Record<string, unknown>): Promise<Response> {
    return fixture.postJson('/v1/participants/register', {
      classId: servedClass.classId,
      participantKey: 'compat-key',
      socketPath: `${fixture.tmpDir}/compat.sock`,
      workspaceCwd: fixture.tmpDir,
      ...patch,
    })
  }

  /**
   * The current durable identity of the one registration under test.
   *
   * Deliberately excludes the attempt's `state`: the establishment worker
   * advances that on its own timeline, so including it would make this snapshot
   * assert the worker's progress rather than the registration's identity. The
   * nonabsorbing precondition is checked separately, where it is the claim.
   */
  function identity(): Record<string, unknown> {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        servedClass.classId,
        'compat-key'
      )
      const attempt =
        registration === null
          ? null
          : db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
      return {
        registrationId: registration?.registrationId,
        hostSessionId: registration?.hostSessionId,
        generation: registration?.generation,
        attemptId: attempt?.attemptId,
        attachEpoch: attempt?.attachEpoch,
        continuation: attempt?.continuation,
        attemptCount: db.participantRegistrations.listAttemptsByRegistrationId(
          registration?.registrationId ?? ''
        ).length,
      }
    } finally {
      db.close()
    }
  }

  /** The precondition R6.2's "ignored" claim is scoped to. */
  function currentAttemptIsAbsorbing(): boolean {
    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        servedClass.classId,
        'compat-key'
      )
      const attempt =
        registration === null
          ? null
          : db.participantRegistrations.getAttemptByRegistrationId(registration.registrationId)
      return attempt === null ? false : isAbsorbingParticipantAttempt(attempt)
    } finally {
      db.close()
    }
  }

  test('a varied compatibility token changes nothing about the registration', async () => {
    await startCountingAdmit()

    expect(await body(await register({ processToken: 'first-token' }))).toMatchObject({
      status: 'registered',
      created: true,
    })
    const first = identity()
    expect(first.attemptCount).toBe(1)
    expect(currentAttemptIsAbsorbing()).toBe(false)

    // Same explicit key, every compatibility permutation R6.2 names. While the
    // current attempt is nonabsorbing, none of these may move the registration,
    // its session, its attempt, its epoch, or its continuation selection.
    for (const patch of [
      { processToken: 'a-different-token' },
      {
        processToken: 'first-token',
        evidence: { kind: 'controlled-continuity/v1', token: 'same' },
      },
      { evidence: { kind: 'controlled-continuity/v1', token: 'changed' } },
      {},
    ]) {
      const repeat = await body(await register(patch))
      expect(repeat).toMatchObject({ status: 'registered', created: false })
      expect(identity()).toEqual(first)
    }

    // Never asked for permission, and never asked about a writer: with no
    // successor requested there is nothing to replace.
    expect(admitCalls).toBe(0)
    expect(asked).toHaveLength(0)
  })

  test('a changed compatibility token alone cannot replace the writer', async () => {
    await startCountingAdmit()
    await body(await register({ processToken: 'first-token' }))
    const before = identity()

    // The controlled writer above is live with an unknown write path and
    // outstanding recovery -- the exact state the retirement gate must refuse.
    // A changed token must not reach that gate at all, let alone pass it.
    const changed = await body(
      await register({
        processToken: 'successor-token',
        evidence: { kind: 'controlled-continuity/v1', token: 'changed' },
      })
    )

    expect(changed).toMatchObject({ status: 'registered', created: false })
    // No successor: still one attempt, same epoch, same runtime identity.
    expect(currentAttemptIsAbsorbing()).toBe(false)
    expect(identity()).toEqual(before)
    expect(admitCalls).toBe(0)
  })

  test('an absent workspace registers durably with attachment pending', async () => {
    await startCountingAdmit()

    // R6.2: `workspaceCwd` is optional metadata, and HRC does not inspect its
    // files during join. Its absence is neither an admission rejection nor a
    // reason to invent one -- the participant is registered and unattached, and
    // a driver that needs a workspace reports that at attachment.
    const registered = await body(
      await fixture.postJson('/v1/participants/register', {
        classId: servedClass.classId,
        participantKey: 'no-workspace-key',
        socketPath: `${fixture.tmpDir}/no-workspace.sock`,
        processToken: 'first-token',
      })
    )
    expect(registered).toMatchObject({
      status: 'registered',
      created: true,
      observation: { state: 'attachment_pending' },
    })

    const db = openHrcDatabase(fixture.dbPath, { migrate: false })
    try {
      const registration = db.participantRegistrations.getRegistrationByClassAndKey(
        servedClass.classId,
        'no-workspace-key'
      )
      expect(registration).not.toBeNull()
      // Absent stays absent all the way through the repository read.
      expect(registration?.workspaceCwd).toBeUndefined()
      const attempt = db.participantRegistrations.getAttemptByRegistrationId(
        registration?.registrationId ?? ''
      )
      expect(attempt).toMatchObject({ state: 'IDENTITY_MINTED', establishmentWorkState: 'pending' })
      expect(attempt?.preparedDescriptorJson).toBeUndefined()
    } finally {
      db.close()
    }
    expect(admitCalls).toBe(0)
  })
})
