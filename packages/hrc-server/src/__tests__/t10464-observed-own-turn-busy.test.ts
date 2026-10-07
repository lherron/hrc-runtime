import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  InvocationEventEnvelope,
  InvocationEventType,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_OPERATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures'

// T-10464: codex-app-server mints observed turns. Its turn.started names the
// turn but carries no inputId; ownership arrives one envelope later as
// turn.attributed {ownership: own}. Live seats sat `ready` with activeRunId set
// and the run stuck at `accepted` for the whole turn (inv-1afb9b3d, seq 12/13).

const RUN_ID = 'run-t10464-own'
const INPUT_ID = 'input-t10464-own'
const OWN_TURN = 'turn-t10464-own' as TurnId

function envelope(
  type: InvocationEventType,
  seq: number,
  payload: unknown,
  extra: Partial<Pick<InvocationEventEnvelope, 'turnId' | 'inputId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
    ...extra,
  }
}

let fixture: SeededFixture

beforeEach(async () => {
  fixture = await makeTmuxSeededFixture()
  const now = ts()
  fixture.db.runs.insert({
    runId: RUN_ID,
    hostSessionId: TMUX_HOST_SESSION_ID,
    runtimeId: TMUX_RUNTIME_ID,
    scopeRef: TMUX_SCOPE_REF,
    laneRef: LANE_REF,
    generation: 1,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    operationId: TMUX_OPERATION_ID,
    invocationId: TMUX_INVOCATION_ID,
    dispatchedInputId: INPUT_ID,
  })
  // The live row at the moment the turn began: run assigned, runtime still ready.
  fixture.db.runtimes.update(TMUX_RUNTIME_ID, {
    activeInvocationId: TMUX_INVOCATION_ID,
    activeRunId: RUN_ID,
    status: 'ready',
    updatedAt: now,
  })
  fixture.db.brokerInvocations.update(TMUX_INVOCATION_ID, {
    brokerDriver: 'codex-app-server',
    capabilitiesJson: JSON.stringify({ bracketMintingMode: 'observed' }),
    updatedAt: now,
  })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('T-10464 observed own turn claims the runtime', () => {
  it('is busy and running from turn.attributed own until turn.completed', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })

    mapper.apply(
      envelope('input.accepted', 1, { inputId: INPUT_ID }, { inputId: INPUT_ID as never })
    )
    mapper.apply(
      envelope('turn.started', 2, { turnId: OWN_TURN, source: 'observed' }, { turnId: OWN_TURN })
    )
    mapper.apply(
      envelope(
        'turn.attributed',
        3,
        { turnId: OWN_TURN, ownership: 'own', inputId: INPUT_ID, origin: 'broker' },
        { turnId: OWN_TURN, inputId: INPUT_ID as never }
      )
    )

    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)).toMatchObject({
      status: 'busy',
      activeRunId: RUN_ID,
    })
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({ status: 'running' })

    mapper.apply(
      envelope(
        'turn.completed',
        4,
        { turnId: OWN_TURN, status: 'completed', producedContent: true },
        { turnId: OWN_TURN }
      )
    )

    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({ status: 'completed' })
    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.status).toBe('ready')
  })

  it('a late own attribution after the turn completed does not re-claim the runtime', () => {
    const mapper = new BrokerEventMapper({ db: fixture.db, now: () => ts(100) })
    fixture.db.runs.markCompleted(RUN_ID, {
      status: 'completed',
      completedAt: ts(2),
      updatedAt: ts(2),
    })

    mapper.apply(
      envelope('input.accepted', 1, { inputId: INPUT_ID }, { inputId: INPUT_ID as never })
    )
    mapper.apply(
      envelope('turn.started', 2, { turnId: OWN_TURN, source: 'observed' }, { turnId: OWN_TURN })
    )
    mapper.apply(
      envelope(
        'turn.attributed',
        3,
        { turnId: OWN_TURN, ownership: 'own', inputId: INPUT_ID, origin: 'broker' },
        { turnId: OWN_TURN, inputId: INPUT_ID as never }
      )
    )

    expect(fixture.db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID)?.status).toBe('ready')
    expect(fixture.db.runs.getByRunId(RUN_ID)).toMatchObject({ status: 'completed' })
  })
})
