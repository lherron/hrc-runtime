/**
 * T-04761 — CHARACTERIZATION TESTS (phase: pin-current-behavior, gates deletion)
 *
 * Pins the CURRENT observable behavior of enrichTurnPromptForBrain() — the live
 * (disabled) path — so curly's deletion of dead modules + reason-union narrowing
 * can be validated with confidence. These tests must pass GREEN today and must
 * STILL pass after the deletion.
 *
 * PUBLIC SURFACE UNDER TEST:
 *   enrichTurnPromptForBrain(input, deps?) → Promise<BrainEnricherResult>
 *   Barrel: packages/hrc-server/src/brain-enricher.ts
 *
 * REASON-UNION ARM CLASSIFICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * REACHABLE (pin here, must survive deletion):
 *   'disabled'        — agent: scope + non-empty prompt  ← the hot path every turn
 *   'non-agent-scope' — scopeRef does NOT start with 'agent:'
 *   'empty-prompt'    — scopeRef starts with 'agent:' but prompt.trim() === ''
 *
 * DEAD — never returned by the current implementation (do NOT pin; curly will delete):
 *   'enabled'             — no code path reaches it
 *   'injection-disabled'  — no code path reaches it
 *   'resolution-error'    — no code path reaches it
 *   'query-timeout'       — no code path reaches it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * INVARIANTS that hold for ALL reachable arms:
 *   applied === false          (always passThrough — brain enrichment is off)
 *   sources === undefined      (passThrough never sets sources)
 *   prompt === input.prompt    (prompt is returned unchanged)
 */

import { describe, expect, it } from 'bun:test'

import { enrichTurnPromptForBrain } from '../brain-enricher.js'
import type { BrainEnricherInput } from '../brain-enricher.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function agentInput(overrides: Partial<BrainEnricherInput> = {}): BrainEnricherInput {
  return {
    session: {
      scopeRef: 'agent:smokey:project:hrc-runtime:task:primary',
      hostSessionId: 'hsid-char-test',
    },
    intent: { placement: { agentRoot: '/tmp/char-test-root' } },
    prompt: 'what is the status of T-04761?',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// REACHABLE ARM: 'disabled'
// The hot path — agent scope + non-empty prompt → always disabled today
// ---------------------------------------------------------------------------

describe('T-04761 char: enrichTurnPromptForBrain — disabled arm (agent scope, non-empty prompt)', () => {
  it('returns applied=false, reason=disabled for a normal agent-scope input', async () => {
    const result = await enrichTurnPromptForBrain(agentInput())
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('disabled')
  })

  it('returns the prompt unchanged (pure passthrough)', async () => {
    const prompt = 'some multi-line\nprompt with\ttabs'
    const result = await enrichTurnPromptForBrain(agentInput({ prompt }))
    expect(result.prompt).toBe(prompt)
  })

  it('sources is not set (undefined) — no enrichment occurred', async () => {
    const result = await enrichTurnPromptForBrain(agentInput())
    expect(result.sources).toBeUndefined()
  })

  it('sources?.length ?? 0 evaluates to 0 (callers log sourceCount)', async () => {
    const result = await enrichTurnPromptForBrain(agentInput())
    expect(result.sources?.length ?? 0).toBe(0)
  })

  it('prompt length is unchanged (promptLengthDelta=0 in callers)', async () => {
    const prompt = 'hello world'
    const result = await enrichTurnPromptForBrain(agentInput({ prompt }))
    expect(result.prompt.length - prompt.length).toBe(0)
  })

  it('accepts a scoped agent ref with task-id suffix', async () => {
    const result = await enrichTurnPromptForBrain(
      agentInput({
        session: {
          scopeRef: 'agent:cody:project:agent-spaces:task:T-04761',
          hostSessionId: 'hsid-scoped',
        },
      })
    )
    expect(result.reason).toBe('disabled')
    expect(result.applied).toBe(false)
  })

  it('_deps is accepted but ignored — same result with or without a resolver', async () => {
    const withoutDeps = await enrichTurnPromptForBrain(agentInput())
    // Pass a deps object (the injection seam that will be removed) — result must be identical
    const withDeps = await enrichTurnPromptForBrain(agentInput(), {
      brainRuntimeResolver: async () => {
        throw new Error('resolver must not be called on the disabled path')
      },
    })
    expect(withDeps).toEqual(withoutDeps)
  })
})

// ---------------------------------------------------------------------------
// REACHABLE ARM: 'non-agent-scope'
// scopeRef does NOT start with 'agent:' — checked first, before empty-prompt
// ---------------------------------------------------------------------------

describe('T-04761 char: enrichTurnPromptForBrain — non-agent-scope arm', () => {
  it('returns applied=false, reason=non-agent-scope for a human-entity scope', async () => {
    const result = await enrichTurnPromptForBrain(
      agentInput({
        session: {
          scopeRef: 'entity:human',
          hostSessionId: 'hsid-human',
        },
        prompt: 'non-empty prompt',
      })
    )
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('non-agent-scope')
  })

  it('non-agent-scope fires even when prompt is empty (non-agent checked first)', async () => {
    const result = await enrichTurnPromptForBrain(
      agentInput({
        session: { scopeRef: 'user:lance', hostSessionId: 'hsid-user' },
        prompt: '',
      })
    )
    // non-agent-scope guard is checked before empty-prompt guard
    expect(result.reason).toBe('non-agent-scope')
  })

  it('returns prompt unchanged under non-agent-scope', async () => {
    const prompt = 'some prompt text'
    const result = await enrichTurnPromptForBrain(
      agentInput({
        session: { scopeRef: 'service:hrc', hostSessionId: 'hsid-svc' },
        prompt,
      })
    )
    expect(result.prompt).toBe(prompt)
    expect(result.sources).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// REACHABLE ARM: 'empty-prompt'
// agent: scope + prompt.trim() === '' → returns empty-prompt
// ---------------------------------------------------------------------------

describe('T-04761 char: enrichTurnPromptForBrain — empty-prompt arm', () => {
  it('returns applied=false, reason=empty-prompt for an empty string prompt', async () => {
    const result = await enrichTurnPromptForBrain(agentInput({ prompt: '' }))
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('empty-prompt')
  })

  it('returns applied=false, reason=empty-prompt for a whitespace-only prompt', async () => {
    const result = await enrichTurnPromptForBrain(agentInput({ prompt: '   \t\n  ' }))
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('empty-prompt')
  })

  it('returns the (empty) prompt unchanged', async () => {
    const prompt = ''
    const result = await enrichTurnPromptForBrain(agentInput({ prompt }))
    expect(result.prompt).toBe(prompt)
    expect(result.sources).toBeUndefined()
  })

  it('whitespace prompt: original whitespace string is preserved (not trimmed in output)', async () => {
    const prompt = '  \n  '
    const result = await enrichTurnPromptForBrain(agentInput({ prompt }))
    // The guard trims to detect empty, but the returned prompt is the original value
    expect(result.prompt).toBe(prompt)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting invariants: applied and sources for every reachable arm
// ---------------------------------------------------------------------------

describe('T-04761 char: invariants across all reachable arms', () => {
  const cases: Array<[string, BrainEnricherInput]> = [
    ['disabled (agent scope, non-empty)', agentInput()],
    [
      'non-agent-scope',
      agentInput({ session: { scopeRef: 'entity:human', hostSessionId: 'h' } }),
    ],
    ['empty-prompt (agent scope)', agentInput({ prompt: '' })],
  ]

  for (const [label, input] of cases) {
    it(`applied is always false [${label}]`, async () => {
      const result = await enrichTurnPromptForBrain(input)
      expect(result.applied).toBe(false)
    })

    it(`sources is always undefined [${label}]`, async () => {
      const result = await enrichTurnPromptForBrain(input)
      expect(result.sources).toBeUndefined()
    })
  }
})
