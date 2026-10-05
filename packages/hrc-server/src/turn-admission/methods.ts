import { executeSemanticTurn } from '../target-message-dm-handlers.js'
import { dispatchPublicSubmission } from '../turn-dispatch-submission-handlers.js'
import { executeHeadlessBrokerFormat2DispatchTurn } from './routes/broker-headless-format2.js'
import { executeHeadlessBrokerInputTurn } from './routes/broker-headless-input-turn.js'
import { dispatchQueuedHeadlessTurnInput } from './routes/broker-headless-queue.js'
import { executeHeadlessBrokerStartTurn } from './routes/broker-headless-start.js'
import {
  handleHeadlessBrokerDispatchTurn,
  handleHeadlessDispatchTurn,
} from './routes/broker-interactive-headless-dispatch.js'
import { executeInteractiveBrokerInputTurn } from './routes/broker-interactive-input-turn.js'
import { handleInteractiveTmuxBrokerDispatchTurn } from './routes/broker-interactive-tmux-dispatch.js'
import { tryDeliverSemanticTurnToInteractiveRuntime } from './routes/semantic-handoff.js'
import { executeAdmittedTurn } from './routes/turn-dispatch-admitted-turn.js'

/** Installed by server bootstrap; every delivery method requires a branded plan. */
export const admissionRouteMethods = {
  dispatchPublicSubmission,
  executeSemanticTurn,
  executeHeadlessBrokerStartTurn,
  dispatchQueuedHeadlessTurnInput,
  executeAdmittedTurn,
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  executeHeadlessBrokerInputTurn,
  executeHeadlessBrokerFormat2DispatchTurn,
  tryDeliverSemanticTurnToInteractiveRuntime,
}
export type AdmissionRouteMethods = typeof admissionRouteMethods
