/** T-08566 C15/F0/F2/F3: retained facts are observable but non-actuating. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BrokerEventMapper } from '../broker/event-mapper'
import {
  RUNTIME_ID,
  RUN_ID,
  headlessSequence,
  makeSeededFixture,
  type SeededFixture,
  ts,
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
    fixture.db.runtimes.update(RUNTIME_ID, {
      status: 'terminated',
      activeRunId: undefined,
      activeInvocationId: undefined,
      activeOperationId: undefined,
      updatedAt: ts(80),
    })
    fixture.db.runs.update(RUN_ID, {
      status: 'failed',
      completedAt: ts(80),
      errorMessage: 'operator terminated',
      updatedAt: ts(80),
    })
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(90) })
    const applyRetained = (mapper as unknown as { applyRetained?: (value: unknown) => unknown })
      .applyRetained
    expect(typeof applyRetained).toBe('function')
    for (const envelope of headlessSequence().slice(0, 4)) applyRetained!.call(mapper, envelope)

    expect(fixture.db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'terminated',
      activeRunId: undefined,
      activeInvocationId: undefined,
      activeOperationId: undefined,
    })
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'failed',
      completedAt: ts(80),
      errorMessage: 'operator terminated',
    })
    const origin = fixture.db.sqlite
      .query<{ evidence_origin: string | null }, []>(
        'SELECT evidence_origin FROM hrc_events ORDER BY hrc_seq DESC LIMIT 1'
      )
      .get()
    expect(origin?.evidence_origin).toBe('retained')
  })
})
