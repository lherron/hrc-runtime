import type { AgentBrainRuntimeContext, BrainRuntimeResolution } from 'spaces-execution'

import type { BrainContextSource, BrainRule } from './format.js'

export interface BrainEnricherInput {
  session: { scopeRef: string; hostSessionId: string }
  intent: { placement: { agentRoot: string } }
  prompt: string
  runId?: string | undefined
}

export interface BrainEnricherResult {
  prompt: string
  applied: boolean
  reason:
    | 'enabled'
    | 'disabled'
    | 'injection-disabled'
    | 'resolution-error'
    | 'query-timeout'
    | 'empty-prompt'
    | 'non-agent-scope'
  sources?: ReadonlyArray<{ slug: string; score: number }> | undefined
}

export type BrainRuntimeResolver = (
  context: AgentBrainRuntimeContext,
  baseEnv?: Record<string, string> | undefined
) => Promise<BrainRuntimeResolution>

type BrainEnricherDeps = {
  brainRuntimeResolver?: BrainRuntimeResolver | undefined
}

export async function enrichTurnPromptForBrain(
  input: BrainEnricherInput,
  _deps: BrainEnricherDeps = {}
): Promise<BrainEnricherResult> {
  if (!input.session.scopeRef.startsWith('agent:')) {
    return passThrough(input.prompt, 'non-agent-scope')
  }

  if (input.prompt.trim().length === 0) {
    return passThrough(input.prompt, 'empty-prompt')
  }

  return passThrough(input.prompt, 'disabled')
}

function passThrough(prompt: string, reason: BrainEnricherResult['reason']): BrainEnricherResult {
  return { prompt, applied: false, reason }
}

export type { BrainContextSource, BrainRule }
