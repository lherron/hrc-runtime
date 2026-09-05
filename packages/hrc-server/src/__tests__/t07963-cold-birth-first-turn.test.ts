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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
} from 'spaces-aspc-protocol'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import type { HrcDatabase } from 'hrc-store-sqlite'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client.js'
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
let facadeSpy: ReturnType<typeof spyOn> | undefined

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

type ColdBirthObservation = {
  compileRequest: AspcCompileHarnessInvocationRequest['compileRequest'] | undefined
  startRequest: InvocationStartRequest | undefined
  identity: RuntimeIdentityAllocation | undefined
}

/**
 * Drive one cold headless birth with the compiler and controller stubbed, and
 * hand back exactly what HRC asked the compiler for and shipped to the broker.
 */
async function coldBirth(prompt: string, runId: string): Promise<ColdBirthObservation> {
  const observed: ColdBirthObservation = {
    compileRequest: undefined,
    startRequest: undefined,
    identity: undefined,
  }
  facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
    return {
      hello: async () => ({
        protocolVersion: ASPC_PROTOCOL_VERSION,
        facadeInfo: { name: 'aspc-facade', version: 't07963-test' },
        capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
      }),
      compileHarnessInvocation: async (
        request: AspcCompileHarnessInvocationRequest
      ): Promise<AspcCompileHarnessInvocationResponse> => {
        observed.compileRequest = request.compileRequest
        const identity = request.compileRequest.identity as RuntimeIdentityAllocation
        observed.identity = identity
        // The fixture echoes the caller prompt HRC supplied into the initial
        // input, so an assertion about the body is about HRC's plumbing. It
        // does NOT model the priming concatenation — see the proof boundary.
        const { profile, startRequest } = makeBrokerProfile(identity, {
          initialInputText: request.compileRequest.materialization.initialPrompt,
        })
        const compileResponse = makeCompileResponse(identity, [profile])
        if (!compileResponse.ok) throw new Error('T-07963 compile fixture rejected')
        return {
          schemaVersion: 'aspc-compile-harness-invocation-response/v1',
          ok: true,
          compileResponse,
          plan: compileResponse.plan,
          selectedProfile: profile,
          startRequest,
          dispatchRequest: { startRequest },
          diagnostics: compileResponse.diagnostics,
        }
      },
      close: async () => undefined,
    } as unknown as AspcFacadeBrokerClient
  })

  const resolved = await fixture.resolveSession(SCOPE)
  const internal = server as unknown as {
    db: {
      sessions: { getByHostSessionId(id: string): HrcSessionRecord | null }
      runs: { getByRunId(id: string): { dispatchedInputId?: string; status: string } | null }
    }
    getHarnessBrokerController(): unknown
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
  const runtime: HrcRuntimeSnapshot = {
    runtimeId: 'rt-t07963',
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'starting',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: 'op-t07963',
    activeInvocationId: 'inv-t07963',
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  }
  internal.getHarnessBrokerController = () => ({
    start: async (input: {
      startRequest: InvocationStartRequest
      onAccepted?: (graph: { runtime: HrcRuntimeSnapshot }) => Promise<void> | void
    }) => {
      observed.startRequest = input.startRequest
      // The real controller persists the start graph before `onAccepted`; this
      // stub owes the runtime row that `runs.insert` keys against. It does NOT
      // model the run binding — that is `persistStartGraph`'s job and is tested
      // directly against it below, not through a double written here.
      ;(
        server as unknown as { db: { runtimes: { insert(row: unknown): unknown } } }
      ).db.runtimes.insert({
        ...runtime,
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          runtimeId: runtime.runtimeId,
          hostSessionId: runtime.hostSessionId,
          generation: runtime.generation,
          status: 'starting',
        },
        lastActivityAt: fixture.now(),
      })
      await input.onAccepted?.({ runtime })
      return { ok: true, runtime }
    },
  })

  await internal.executeHeadlessBrokerStartTurn(session, headlessIntent(), prompt, runId, {
    waitForCompletion: false,
  })
  return observed
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t07963-cold-birth-')
  server = await createHrcServer(
    fixture.serverOpts({ headlessCodexBrokerEnabled: true, otelListenerEnabled: false })
  )
})

afterEach(async () => {
  facadeSpy?.mockRestore()
  facadeSpy = undefined
  await server.stop()
  await fixture.cleanup()
})

describe('T-07963 criterion 4 — cold-birth first turn carries the caller prompt', () => {
  it('hands the caller prompt to compile as initialPrompt and keeps priming on', async () => {
    const observed = await coldBirth(ENVELOPE_BODY, 'run-t07963-a')

    expect(observed.compileRequest?.materialization.initialPrompt).toBe(ENVELOPE_BODY)
    // `omitPriming` unset is what makes the compiler concatenate priming with
    // the caller prompt rather than replacing it. Lance's ruling keeps priming.
    expect(observed.compileRequest?.materialization.omitPriming).toBeUndefined()
  })

  it('ships exactly ONE initial input carrying the caller prompt', async () => {
    const observed = await coldBirth(ENVELOPE_BODY, 'run-t07963-b')

    // One submission, not two: the caller prompt is IN the boot's first input.
    expect(observed.startRequest?.initialInput).toBeDefined()
    expect(observed.startRequest?.initialInput?.inputId).toBe(
      String(observed.identity?.initialInputId)
    )
    expect(observed.startRequest?.initialInput?.content).toHaveLength(1)
  })

  it('allocates the run identity the compiler needs to bind the first turn', async () => {
    const observed = await coldBirth(ENVELOPE_BODY, 'run-t07963-c')

    expect(observed.identity?.initialInputId).toBeDefined()
    expect(String(observed.identity?.runId)).toBe('run-t07963-c')
  })

  it('negative control: a promptless cold boot submits priming only and binds nothing', async () => {
    const observed = await coldBirth('', 'run-t07963-d')

    expect(observed.compileRequest?.materialization.initialPrompt).toBeUndefined()
    // No caller turn means no run/input identity to bind, which is exactly the
    // shape `allowCompilerInitialInputWithoutIdentity` still exists for.
    expect(observed.identity?.initialInputId).toBeUndefined()
    expect(observed.identity?.runId).toBeUndefined()
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
