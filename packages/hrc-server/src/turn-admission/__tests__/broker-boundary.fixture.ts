import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import { envelope, inputId, turnId } from '../../__tests__/broker-event-mapper-fixtures'
import type { BrokerClientLike } from '../../broker/controller/types'
import { BrokerEventMapper } from '../../broker/event-mapper'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'

/** All delivery goes through the real controller and executors. */
export function fakeBrokerClient(
  ctx: HrcServerInstanceForHandlers,
  runtimeId: string,
  invocationId: string
): BrokerClientLike {
  let calls = 0
  const unused = async (): Promise<never> => {
    throw new Error('unexpected broker method')
  }
  const submit = async () => {
    const submissionId = inputId(`sub-conformance-${++calls}`)
    setTimeout(() => {
      const run = ctx.db.runs
        .listRuns()
        .find((row) => row.runtimeId === runtimeId && row.brokerSubmissionId === submissionId)
      if (run === undefined) throw new Error('submission has no durable run')
      const mapper = new BrokerEventMapper({ db: ctx.db })
      const seq = ctx.db.brokerInvocationEvents.maxBrokerSeq(invocationId) + 1
      const nativeTurn = turnId(`turn-conformance-${calls}`)
      for (const event of [
        envelope(
          'input.accepted',
          seq,
          { inputId: submissionId },
          { invocationId: invocationId as InvocationId, inputId: submissionId as InputId }
        ),
        envelope(
          'turn.started',
          seq + 1,
          { inputId: submissionId, turnId: nativeTurn },
          {
            invocationId: invocationId as InvocationId,
            inputId: submissionId as InputId,
            turnId: nativeTurn,
          }
        ),
        envelope(
          'turn.completed',
          seq + 2,
          { status: 'completed', turnId: nativeTurn },
          { invocationId: invocationId as InvocationId, turnId: nativeTurn }
        ),
      ]) {
        for (const lifecycle of mapper.apply({
          ...event,
          correlation: {
            runId: run.runId,
            runtimeId,
            hostSessionId: run.hostSessionId,
            scopeRef: run.scopeRef,
            laneRef: run.laneRef,
          },
        }).lifecycleEvents)
          ctx.notifyEvent(lifecycle)
      }
    }, 10)
    return { submissionId, admission: 'admitted' as const }
  }
  return {
    hello: unused,
    health: unused,
    startInvocationFromRequest: unused,
    invoke: submit,
    enqueue: submit,
    steer: submit,
    preempt: submit,
    turnManifest: unused,
    seatProbe: async (req) => ({
      invocationId: req.invocationId,
      seat: { state: 'idle' },
      brokerHeldDepth: 0,
    }),
    interrupt: unused,
    stop: unused,
    status: unused,
    dispose: async () => {},
    close: async () => {},
    onPermissionRequest() {},
    onClose() {},
  } satisfies BrokerClientLike
}
