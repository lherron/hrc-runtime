/**
 * T-07398 cycle 2 — summon directives reach ASP unchanged. v2 makes ASP the
 * sole selector: HRC forwards raw snake_case directives and only persists the
 * producer-selected realization it receives back.
 */

import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import { neutralStartRequestHash } from 'spaces-runtime-contracts'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import {
  type V2RuntimeCompileRequest,
  compileBrokerRuntimePlan,
} from '../agent-spaces-adapter/compile-adapter'
import { resolveLaunchReasoning } from '../agent-spaces-adapter/provision-launch'

const DIRECTED_MODEL = 'sonnet'
const NOW = '2026-09-22T00:00:00.000Z'
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

/** The persisted v2 input: directives remain raw until ASP selects execution. */
function directedIntent(harness: HrcRuntimeIntent['harness']): HrcRuntimeIntent {
  return {
    placement: placement(),
    harness,
    summonDirectives: { model: DIRECTED_MODEL, reasoning_effort: DIRECTED_REASONING },
  } as unknown as HrcRuntimeIntent
}

describe('T-07398 cycle 2 item 1 — provisioning directives reach the launch path', () => {
  it('reads the canonical reasoning_effort provisioning scalar', () => {
    const intent = {
      provision: { reasoning_effort: DIRECTED_REASONING },
    } as unknown as HrcRuntimeIntent

    expect(resolveLaunchReasoning(intent)).toBe(DIRECTED_REASONING)
  })

  it('compile-adapter forwards directed model and reasoning as raw summon directives', async () => {
    const captured: { request?: V2RuntimeCompileRequest } = {}

    const result = await compileBrokerRuntimePlan(
      {
        intent: directedIntent({ provider: 'openai', interactive: false, id: 'codex-cli' }),
        scopeRef: 'agent:clod:project:hrc-runtime:task:t07398c2',
        hostSessionId: 'hostSession_T1',
        generation: 1,
      },
      {
        compileHarnessInvocation: async (request) => {
          captured.request = request.compileRequest as unknown as V2RuntimeCompileRequest
          const identity = request.compileRequest.identity as RuntimeIdentityAllocation
          return {
            schemaVersion: 'aspc-compile-harness-invocation-response/v2',
            ok: true,
            diagnostics: [],
            plan: {
              schemaVersion: 'agent-runtime-plan/v2',
              agent: { id: 'clod' },
              identity,
              planHash: 'plan-t07398-v2',
              compileId: 'compile-t07398-v2',
              createdAt: NOW,
              diagnostics: [],
              selection: {
                harness: 'codex',
                modelProvider: 'openai-codex',
                model: DIRECTED_MODEL,
                reasoningEffort: DIRECTED_REASONING,
                presentation: false,
                provenance: {
                  harness: 'agent-profile',
                  modelProvider: 'agent-profile',
                  model: 'summon-directive',
                  reasoningEffort: 'summon-directive',
                  presentation: 'agent-profile',
                },
              },
              execution: {
                recipeId: 'codex-app-server',
                driver: 'codex-app-server',
                protocol: 'harness-broker/0.2',
                hosting: {
                  executionTransport: 'jsonrpc-stdio',
                  terminalRequired: false,
                  processExecution: 'broker-process',
                },
                presentationFulfillment: 'attachable',
                profile: {
                  profileId: 'profile-t07398-v2',
                  profileHash: 'profile-hash-t07398-v2',
                  compatibilityHash: 'compatibility-t07398-v2',
                  startRequestHash: neutralStartRequestHash({
                    spec: {
                      invocationId: identity.invocationId,
                      driver: { kind: 'codex-app-server' },
                      correlation: {
                        requestId: identity.requestId,
                        operationId: identity.operationId,
                        hostSessionId: identity.hostSessionId,
                        runtimeId: identity.runtimeId,
                        traceId: identity.traceId,
                      },
                    },
                  } as never),
                },
                dispatchRequest: {
                  startRequest: {
                    spec: {
                      invocationId: identity.invocationId,
                      driver: { kind: 'codex-app-server' },
                      correlation: {
                        requestId: identity.requestId,
                        operationId: identity.operationId,
                        hostSessionId: identity.hostSessionId,
                        runtimeId: identity.runtimeId,
                        traceId: identity.traceId,
                      },
                    },
                  },
                },
              },
            },
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

    expect(captured.request).toMatchObject({
      agent: { id: 'clod' },
      requested: {},
      selectionContext: {
        summonDirectives: { model: DIRECTED_MODEL, reasoning_effort: DIRECTED_REASONING },
      },
    })
    expect(result).toMatchObject({
      admitted: true,
      plan: {
        selection: {
          model: DIRECTED_MODEL,
          reasoningEffort: DIRECTED_REASONING,
          provenance: {
            model: 'summon-directive',
            reasoningEffort: 'summon-directive',
          },
        },
      },
    })
  })
})
