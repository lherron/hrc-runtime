/** T-08566 C15/F0/F2/F3: retained facts are observable but non-actuating. */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { BrokerEventMapper } from '../broker/event-mapper'
import { notifyEvent } from '../event-notification-handlers'
import {
  HOST_SESSION_ID,
  LANE_REF,
  RUNTIME_ID,
  RUN_ID,
  SCOPE_REF,
  type SeededFixture,
  envelope,
  headlessSequence,
  inputId,
  makeSeededFixture,
  ts,
  turnId,
} from './broker-event-mapper-fixtures'

let fixture: SeededFixture
beforeEach(async () => {
  fixture = await makeSeededFixture()
})
afterEach(async () => fixture.cleanup())

describe('T-08566 retained projection fence', () => {
  test('the live mapper still owns runtime state (positive control)', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(90) })
    for (const envelope of headlessSequence().slice(0, 4)) mapper.apply(envelope)
    expect(fixture.db.runs.getByRunId(RUN_ID)?.status).toBe('running')
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('busy')
  })

  test('retained turn start cannot resurrect runtime or overwrite operator terminal', () => {
    fixture.db.sessions.updateContinuation(
      HOST_SESSION_ID,
      { provider: 'openai', key: 'K1' },
      ts(70)
    )
    fixture.db.sessions.setContinuationReuseDisabled(HOST_SESSION_ID, true, ts(71))
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'terminated',
      activeRunId: null as never,
      activeInvocationId: null as never,
      activeOperationId: null as never,
      updatedAt: ts(80),
    })
    fixture.db.runs.update(RUN_ID, {
      status: 'failed',
      startedAt: ts(70),
      completedAt: ts(80),
      errorMessage: 'operator terminated',
      updatedAt: ts(80),
    })
    const terminatedRuntime = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
    expect(terminatedRuntime).toMatchObject({
      status: 'terminated',
      activeRunId: undefined,
      activeInvocationId: undefined,
      activeOperationId: undefined,
    })
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(90) })
    const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof applyRetained).toBe('function')
    for (const envelope of headlessSequence()) applyRetained!.call(mapper, envelope)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toEqual(terminatedRuntime)
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'failed',
      startedAt: ts(70),
      completedAt: ts(80),
      errorMessage: 'operator terminated',
    })
    const origin = fixture.db.sqlite
      .query<{ evidence_origin: string | null }, []>(
        'SELECT evidence_origin FROM hrc_events ORDER BY hrc_seq DESC LIMIT 1'
      )
      .get()
    expect(origin?.evidence_origin).toBe('retained')
    expect(fixture.db.sessions.getByHostSessionId(HOST_SESSION_ID)?.continuation).toEqual({
      provider: 'openai',
      key: 'K1',
    })
    expect(fixture.db.sessions.isContinuationReuseDisabled(HOST_SESSION_ID)).toBe(true)
    expect(
      fixture.db.sqlite
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM runtime_first_turn_watch WHERE runtime_id = ?'
        )
        .get(RUNTIME_ID)?.count
    ).toBe(0)
  })

  test('F2: retained input acceptance alone never infers a terminal run', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(90) })
    const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof applyRetained).toBe('function')
    const acceptedInput = inputId('input_w3a_1')
    applyRetained!.call(
      mapper,
      envelope('input.accepted', 1, { inputId: acceptedInput }, { inputId: acceptedInput })
    )
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'accepted',
      completedAt: undefined,
      errorMessage: undefined,
    })
  })

  test('F3: retained rows from an older invocation stay on its historical run', () => {
    const newerRunId = 'run_broker_w3a_newer'
    fixture.db.runs.insert({
      runId: newerRunId,
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: ts(40),
      updatedAt: ts(40),
      operationId: 'op_broker_w3a_newer',
      invocationId: 'invocation_broker_w3a_newer' as never,
      dispatchedInputId: 'input_w3a_newer',
    })
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'busy',
      activeRunId: newerRunId,
      activeInvocationId: 'invocation_broker_w3a_newer',
      activeOperationId: 'op_broker_w3a_newer',
      updatedAt: ts(40),
    })
    const newerRunBefore = fixture.db.runs.getByRunId(newerRunId)
    const runtimeBefore = fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(90) })
    const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof applyRetained).toBe('function')
    const tid = turnId('turn_w3a_historical')
    const iid = inputId('input_w3a_1')
    for (const event of [
      envelope('input.accepted', 1, { inputId: iid }, { inputId: iid }),
      envelope('turn.started', 2, { turnId: tid, inputId: iid }, { turnId: tid, inputId: iid }),
      envelope(
        'turn.completed',
        3,
        { turnId: tid, status: 'completed', finalOutput: 'historical', producedContent: true },
        { turnId: tid }
      ),
    ]) {
      applyRetained!.call(mapper, event)
    }
    expect(fixture.db.runs.getByRunId(RUN_ID)?.status).toBe('completed')
    expect(fixture.db.runs.getByRunId(newerRunId)).toEqual(newerRunBefore)
    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toEqual(runtimeBefore)
    expect(
      fixture.db.sqlite
        .query<{ run_id: string | null }, []>(
          "SELECT run_id FROM hrc_events WHERE evidence_origin = 'retained' ORDER BY hrc_seq DESC LIMIT 1"
        )
        .get()?.run_id
    ).toBe(RUN_ID)
  })

  test('F0: retained lifecycle notifications reach follow subscribers only', async () => {
    const follow = mock(() => undefined)
    const acp = mock(() => undefined)
    const project = mock(() => undefined)
    const drain = mock(async () => undefined)
    const finalize = mock(() => undefined)
    const fake = {
      followSubscribers: new Set([follow]),
      acpEventBridge: { observe: acp },
      sessionProjectEvents: { observe: project },
      drainDurableHeadlessTurnInputs: drain,
      finalizeSemanticTurnResponse: finalize,
    }
    for (const [index, eventKind] of ['turn.started', 'turn.completed', 'turn.failed'].entries()) {
      notifyEvent.call(
        fake as never,
        {
          hrcSeq: index + 1,
          streamSeq: index + 1,
          ts: ts(index + 1),
          hostSessionId: HOST_SESSION_ID,
          scopeRef: SCOPE_REF,
          laneRef: LANE_REF,
          generation: 1,
          runtimeId: RUNTIME_ID,
          runId: RUN_ID,
          category: 'turn',
          eventKind,
          transport: 'headless',
          replayed: false,
          evidenceOrigin: 'retained',
          payload: {},
        } as never
      )
    }
    await Bun.sleep(0)
    expect(follow).toHaveBeenCalledTimes(3)
    expect(acp).toHaveBeenCalledTimes(0)
    expect(project).toHaveBeenCalledTimes(0)
    expect(drain).toHaveBeenCalledTimes(0)
    expect(finalize).toHaveBeenCalledTimes(0)
  })

  test('F0 control: live lifecycle notification reaches every applicable actuator', async () => {
    const follow = mock(() => undefined)
    const acp = mock(() => undefined)
    const project = mock(() => undefined)
    const drain = mock(async () => undefined)
    const finalize = mock(() => undefined)
    notifyEvent.call(
      {
        followSubscribers: new Set([follow]),
        acpEventBridge: { observe: acp },
        sessionProjectEvents: { observe: project },
        drainDurableHeadlessTurnInputs: drain,
        finalizeSemanticTurnResponse: finalize,
      } as never,
      {
        hrcSeq: 1,
        streamSeq: 1,
        ts: ts(1),
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE_REF,
        laneRef: LANE_REF,
        generation: 1,
        runtimeId: RUNTIME_ID,
        runId: RUN_ID,
        category: 'turn',
        eventKind: 'turn.completed',
        transport: 'headless',
        replayed: false,
        payload: {},
      }
    )
    await Bun.sleep(0)
    for (const observer of [follow, acp, project, drain, finalize]) {
      expect(observer).toHaveBeenCalledTimes(1)
    }
  })
})
