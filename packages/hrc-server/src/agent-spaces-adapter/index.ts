// hrc-adapter-agent-spaces: adapter between HRC intent and agent-spaces execution surfaces

// Phase 1: CLI adapter only
export {
  buildCliInvocation,
  mergeEnv,
  UnsupportedHarnessError,
  type BuildCliInvocationOptions,
  type CliInvocationResult,
  type SpecBuilder,
} from './cli-adapter.js'
export {
  runSdkTurn,
  type SdkTurnOptions,
  type SdkTurnResult,
  type SdkTurnRunner,
  getSdkInflightCapability,
  deliverSdkInflightInput,
  type SdkInflightInputOptions,
  type SdkInflightInputResult,
  type SdkInflightInputClient,
} from './sdk-adapter.js'
