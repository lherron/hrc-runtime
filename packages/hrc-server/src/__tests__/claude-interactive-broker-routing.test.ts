/**
 * T-01770 (T-01761 Phase B/C/D) — route non-interactive Claude turns to the
 * claude-code-tmux broker, block synchronous callers, and resume on recreate.
 *
 * These unit tests pin the HRC-side routing/threading SEAMS with mocks. They do
 * NOT assert real claude-code-tmux argv/capability behavior compiled from the
 * ASP snapshot — that is proven in the coordinator e2e after the snapshot pin
 * (see task NOTE). Here we assert:
 *
 *   B (admission): shouldRedirectClaudeToInteractiveBroker admits ariadne-class
 *     (explicit id:claude-code, dispatched headless) AND SDK-shaped Claude
 *     intents (agent-sdk / pi-sdk / id-less anthropic) even when preferredMode
 *     is headless; normalizeClaudeInteractiveBrokerIntent rewrites them so the
 *     dispatch predicates send them to the claude-code-tmux broker branch and
 *     NOT to the SDK executor (runSdkTurn) or legacy exec (executeHeadlessCliTurn).
 *
 *   C (block): shouldBlockForBrokerTurnCompletion encodes the headless-parity
 *     convention (undefined/true => block, false => return started); and
 *     waitForInteractiveBrokerRunCompletion blocks until the run reaches a
 *     terminal state and surfaces failures.
 *
 *   D (resume): decideInteractiveTmuxBrokerContinuation returns the captured
 *     session continuation for safe explicit-id TUI resume. Claude accepts an
 *     Anthropic key; Codex accepts only openai + kind:session + UUID, so the
 *     adapter can emit `codex resume <uuid>` and never no-arg picker resume.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import type { HrcContinuationRef, HrcRuntimeIntent } from 'hrc-core'

import * as hrc from '../index'
import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

type Harness = HrcRuntimeIntent['harness']

function intent(
  harness: Harness,
  preferredMode: 'headless' | 'interactive' | 'nonInteractive' = 'headless'
): HrcRuntimeIntent {
  return {
    placement: { kind: 'inline' } as unknown as HrcRuntimeIntent['placement'],
    harness,
    execution: { preferredMode },
  }
}

// Typed handles to the seams under test (undefined until implemented => RED).
const api = hrc as unknown as {
  shouldRedirectClaudeToInteractiveBroker?: (intent: HrcRuntimeIntent) => boolean
  normalizeClaudeInteractiveBrokerIntent?: (intent: HrcRuntimeIntent) => HrcRuntimeIntent
  shouldBlockForBrokerTurnCompletion?: (waitForCompletion: boolean | undefined) => boolean
  decideInteractiveTmuxBrokerContinuation?: (options: {
    allowedBrokerDriver: 'claude-code-tmux' | 'codex-cli-tmux' | 'pi-tui-tmux'
    sessionContinuation: HrcContinuationRef | undefined
  }) => HrcContinuationRef | undefined
  // Reused existing predicates (now exported) to prove post-normalization routing.
  shouldUseHeadlessTransport?: (intent: HrcRuntimeIntent) => boolean
  shouldUseSdkTransport?: (intent: HrcRuntimeIntent) => boolean
  shouldConsiderClaudeCodeTmuxBrokerDispatch?: (intent: HrcRuntimeIntent) => boolean
}

describe('T-01770 seam exports exist', () => {
  it('exports the Phase B/C/D seams', () => {
    expect(typeof api.shouldRedirectClaudeToInteractiveBroker).toBe('function')
    expect(typeof api.normalizeClaudeInteractiveBrokerIntent).toBe('function')
    expect(typeof api.shouldBlockForBrokerTurnCompletion).toBe('function')
    expect(typeof api.decideInteractiveTmuxBrokerContinuation).toBe('function')
    expect(typeof api.shouldUseHeadlessTransport).toBe('function')
    expect(typeof api.shouldUseSdkTransport).toBe('function')
    expect(typeof api.shouldConsiderClaudeCodeTmuxBrokerDispatch).toBe('function')
  })
})

describe('Phase B — shouldRedirectClaudeToInteractiveBroker admission', () => {
  type Case = { name: string; harness: Harness; expected: boolean }
  const cases: Case[] = [
    {
      name: 'ariadne-class explicit claude-code (anthropic, headless) => redirect',
      harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
      expected: true,
    },
    {
      name: 'SDK-shaped agent-sdk (anthropic) => redirect',
      harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
      expected: true,
    },
    {
      name: 'SDK-shaped pi-sdk (anthropic) => redirect',
      harness: { provider: 'anthropic', interactive: false, id: 'pi-sdk' },
      expected: true,
    },
    {
      name: 'id-less anthropic headless => redirect',
      harness: { provider: 'anthropic', interactive: false },
      expected: true,
    },
    {
      name: 'agent-spaces-native claude-code-cli (anthropic, headless) => redirect',
      // 'claude-code-cli' is an out-of-type agent-spaces runtime value a raw
      // adapter can leak; cast to exercise the defensive clause.
      harness: {
        provider: 'anthropic',
        interactive: false,
        id: 'claude-code-cli',
      } as unknown as Harness,
      expected: true,
    },
    {
      name: 'openai codex-cli headless => NOT redirect (codex cutover owns it)',
      harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
      expected: false,
    },
    {
      name: 'id-less openai headless => NOT redirect',
      harness: { provider: 'openai', interactive: false },
      expected: false,
    },
    {
      name: 'openai pi-sdk => NOT redirect (would normalize to codex, not claude)',
      harness: { provider: 'openai', interactive: false, id: 'pi-sdk' },
      expected: false,
    },
    {
      name: 'pi-cli (anthropic) => NOT redirect (not an SDK/claude id)',
      harness: { provider: 'anthropic', interactive: true, id: 'pi-cli' },
      expected: false,
    },
  ]
  for (const { name, harness, expected } of cases) {
    it(name, () => {
      expect(api.shouldRedirectClaudeToInteractiveBroker!(intent(harness))).toBe(expected)
    })
  }
})

describe('Phase B — normalizeClaudeInteractiveBrokerIntent flips routing to claude-code-tmux', () => {
  const redirectCases: { name: string; harness: Harness }[] = [
    {
      name: 'ariadne-class id:claude-code dispatched headless',
      harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
    },
    {
      name: 'SDK-shaped agent-sdk',
      harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
    },
    {
      name: 'id-less anthropic',
      harness: { provider: 'anthropic', interactive: false },
    },
    {
      name: 'agent-spaces-native claude-code-cli',
      harness: {
        provider: 'anthropic',
        interactive: false,
        id: 'claude-code-cli',
      } as unknown as Harness,
    },
  ]

  for (const { name, harness } of redirectCases) {
    it(`${name}: normalized intent bypasses headless + SDK and enters the claude broker branch`, () => {
      const raw = intent(harness, 'headless')
      // Precondition: the raw intent today would NOT reach the claude broker
      // branch (it is headless), proving the regression the redirect closes.
      expect(api.shouldUseHeadlessTransport!(raw)).toBe(true)

      const normalized = api.normalizeClaudeInteractiveBrokerIntent!(raw)

      // No headless transport => executeHeadlessCliTurn (legacy exec) unreachable.
      expect(api.shouldUseHeadlessTransport!(normalized)).toBe(false)
      // No SDK transport => runSdkTurn unreachable.
      expect(api.shouldUseSdkTransport!(normalized)).toBe(false)
      // Admitted into the claude-code-tmux broker dispatch branch.
      expect(api.shouldConsiderClaudeCodeTmuxBrokerDispatch!(normalized)).toBe(true)
      // Normalized to an interactive claude-code anthropic intent.
      expect(normalized.harness.interactive).toBe(true)
      expect(normalized.harness.id).toBe('claude-code')
      expect(normalized.harness.provider).toBe('anthropic')
      expect(normalized.execution?.preferredMode).toBe('interactive')
    })
  }
})

describe('Phase C — shouldBlockForBrokerTurnCompletion convention (headless parity)', () => {
  it('blocks when waitForCompletion is undefined (default synchronous caller)', () => {
    expect(api.shouldBlockForBrokerTurnCompletion!(undefined)).toBe(true)
  })
  it('blocks when waitForCompletion is true', () => {
    expect(api.shouldBlockForBrokerTurnCompletion!(true)).toBe(true)
  })
  it('returns started (does not block) when waitForCompletion is false', () => {
    expect(api.shouldBlockForBrokerTurnCompletion!(false)).toBe(false)
  })
})

describe('Phase D — decideInteractiveTmuxBrokerContinuation gating', () => {
  const captured: HrcContinuationRef = { provider: 'anthropic', key: 'session-uuid-1234' }
  const codexSessionUuid = '018fe9d5-992c-7cc8-a4bc-9c0c04c4f919'
  const codexCaptured = {
    provider: 'openai',
    kind: 'session',
    key: codexSessionUuid,
  } as HrcContinuationRef & { kind: 'session' }

  it('claude-code-tmux + captured session id => resume with the captured continuation', () => {
    expect(
      api.decideInteractiveTmuxBrokerContinuation!({
        allowedBrokerDriver: 'claude-code-tmux',
        sessionContinuation: captured,
      })
    ).toEqual(captured)
  })

  it('claude-code-tmux + no captured session id => fresh launch (undefined)', () => {
    expect(
      api.decideInteractiveTmuxBrokerContinuation!({
        allowedBrokerDriver: 'claude-code-tmux',
        sessionContinuation: undefined,
      })
    ).toBeUndefined()
  })

  it('claude-code-tmux + continuation with no key => fresh launch (undefined)', () => {
    expect(
      api.decideInteractiveTmuxBrokerContinuation!({
        allowedBrokerDriver: 'claude-code-tmux',
        sessionContinuation: { provider: 'anthropic' },
      })
    ).toBeUndefined()
  })

  it('codex-cli-tmux + openai session UUID => resume with explicit session id', () => {
    expect(
      api.decideInteractiveTmuxBrokerContinuation!({
        allowedBrokerDriver: 'codex-cli-tmux',
        sessionContinuation: codexCaptured,
      })
    ).toEqual(codexCaptured)
  })

  it('codex-cli-tmux rejects non-session or non-UUID continuations so no-arg picker resume is unreachable', () => {
    const badContinuations = [
      { provider: 'openai', key: codexSessionUuid },
      { provider: 'openai', kind: 'thread', key: codexSessionUuid },
      { provider: 'openai', kind: 'session', key: 'rollout-file-or-thread-key' },
      { provider: 'anthropic', kind: 'session', key: codexSessionUuid },
    ] as Array<HrcContinuationRef & { kind?: string }>

    for (const sessionContinuation of badContinuations) {
      expect(
        api.decideInteractiveTmuxBrokerContinuation!({
          allowedBrokerDriver: 'codex-cli-tmux',
          sessionContinuation,
        })
      ).toBeUndefined()
    }
  })

  it('pi-tui-tmux remains blocked even with an openai session UUID continuation', () => {
    expect(
      api.decideInteractiveTmuxBrokerContinuation!({
        allowedBrokerDriver: 'pi-tui-tmux',
        sessionContinuation: codexCaptured,
      })
    ).toBeUndefined()
  })
})

describe('Phase C — waitForInteractiveBrokerRunCompletion blocks on the run terminal state', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-claude-broker-routing-')
    server = await hrc.createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
    await fixture.cleanup()
  })

  async function seedRun(
    status: 'completed' | 'failed',
    runId: string
  ): Promise<{ runtimeId: string }> {
    const scopeRef = 'agent:ariadne:project:hrc-runtime'
    const resolved = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-test-${runId}`
    fixture.seedTmuxRuntime(resolved.hostSessionId, scopeRef, runtimeId, { status: 'busy' })
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.runs.insert({
        runId,
        hostSessionId: resolved.hostSessionId,
        runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: resolved.generation,
        transport: 'tmux',
        status,
        acceptedAt: now,
        completedAt: now,
        updatedAt: now,
        ...(status === 'failed'
          ? { errorCode: 'RUNTIME_UNAVAILABLE', errorMessage: 'broker exploded' }
          : {}),
      })
    } finally {
      db.close()
    }
    return { runtimeId }
  }

  it('resolves with the completed run when it is already terminal', async () => {
    const runId = `run-${Date.now()}-ok`
    const { runtimeId } = await seedRun('completed', runId)
    const waitFn = (
      server as unknown as {
        waitForInteractiveBrokerRunCompletion: (
          runId: string,
          runtimeId: string
        ) => Promise<{ runId: string; status: string }>
      }
    ).waitForInteractiveBrokerRunCompletion.bind(server)
    const run = await waitFn(runId, runtimeId)
    expect(run.status).toBe('completed')
    expect(run.runId).toBe(runId)
  })

  it('throws when the run terminated in a non-completed (failed) state', async () => {
    const runId = `run-${Date.now()}-fail`
    const { runtimeId } = await seedRun('failed', runId)
    const waitFn = (
      server as unknown as {
        waitForInteractiveBrokerRunCompletion: (
          runId: string,
          runtimeId: string
        ) => Promise<unknown>
      }
    ).waitForInteractiveBrokerRunCompletion.bind(server)
    await expect(waitFn(runId, runtimeId)).rejects.toThrow(/interactive broker turn failed/)
  })
})
