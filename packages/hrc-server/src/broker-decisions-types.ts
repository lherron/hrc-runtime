import type { HrcProvider, HrcRuntimeControllerKind } from 'hrc-core'

export type InteractiveTmuxBrokerDriver =
  | 'claude-code-tmux'
  | 'codex-app-server'
  | 'codex-cli-tmux'
  | 'pi-tui-tmux'
  | 'muse-cli-tmux'

export type LatestRuntimeAdmissionView = {
  controllerKind: HrcRuntimeControllerKind | undefined
  transport: string
  status: string
  provider: HrcProvider
  brokerDriver: InteractiveTmuxBrokerDriver | undefined
  // T-05358: false when the runtime's active broker invocation is terminal or
  // transitioning (starting/stopping) and therefore cannot accept input. Row
  // `status` alone admits `stopping` (a non-unavailable status), so reuse must
  // also gate on this — else the broker-reuse admission delivers input to a
  // tearing-down runtime and the broker rejects it (`Cannot accept input in
  // state: stopping`).
  inputDispatchable: boolean
  // T-07397: the runtime's ACTIVE broker invocation. A refusing caller may reuse
  // this runtime only by carrying exactly this id (proof it established the
  // surface itself). Undefined ⇒ nothing to match ⇒ never reuse under refusal.
  activeInvocationId?: string | undefined
} | null

export type InteractiveBrokerAdmissionDecision =
  | { decision: 'broker-reuse'; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
  | {
      decision: 'broker-start'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | {
      decision: 'stale-and-reprovision'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | { decision: 'runtime-unavailable'; reason: string }

export type InteractiveTmuxBrokerStartRoute =
  | {
      route: 'broker'
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
    }
  | { route: 'legacy-tmux' }
