/**
 * T-09823: a fresh app-session ensure must admit its first turn onto the tmux
 * runtime it just birthed, even while that runtime's broker invocation is still
 * `starting`.
 *
 * Live (max3, codex-cli interactive): ensure births a tmux v2 runtime whose
 * invocation is still `starting` when the birth returns. The auto-dispatch then
 * took 78b1077b's producer-selected tmux reuse branch, which refuses a
 * transitioning invocation with 503 broker_runtime_transitioning, "the caller
 * retries once it settles" — but ensure is the caller and never retries, so the
 * session went `ready` with no first turn.
 *
 * The double reproduces the timing: the born invocation is held `starting` for
 * a moment after birth, then reaches `ready`, exactly as broker readiness
 * events settle it live.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  APP_ID,
  KEY,
  aspd,
  baseIntent,
  bootAspdBirthServer,
  internal,
  ledger,
  post,
  setUpAppSessionBirthFixture,
  tearDownAppSessionBirthFixture,
} from './fixtures/app-session-birth.fixture'
import { producerResult } from './fixtures/aspd-route-doubles'

const SETTLE_AFTER_MS = 300

beforeEach(setUpAppSessionBirthFixture)
afterEach(tearDownAppSessionBirthFixture)

function tmuxProducer() {
  return producerResult({
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: true,
    },
    execution: {
      recipeId: 'fixture-t09823-terminal',
      driver: 'codex-app-server',
      hosting: {
        executionTransport: 'pty',
        terminalRequired: true,
        terminalHost: 'tmux',
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
      presentationSurface: { transport: 'terminal', terminalHost: 'tmux' },
    },
  })
}

/** Hold the just-born invocation `starting`, then let it settle `ready`. */
function holdBornInvocationStarting(): void {
  const handlers = internal as unknown as {
    ensureRuntimeForSession: (...args: unknown[]) => Promise<{ activeInvocationId?: string }>
  }
  const ensureRuntime = handlers.ensureRuntimeForSession.bind(internal)
  handlers.ensureRuntimeForSession = async (...args: unknown[]) => {
    const runtime = await ensureRuntime(...args)
    const invocationId = runtime.activeInvocationId
    if (invocationId !== undefined) {
      const setState = (state: string) =>
        internal.db.sqlite
          .query('UPDATE broker_invocations SET invocation_state = ? WHERE invocation_id = ?')
          .run(state, invocationId)
      setState('starting')
      setTimeout(() => setState('ready'), SETTLE_AFTER_MS)
    }
    return runtime
  }
}

describe('T-09823 app-session ensure on its own just-born starting tmux runtime', () => {
  it('admits the first turn onto the born invocation instead of 503ing', async () => {
    await bootAspdBirthServer()
    aspd!.producerResult = tmuxProducer()
    holdBornInvocationStarting()

    const response = await post('/v1/app-sessions/ensure', {
      selector: { appId: APP_ID, appSessionKey: KEY },
      spec: { kind: 'harness', runtimeIntent: baseIntent() },
      initialPrompt: 'first turn on a starting birth',
    })

    expect(response.status).toBe(200)
    // No second writer: the first turn rides the invocation the birth started.
    expect(ledger?.startCalls).toHaveLength(1)
    const born = internal.db.runtimes.listAvailable().find((r) => r.transport === 'tmux')
    expect(born).toBeDefined()
    const firstTurn = internal.db.runs
      .listRuns({ hostSessionId: born?.hostSessionId })
      .find((run) => run.runtimeId === born?.runtimeId)
    expect(firstTurn).toBeDefined()
    expect(firstTurn?.status).not.toBe('failed')
  })
})
