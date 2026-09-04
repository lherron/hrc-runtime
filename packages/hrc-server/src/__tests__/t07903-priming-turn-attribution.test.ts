import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import type {
  InputId,
  InvocationEventEnvelope,
  SubmissionId,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { autoReplyCandidateFor } from 'hrc-mail-kicker'
import { observeMailDriveLifecycleEvent } from 'hrc-mail-kicker'
import { reconcileAutoReplyIntent } from '../auto-reply-handlers.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { storedManifestEnvelopeIdsForTurn } from '../turn-dispatch-handlers.js'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'

// Stable ids from the recorded inv-f3755740 / EN-03070 failure. The bodies are
// deliberately minimized; event ordering and attribution fields are the load-
// bearing evidence carried into this HRC-level regression.
const SUBMISSION_ID = 'submission_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as SubmissionId
const INPUT_ID = SUBMISSION_ID as InputId
const HUMAN_SUBMISSION_ID =
  'human_submission_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as SubmissionId
const PRIMING_TURN_ID = 'turn_inv-f3755740-be0c-4a14-8816-60e639cd1025_2' as TurnId
const SUMMONS_TURN_ID = 'turn_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as TurnId
const RUN_ID = 'run-8077ca65-5f10-41c0-a098-13c8351d1492'
const DRIVE_ATTEMPT_ID = 'drive-8077ca65-5f10-41c0-a098-13c8351d1492'
const TARGET = `${TMUX_SCOPE_REF}/lane:${LANE_REF}`
const LEDGER_TARGET = 'smokey@hrc-runtime:T-04215'
const COUNTERPARTY = 'chief@hcs:T-07894'
const ROOM = 'T-07903'
// T-07963: the cold birth's compiler initial input and the turn it starts.
const COLD_SUBMISSION_ID = 'input_e1901a0ee1efce8be81f577cdbf791d4' as SubmissionId
const COLD_TURN_ID = 'turn_inv-f3755740-be0c-4a14-8816-60e639cd1025_9' as TurnId
const COLD_RUN_ID = 'run-72fece2f-120a-4745-930f-b6c5ef1936c8'
const COLD_DRIVE_ATTEMPT_ID = 'drive-72fece2f-120a-4745-930f-b6c5ef1936c8'

function brokerEnvelope(
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: Record<string, unknown>,
  extra: Partial<Pick<InvocationEventEnvelope, 'inputId' | 'turnId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload,
    ...extra,
  } as InvocationEventEnvelope
}

type Scenario = {
  applyAndObserve: (event: InvocationEventEnvelope) => void
  sourceId: string
  ledger: FakeWrkqLedger
}

describe('T-07903 fresh-seat priming attribution', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeTmuxSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function setupScenario(): Promise<Scenario> {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      capabilitiesJson: JSON.stringify({
        turns: 'multi',
        bracketMintingMode: 'harness-evidence',
      }),
      updatedAt: ts(0),
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      brokerSubmissionId: SUBMISSION_ID,
      dispatchedInputId: SUBMISSION_ID,
    })

    const ledger = new FakeWrkqLedger()
    const source = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: '[recorded EN-03070 dispatch body redacted]',
    })
    const candidate = autoReplyCandidateFor([source])
    if (candidate === undefined) throw new Error('recorded summons was not auto-reply eligible')
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [source.id] },
      { driveAttemptId: DRIVE_ATTEMPT_ID, runId: RUN_ID }
    )
    db.mailDrives.presentForAttempt(DRIVE_ATTEMPT_ID, [source.id])
    db.mailDrives.recordAutoReplyCandidate(DRIVE_ATTEMPT_ID, candidate)
    await ledger.present({
      envelope: source.id,
      memberRef: LEDGER_TARGET,
      node: 'max3',
      runtimeId: TMUX_RUNTIME_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      generation: 1,
      runId: RUN_ID,
      driveAttemptId: DRIVE_ATTEMPT_ID,
      inputId: SUBMISSION_ID,
    })

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      wake: () => {
        db.mailDrives.completeStartedAttempt(RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
    }

    applyAndObserve(
      brokerEnvelope(5, 'admission.requested', {
        submissionId: SUBMISSION_ID,
        class: 'queue',
        origin: {
          principalRef: 'agent:chief',
          scopeRef: COUNTERPARTY,
          envelopeId: source.id,
        },
        turnPolicy: 'open',
      })
    )
    applyAndObserve(
      brokerEnvelope(
        8,
        'input.accepted',
        { inputId: INPUT_ID, disposition: 'started' },
        { inputId: INPUT_ID }
      )
    )

    return { applyAndObserve, sourceId: source.id, ledger }
  }

  function primingManifest() {
    return storedManifestEnvelopeIdsForTurn(
      fixture.db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID),
      PRIMING_TURN_ID
    )
  }

  function summonsManifest() {
    return storedManifestEnvelopeIdsForTurn(
      fixture.db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID),
      SUMMONS_TURN_ID
    )
  }

  it('reproduces the recorded stamp that put EN-03070 in the foreign priming manifest', async () => {
    const { applyAndObserve, sourceId } = await setupScenario()

    applyAndObserve(
      brokerEnvelope(
        10,
        'turn.started',
        { turnId: PRIMING_TURN_ID, source: 'hook-observed' },
        { inputId: INPUT_ID, turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        11,
        'submission.executed',
        { submissionId: SUBMISSION_ID, turnId: PRIMING_TURN_ID },
        { inputId: INPUT_ID, turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(12, 'submission.executed', {
        submissionId: HUMAN_SUBMISSION_ID,
        turnId: PRIMING_TURN_ID,
      })
    )
    applyAndObserve(
      brokerEnvelope(
        22,
        'turn.completed',
        { turnId: PRIMING_TURN_ID, status: 'completed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    // The real transcript input arrived only after priming completed. Because
    // the defective broker had already terminalized SUBMISSION_ID on turn_2,
    // it emitted no second submission.executed for this matching turn_1.
    applyAndObserve(
      brokerEnvelope(
        23,
        'turn.started',
        { turnId: SUMMONS_TURN_ID, source: 'hook-observed', inputId: INPUT_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        24,
        'user.message',
        {
          content: '[recorded EN-03070 dispatch body redacted]',
          turnId: SUMMONS_TURN_ID,
          inputId: INPUT_ID,
        },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )

    expect(primingManifest()).toEqual({
      eventsPresent: true,
      envelopeIds: [sourceId],
    })
    expect(summonsManifest()).toEqual({
      eventsPresent: false,
      envelopeIds: [],
    })
    expect(fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)).toMatchObject({
      runId: RUN_ID,
      sourceEnvelopeIds: [sourceId],
    })
  })

  it('keeps the summons out of priming and reconciles only the turn whose input carried it', async () => {
    const { applyAndObserve, sourceId, ledger } = await setupScenario()

    // Fixed T-07915 shape: harness evidence leaves the foreign hook start
    // unstamped. Only its synthetic human submission belongs to priming.
    applyAndObserve(
      brokerEnvelope(
        10,
        'turn.started',
        { turnId: PRIMING_TURN_ID, source: 'hook-observed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(12, 'submission.executed', {
        submissionId: HUMAN_SUBMISSION_ID,
        turnId: PRIMING_TURN_ID,
      })
    )
    applyAndObserve(
      brokerEnvelope(
        22,
        'turn.completed',
        { turnId: PRIMING_TURN_ID, status: 'completed' },
        { turnId: PRIMING_TURN_ID }
      )
    )

    expect(primingManifest().envelopeIds).not.toContain(sourceId)
    expect(fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)).toBeUndefined()
    expect(ledger.roomSayRequests).toHaveLength(0)

    applyAndObserve(
      brokerEnvelope(
        23,
        'turn.started',
        { turnId: SUMMONS_TURN_ID, source: 'hook-observed', inputId: INPUT_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        24,
        'submission.executed',
        { submissionId: SUBMISSION_ID, turnId: SUMMONS_TURN_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        25,
        'user.message',
        {
          content: '[recorded EN-03070 dispatch body redacted]',
          turnId: SUMMONS_TURN_ID,
          inputId: INPUT_ID,
        },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    appendHrcEvent(fixture.db, 'turn.message', {
      ts: ts(26),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: {
        message: {
          role: 'assistant',
          content: 'Implemented the dispatched brief.',
        },
      },
    })
    applyAndObserve(
      brokerEnvelope(
        27,
        'turn.completed',
        { turnId: SUMMONS_TURN_ID, status: 'completed' },
        { turnId: SUMMONS_TURN_ID }
      )
    )

    const intent = fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)
    expect(intent).toMatchObject({
      runId: RUN_ID,
      sourceEnvelopeIds: [sourceId],
    })
    expect(summonsManifest()).toEqual({
      eventsPresent: true,
      envelopeIds: [sourceId],
    })
    if (intent === undefined) throw new Error('summons turn did not mint an auto-reply intent')

    expect(await reconcileAutoReplyIntent({ db: fixture.db, wrkqLedger: ledger }, intent)).toBe(
      'minted'
    )
    expect(ledger.roomSayRequests).toEqual([
      expect.objectContaining({
        ref: ROOM,
        body: 'Implemented the dispatched brief.',
        to: [COUNTERPARTY],
        dischargeEnvelopeIds: [sourceId],
        meta: {
          auto: 'turn_final',
          discharge: 'manifest',
          dischargeEnvelopeIds: [sourceId],
        },
      }),
    ])
    expect(ledger.envelopes.get(sourceId)?.state).toBe('acked')
  })

  /**
   * T-07963 — a cold birth's own initial input is admitted by the BROKER, not
   * through HRC's submission door, so its `admission.requested` carries
   * `origin.principalRef = 'legacy:invocation.input'` and NO `envelopeId`.
   *
   * The manifest therefore comes back present-but-EMPTY, and treating that as
   * authoritative derived an empty discharge set — which cannot be said. The
   * intent pended every second forever, the 60s reminder drove a pointer turn,
   * and the agent replied by hand. That is the reply-is-ack failure this whole
   * task exists to close, surviving the run binding that was supposed to fix it.
   *
   * An empty manifest carries no attribution and is no evidence about what the
   * turn carried; only a manifest that names envelopes outranks the drive
   * attempt's own recorded candidate.
   */
  it('T-07963: mints from the candidate when the cold-birth admission names no envelope', async () => {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      capabilitiesJson: JSON.stringify({ turns: 'multi', bracketMintingMode: 'harness-evidence' }),
      updatedAt: ts(0),
    })
    // The criterion-4 binding: the run OWNS the compiler's initial input id.
    db.runs.insert({
      runId: COLD_RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      brokerSubmissionId: COLD_SUBMISSION_ID,
      dispatchedInputId: COLD_SUBMISSION_ID,
    })

    const ledger = new FakeWrkqLedger()
    const source = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: 'Implement T-07962.',
    })
    const candidate = autoReplyCandidateFor([source])
    if (candidate === undefined) throw new Error('cold-birth summons was not auto-reply eligible')
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [source.id] },
      { driveAttemptId: COLD_DRIVE_ATTEMPT_ID, runId: COLD_RUN_ID }
    )
    db.mailDrives.presentForAttempt(COLD_DRIVE_ATTEMPT_ID, [source.id])
    db.mailDrives.recordAutoReplyCandidate(COLD_DRIVE_ATTEMPT_ID, candidate)
    await ledger.present({
      envelope: source.id,
      memberRef: LEDGER_TARGET,
      node: 'max3',
      runtimeId: TMUX_RUNTIME_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      generation: 1,
      runId: COLD_RUN_ID,
      driveAttemptId: COLD_DRIVE_ATTEMPT_ID,
      inputId: COLD_SUBMISSION_ID,
    })

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      wake: () => {
        db.mailDrives.completeStartedAttempt(COLD_RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
      return projected
    }

    // The broker's OWN admission of the compiler initial input: no envelopeId.
    applyAndObserve(
      brokerEnvelope(30, 'admission.requested', {
        submissionId: COLD_SUBMISSION_ID,
        class: 'exclusive',
        origin: { principalRef: 'legacy:invocation.input' },
        turnPolicy: 'open',
      })
    )
    const started = applyAndObserve(
      brokerEnvelope(
        31,
        'turn.started',
        { turnId: COLD_TURN_ID, source: 'broker-delivery', inputId: COLD_SUBMISSION_ID },
        { inputId: COLD_SUBMISSION_ID, turnId: COLD_TURN_ID }
      )
    )
    // Criterion 4's binding, asserted here as the precondition it is.
    expect(started.lifecycleEvents[0]?.runId).toBe(COLD_RUN_ID)
    applyAndObserve(
      brokerEnvelope(
        32,
        'submission.executed',
        { submissionId: COLD_SUBMISSION_ID, turnId: COLD_TURN_ID },
        { inputId: COLD_SUBMISSION_ID, turnId: COLD_TURN_ID }
      )
    )
    appendHrcEvent(db, 'turn.message', {
      ts: ts(33),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: COLD_RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: { message: { role: 'assistant', content: 'T-07962 is completed and shipped.' } },
    })
    applyAndObserve(
      brokerEnvelope(
        34,
        'turn.completed',
        { turnId: COLD_TURN_ID, status: 'completed' },
        { turnId: COLD_TURN_ID }
      )
    )

    // The defect shape, asserted rather than described: admissions exist for
    // this turn, and not one of them attributes an envelope.
    expect(
      storedManifestEnvelopeIdsForTurn(
        db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID),
        COLD_TURN_ID
      )
    ).toEqual({ eventsPresent: true, envelopeIds: [] })

    const intent = db.mailDrives.getAutoReplyIntent(COLD_DRIVE_ATTEMPT_ID)
    if (intent === undefined) throw new Error('cold-birth turn did not mint an auto-reply intent')

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests).toEqual([
      expect.objectContaining({
        ref: ROOM,
        body: 'T-07962 is completed and shipped.',
        to: [COUNTERPARTY],
        dischargeEnvelopeIds: [source.id],
        // The candidate, precisely because the manifest attributed nothing.
        meta: expect.objectContaining({ auto: 'turn_final', discharge: 'candidate' }),
      }),
    ])
    expect(ledger.envelopes.get(source.id)?.state).toBe('acked')
  })

  /**
   * T-07963 negative control (mable): a promptless cold boot mints NOTHING.
   *
   * The fix above widens the discharge fallback to the drive attempt's recorded
   * candidate, so the boundary that must still hold is the one where there IS
   * no candidate — a cold boot carrying no caller prompt and therefore no
   * envelope. Nothing may be said on its behalf, and no intent may exist to
   * pend forever. Without this, "fall back to the candidate" could quietly
   * become "say something regardless".
   */
  it('T-07963 negative: a promptless cold boot mints no intent and says nothing', async () => {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      capabilitiesJson: JSON.stringify({ turns: 'multi', bracketMintingMode: 'harness-evidence' }),
      updatedAt: ts(0),
    })
    db.runs.insert({
      runId: COLD_RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      brokerSubmissionId: COLD_SUBMISSION_ID,
      dispatchedInputId: COLD_SUBMISSION_ID,
    })
    const ledger = new FakeWrkqLedger()
    // A drive attempt with NO auto-reply candidate: the promptless shape.
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [] },
      { driveAttemptId: COLD_DRIVE_ATTEMPT_ID, runId: COLD_RUN_ID }
    )

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      wake: () => {
        db.mailDrives.completeStartedAttempt(COLD_RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
    }

    applyAndObserve(
      brokerEnvelope(30, 'admission.requested', {
        submissionId: COLD_SUBMISSION_ID,
        class: 'exclusive',
        origin: { principalRef: 'legacy:invocation.input' },
        turnPolicy: 'open',
      })
    )
    applyAndObserve(
      brokerEnvelope(
        31,
        'turn.started',
        { turnId: COLD_TURN_ID, source: 'broker-delivery', inputId: COLD_SUBMISSION_ID },
        { inputId: COLD_SUBMISSION_ID, turnId: COLD_TURN_ID }
      )
    )
    appendHrcEvent(db, 'turn.message', {
      ts: ts(33),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: COLD_RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: { message: { role: 'assistant', content: 'Priming acknowledged.' } },
    })
    applyAndObserve(
      brokerEnvelope(
        34,
        'turn.completed',
        { turnId: COLD_TURN_ID, status: 'completed' },
        { turnId: COLD_TURN_ID }
      )
    )

    expect(db.mailDrives.getAutoReplyIntent(COLD_DRIVE_ATTEMPT_ID)).toBeUndefined()
    expect(ledger.roomSayRequests).toHaveLength(0)
  })

  it('binds an input-less launch turn to its mail drive and discharges from the candidate', async () => {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      runId: RUN_ID,
      capabilitiesJson: JSON.stringify({
        turns: 'multi',
        bracketMintingMode: 'harness-evidence',
      }),
      updatedAt: ts(0),
    })
    db.runtimes.updateRunId(TMUX_RUNTIME_ID, RUN_ID, ts(0))
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      // No dispatchedInputId: the summons is part of launch material.
    })

    const ledger = new FakeWrkqLedger()
    const source = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: 'the launch-carried summons',
    })
    const candidate = autoReplyCandidateFor([source])
    if (candidate === undefined) throw new Error('launch summons was not auto-reply eligible')
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [source.id] },
      { driveAttemptId: DRIVE_ATTEMPT_ID, runId: RUN_ID }
    )
    db.mailDrives.presentForAttempt(DRIVE_ATTEMPT_ID, [source.id])
    db.mailDrives.recordAutoReplyCandidate(DRIVE_ATTEMPT_ID, candidate)
    await ledger.present({
      envelope: source.id,
      memberRef: LEDGER_TARGET,
      node: 'max3',
      runtimeId: TMUX_RUNTIME_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      generation: 1,
      runId: RUN_ID,
      driveAttemptId: DRIVE_ATTEMPT_ID,
    })

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      wake: () => {
        db.mailDrives.completeStartedAttempt(RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
      return projected
    }

    const started = applyAndObserve(
      brokerEnvelope(
        10,
        'turn.started',
        { turnId: PRIMING_TURN_ID, source: 'hook-observed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    expect(started.lifecycleEvents[0]?.runId).toBe(RUN_ID)
    appendHrcEvent(db, 'turn.message', {
      ts: ts(11),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: {
        message: { role: 'assistant', content: 'Handled the launch-carried brief.' },
      },
    })
    const terminal = applyAndObserve(
      brokerEnvelope(
        12,
        'turn.completed',
        { turnId: PRIMING_TURN_ID, status: 'completed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    expect(terminal.lifecycleEvents[0]?.runId).toBe(RUN_ID)
    expect(db.runs.getByRunId(RUN_ID)?.status).toBe('completed')

    const intent = db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)
    if (intent === undefined) throw new Error('launch turn did not mint an auto-reply intent')
    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests).toEqual([
      expect.objectContaining({
        ref: ROOM,
        body: 'Handled the launch-carried brief.',
        to: [COUNTERPARTY],
        dischargeEnvelopeIds: [source.id],
        meta: {
          auto: 'turn_final',
          discharge: 'candidate',
          dischargeEnvelopeIds: [source.id],
        },
      }),
    ])
    expect(ledger.envelopes.get(source.id)?.presentedTo[0]?.inputId).toBeUndefined()
    expect(
      db.brokerInvocationEvents
        .listByInvocationId(TMUX_INVOCATION_ID)
        .filter((event) => event.type.startsWith('submission.') || event.type.startsWith('input.'))
    ).toHaveLength(0)
  })
})
