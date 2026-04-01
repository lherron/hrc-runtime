export type HookEnvelopeEnv = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
}

export type HookEnvelope = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  hookData: unknown
}

export function buildHookEnvelope(stdinJson: unknown, env: HookEnvelopeEnv): HookEnvelope {
  return {
    launchId: env.launchId,
    hostSessionId: env.hostSessionId,
    generation: env.generation,
    runtimeId: env.runtimeId,
    hookData: stdinJson,
  }
}
