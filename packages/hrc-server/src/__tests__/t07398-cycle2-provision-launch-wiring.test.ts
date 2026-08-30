/**
 * T-07398 DEFECT CYCLE 2, item 1 — an overridable scalar directive must reach
 * the LAUNCHED PROCESS, not just the database.
 *
 * `+model=sonnet` is parsed, validated, carried on the intent and persisted to
 * `lastAppliedIntentJson` — and then dropped on the floor at the launch
 * boundary. Every launch path reads `intent.harness.model`, which no sender
 * ever populates from a directive (only `+harness=` survives, and only because
 * `buildHrcRuntimeIntent` re-resolves the provider/id from it). Nothing anywhere
 * reads `intent.provision.model`. Live proof: a runtime born from
 * `+model=sonnet` launched with `--model opus` in the process table and
 * self-reported claude-opus-5 (C-15425 / DM #230).
 *
 * These cases are deliberately at the live adapters — the last thing between
 * an intent and an actual process — because that is where the acceptance lives
 * ("process args AND self-report show sonnet"). Cycle 1's bar had no launch-path
 * case at all, which is exactly why it could not catch this.
 *
 * The intent shape under test is the one that really reaches launch: `provision`
 * carries the directive and `harness.model` is UNSET, so agent-spaces falls back
 * to the profile default. An implementation may satisfy this by folding
 * `provision` into the harness route inside (or just before) each adapter — but
 * the guarantee has to hold at the adapter, since that is the shape the
 * persisted intent actually has.
 *
 * WHERE `reasoning` IS OBSERVABLE. Both live boundaries carry a
 * reasoning field at all, so it is asserted exactly there rather than three
 * times mechanically:
 *   - cli-adapter     -> `BuildProcessInvocationSpecRequest.modelReasoningEffort`
 *   - compile-adapter -> `RuntimeCompileRequest.requested.reasoningEffort`
 * Because `modelReasoningEffort` and `reasoningEffort` are fields of their own,
 * the cheap fix of projecting the overlaid model onto `harness.model` — which
 * the adapters already read — cannot turn this file green.
 */

import { describe, expect, it } from 'bun:test'

import type {
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
} from 'agent-spaces'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { buildCliInvocation } from '../agent-spaces-adapter/cli-adapter'
import { compileBrokerRuntimePlan } from '../agent-spaces-adapter/compile-adapter'
import { makeBrokerProfile, makeCompileResponse } from './broker-compile-fixtures'

const DIRECTED_MODEL = 'sonnet'
/**
 * Kept inside the compile boundary's closed enum ('low'|'medium'|'high'|'xhigh')
 * so this bar never has to invent a harness mapping table — the spec assigns
 * per-harness reasoning mapping to the compiler, not to HRC.
 */
const DIRECTED_REASONING = 'low'

function placement(): HrcRuntimeIntent['placement'] {
  return {
    agentRoot: '/tmp/agent',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
    correlation: {
      hostSessionId: 'hsid-t07398-c2',
      runId: 'run-t07398-c2',
      generation: 1,
      sessionRef: {
        scopeRef: 'agent:clod:project:hrc-runtime:task:t07398c2',
        laneRef: 'lane:main',
      },
    },
  } as HrcRuntimeIntent['placement']
}

/** The persisted shape after a `+model=sonnet` birth: directive set, harness.model absent. */
function directedIntent(harness: HrcRuntimeIntent['harness']): HrcRuntimeIntent {
  return {
    placement: placement(),
    harness,
    provision: { model: DIRECTED_MODEL, reasoning: DIRECTED_REASONING },
  } as unknown as HrcRuntimeIntent
}

describe('T-07398 cycle 2 item 1 — provisioning directives reach the launch path', () => {
  it('cli-adapter: the process invocation spec is built for the directed model AND reasoning', async () => {
    let captured: BuildProcessInvocationSpecRequest | undefined

    await buildCliInvocation(directedIntent({ provider: 'anthropic', interactive: true }), {
      specBuilder: async (request): Promise<BuildProcessInvocationSpecResponse> => {
        captured = request
        return { spec: { argv: ['agent-spaces-cli'], env: {}, cwd: '/tmp/materialized' } }
      },
    })

    expect(captured?.model).toBe(DIRECTED_MODEL)
    // Independently red: `modelReasoningEffort` is its own field on the process
    // spec request, so projecting only the model onto `harness.model` (which the
    // adapter already reads) cannot satisfy this line.
    expect(captured?.modelReasoningEffort).toBe(DIRECTED_REASONING)
  })

  it('compile-adapter: the broker compile request requests the directed model AND reasoning', async () => {
    const captured: { request?: RuntimeCompileRequest } = {}

    await compileBrokerRuntimePlan(
      {
        intent: directedIntent({ provider: 'openai', interactive: false, id: 'codex-cli' }),
        hostSessionId: 'hostSession_T1',
        generation: 1,
      },
      {
        compileHarnessInvocation: async (request) => {
          captured.request = request.compileRequest
          const identity = request.compileRequest.identity as RuntimeIdentityAllocation
          const { profile } = makeBrokerProfile(identity)
          const compileResponse = makeCompileResponse(identity, [profile])
          if (!compileResponse.ok) throw new Error('fixture compile response unexpectedly failed')
          return {
            schemaVersion: 'aspc-compile-harness-invocation-response/v1',
            ok: true,
            compileResponse,
            plan: compileResponse.plan,
            selectedProfile: profile,
            startRequest: profile.harnessInvocation.startRequest,
            dispatchRequest: { startRequest: profile.harnessInvocation.startRequest },
            diagnostics: compileResponse.diagnostics,
          }
        },
        ids: {
          requestId: () => 'request_T1',
          operationId: () => 'runtimeOperation_T1',
          runtimeId: () => 'runtime_T1',
          invocationId: () => 'invocation_T1',
          initialInputId: () => 'input_T1',
          runId: () => 'run_T1',
          traceId: () => 'trace_T1',
        },
      }
    )

    expect(captured.request?.requested.model).toBe(DIRECTED_MODEL)
    expect(captured.request?.requested.reasoningEffort).toBe(DIRECTED_REASONING)
  })
})
