import { getHarnessBrokerController } from './broker-interactive-handlers/controller-factory.js'
import {
  handleHeadlessBrokerDispatchTurn,
  handleHeadlessDispatchTurn,
} from './broker-interactive-headless-dispatch.js'
import {
  deliverReassociatedBrokerTmuxInput,
  executeInteractiveBrokerInputTurn,
} from './broker-interactive-input-turn.js'
import {
  handleInteractiveTmuxBrokerDispatchTurn,
  startInteractiveTmuxBrokerRuntime,
} from './broker-interactive-tmux-dispatch.js'

// Re-exported so the public surface of this module is preserved after the
// substrate-allocator + controller-factory split (no downstream import changes
// required).
export {
  allocateBrokerSubstrate,
  type AllocateBrokerSubstrateInput,
  type BrokerDurableTmuxAllocatorDeps,
  type BrokerSubstrateAllocation,
  type BrokerSubstratePresentationKind,
  BrokerTuiAllocationError,
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerObserverPaneAllocator,
  type DurableTmuxManagerLike,
} from './broker-interactive-handlers/substrate-allocator.js'
export { getHarnessBrokerController }

export {
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
}

export const brokerInteractiveHandlersMethods = {
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
