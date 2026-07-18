/**
 * RED tests (T-01695 / T-01690 Wave W2) for the broker COMPILE ADAPTER.
 *
 * These tests are EXPECTED TO FAIL until curly implements
 *   packages/hrc-server/src/agent-spaces-adapter/compile-adapter.ts
 *
 * The adapter:
 *  - allocates runtime identities BEFORE compile and uses the SAME ids in both
 *    `identity` and `correlation`;
 *  - translates an HrcRuntimeIntent (+ overlays) into a RuntimeCompileRequest;
 *  - compiles via an injected compile fn (no live compiler required);
 *  - runs the W2 profile selector and returns a verified/frozen plan + profile +
 *    startRequest + dispatchEnv + identities (it does NOT execute the broker).
 *  - preserves placement.dispatchEnv as a dispatch-time channel, never folded
 *    into the hashed startRequest/spec material.
 *
 * Public API under test (see final reply / API contract):
 *   compileBrokerRuntimePlan(input, deps): Promise<BrokerCompileAdapterResult>
 */

import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { AspcCompileHarnessInvocationResponse } from 'spaces-aspc-protocol'
import { project } from 'spaces-runtime-contracts'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { compileBrokerRuntimePlan } from '../agent-spaces-adapter/compile-adapter'

import {
  makeBrokerProfile,
  makeCompileResponse,
  makeFailedCompileResponse,
  makeInteractiveTmuxProfile,
  neutralStartRequestHash,
} from './broker-compile-fixtures'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A deterministic id allocator so tests can assert exact id propagation. */
function makeIdAllocator() {
  return {
    requestId: () => 'request_T1',
    operationId: () => 'runtimeOperation_T1',
    runtimeId: () => 'runtime_T1',
    invocationId: () => 'invocation_T1',
    initialInputId: () => 'input_T1',
    runId: () => 'run_T1',
    traceId: () => 'trace_T1',
  }
}

function makeIntent(overrides: Partial<HrcRuntimeIntent> = {}): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    } as HrcRuntimeIntent['placement'],
    harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
    initialPrompt: 'do the thing',
    ...overrides,
  }
}

/**
 * A capturing compile fn: records the RuntimeCompileRequest the adapter built,
 * then returns a valid headless-codex compile response that echoes the
 * allocated identity into startRequest.spec.invocationId.
 */
function makeCapturingCompile() {
  const captured: { request?: RuntimeCompileRequest } = {}
  const compileHarnessInvocation = async (request: {
    compileRequest: RuntimeCompileRequest
    dispatchEnv?: Record<string, string> | undefined
  }): Promise<AspcCompileHarnessInvocationResponse> => {
    captured.request = request.compileRequest
    const identity = request.compileRequest.identity as RuntimeIdentityAllocation
    const { profile } = makeBrokerProfile(identity)
    return makeAspcCompileResponse(identity, [profile], request.dispatchEnv)
  }
  return { compileHarnessInvocation, captured }
}

function makeAspcCompileResponse(
  identity: RuntimeIdentityAllocation,
  profiles: ReturnType<typeof makeBrokerProfile>['profile'][],
  dispatchEnv?: Record<string, string> | undefined
): AspcCompileHarnessInvocationResponse {
  const compileResponse = makeCompileResponse(identity, profiles)
  if (!compileResponse.ok) {
    throw new Error('fixture compile response unexpectedly failed')
  }
  const selectedProfile = profiles[0]
  if (!selectedProfile) {
    throw new Error('fixture requires one selected profile')
  }
  const startRequest = selectedProfile.harnessInvocation.startRequest
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: true,
    compileResponse,
    plan: compileResponse.plan,
    selectedProfile,
    startRequest,
    dispatchRequest: {
      startRequest,
      ...(dispatchEnv ? { dispatchEnv } : {}),
    },
    diagnostics: compileResponse.diagnostics,
  }
}

function makeAspcFailedCompileResponse(): AspcCompileHarnessInvocationResponse {
  const compileResponse = makeFailedCompileResponse()
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: false,
    compileResponse,
    diagnostics: compileResponse.diagnostics,
  }
}

const STANDARD_INPUT = () => ({
  intent: makeIntent(),
  hostSessionId: 'hostSession_T1',
  generation: 1,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileBrokerRuntimePlan (W2 compile adapter)', () => {
  it('compiles a headless-codex intent to exactly one admitted broker profile', async () => {
    const { compileHarnessInvocation } = makeCapturingCompile()
    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.profile.kind).toBe('harness-broker')
    expect(result.profile.interactionMode).toBe('headless')
    expect(result.profile.brokerDriver).toBe('codex-app-server')
    expect(result.profile.brokerProtocol).toBe('harness-broker/0.2')
  })

  it('allocates identities BEFORE compile and uses the SAME ids in identity + correlation', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })

    const req = captured.request
    expect(req).toBeDefined()
    if (!req) return
    const { identity, correlation } = req

    expect(identity.requestId).toBe('request_T1')
    expect(identity.operationId).toBe('runtimeOperation_T1')
    expect(identity.runtimeId).toBe('runtime_T1')
    expect(identity.invocationId).toBe('invocation_T1')
    expect(identity.hostSessionId).toBe('hostSession_T1')
    expect(identity.generation).toBe(1)

    // SAME values mirrored into correlation
    expect(correlation.requestId).toBe(identity.requestId)
    expect(correlation.operationId).toBe(identity.operationId)
    expect(correlation.runtimeId).toBe(identity.runtimeId)
    expect(correlation.invocationId).toBe(identity.invocationId)
    expect(correlation.hostSessionId).toBe(identity.hostSessionId)
    expect(correlation.generation).toBe(identity.generation)
    expect(correlation.traceId).toBe(identity.traceId)
    expect(correlation.runId).toBe(identity.runId)
  })

  it('allocates initialInputId AND runId only when an initial user turn exists', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    const withTurn = captured.request
    expect(withTurn?.identity.initialInputId).toBe('input_T1')
    expect(withTurn?.identity.runId).toBe('run_T1')
  })

  it('omits initialInputId and runId when there is no initial turn', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    const input = {
      intent: makeIntent({ initialPrompt: undefined }),
      hostSessionId: 'hostSession_T1',
      generation: 1,
    }
    await compileBrokerRuntimePlan(input, { compileHarnessInvocation, ids: makeIdAllocator() })
    const req = captured.request
    expect(req?.identity.initialInputId).toBeUndefined()
    expect(req?.identity.runId).toBeUndefined()
  })

  it('rejects compiler-derived initialInput without identity by default', async () => {
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      expect(identity.initialInputId).toBeUndefined()
      expect(identity.runId).toBeUndefined()
      const { profile } = makeBrokerProfile(identity, {
        withInitialInput: true,
        initialInputId: 'input_profile_priming',
      })
      return makeAspcCompileResponse(identity, [profile])
    }

    const result = await compileBrokerRuntimePlan(
      {
        intent: makeIntent({ initialPrompt: undefined }),
        hostSessionId: 'hostSession_T1',
        generation: 1,
      },
      { compileHarnessInvocation, ids: makeIdAllocator() }
    )

    expect(result.admitted).toBe(false)
    if (result.admitted) return
    expect(result.code).toBe('initial-input-id-mismatch')
    expect(result.identity.initialInputId).toBeUndefined()
    expect(result.identity.runId).toBeUndefined()
  })

  it('admits compiler-derived profile priming without HRC run identity when explicitly allowed', async () => {
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      expect(identity.initialInputId).toBeUndefined()
      expect(identity.runId).toBeUndefined()
      const { profile } = makeBrokerProfile(identity, {
        withInitialInput: true,
        initialInputId: 'input_profile_priming',
      })
      return makeAspcCompileResponse(identity, [profile])
    }

    const result = await compileBrokerRuntimePlan(
      {
        intent: makeIntent({ initialPrompt: undefined }),
        hostSessionId: 'hostSession_T1',
        generation: 1,
        allowCompilerInitialInputWithoutIdentity: true,
      },
      { compileHarnessInvocation, ids: makeIdAllocator() }
    )

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.startRequest.initialInput?.inputId).toBe('input_profile_priming')
    expect(result.identity.initialInputId).toBeUndefined()
    expect(result.identity.runId).toBeUndefined()
  })

  it('treats an empty initialPrompt as no initial turn', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    const input = {
      intent: makeIntent({ initialPrompt: '' }),
      hostSessionId: 'hostSession_T1',
      generation: 1,
    }
    await compileBrokerRuntimePlan(input, { compileHarnessInvocation, ids: makeIdAllocator() })
    const req = captured.request
    expect(req?.identity.initialInputId).toBeUndefined()
    expect(req?.identity.runId).toBeUndefined()
    expect(req?.materialization.initialPrompt).toBe('')
  })

  it('allocates initialInputId and runId for managed interactive starts without an explicit prompt', async () => {
    const captured: { request?: RuntimeCompileRequest } = {}
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      captured.request = request.compileRequest
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      const { profile } = makeInteractiveTmuxProfile(identity)
      return makeAspcCompileResponse(identity, [profile])
    }

    const result = await compileBrokerRuntimePlan(
      {
        intent: makeIntent({
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentName: 'clod', projectRoot: '/tmp/project' },
          } as HrcRuntimeIntent['placement'],
          harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
          initialPrompt: undefined,
        }),
        hostSessionId: 'hostSession_T1',
        generation: 1,
      },
      { compileHarnessInvocation, ids: makeIdAllocator() }
    )

    expect(captured.request?.identity.initialInputId).toBe('input_T1')
    expect(captured.request?.identity.runId).toBe('run_T1')
    expect(result.admitted).toBe(true)
  })

  it('echoes the allocated invocationId into startRequest.spec.invocationId on the admitted result', async () => {
    const { compileHarnessInvocation } = makeCapturingCompile()
    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.startRequest.spec.invocationId).toBe('invocation_T1')
    expect(result.startRequest.spec.invocationId).toBe(result.identity.invocationId)
    // initialInput id matches allocated initialInputId
    expect(result.startRequest.initialInput?.inputId).toBe('input_T1')
  })

  it('translates intent materialization (initialPrompt) into the compile request', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    expect(captured.request?.materialization.initialPrompt).toBe('do the thing')
    expect(captured.request?.requested.interactionMode).toBe('headless')
  })

  it('threads responseFormat through materialization and compiled broker initial input', async () => {
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    }
    const captured: { request?: RuntimeCompileRequest } = {}
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      captured.request = request.compileRequest
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      const fixture = makeBrokerProfile(identity)
      const responseFormat = request.compileRequest.materialization.responseFormat
      const startRequest = {
        ...fixture.startRequest,
        initialInput: {
          ...fixture.startRequest.initialInput,
          responseFormat,
        },
      } as NonNullable<typeof fixture.startRequest>
      const profile = {
        ...fixture.profile,
        harnessInvocation: {
          ...fixture.profile.harnessInvocation,
          startRequest,
          startRequestHash: neutralStartRequestHash(startRequest),
        },
      }
      return makeAspcCompileResponse(identity, [profile])
    }

    const result = await compileBrokerRuntimePlan(
      {
        ...STANDARD_INPUT(),
        responseFormat: { kind: 'json_schema', schema },
      },
      { compileHarnessInvocation, ids: makeIdAllocator() }
    )

    expect(captured.request?.materialization.responseFormat).toEqual({
      kind: 'json_schema',
      schema,
    })
    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.startRequest.initialInput?.responseFormat).toEqual({
      kind: 'json_schema',
      schema,
    })
  })

  it('translates interactive Claude tmux intent into explicit compiler route fields', async () => {
    const captured: { request?: RuntimeCompileRequest } = {}
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      captured.request = request.compileRequest
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      const { profile } = makeInteractiveTmuxProfile(identity)
      return makeAspcCompileResponse(identity, [profile])
    }

    const result = await compileBrokerRuntimePlan(
      {
        intent: makeIntent({
          harness: { provider: 'anthropic', interactive: true, id: 'claude-code' },
          initialPrompt: 'hello claude',
        }),
        hostSessionId: 'hostSession_T1',
        generation: 1,
      },
      { compileHarnessInvocation, ids: makeIdAllocator() }
    )

    expect(result.admitted).toBe(true)
    expect(captured.request?.requested).toMatchObject({
      modelProvider: 'anthropic',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    })
  })

  it('preserves dispatchEnv as a dispatch-only channel: on placement, on the result, NEVER in hashed material', async () => {
    const { compileHarnessInvocation, captured } = makeCapturingCompile()
    const dispatchEnv = { DISCORD_CHANNEL_ID: '1234567890', ASP_DISPATCH_TOKEN: 'sekret-token' }
    const input = { ...STANDARD_INPUT(), dispatchEnv }

    const result = await compileBrokerRuntimePlan(input, {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })

    // (1) carried into the compile request as a dispatch-time channel on placement
    expect((captured.request?.placement as { dispatchEnv?: unknown }).dispatchEnv).toEqual(
      dispatchEnv
    )

    expect(result.admitted).toBe(true)
    if (!result.admitted) return

    // (2) surfaced separately on the adapter result for W3B dispatch
    expect(result.dispatchEnv).toEqual(dispatchEnv)

    // (3) NOT folded into the (frozen) startRequest, and ABSENT from hashed material
    expect((result.startRequest as { dispatchEnv?: unknown }).dispatchEnv).toBeUndefined()
    const hashedMaterial = JSON.stringify(project(result.startRequest, 'start-request').value)
    expect(hashedMaterial).not.toContain('sekret-token')
    expect(hashedMaterial).not.toContain('DISCORD_CHANNEL_ID')
  })

  it('returns a frozen startRequest on the admitted result (cannot be mutated post-verification)', async () => {
    const { compileHarnessInvocation } = makeCapturingCompile()
    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(Object.isFrozen(result.startRequest)).toBe(true)
  })

  it('reports a bounded, redacted field diff when dispatch and CLI startRequests differ', async () => {
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      const { profile } = makeBrokerProfile(identity)
      const response = makeAspcCompileResponse(identity, [profile])
      if (!response.ok) return response

      const cliStartRequest = {
        ...response.startRequest,
        spec: {
          ...response.startRequest.spec,
          process: {
            ...response.startRequest.spec.process,
            cwd: '/tmp/cli-work',
            lockedEnv: {
              ...response.startRequest.spec.process.lockedEnv,
              API_TOKEN: 'cli-secret-value',
            },
          },
        },
        initialInput: {
          ...response.startRequest.initialInput,
          content: [{ type: 'text', text: `cli-${'x'.repeat(20_000)}` }],
        },
      } as unknown as typeof response.startRequest
      const daemonStartRequest = {
        ...cliStartRequest,
        spec: {
          ...cliStartRequest.spec,
          process: {
            ...cliStartRequest.spec.process,
            cwd: '/tmp/daemon-work',
            lockedEnv: {
              ...cliStartRequest.spec.process.lockedEnv,
              API_TOKEN: 'daemon-secret-value',
            },
          },
        },
        initialInput: {
          ...cliStartRequest.initialInput,
          content: [{ type: 'text', text: `daemon-${'y'.repeat(20_000)}` }],
        },
      } as unknown as typeof response.startRequest

      return {
        ...response,
        startRequest: cliStartRequest,
        dispatchRequest: {
          ...response.dispatchRequest,
          startRequest: daemonStartRequest,
        },
      }
    }

    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })

    expect(result.admitted).toBe(false)
    if (result.admitted) return
    expect(result.code).toBe('start-request-hash-mismatch')
    const diagnosticText = result.diagnostics.map((diagnostic) => diagnostic.message).join('\n')
    expect(diagnosticText).toContain('/spec/process/cwd')
    expect(diagnosticText).toContain('/tmp/daemon-work')
    expect(diagnosticText).toContain('/tmp/cli-work')
    expect(diagnosticText).toContain('/spec/process/lockedEnv/API_TOKEN')
    expect(diagnosticText).not.toContain('daemon-secret-value')
    expect(diagnosticText).not.toContain('cli-secret-value')
    expect(diagnosticText).toMatch(/redact/i)
    expect(diagnosticText).toContain('/initialInput/content/0/text')
    expect(diagnosticText).toMatch(/truncat|omitt|limit|cap/i)
    expect(diagnosticText.length).toBeLessThan(10_000)
  })

  it('propagates a selector rejection without falling back (ok:false compile)', async () => {
    const compileHarnessInvocation = async (): Promise<AspcCompileHarnessInvocationResponse> =>
      makeAspcFailedCompileResponse()
    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    expect(result.admitted).toBe(false)
    if (result.admitted) return
    expect(result.code).toBe('compile-not-ok')
    // identity is still allocated/returned even on rejection
    expect(result.identity.invocationId).toBe('invocation_T1')
  })

  it('rejects (no fallback) when the compiler echoes a mismatched invocationId', async () => {
    const compileHarnessInvocation = async (request: {
      compileRequest: RuntimeCompileRequest
    }): Promise<AspcCompileHarnessInvocationResponse> => {
      const identity = request.compileRequest.identity as RuntimeIdentityAllocation
      const { profile } = makeBrokerProfile(identity, { invocationId: 'invocation_WRONG' })
      return makeAspcCompileResponse(identity, [profile])
    }
    const result = await compileBrokerRuntimePlan(STANDARD_INPUT(), {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
    })
    expect(result.admitted).toBe(false)
    if (result.admitted) return
    expect(result.code).toBe('invocation-id-mismatch')
  })
})
