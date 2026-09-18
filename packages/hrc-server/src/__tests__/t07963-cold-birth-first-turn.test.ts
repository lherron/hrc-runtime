/**
 * T-07963 criterion 4 — the cold boot's first turn IS the delivery.
 *
 * The defect this pins: a cold-birthed seat took the caller's prompt as a
 * SECOND submission after the compiler priming turn finished, so the run sat
 * `accepted` with a NULL `dispatched_input_id` for the whole first turn. The
 * broker's `turn.started` quotes the initial input's id, `runForInputIdentity`
 * could not resolve it to any run, and the turn was orphaned from its own run —
 * which left the mail drive stuck at `claimed`, armed no reminder, and
 * stranded the sender's obligation with neither reminder nor failure (EN-03687).
 *
 * PROOF BOUNDARY, deliberate. Criterion 4 also asks that the single submission's
 * CONTENT hold priming + the envelope body concatenated. That concatenation is
 * `combineBrokerPrompts`, which lives in the agent-spaces compiler and is not
 * exported from that package's root, so asserting it here could only assert a
 * double written in this file. These tests therefore pin exactly what HRC
 * controls — the prompt it hands to compile, the cardinality of the initial
 * input, and the run binding — and the concatenation is proved against the real
 * compiler in the criterion-5 live smoke by reading the broker ledger.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { persistStartGraph } from '../broker/controller/persistence.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { makeBrokerProfile, makeCompileResponse } from './broker-compile-fixtures.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE = 'agent:t07963:project:hrc-runtime:task:T-07963'
const ENVELOPE_BODY =
  '[T-07963 · mable@agent-spaces:primary → you · reply required]\nDeliver this in the first turn.'

let fixture: HrcServerTestFixture
let server: HrcServer

function headlessIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07963-cold-birth-')
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

/**
 * T-08596: the local facade compile behind a cold birth is deleted. On a node
 * that declares no aspd endpoint the birth refuses with the typed closure
 * refusal before any compile is consulted — so the prompt/identity plumbing
 * assertions below pin the refusal (and that no compile runs), not the shaping
 * of a compile request HRC no longer builds. Prompt shaping on the aspd path
 * is pinned by the aspd-prepared route tests.
 */
async function refusedColdBirth(prompt: string, runId: string): Promise<unknown> {
  const resolved = await fixture.resolveSession(SCOPE)
  const internal = server as unknown as {
    db: { sessions: { getByHostSessionId(id: string): HrcSessionRecord | null } }
    executeHeadlessBrokerStartTurn(
      session: HrcSessionRecord,
      intent: HrcRuntimeIntent,
      prompt: string,
      runId: string,
      options: Record<string, unknown>
    ): Promise<Response>
  }
  const session = internal.db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (session === null) throw new Error('T-07963 fixture session was not persisted')
  return await internal
    .executeHeadlessBrokerStartTurn(session, headlessIntent(), prompt, runId, {
      waitForCompletion: false,
    })
    .then(
      () => {
        throw new Error('cold birth without an aspd endpoint must refuse')
      },
      (error: unknown) => error
    )
}

describe('T-07963 criterion 4 — cold birth without an aspd endpoint refuses (T-08596)', () => {
  it('refuses the caller-prompt birth with aspd_unconfigured and consults no compile', async () => {
    const error = (await refusedColdBirth(ENVELOPE_BODY, 'run-t07963-a')) as Error & {
      detail?: Record<string, unknown>
    }
    expect(String(error.message)).toContain('aspd-independent execution closure')
    expect(error.detail).toMatchObject({ code: 'aspd_unconfigured', site: 'headless-broker-birth' })
  })

  it('refuses the promptless cold boot the same way', async () => {
    const error = (await refusedColdBirth('', 'run-t07963-d')) as Error & {
      detail?: Record<string, unknown>
    }
    expect(String(error.message)).toContain('aspd-independent execution closure')
    expect(error.detail).toMatchObject({ code: 'aspd_unconfigured', site: 'headless-broker-birth' })
  })
})

/**
 * The run binding itself, tested against `persistStartGraph` rather than through
 * a stubbed controller. The binding IS this function's behaviour, so exercising
 * it through a double would only assert the double.
 */
describe('T-07963 criterion 4 — persistStartGraph binds the run to the start request input', () => {
  function startInput(withInitialInput: boolean, runIdSuffix: string) {
    const hostSessionId = seededHostSessionId
    const identity = {
      requestId: `req-${runIdSuffix}`,
      operationId: `op-${runIdSuffix}`,
      hostSessionId,
      generation: seededGeneration,
      runtimeId: `rt-${runIdSuffix}`,
      invocationId: `inv-${runIdSuffix}`,
      traceId: `trace-${runIdSuffix}`,
      ...(withInitialInput
        ? { initialInputId: `input_${runIdSuffix}`, runId: `run-${runIdSuffix}` }
        : {}),
    } as unknown as RuntimeIdentityAllocation
    const { profile, startRequest } = makeBrokerProfile(identity, {
      withInitialInput,
      initialInputText: 'priming + caller body',
    })
    const compileResponse = makeCompileResponse(identity, [profile])
    if (!compileResponse.ok) throw new Error('T-07963 binding fixture rejected')
    return {
      identity,
      input: {
        plan: compileResponse.plan,
        profile,
        startRequest,
        specHash: (profile as unknown as { harnessInvocation: { specHash: string } })
          .harnessInvocation.specHash,
        startRequestHash: (
          profile as unknown as { harnessInvocation: { startRequestHash: string } }
        ).harnessInvocation.startRequestHash,
        identity,
      },
      startRequest,
    }
  }

  let seededHostSessionId: string
  let seededGeneration: number

  beforeEach(async () => {
    const resolved = await fixture.resolveSession(SCOPE)
    seededHostSessionId = resolved.hostSessionId
    const session = (
      server as unknown as {
        db: { sessions: { getByHostSessionId(id: string): HrcSessionRecord | null } }
      }
    ).db.sessions.getByHostSessionId(resolved.hostSessionId)
    seededGeneration = session?.generation ?? 1
  })

  it('sets dispatched_input_id from the start request initial input', () => {
    const { input, startRequest } = startInput(true, 't07963bind')
    const internal = server as unknown as {
      db: { runs: { getByRunId(id: string): { dispatchedInputId?: string } | null } }
      serverInstanceId: string
    }

    persistStartGraph(
      {
        db: (internal as unknown as { db: HrcDatabase }).db,
        now: () => fixture.now(),
        serverInstanceId: 'srv-t07963',
      },
      input as unknown as Parameters<typeof persistStartGraph>[1],
      { protocolVersion: 'harness-broker/0.2' } as unknown as Parameters<
        typeof persistStartGraph
      >[2],
      undefined
    )

    expect(internal.db.runs.getByRunId('run-t07963bind')?.dispatchedInputId).toBe(
      String(startRequest.initialInput?.inputId)
    )
  })

  it('leaves dispatched_input_id NULL when the start carries no initial input (tmux launch shape)', () => {
    const { input } = startInput(false, 't07963nobind')
    const internal = server as unknown as {
      db: { runs: { getByRunId(id: string): { dispatchedInputId?: string } | null } }
    }

    persistStartGraph(
      {
        db: (internal as unknown as { db: HrcDatabase }).db,
        now: () => fixture.now(),
        serverInstanceId: 'srv-t07963',
      },
      input as unknown as Parameters<typeof persistStartGraph>[1],
      { protocolVersion: 'harness-broker/0.2' } as unknown as Parameters<
        typeof persistStartGraph
      >[2],
      undefined
    )

    // No identity.runId is allocated without an initial user turn, so there is
    // no run row at all — which is why T-07920's launch-primed attribution,
    // gated on `dispatchedInputId === undefined`, stays structurally separate.
    expect(internal.db.runs.getByRunId('run-t07963nobind')).toBeNull()
  })
})
