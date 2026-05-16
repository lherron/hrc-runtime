import { join } from 'node:path'

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

function sdkIntent(): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider: 'anthropic',
      interactive: false,
    },
  }
}

function headlessIntent(): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider: 'anthropic',
      interactive: true,
    },
    execution: {
      preferredMode: 'headless',
    },
  }
}

function tmuxIntent(): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider: 'anthropic',
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

function getSession(hostSessionId: string): HrcSessionRecord {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const session = db.sessions.getByHostSessionId(hostSessionId)
    if (!session) {
      throw new Error(`missing test session ${hostSessionId}`)
    }
    return session
  } finally {
    db.close()
  }
}

function seedRawSession(hostSessionId: string, scopeRef: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
  } finally {
    db.close()
  }
}

async function dispatchTurnForSessionDirect(
  hostSessionId: string,
  prompt: string,
  runtimeIntent: object
): Promise<{ response: Response; body: any }> {
  if (!server) {
    throw new Error('server not initialized')
  }
  const response = await (
    server as unknown as {
      dispatchTurnForSession(
        session: HrcSessionRecord,
        intent: object,
        prompt: string
      ): Promise<Response>
    }
  ).dispatchTurnForSession(getSession(hostSessionId), runtimeIntent, prompt)
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

async function dispatchSdkWithMockedResult(
  prompt: string,
  result: BrainEnricherResult
): Promise<{ runId: string; content: string | undefined }> {
  brainEnricherMock.use(async (input) => {
    expect(input.prompt).toBe(prompt)
    return result
  })
  const hostSessionId = await resolveSession(`brain-${crypto.randomUUID()}`)
  const { response, body } = await dispatchTurn(hostSessionId, prompt, sdkIntent())
  expect(response.status).toBe(200)
  return { runId: body.runId, content: userPromptContentForRun(body.runId) }
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
  it('applies the empty enabled result with empty brain blocks and preserves the raw prompt', async () => {
    const rawPrompt = 'Explain the scheduler decision.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt)

    const { runId, content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: false,
      reason: 'enabled',
      sources: [],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(enrichedPrompt)
    expect(content).toContain(rawPrompt)
    expect(content).toContain('<brain_rules>\n</brain_rules>')
    expect(content).toContain('<brain_context source="gbrain" mode="query" results="0"')
    expect(acceptedPromptLengthForRun(runId)).toBe(enrichedPrompt.length)
  })

  it('fails open when gbrain exits non-zero', async () => {
    const rawPrompt = 'Continue after a gbrain CLI error.'

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: rawPrompt,
      applied: false,
      reason: 'resolution-error',
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(rawPrompt)
  })

  it('fails open when the gbrain query hits the timeout', async () => {
    const rawPrompt = 'Continue after a slow brain lookup.'

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: rawPrompt,
      applied: false,
      reason: 'query-timeout',
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(rawPrompt)
  })

  it('delivers only status-eligible brain context while leaving concepts and guides eligible', async () => {
    const rawPrompt = 'Which prior docs apply?'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      context: [
        { slug: 'concepts/current-model', mode: 'query', score: 0.98, text: 'concept survives' },
        { slug: 'guides/current-flow', mode: 'query', score: 0.93, text: 'guide survives' },
      ],
    })

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [
        { slug: 'concepts/current-model', score: 0.98 },
        { slug: 'guides/current-flow', score: 0.93 },
      ],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toContain('concept survives')
    expect(content).toContain('guide survives')
    expect(content).not.toContain('deprecated decision')
    expect(content).not.toContain('draft pattern')
    expect(content).not.toContain('superseded rule')
    expect(content).not.toContain('deprecated architecture')
  })

  it('keeps brain rules separate from brain context and limits rules to the top five', async () => {
    const rawPrompt = 'Apply operating rules.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      rules: ['rule 1', 'rule 2', 'rule 3', 'rule 4', 'rule 5'],
      context: [{ slug: 'concepts/context', mode: 'query', score: 0.91, text: 'context only' }],
    })

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'concepts/context', score: 0.91 }],
    })

    expectEnricherCalledWith(rawPrompt)
    const rulesBlock = content?.match(/<brain_rules>\n([\s\S]*?)\n<\/brain_rules>/)?.[1] ?? ''
    const contextBlock =
      content?.match(/<brain_context[^>]*>\n([\s\S]*?)\n<\/brain_context>/)?.[1] ?? ''
    expect(rulesBlock.split('\n')).toHaveLength(5)
    expect(rulesBlock).toContain('rule 5')
    expect(rulesBlock).not.toContain('context only')
    expect(contextBlock).toContain('context only')
    expect(contextBlock).not.toContain('rule 1')
  })

  it('uses the contracted enriched prompt block format', async () => {
    const rawPrompt = 'Format the enriched turn.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      rules: ['prefer narrow changes'],
      context: [{ slug: 'guides/testing', mode: 'query', score: 0.87, text: 'test with HRC' }],
      elapsedMs: 37,
    })

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'guides/testing', score: 0.87 }],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toMatch(
      /<brain_rules>\n[\s\S]*<\/brain_rules>\n<brain_context source="gbrain" mode="query" results="\d+" elapsed_ms="\d+">\n[\s\S]*<\/brain_context>/
    )
  })

  it('integrates end-to-end through POST /v1/turns', async () => {
    const rawPrompt = 'REST ingress should enrich once.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      context: [{ slug: 'concepts/rest', mode: 'query', score: 0.76, text: 'REST context' }],
    })

    const { content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'concepts/rest', score: 0.76 }],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(enrichedPrompt)
  })

  it('honors disabled brain mode without attempting a gbrain CLI query', async () => {
    const rawPrompt = 'No brain for this agent.'
    brainEnricherMock.use(async (input) => {
      expect(input.prompt).toBe(rawPrompt)
      return { prompt: input.prompt, applied: false, reason: 'disabled' }
    })
    const hostSessionId = await resolveSession('brain-disabled')

    const { response, body } = await dispatchTurn(hostSessionId, rawPrompt, sdkIntent())

    expect(response.status).toBe(200)
    expectEnricherCalledWith(rawPrompt)
    expect(userPromptContentForRun(body.runId)).toBe(rawPrompt)
    expect(brainEnricherMock.gbrainCliCalls()).toBe(0)
  })

  it('enriches before turn.user_prompt is emitted', async () => {
    const rawPrompt = 'Original prompt before event.'
    const enrichedPrompt = `${rawPrompt}\n\n<brain_rules>\nrule before event\n</brain_rules>\n<brain_context source="gbrain" mode="query" results="1" elapsed_ms="5">\nevent context\n</brain_context>`

    const { runId, content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'rules/event-order', score: 1 }],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(enrichedPrompt)
    expect(userPromptContentForRun(runId)).not.toBe(rawPrompt)
  })

  it('fails open for non-agent scopes without profile resolution', async () => {
    const hostSessionId = `hsid-system-${crypto.randomUUID()}`
    seedRawSession(hostSessionId, 'system:ops-dashboard')
    const rawPrompt = 'System scope prompt.'
    brainEnricherMock.use(async (input) => {
      expect(input.session.scopeRef).toBe('system:ops-dashboard')
      return { prompt: input.prompt, applied: false, reason: 'non-agent-scope' }
    })

    const { response, body } = await dispatchTurnForSessionDirect(
      hostSessionId,
      rawPrompt,
      sdkIntent()
    )

    expect(response.status).toBe(200)
    expectEnricherCalledWith(rawPrompt)
    expect(userPromptContentForRun(body.runId)).toBe(rawPrompt)
    expect(brainEnricherMock.profileLoadCalls()).toBe(0)
  })

  it('skips enrichment for empty and whitespace-only prompts', async () => {
    const hostSessionId = await resolveSession('brain-empty-prompt')
    brainEnricherMock.use(async (input) => {
      expect(input.prompt.trim()).toBe('')
      return { prompt: input.prompt, applied: false, reason: 'empty-prompt' }
    })

    const { response, body } = await dispatchTurnForSessionDirect(
      hostSessionId,
      '   \n\t',
      sdkIntent()
    )

    expect(response.status).toBe(200)
    expectEnricherCalledWith('   \n\t')
    expect(userPromptContentForRun(body.runId)).toBe('   \n\t')
    expect(brainEnricherMock.gbrainCliCalls()).toBe(0)
  })

  it('keeps disabled, resolution-error, and query-timeout reasons distinct', async () => {
    const reasons: BrainEnricherResult['reason'][] = [
      'disabled',
      'resolution-error',
      'query-timeout',
    ]

    for (const reason of reasons) {
      brainEnricherMock.use(async (input) => ({ prompt: input.prompt, applied: false, reason }))
      const hostSessionId = await resolveSession(`brain-reason-${reason}`)
      const { response } = await dispatchTurn(hostSessionId, `reason ${reason}`, sdkIntent())
      expect(response.status).toBe(200)
    }

    expect(brainEnricherMock.calls).toHaveLength(3)
    expect(new Set(reasons)).toEqual(new Set(['disabled', 'resolution-error', 'query-timeout']))
  })

  it('keeps ACP admission free of brain-enricher imports', async () => {
    const acpServerRoot = join(import.meta.dir, '..', '..', '..', 'acp-server', 'src')
    const proc = Bun.spawn(
      ['rg', 'enrichTurnPromptForBrain|brain-enricher|gbrain', acpServerRoot],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 1, stdout: '', stderr: '' })

    brainEnricherMock.use(async (input) => ({
      prompt: formatBrainPrompt(input.prompt, {
        context: [
          { slug: 'concepts/acp-forwarded', mode: 'query', score: 0.79, text: 'ACP forwarded' },
        ],
      }),
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'concepts/acp-forwarded', score: 0.79 }],
    }))
    const hostSessionId = await resolveSession('brain-acp-forwarded')
    const { response } = await dispatchTurn(hostSessionId, 'Forwarded through ACP.', sdkIntent())

    expect(response.status).toBe(200)
    expect(brainEnricherMock.calls).toHaveLength(1)
  })

  it('enriches before headless transport dispatch handles the prompt', async () => {
    const rawPrompt = 'Headless should receive enriched prompt.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      context: [{ slug: 'guides/headless', mode: 'query', score: 0.82, text: 'headless context' }],
    })
    brainEnricherMock.use(async () => ({
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'guides/headless', score: 0.82 }],
    }))
    const hostSessionId = await resolveSession('brain-headless')

    const { response, body } = await dispatchTurn(hostSessionId, rawPrompt, headlessIntent())

    expect(response.status).toBe(200)
    expect(body.transport).toBe('headless')
    expectEnricherCalledWith(rawPrompt)
    expect(userPromptContentForRun(body.runId)).toBe(enrichedPrompt)
  })

  it('enriches before SDK transport dispatch handles the prompt', async () => {
    const rawPrompt = 'SDK should receive enriched prompt.'
    const enrichedPrompt = formatBrainPrompt(rawPrompt, {
      context: [{ slug: 'guides/sdk', mode: 'query', score: 0.81, text: 'sdk context' }],
    })

    const { runId, content } = await dispatchSdkWithMockedResult(rawPrompt, {
      prompt: enrichedPrompt,
      applied: true,
      reason: 'enabled',
      sources: [{ slug: 'guides/sdk', score: 0.81 }],
    })

    expectEnricherCalledWith(rawPrompt)
    expect(content).toBe(enrichedPrompt)
    expect(acceptedPromptLengthForRun(runId)).toBe(enrichedPrompt.length)
  })

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
  })
})
