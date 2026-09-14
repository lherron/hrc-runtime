/**
 * T-08337 — the preempt door is gated on the driver's ADVERTISED admission class.
 *
 * `invoke()` degrades to the queue class when the driver cannot serve
 * `exclusive`, because an own-turn promise survives being queued. A preempt
 * cannot be degraded the same way: it is an interruption request, and a body
 * that merely waits its turn is not the interruption that was asked for. So the
 * capability answer for preempt is a REFUSAL, and it must be distinguishable in
 * the ledger from a genuine authority denial — "this driver cannot preempt" and
 * "you are not allowed to preempt" are different facts.
 *
 * The state this suite exists to catch is the one where a detector that is true
 * everywhere would be useless: a seat whose driver DOES advertise preempt
 * (claude-code-tmux, headless codex-app-server) must be completely unaffected.
 * Every refusal assertion below is paired with a control that must NOT fire.
 *
 * Run with: TMPDIR=/tmp bun test packages/hrc-server/src/__tests__/t08337-preempt-capability-gate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { PreemptSubmissionRequest } from 'hrc-core'

import {
  BROKER_PREEMPT_UNSUPPORTED_REASON,
  brokerCapabilitiesAdmissionClasses,
  brokerCapabilitiesRefuseAdmissionClass,
  brokerCapabilitiesSupportAdmissionClass,
} from '../broker/capabilities'
import { HarnessBrokerController } from '../broker/controller'
import { getBrokerDispatchDiagnostics } from '../broker/dispatch-observability'
import {
  brokerRuntimeRefusesAdmissionClass,
  brokerRuntimeSupportsAdmissionClass,
} from '../require-helpers'
import { preemptAdmission } from '../turn-dispatch-handlers'

import { INVOCATION_ID, RUNTIME_ID, makeSeededFixture, ts } from './broker-event-mapper-fixtures'
import type { SeededFixture } from './broker-event-mapper-fixtures'
import {
  FakeBrokerClient,
  NOW,
  type TestFixture,
  invocationCapabilities,
  makeFixture,
  makeStartInput,
} from './fixtures/broker-controller.fixture'

/**
 * The real advertised class lists, copied from the agent-spaces drivers this
 * gate discriminates between. Hand-written wire types can repeat the mistake
 * they are meant to catch, so these are the driver declarations verbatim:
 * `drivers/codex-app-server/capabilities.ts` (both profiles),
 * `drivers/claude-code-tmux/driver.ts`, `drivers/codex-cli-tmux/driver.ts`.
 */
const DRIVER_CLASSES = {
  /** codex-app-server, headless — the existing preempt path. */
  codexHeadless: ['steer', 'queue', 'exclusive', 'preempt'],
  /** claude-code-tmux — the other existing preempt path. */
  claudeCodeTmux: ['steer', 'queue', 'exclusive', 'preempt'],
  /** codex-app-server in codex-tui presentation — the subject of this task. */
  codexTui: ['steer', 'queue'],
  /** codex-cli-tmux — also non-preempt, and fixed by the same gate. */
  codexCliTmux: ['steer', 'queue', 'exclusive'],
} as const

const caps = (classes: readonly string[]) => JSON.stringify({ admission: { classes } })

// ---------------------------------------------------------------------------
// 1. The capability reader: declared-and-omits vs never-declared
// ---------------------------------------------------------------------------

describe('brokerCapabilitiesRefuseAdmissionClass', () => {
  it('refuses only a class the driver declared its list WITHOUT', () => {
    expect(brokerCapabilitiesRefuseAdmissionClass(caps(DRIVER_CLASSES.codexTui), 'preempt')).toBe(
      true
    )
    expect(
      brokerCapabilitiesRefuseAdmissionClass(caps(DRIVER_CLASSES.codexCliTmux), 'preempt')
    ).toBe(true)
    // An empty declared list is still a declaration (the noop driver's shape).
    expect(brokerCapabilitiesRefuseAdmissionClass(caps([]), 'preempt')).toBe(true)
  })

  it('does NOT refuse a driver that advertises the class — the control', () => {
    expect(
      brokerCapabilitiesRefuseAdmissionClass(caps(DRIVER_CLASSES.codexHeadless), 'preempt')
    ).toBe(false)
    expect(
      brokerCapabilitiesRefuseAdmissionClass(caps(DRIVER_CLASSES.claudeCodeTmux), 'preempt')
    ).toBe(false)
  })

  it('does NOT treat silence as refusal', () => {
    // Every one of these is "the projection did not say", which is not the
    // driver saying no. The live ledger holds hundreds of pre-`admission`
    // capability blobs; reading them as refusals would retroactively close the
    // preempt door on all of them.
    const legacyBlob = JSON.stringify({ turns: { concurrency: 'single' } })
    expect(brokerCapabilitiesRefuseAdmissionClass(legacyBlob, 'preempt')).toBe(false)
    expect(brokerCapabilitiesRefuseAdmissionClass(undefined, 'preempt')).toBe(false)
    expect(brokerCapabilitiesRefuseAdmissionClass('', 'preempt')).toBe(false)
    expect(brokerCapabilitiesRefuseAdmissionClass('{not-json', 'preempt')).toBe(false)
    expect(
      brokerCapabilitiesRefuseAdmissionClass(JSON.stringify({ admission: {} }), 'preempt')
    ).toBe(false)
  })

  it('is NOT the negation of brokerCapabilitiesSupportAdmissionClass', () => {
    // The distinction this whole gate rests on: for an undeclared list, BOTH
    // predicates are false. Collapsing them into one boolean is the bug.
    const legacyBlob = JSON.stringify({ turns: { concurrency: 'single' } })
    expect(brokerCapabilitiesSupportAdmissionClass(legacyBlob, 'preempt')).toBe(false)
    expect(brokerCapabilitiesRefuseAdmissionClass(legacyBlob, 'preempt')).toBe(false)
    expect(brokerCapabilitiesAdmissionClasses(legacyBlob)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. The runtime-level predicate, against a real seeded store
// ---------------------------------------------------------------------------

describe('brokerRuntimeRefusesAdmissionClass', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  const runtimeWithClasses = (classes: readonly string[] | undefined, at: number) => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      updatedAt: ts(at),
    })
    if (classes !== undefined) {
      fixture.db.brokerInvocations.update(INVOCATION_ID, {
        capabilitiesJson: caps(classes),
        updatedAt: ts(at),
      })
    }
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
    if (!runtime) throw new Error(`runtime ${RUNTIME_ID} not found`)
    return runtime
  }

  it('refuses preempt for a codex-tui invocation', () => {
    const runtime = runtimeWithClasses(DRIVER_CLASSES.codexTui, 20)
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'preempt')).toBe(true)
    // …and the classes it DOES advertise are untouched.
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'steer')).toBe(false)
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'queue')).toBe(false)
  })

  it('does NOT refuse preempt for a claude-code-tmux invocation — the control', () => {
    const runtime = runtimeWithClasses(DRIVER_CLASSES.claudeCodeTmux, 21)
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'preempt')).toBe(false)
    expect(brokerRuntimeSupportsAdmissionClass(fixture.db, runtime, 'preempt')).toBe(true)
  })

  it('does NOT refuse preempt for the seeded legacy capability blob', () => {
    // The seeded fixture's capabilitiesJson is `{"turns":"single"}` — no
    // admission key at all, i.e. the pre-`admission` shape still in the ledger.
    const runtime = runtimeWithClasses(undefined, 22)
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'preempt')).toBe(false)
    expect(brokerRuntimeSupportsAdmissionClass(fixture.db, runtime, 'preempt')).toBe(false)
  })

  it('does NOT refuse when the runtime has no active broker invocation', () => {
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
    if (!runtime) throw new Error(`runtime ${RUNTIME_ID} not found`)
    expect(runtime.activeInvocationId).toBeUndefined()
    expect(brokerRuntimeRefusesAdmissionClass(fixture.db, runtime, 'preempt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. The controller: refuse WITHOUT calling the driver, and never degrade
// ---------------------------------------------------------------------------

describe('HarnessBrokerController.preempt capability gate', () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  const startedController = async (classes: readonly string[]) => {
    const fake = new FakeBrokerClient()
    const input = makeStartInput()
    fake.startResponse = {
      ...fake.startResponse,
      capabilities: {
        ...invocationCapabilities(),
        admission: { classes: [...classes] as never },
      },
    }
    const controller = new HarnessBrokerController({
      db: fixture.db,
      brokerClientFactory: async () => fake,
      now: () => NOW,
      serverInstanceId: 'server-test',
    })
    const started = await controller.start({ ...input, brokerClient: fake })
    if (!started.ok) throw new Error('fixture controller failed to start')
    return { controller, fake, runtimeId: input.identity.runtimeId }
  }

  const preemptInput = (runtimeId: string) => ({
    runtimeId,
    origin: { principalRef: 'human:lance' },
    body: 'stop what you are doing',
  })

  it('refuses a preempt the driver did not advertise, without calling the driver', async () => {
    const { controller, fake, runtimeId } = await startedController(DRIVER_CLASSES.codexTui)

    const result = await controller.preempt(preemptInput(runtimeId))

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.response.admission).toBe('rejected')
    expect(result.response.reason).toBe(BROKER_PREEMPT_UNSUPPORTED_REASON)
    // The whole point: the driver never saw a preempt it cannot serve…
    expect(fake.callOrder).not.toContain('preempt')
    // …and it was NOT silently downgraded into a queued body either, which
    // would have reported an interrupt that never happened.
    expect(fake.callOrder).not.toContain('enqueue')
    expect(fake.callOrder).not.toContain('steer')
  })

  it('leaves the existing preempt path for a preempt-capable driver unchanged', async () => {
    const { controller, fake, runtimeId } = await startedController(DRIVER_CLASSES.codexHeadless)

    const result = await controller.preempt(preemptInput(runtimeId))

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.response.admission).toBe('admitted')
    expect(result.response.reason).toBeUndefined()
    expect(fake.callOrder).toContain('preempt')
  })

  it('records no accepted-submission milestone for a refused preempt', async () => {
    const { controller, runtimeId } = await startedController(DRIVER_CLASSES.codexTui)

    await controller.preempt(preemptInput(runtimeId))

    // A rejection is not an admission. The accepted-submission milestone is
    // what a later reader counts as "an interrupt was admitted here", so a
    // refused preempt must leave none — otherwise the gate would refuse the
    // body and still report the interrupt.
    const submissions = getBrokerDispatchDiagnostics(fixture.db, runtimeId)?.submissions ?? []
    expect(submissions.filter((entry) => entry.admissionClass === 'preempt')).toEqual([])
  })

  it('DOES record the accepted-submission milestone when the driver can preempt', async () => {
    // The control for the assertion above: it must be capable of being true.
    const { controller, runtimeId } = await startedController(DRIVER_CLASSES.codexHeadless)

    await controller.preempt(preemptInput(runtimeId))

    const submissions = getBrokerDispatchDiagnostics(fixture.db, runtimeId)?.submissions ?? []
    expect(submissions.filter((entry) => entry.admissionClass === 'preempt')).not.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. The door: the operator short-circuit is BELOW the capability gate
// ---------------------------------------------------------------------------

describe('preemptAdmission (both entry paths)', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  /**
   * The capability branch reads only `server.db`, and an operator principal
   * short-circuits before the seat probe — so this stub is complete for the
   * states asserted here. A controller call would throw loudly rather than
   * silently pass, which is what we want if the gate ever stops short-circuiting.
   */
  const serverStub = () =>
    ({
      db: fixture.db,
      getHarnessBrokerController: () => {
        throw new Error('preemptAdmission must not reach the broker for these states')
      },
    }) as unknown as Parameters<typeof preemptAdmission>[0]

  const sessionFor = () => {
    const runtime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
    if (!runtime) throw new Error(`runtime ${RUNTIME_ID} not found`)
    const session = fixture.db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (!session) throw new Error(`session ${runtime.hostSessionId} not found`)
    return session
  }

  const seatWithClasses = (classes: readonly string[], at: number) => {
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      updatedAt: ts(at),
    })
    fixture.db.brokerInvocations.update(INVOCATION_ID, {
      capabilitiesJson: caps(classes),
      updatedAt: ts(at),
    })
  }

  const operatorRequest = () =>
    ({
      target: 'agent@project:primary',
      body: 'stop',
      origin: { principalRef: 'human:lance' },
    }) as PreemptSubmissionRequest

  it('refuses an OPERATOR preempt to a codex-tui seat', async () => {
    // Entry path 1. The gate used to return true for an operator
    // before the runtime was even resolved; an operator outranks the authority
    // question but cannot grant a driver an interrupt it does not implement.
    seatWithClasses(DRIVER_CLASSES.codexTui, 30)

    expect(await preemptAdmission(serverStub(), sessionFor(), operatorRequest())).toBe(
      'preempt-unsupported'
    )
  })

  it('still authorizes an OPERATOR preempt to a preempt-capable seat — the control', async () => {
    seatWithClasses(DRIVER_CLASSES.claudeCodeTmux, 31)

    expect(await preemptAdmission(serverStub(), sessionFor(), operatorRequest())).toBe('authorized')
  })

  it('still authorizes an OPERATOR preempt when the seat never declared its classes', async () => {
    // The legacy blob: silence is not refusal, so today's behaviour stands.
    fixture.db.runtimes.update(RUNTIME_ID, {
      activeInvocationId: String(INVOCATION_ID),
      updatedAt: ts(32),
    })

    expect(await preemptAdmission(serverStub(), sessionFor(), operatorRequest())).toBe('authorized')
  })

  it('refuses a MAIL-KICKER hold to a codex-tui seat as unsupported, not authority-denied', async () => {
    // Entry path 2. An envelope-origin hold whose sender could never be
    // authorized here would otherwise report `authority-denied`, which invites
    // the wrong fix (grant the sender authority). Capability is asked first, so
    // the answer names the driver instead.
    seatWithClasses(DRIVER_CLASSES.codexTui, 33)
    const request = {
      target: 'agent@project:primary',
      body: 'stop',
      origin: { principalRef: 'agent:chief', envelopeId: 'EN-00001' },
    } as PreemptSubmissionRequest

    expect(await preemptAdmission(serverStub(), sessionFor(), request)).toBe('preempt-unsupported')
  })
})
