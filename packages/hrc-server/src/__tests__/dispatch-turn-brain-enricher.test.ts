import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

// biome-ignore lint/suspicious/noExportsInTest: T-01476 requires an exported mock surface for the C-impl handoff.
export type BrainEnricherInput = {
  session: HrcSessionRecord
  intent: HrcRuntimeIntent
  prompt: string
  runId?: string
}

// biome-ignore lint/suspicious/noExportsInTest: T-01476 requires an exported mock surface for the C-impl handoff.
export type BrainEnricherResult = {
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
  sources?: ReadonlyArray<{ slug: string; score: number }>
}

type BrainEnricherHandler = (input: BrainEnricherInput) => Promise<BrainEnricherResult>

// biome-ignore lint/suspicious/noExportsInTest: Documents the normalized admission stub shape from T-01473.
export type BrainRuntimeResolution =
  | { kind: 'enabled'; source: 'agent-profile' }
  | { kind: 'disabled'; source: 'agent-profile' }
  | { kind: 'unresolved'; reason: string }

// biome-ignore lint/suspicious/noExportsInTest: Documents the agent profile brain stub shape from T-01473.
export type AgentProfileBrain = {
  enabled?: boolean | undefined
}

const brainEnricherCalls: BrainEnricherInput[] = []
let brainEnricherHandler: BrainEnricherHandler | undefined
let profileLoadCalls = 0
let gbrainCliCalls = 0

// biome-ignore lint/suspicious/noExportsInTest: T-01476 requires an exported reusable mock for Larry's C-impl work.
export const brainEnricherMock = {
  calls: brainEnricherCalls,
  reset(): void {
    brainEnricherCalls.length = 0
    brainEnricherHandler = undefined
    profileLoadCalls = 0
    gbrainCliCalls = 0
  },
  use(handler: BrainEnricherHandler): void {
    brainEnricherHandler = handler
  },
  profileLoadCalls(): number {
    return profileLoadCalls
  },
  gbrainCliCalls(): number {
    return gbrainCliCalls
  },
  recordProfileLoad(): void {
    profileLoadCalls += 1
  },
  recordGbrainCliCall(): void {
    gbrainCliCalls += 1
  },
}

// biome-ignore lint/suspicious/noExportsInTest: T-01476 pins the exact exported module function signature.
export async function enrichTurnPromptForBrain(
  input: BrainEnricherInput
): Promise<BrainEnricherResult> {
  brainEnricherCalls.push(input)
  if (!brainEnricherHandler) {
    return { prompt: input.prompt, applied: false, reason: 'enabled' }
  }
  return brainEnricherHandler(input)
}

mock.module('../brain-enricher.js', () => ({ enrichTurnPromptForBrain }))
mock.module('../brain-enricher', () => ({ enrichTurnPromptForBrain }))

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  brainEnricherMock.reset()
  fixture = await createHrcTestFixture('hrc-brain-enricher-')
  const hrcServer = await import('../index')
  server = await hrcServer.createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
  brainEnricherMock.reset()
})

function tmuxIntent(): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: 'openai',
      interactive: true,
    },
    execution: {
      preferredMode: 'interactive',
    },
  }
}

async function resolveSession(scopeRef: string): Promise<string> {
  return (await fixture.resolveSession(scopeRef)).hostSessionId
}

async function dispatchTurn(
  hostSessionId: string,
  prompt: string,
  runtimeIntent: object,
  options: { waitForCompletion?: boolean | undefined } = {}
): Promise<{ response: Response; body: any }> {
  const response = await fixture.postJson('/v1/turns', {
    hostSessionId,
    prompt,
    runtimeIntent,
    ...(options.waitForCompletion !== undefined
      ? { waitForCompletion: options.waitForCompletion }
      : {}),
  })
  const body = await response.json()
  return { response, body }
}

function listHrcEvents(): any[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1)
  } finally {
    db.close()
  }
}

function userPromptContentForRun(runId: string): string | undefined {
  const event = listHrcEvents().find(
    (entry) => entry.runId === runId && entry.eventKind === 'turn.user_prompt'
  )
  return event?.payload?.message?.content
}

function acceptedPromptLengthForRun(runId: string): number | undefined {
  const event = listHrcEvents().find(
    (entry) => entry.runId === runId && entry.eventKind === 'turn.accepted'
  )
  return event?.payload?.promptLength
}

function formatBrainPrompt(
  rawPrompt: string,
  options: {
    rules?: string[] | undefined
    context?: Array<{ slug: string; mode: string; text: string; score: number }> | undefined
    elapsedMs?: number | undefined
  } = {}
): string {
  const rules = options.rules ?? []
  const context = options.context ?? []
  const rulesBlock =
    rules.length === 0
      ? '<brain_rules>\n</brain_rules>'
      : `<brain_rules>\n${rules.join('\n')}\n</brain_rules>`
  const contextText = context
    .map(
      (source) =>
        `<source slug="${source.slug}" score="${source.score}">\n${source.text}\n</source>`
    )
    .join('\n')

  return `${rawPrompt}

${rulesBlock}
<brain_context source="gbrain" mode="query" results="${context.length}" elapsed_ms="${
    options.elapsedMs ?? 12
  }">
${contextText}
</brain_context>`
}

function expectEnricherCalledWith(prompt: string): BrainEnricherInput {
  expect(brainEnricherMock.calls).toHaveLength(1)
  const call = brainEnricherMock.calls[0]
  expect(call.prompt).toBe(prompt)
  expect(call.session.hostSessionId).toBeTruthy()
  expect(call.intent).toBeTruthy()
  expect(call.runId).toMatch(/^run-/)
  return call
}

describe('dispatchTurnForSession brain enricher seam', () => {
  it('enriches before tmux transport dispatch handles the prompt', async () => {
    const rawPrompt = 'Tmux should receive enriched prompt.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      context: [{ slug: 'guides/tmux', mode: 'query', score: 0.8, text: 'tmux context' }],
    })
    brainEnricherMock.use(async () => ({
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'guides/tmux', score: 0.8 }],
    }))
    const hostSessionId = await resolveSession('brain-tmux')
    const ensure = await fixture.postJson('/v1/runtimes/ensure', {
      hostSessionId,
      intent: tmuxIntent(),
    })
    expect(ensure.status).toBe(200)

    const { response, body } = await dispatchTurn(hostSessionId, rawPrompt, tmuxIntent())

    expect(response.status).toBe(200)
    expect(body.transport).toBe('tmux')
    expectEnricherCalledWith(rawPrompt)
    expect(userPromptContentForRun(body.runId)).toBe(enrichedPrompt)

    expect(acceptedPromptLengthForRun(body.runId)).toBe(enrichedPrompt.length)
  }, 10_000)
})
