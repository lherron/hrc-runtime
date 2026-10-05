import { getHarnessBrokerController } from './broker-interactive-handlers/controller-factory.js'
import { deliverReassociatedBrokerTmuxInput } from './turn-admission/routes/broker-interactive-input-turn.js'
import { startInteractiveTmuxBrokerRuntime } from './turn-admission/routes/broker-interactive-tmux-dispatch.js'

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

export { deliverReassociatedBrokerTmuxInput, startInteractiveTmuxBrokerRuntime }

export const brokerInteractiveHandlersMethods = {
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
