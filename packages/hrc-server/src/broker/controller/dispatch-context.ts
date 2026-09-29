/**
 * The `DispatchContext` seam — the explicit stand-in for `this` that the
 * controller passes to the start and attach dispatch flows.
 */

import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type { BrokerEventMapper, BrokerProjectionResult } from '../event-mapper'
import type { AllocationContext } from './allocation'
import type { rehydrateInspectionCapabilities } from './internal'
import type { LifecycleContext } from './lifecycle'
import type { PersistenceContext } from './persistence'
import type {
  BrokerAttachedLaunchInput,
  BrokerClientFactory,
  BrokerClientLike,
  BrokerControllerLogger,
  BrokerControllerStartInput,
  BrokerTmuxAllocation,
  BrokerUnixClientFactory,
  DurableBrokerClientLike,
} from './types'

export type DispatchContext = {
  db: HrcDatabase
  mapper: Pick<BrokerEventMapper, 'apply'> &
    Partial<
      Pick<
        BrokerEventMapper,
        'flushIgnoredDeltas' | 'projectCaptureState' | 'projectCaptureRelease'
      >
    >
  brokerClientFactory: BrokerClientFactory
  brokerUnixClientFactory: BrokerUnixClientFactory
  resolveBrokerCommand: () => string
  brokerArgs: string[]
  env: Record<string, string | undefined> | undefined
  metricsStateRoot: string | undefined
  now: () => string
  serverInstanceId: string
  attachControlProbeTimeoutMs: number
  logger: BrokerControllerLogger
  persistenceContext: () => PersistenceContext
  allocationContext: () => AllocationContext
  lifecycleContext: () => LifecycleContext
  handlePermissionRequest: (request: PermissionRequestParams) => Promise<PermissionDecision>
  handleBrokerClose: (runtimeId: string, error: Error, client: BrokerClientLike) => void
  markBrokerClosing: (runtimeId: string, reason: string, client: BrokerClientLike) => void
  setActive: (record: {
    runtimeId: string
    invocationId: string
    client: BrokerClientLike
    closing: boolean
    inspection?: ReturnType<typeof rehydrateInspectionCapabilities>
    birthTimeline?: BrokerControllerStartInput['birthTimeline']
  }) => void
  consumeEvents: (runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>) => void
  afterMappedEvent: (
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ) => void
  resolveAttachInvocation: (
    runtime: HrcRuntimeSnapshot | null,
    runtimeId: string
  ) => HrcBrokerInvocationRecord | null
  lastProjectedBrokerSeq: (invocationId: string) => number
  testOnlyAfterProjectionCommitBeforeAck?:
    | ((input: {
        runtimeId: string
        invocationId: string
        committedThroughSeq: number
      }) => Promise<void> | void)
    | undefined
  connectDurableBrokerWithRetry: (
    socketPath: string,
    runtimeId: string
  ) => Promise<DurableBrokerClientLike>
  pauseForAttachedInvocationStart: (input: {
    pending: BrokerAttachedLaunchInput
    runtime: HrcRuntimeSnapshot
    allocation: BrokerTmuxAllocation
  }) => Promise<void>
  registerInvocation?: (input: {
    runtime: HrcRuntimeSnapshot
    invocation: HrcBrokerInvocationRecord
  }) => Promise<void> | void
}
