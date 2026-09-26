import { describe, expect, it } from 'bun:test'

import { INVOCATION_ID, RUNTIME_ID, RUN_ID, envelope, ts } from './broker-event-mapper-fixtures'
import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

/**
 * T-08385: raw broker `submission.withdrawn` is the replayable terminal
 * evidence. It may settle exactly the accepted submission, but must leave the
 * runtime busy: only the explicit recovery door is allowed to perform its
 * separate fresh-idle ready normalization.
 */
const harness = createBrokerEventMapperTestFixture()

describe('accepted-run withdrawal replay', () => {
  it('terminalizes only the exact accepted input and never projects ready', () => {
    const db = harness.fixture.db
    const submissionId = 'submission-t08385-replay'
    db.runs.update(RUN_ID, {
      brokerSubmissionId: submissionId,
      dispatchedInputId: submissionId,
      updatedAt: ts(1),
    })
    db.runtimes.update(RUNTIME_ID, {
      status: 'busy',
      activeRunId: RUN_ID,
      activeInvocationId: INVOCATION_ID,
      updatedAt: ts(1),
    })
    db.brokerInvocations.update(INVOCATION_ID, { invocationState: 'ready', updatedAt: ts(1) })

    const result = harness.makeMapper().apply(
      envelope('submission.withdrawn', 1, {
        submissionId,
        reason: 'accepted_run_never_started',
      })
    )

    expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'failed',
      errorCode: 'accepted_run_never_started',
    })
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: 'busy',
      activeRunId: undefined,
    })
    expect(result.lifecycleEvents.map((event) => event.eventKind)).toContain('turn.reaped')
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'turn.reaped' })).toHaveLength(1)
  })
})
