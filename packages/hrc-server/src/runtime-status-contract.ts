export const HRC_RUNTIME_STATE_JSON_STATUS_VALUES = [
  'starting',
  'ready',
  'busy',
  'stopping',
  'stopped',
  'failed',
  'disposed',
  'awaiting_input',
  'stale',
  'terminated',
] as const

export const HRC_RUNTIME_STATE_JSON_STATUS_PRODUCERS = [
  { status: 'starting', producer: 'broker/controller/persistence.createBrokerRuntimeRecord' },
  { status: 'ready', producer: 'broker/event-mapper/runtime-state.completeRuntimeRun' },
  { status: 'busy', producer: 'broker/event-mapper/runtime-state.markRuntimeBusy' },
  { status: 'stopping', producer: 'broker/runtime-state.runtimeStatusFromInvocationState' },
  { status: 'stopped', producer: 'broker/runtime-state.runtimeStatusFromInvocationState' },
  { status: 'failed', producer: 'broker/controller/persistence.markRuntimeStartFailed' },
  { status: 'disposed', producer: 'broker/runtime-state.runtimeStatusFromInvocationState' },
  {
    status: 'awaiting_input',
    producer: 'broker/event-mapper/runtime-state.markRuntimeAwaitingInput',
  },
  { status: 'stale', producer: 'startup-reconcile/runtime-mutations.markRuntimeStale' },
  {
    status: 'terminated',
    producer: 'startup-reconcile/runtime-mutations.markRuntimeTerminatedAfterUserExit',
  },
] as const

export const HRC_RUNTIME_ROW_STATUS_VALUES = [
  ...HRC_RUNTIME_STATE_JSON_STATUS_VALUES,
  'dead',
  'adopted',
] as const

export const HRC_RUNTIME_ROW_STATUS_PRODUCERS = [
  { status: 'starting', producer: 'runtime-control-handlers.createRuntime' },
  { status: 'ready', producer: 'runtime-control-handlers.completeRuntimeRun' },
  { status: 'busy', producer: 'broker/event-mapper/runtime-state.markRuntimeBusy' },
  { status: 'stopping', producer: 'broker/runtime-state.runtimeStatusFromInvocationState' },
  { status: 'stopped', producer: 'broker/runtime-state.runtimeStatusFromInvocationState' },
  { status: 'failed', producer: 'startup-reconcile/runtime-mutations.finalizeActiveRun' },
  { status: 'disposed', producer: 'broker/controller.disposeRuntime' },
  {
    status: 'awaiting_input',
    producer: 'broker/event-mapper/runtime-state.markRuntimeAwaitingInput',
  },
  { status: 'stale', producer: 'startup-reconcile/runtime-mutations.markRuntimeStale' },
  {
    status: 'terminated',
    producer: 'startup-reconcile/runtime-mutations.markRuntimeTerminatedAfterUserExit',
  },
  { status: 'dead', producer: 'startup-reconcile/runtime-mutations.markRuntimeDead' },
  { status: 'adopted', producer: 'runtime-list-adopt-handlers.handleAdoptRuntime' },
] as const
