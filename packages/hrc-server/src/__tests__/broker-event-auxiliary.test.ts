/**
 * RED tests (T-01696 / T-01690 Wave W3A) for the idempotent BROKER EVENT MAPPER.
 *
 * These tests are EXPECTED TO FAIL until curly implements
 *   packages/hrc-server/src/broker/event-mapper.ts
 * (red signal = module-not-found on the import below).
 *
 * The mapper is the SOLE interpreter of broker `InvocationEventEnvelope`
 * payloads. It resolves projection context from the persisted broker invocation
 * and, in ONE SQLite transaction:
 *   1. appends the broker event by (invocationId, seq) via the W1B idempotent
 *      append repo (`BrokerInvocationEventRepository.appendEvent`);
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits canonical lifecycle rows through `HrcEventRepository`;
 *   4. marks the broker event row projection_status = 'applied'.
 *
 * Contract invariants under test:
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     BrokerInvocationEventConflictError, NO projection;
 *   - the retired raw `events` mirror remains empty;
 *   - full ordered sequence projects runtime/run/message/tool/continuation;
 *   - replay of the whole sequence is a no-op.
 *
 * Public API under test (documented for curly in the final reply):
 *   class BrokerEventMapper {
 *     constructor(deps: { db: HrcDatabase; now?: () => string })
 *     apply(envelope: InvocationEventEnvelope): {
 *       idempotent: boolean
 *       events: HrcEventEnvelope[]   // retired compatibility surface; always empty
 *     }
 *   }
 */
import { describe, expect, it } from 'bun:test'
import type { TurnId } from 'spaces-harness-broker-protocol'

import {
  INVOCATION_ID,
  RUNTIME_ID,
  RUN_ID,
  envelope,
  permissionRequestId,
  ts,
} from './broker-event-mapper-fixtures'

import { createBrokerEventMapperTestFixture } from './broker-event-mapper.test.fixture.js'

const harness = createBrokerEventMapperTestFixture()

describe('auxiliary projections', () => {
  it('audits permission.resolved through permission_decisions', () => {
    const mapper = harness.makeMapper()
    const prid = permissionRequestId('perm_w3a_1')

    mapper.apply(
      envelope('permission.requested', 30, {
        permissionRequestId: prid,
        kind: 'command',
        subjectDisplay: { command: 'rm -rf /tmp/x' },
        defaultDecision: 'deny',
      })
    )

    mapper.apply(
      envelope('permission.resolved', 31, {
        permissionRequestId: prid,
        decision: 'deny',
        decidedBy: 'policy',
      })
    )

    const decision = harness.fixture.db.permissionDecisions.getByPermissionRequestId('perm_w3a_1')
    expect(decision).not.toBeNull()
    expect(decision!.decision).toBe('deny')
    expect(decision!.decidedBy).toBe('policy')
    expect(decision!.invocationId).toBe(INVOCATION_ID)
    expect(decision!.runtimeId).toBe(RUNTIME_ID)
  })

  it('binds a terminal surface on terminal.surface.reported', () => {
    const mapper = harness.makeMapper()
    mapper.apply(
      envelope('terminal.surface.reported', 40, {
        kind: 'tmux-session',
        socketPath: '/tmp/hrc-tmux.sock',
        sessionName: 'broker-w3a',
        paneId: '%7',
      })
    )

    const bindings = harness.fixture.db.surfaceBindings.findByRuntime(RUNTIME_ID)
    expect(bindings.length).toBeGreaterThan(0)
  })

  it('keeps provenance-only diagnostics durable in the broker ledger', () => {
    const mapper = harness.makeMapper()
    const result = mapper.apply(
      envelope('diagnostic', 50, {
        level: 'warn',
        message: 'broker-diagnostic-marker',
        source: 'driver',
      })
    )

    expect(result.events).toEqual([])
    expect(result.lifecycleEvents).toEqual([])
    const stored = harness.fixture.db.brokerInvocationEvents.getByInvocationAndSeq(
      INVOCATION_ID,
      50
    )
    expect(stored?.brokerEventJson).toContain('broker-diagnostic-marker')
  })

  it('projects only error/api diagnostics into non-terminal monitor lifecycle rows', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    // T-05096 guard: info/warn diagnostics remain provenance-only so monitor
    // visibility does not broaden into noisy broker health chatter.
    const warn = mapper.apply(
      envelope('diagnostic', 50, {
        level: 'warn',
        source: 'harness',
        message: 'background warning',
        data: { code: 'ordinary_warning' },
      })
    )
    expect(warn.events).toEqual([])
    expect(warn.lifecycleEvents).toEqual([])
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })).toEqual([])

    const beforeRun = db.runs.getByRunId(RUN_ID)!
    const beforeRuntime = db.runtimes.getByRuntimeId(RUNTIME_ID)!

    const diagnosticEnvelope = {
      ...envelope(
        'diagnostic',
        51,
        {
          level: 'error',
          source: 'harness',
          message: 'API Error: overloaded upstream',
          data: {
            code: 'api_error',
            rawType: 'assistant',
            isApiErrorMessage: true,
            requestId: 'req_05096',
            apiErrorStatus: 529,
          },
        },
        {
          turnId: 'turn_api_error' as TurnId,
          inputId: 'input_api_error' as never,
          itemId: 'item_api_error',
        }
      ),
      correlation: { requestId: 'req_05096', spanId: 'span_05096' },
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
    }

    const result = mapper.apply(diagnosticEnvelope)

    expect(result.events).toEqual([])
    expect(result.lifecycleEvents.map((event) => event.eventKind)).toEqual(['broker.diagnostic'])
    expect(result.lifecycleEvents).toHaveLength(1)

    const lifecycle = result.lifecycleEvents[0]!
    expect(lifecycle.category).toBe('runtime')
    expect(lifecycle.runId).toBe(RUN_ID)
    expect(lifecycle.payload).toMatchObject({
      level: 'error',
      source: 'harness',
      message: 'API Error: overloaded upstream',
      data: {
        code: 'api_error',
        rawType: 'assistant',
        isApiErrorMessage: true,
        requestId: 'req_05096',
        apiErrorStatus: 529,
      },
      invocationId: INVOCATION_ID,
      seq: 51,
      time: ts(51),
      turnId: 'turn_api_error',
      inputId: 'input_api_error',
      itemId: 'item_api_error',
      correlation: { requestId: 'req_05096', spanId: 'span_05096' },
      driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
      runId: RUN_ID,
    })

    const hrcRows = db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })
    expect(hrcRows).toHaveLength(1)
    expect(hrcRows[0]!.category).toBe('runtime')
    expect(hrcRows[0]!.payload).toMatchObject({
      message: 'API Error: overloaded upstream',
      data: { code: 'api_error' },
      invocationId: INVOCATION_ID,
      seq: 51,
      runId: RUN_ID,
    })

    expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: beforeRun.status,
      completedAt: beforeRun.completedAt,
    })
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)).toMatchObject({
      status: beforeRuntime.status,
    })
    expect(
      db.hrcEvents
        .listByRun(RUN_ID)
        .filter((event) =>
          ['turn.failed', 'turn.finished', 'turn.completed', 'invocation.failed'].includes(
            event.eventKind
          )
        )
    ).toEqual([])

    // T-05096 idempotency guard: replaying the same broker sequence must not
    // duplicate the monitor-visible diagnostic.
    const replay = mapper.apply(diagnosticEnvelope)
    expect(replay.idempotent).toBe(true)
    expect(replay.lifecycleEvents).toEqual([])
    expect(db.hrcEvents.listByRun(RUN_ID, { eventKind: 'broker.diagnostic' })).toHaveLength(1)
    expect(
      db.brokerInvocationEvents.listByInvocationId(INVOCATION_ID).map((event) => event.seq)
    ).toContain(51)
  })

  it('does not expose fabricated terminal-state fields on public run/runtime records', () => {
    const mapper = harness.makeMapper()
    const db = harness.fixture.db

    mapper.apply(
      envelope(
        'diagnostic',
        52,
        {
          level: 'error',
          source: 'harness',
          message: 'API Error: rate limited',
          data: { code: 'api_error' },
        },
        {
          turnId: 'turn_x' as TurnId,
          inputId: 'input_rate_limit',
          driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
        }
      )
    )

    const run = db.runs.getByRunId(RUN_ID)!
    const runtime = db.runtimes.getByRuntimeId(RUNTIME_ID)!

    // T-05096 gate addendum: these fields never existed on the public DTOs.
    // Non-terminal behavior is covered by real status/completedAt/event-kind
    // assertions; adding undefined placeholders would pollute every consumer.
    expect('failureKind' in run).toBe(false)
    expect('lastError' in runtime).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Replay — applying the whole sequence again is a no-op
// ---------------------------------------------------------------------------
