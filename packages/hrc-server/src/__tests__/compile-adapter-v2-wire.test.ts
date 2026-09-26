import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'
import { neutralStartRequestHash, project } from 'spaces-runtime-contracts'

import {
  buildV2CompileRequest,
  compileBrokerRuntimePlan,
} from '../agent-spaces-adapter/compile-adapter.js'

function intent(overrides: Partial<HrcRuntimeIntent> = {}): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/astra',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    } as HrcRuntimeIntent['placement'],
    // Deliberately legacy-shaped: the v2 carrier must not derive a selection
    // from this historical HRC-owned route hint.
    harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
    ...overrides,
  }
}

const identity = {
  requestId: 'req-1',
  operationId: 'op-1',
  hostSessionId: 'host-1',
  generation: 1,
  runtimeId: 'runtime-1',
  invocationId: 'invocation-1',
  traceId: 'trace-1',
}

const ids = {
  requestId: () => identity.requestId,
  operationId: () => identity.operationId,
  runtimeId: () => identity.runtimeId,
  invocationId: () => identity.invocationId,
  initialInputId: () => 'input-1',
  runId: () => 'run-1',
  traceId: () => identity.traceId,
}

function validResponse(responseIdentity = identity) {
  const startRequest = {
    spec: {
      invocationId: responseIdentity.invocationId,
      driver: { kind: 'codex-app-server' },
      correlation: {
        requestId: responseIdentity.requestId,
        operationId: responseIdentity.operationId,
        hostSessionId: responseIdentity.hostSessionId,
        runtimeId: responseIdentity.runtimeId,
        ...(responseIdentity.runId ? { runId: responseIdentity.runId } : {}),
        traceId: responseIdentity.traceId,
      },
    },
    ...(responseIdentity.initialInputId
      ? { initialInput: { inputId: responseIdentity.initialInputId } }
      : {}),
  } as never
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v2',
    ok: true,
    diagnostics: [],
    executionRelease: {
      releaseId: 'asp-v2-test',
      sourceCommit: 'a'.repeat(40),
      builtAt: '2026-09-22T00:00:00.000Z',
      releaseRoot: '/tmp/asp-v2-test',
      worker: {
        protocol: 'harness-broker/0.2',
        executable: '/tmp/asp-v2-test/agent-harness',
        argvPrefix: ['run', '--transport', 'unix'],
      },
    },
    plan: {
      schemaVersion: 'agent-runtime-plan/v2',
      agent: { id: 'astra' },
      identity: { ...responseIdentity },
      planHash: 'plan-v2',
      compileId: 'compile-v2',
      createdAt: '2026-09-22T00:00:00.000Z',
      diagnostics: [],
      selection: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        presentation: false,
        provenance: {
          harness: 'agent-profile',
          modelProvider: 'agent-profile',
          model: 'agent-profile',
          reasoningEffort: 'project-target',
          presentation: 'summon-directive',
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
          profileId: 'profile-v2',
          profileHash: 'profile-hash-v2',
          compatibilityHash: 'compatibility-v2',
          startRequestHash: neutralStartRequestHash(startRequest),
        },
        dispatchRequest: { startRequest },
      },
    },
  }
}

async function compile(
  response: Record<string, unknown>,
  policy?: Record<string, unknown>,
  intentOverrides: Partial<HrcRuntimeIntent> = {}
) {
  return await compileBrokerRuntimePlan(
    {
      intent: intent(intentOverrides),
      scopeRef: 'agent:astra:project:hrc-runtime',
      hostSessionId: 'host-1',
      generation: 1,
      ...(policy ? { policy: policy as never } : {}),
    },
    { ids, compileHarnessInvocation: async () => response as never }
  )
}

describe('v2 compile request carrier', () => {
  it('preserves source-distinct selection values, snake_case directives, and false', () => {
    const request = buildV2CompileRequest({
      intent: intent({
        selection: { model: 'gpt-5.5', presentation: true },
        summonDirectives: {
          harness: 'codex',
          model_provider: 'openai-codex',
          reasoning_effort: 'high',
          presentation: false,
        },
        // This old merged surface must not become a third selection source.
        provision: { model: 'must-not-cross-the-boundary', presentation: false },
      }),
      scopeRef: 'agent:astra:project:hrc-runtime',
      identity,
    })

    expect(request).toMatchObject({
      schemaVersion: 'agent-runtime-compile-request/v2',
      agent: { id: 'astra' },
      requested: { model: 'gpt-5.5', presentation: true },
      selectionContext: {
        summonDirectives: {
          harness: 'codex',
          model_provider: 'openai-codex',
          reasoning_effort: 'high',
          presentation: false,
        },
      },
    })
    expect(JSON.stringify(request)).not.toContain('must-not-cross-the-boundary')
  })

  it('keeps omitted selection absent and still emits requested as an empty object', () => {
    const request = buildV2CompileRequest({
      intent: intent(),
      scopeRef: 'agent:astra:project:hrc-runtime',
      identity,
    })

    expect(request.requested).toEqual({})
    expect(request.selectionContext).toBeUndefined()
  })

  it('does not allocate user-turn identity for an interactive birth without materialized input', async () => {
    const result = await compileBrokerRuntimePlan(
      {
        intent: intent({
          placement: {
            agentRoot: '/tmp/astra',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-project', agentId: 'astra', projectId: 'hrc-runtime' },
            dryRun: false,
          } as HrcRuntimeIntent['placement'],
          harness: { provider: 'anthropic', interactive: true, id: 'claude' },
        }),
        scopeRef: 'agent:astra:project:hrc-runtime',
        hostSessionId: 'host-1',
        generation: 1,
      },
      {
        ids,
        compileHarnessInvocation: async ({ compileRequest }) => {
          const requestIdentity = compileRequest.identity as typeof identity & {
            initialInputId?: string
            runId?: string
          }
          const response = validResponse(requestIdentity)
          // ASP materializes the agent priming prompt as launch input, not as a
          // user turn. Its canonical start request therefore has no initialInput.
          const { initialInput: _initialInput, ...promptlessStartRequest } = response.plan.execution
            .dispatchRequest.startRequest as unknown as Record<string, unknown>
          response.plan.execution.dispatchRequest.startRequest = promptlessStartRequest as never
          response.plan.execution.profile.startRequestHash = neutralStartRequestHash(
            response.plan.execution.dispatchRequest.startRequest
          )
          return response as never
        },
      }
    )

    expect(result).toMatchObject({ admitted: true })
    expect(result.identity).not.toHaveProperty('initialInputId')
    expect(result.identity).not.toHaveProperty('runId')
  })

  it('carries HRC materialization, continuation, and dispatch environment without creating selection', () => {
    const continuation = { provider: 'openai', kind: 'thread', key: 'thread-v2' } as const
    const request = buildV2CompileRequest({
      intent: intent({
        initialPrompt: 'materialize this turn',
        omitPriming: true,
        attachments: [{ kind: 'path', path: '/tmp/input.png', contentType: 'image/png' }],
      }),
      scopeRef: 'agent:astra:project:hrc-runtime',
      identity,
      continuation,
      dispatchEnv: { DISPATCH_ONLY_TOKEN: 'never-select' },
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })

    expect(request.placement.dispatchEnv).toEqual({ DISPATCH_ONLY_TOKEN: 'never-select' })
    expect(request.materialization).toEqual({
      initialPrompt: 'materialize this turn',
      omitPriming: true,
      attachments: [{ kind: 'image', path: '/tmp/input.png', mimeType: 'image/png' }],
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })
    expect(request.continuation).toEqual(continuation)
    expect(request.requested).toEqual({})
  })

  it('allocates and carries one identity before compile, including only a real initial user turn', async () => {
    const allocated = { ...identity, initialInputId: 'input-1', runId: 'run-1' }
    let captured: unknown
    const result = await compileBrokerRuntimePlan(
      {
        intent: intent({ initialPrompt: 'first turn' }),
        scopeRef: 'agent:astra:project:hrc-runtime',
        hostSessionId: 'host-1',
        generation: 1,
      },
      {
        ids,
        compileHarnessInvocation: async (request) => {
          captured = request.compileRequest
          return validResponse(allocated) as never
        },
      }
    )

    expect(captured).toMatchObject({
      identity: allocated,
      correlation: {
        requestId: allocated.requestId,
        operationId: allocated.operationId,
        hostSessionId: allocated.hostSessionId,
        generation: allocated.generation,
        runtimeId: allocated.runtimeId,
        invocationId: allocated.invocationId,
        runId: allocated.runId,
        traceId: allocated.traceId,
      },
    })
    expect(result).toMatchObject({ admitted: true, identity: allocated })

    const promptless = await compile(validResponse())
    expect(promptless).toMatchObject({ admitted: true, identity })
    expect(promptless.identity.initialInputId).toBeUndefined()
    expect(promptless.identity.runId).toBeUndefined()
  })

  it('format 2 allocates an initial input but never an admission run for a prompted birth', async () => {
    let captured: Record<string, unknown> | undefined
    const result = await compileBrokerRuntimePlan(
      {
        intent: intent({ initialPrompt: 'first observed input' }),
        scopeRef: 'agent:astra:project:hrc-runtime',
        hostSessionId: 'host-1',
        generation: 1,
        executionFormat: 'format2',
      },
      {
        ids,
        compileHarnessInvocation: async ({ compileRequest }) => {
          captured = compileRequest as unknown as Record<string, unknown>
          return validResponse(compileRequest.identity) as never
        },
      }
    )

    expect(captured?.['identity']).toMatchObject({ ...identity, initialInputId: 'input-1' })
    expect(captured?.['identity']).not.toHaveProperty('runId')
    expect(captured?.['correlation']).not.toHaveProperty('runId')
    expect(result).toMatchObject({
      admitted: true,
      identity: { ...identity, initialInputId: 'input-1' },
    })
    expect(result.identity).not.toHaveProperty('runId')
  })

  it('admits and freezes exactly the producer-selected execution', async () => {
    const result = await compile(validResponse())

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.execution.driver).toBe('codex-app-server')
    expect(result.executionRelease?.releaseId).toBe('asp-v2-test')
    expect(Object.isFrozen(result.execution)).toBe(true)
    expect(Object.isFrozen(result.execution.dispatchRequest.startRequest.spec.driver)).toBe(true)
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(Object.isFrozen(result.plan.selection.provenance)).toBe(true)
    expect(Object.isFrozen(result.executionRelease)).toBe(true)
    expect(Object.isFrozen(result.executionRelease?.worker)).toBe(true)
  })

  it('keeps producer dispatch environment out of the canonical hashed start request', async () => {
    const response = validResponse()
    response.plan.execution.dispatchRequest.dispatchEnv = {
      DISPATCH_ONLY_TOKEN: 'not-start-request-material',
    }

    const result = await compile(response)

    expect(result).toMatchObject({
      admitted: true,
      dispatchEnv: { DISPATCH_ONLY_TOKEN: 'not-start-request-material' },
    })
    if (!result.admitted) return
    expect(JSON.stringify(project(result.startRequest, 'start-request').value)).not.toContain(
      'not-start-request-material'
    )
  })

  it('carries non-default HRC policy separately from producer selection', async () => {
    const policy = {
      permissionPolicy: {
        mode: 'ask-client',
        timeoutMs: 3_000,
        defaultDecision: 'deny',
        surface: 'api',
        audit: true,
      },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'queue', maxDepth: 7 },
        supportedKinds: ['user', 'steer'],
        attachmentPolicy: { localImages: true, fileRefs: false },
      },
      disallowedTools: ['shell'],
    }

    const result = await compile(validResponse(), policy)

    expect(result).toMatchObject({ admitted: true, hrcPolicy: policy })
  })

  it('refuses a v1 response before any consumer can select a profile', async () => {
    const result = await compile({
      schemaVersion: 'aspc-compile-harness-invocation-response/v1',
      ok: true,
      diagnostics: [],
      plan: { schemaVersion: 'agent-runtime-plan/v1', executionProfiles: [] },
    })

    expect(result).toMatchObject({ admitted: false, code: 'v2-envelope-required' })
  })

  it('preserves a v2 compiler refusal without a local fallback', async () => {
    const result = await compile({
      schemaVersion: 'aspc-compile-harness-invocation-response/v2',
      ok: false,
      diagnostics: [{ code: 'producer-refusal' }],
    })

    expect(result).toMatchObject({
      admitted: false,
      code: 'compile-not-ok',
      identity,
    })
  })

  it('refuses a v2 envelope whose canonical start driver disagrees', async () => {
    const response = validResponse()
    ;(
      response.plan.execution.dispatchRequest.startRequest as { spec: { driver: { kind: string } } }
    ).spec.driver.kind = 'claude-code-tmux'

    expect(await compile(response)).toMatchObject({
      admitted: false,
      code: 'execution-driver-mismatch',
    })
  })

  it('refuses incoherent terminal hosting', async () => {
    const response = validResponse()
    response.plan.execution.hosting = {
      executionTransport: 'jsonrpc-stdio',
      terminalRequired: false,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
    }

    expect(await compile(response)).toMatchObject({
      admitted: false,
      code: 'execution-hosting-invalid',
    })
  })

  it('refuses a selected execution without every profile identity field', async () => {
    for (const field of [
      'profileId',
      'profileHash',
      'compatibilityHash',
      'startRequestHash',
    ] as const) {
      const response = validResponse()
      response.plan.execution.profile[field] = ''

      expect(await compile(response)).toMatchObject({
        admitted: false,
        code: 'execution-profile-invalid',
      })
    }
  })

  it('refuses an execution whose declared start-request hash does not match its frozen bytes', async () => {
    const response = validResponse()
    response.plan.execution.profile.startRequestHash = 'not-a-neutral-start-request-hash'

    expect(await compile(response)).toMatchObject({
      admitted: false,
      code: 'execution-hash-mismatch',
    })
  })

  it('accepts catalog-default provenance and omitted reasoning effort as producer output', async () => {
    const response = validResponse()
    response.plan.selection.provenance.harness = 'catalog-default'
    response.plan.selection.reasoningEffort = undefined
    response.plan.selection.provenance.reasoningEffort = undefined

    expect(await compile(response)).toMatchObject({ admitted: true })
  })

  it('refuses any allocated plan or canonical correlation identity mismatch', async () => {
    const planMismatch = validResponse()
    planMismatch.plan.identity.traceId = 'other-trace'
    expect(await compile(planMismatch)).toMatchObject({
      admitted: false,
      code: 'execution-identity-mismatch',
    })

    const correlationMismatch = validResponse()
    ;(
      correlationMismatch.plan.execution.dispatchRequest.startRequest as {
        spec: { correlation: { operationId: string } }
      }
    ).spec.correlation.operationId = 'other-operation'
    expect(await compile(correlationMismatch)).toMatchObject({
      admitted: false,
      code: 'execution-identity-mismatch',
    })
  })

  // T-08712: a prompted Claude start. ASP selects the terminal-hosted
  // claude-code-tmux execution and carries the first turn on the launch
  // (argv + spec.launch.initialPrompt); there is no broker initialInput to echo
  // HRC's allocated initialInputId, exactly as pre-v2 interactive tmux profiles.
  const promptedIdentity = { ...identity, initialInputId: 'input-1', runId: 'run-1' }

  function promptedTerminalResponse(responseIdentity = promptedIdentity) {
    const response = validResponse(responseIdentity)
    const startRequest = response.plan.execution.dispatchRequest.startRequest as {
      spec: Record<string, unknown>
      initialInput?: unknown
    }
    Reflect.deleteProperty(startRequest, 'initialInput')
    startRequest.spec['driver'] = { kind: 'claude-code-tmux' }
    startRequest.spec['launch'] = { initialPrompt: 'Reply with the single word: ok.' }
    response.plan.execution.driver = 'claude-code-tmux'
    response.plan.execution.recipeId = 'claude-code-tmux'
    response.plan.execution.hosting = {
      executionTransport: 'pty',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
    }
    response.plan.execution.presentationFulfillment = 'intrinsic'
    response.plan.execution.profile.startRequestHash = neutralStartRequestHash(
      startRequest as never
    )
    return response
  }

  it('admits a prompted terminal-hosted execution whose first turn is launch-carried', async () => {
    const result = await compile(promptedTerminalResponse(), undefined, {
      initialPrompt: 'Reply with the single word: ok.',
    })

    expect(result).toMatchObject({ admitted: true, identity: promptedIdentity })
  })

  it('refuses a format-2 prompt that the selected profile can carry only through launch argv', async () => {
    const result = await compileBrokerRuntimePlan(
      {
        intent: intent({ initialPrompt: 'must be a broker-deliverable input' }),
        scopeRef: 'agent:astra:project:hrc-runtime',
        hostSessionId: 'host-1',
        generation: 1,
        executionFormat: 'format2',
      },
      {
        ids,
        compileHarnessInvocation: async ({ compileRequest }) =>
          promptedTerminalResponse(compileRequest.identity) as never,
      }
    )

    expect(result).toMatchObject({
      admitted: false,
      rejectedBy: 'hrc-admission',
      code: 'format2_initial_input_undeliverable',
      admissionDiagnostic: {
        field: 'startRequest.initialInput',
        expected: 'broker-deliverable initialInput',
        actual: null,
      },
    })
  })

  it('still refuses a prompted broker-input execution that drops the allocated initial input', async () => {
    const response = validResponse(promptedIdentity)
    const startRequest = response.plan.execution.dispatchRequest.startRequest as {
      initialInput?: unknown
    }
    Reflect.deleteProperty(startRequest, 'initialInput')
    response.plan.execution.profile.startRequestHash = neutralStartRequestHash(
      startRequest as never
    )

    expect(
      await compile(response, undefined, { initialPrompt: 'Reply with the single word: ok.' })
    ).toMatchObject({
      admitted: false,
      rejectedBy: 'hrc-admission',
      code: 'execution-identity-mismatch',
      admissionDiagnostic: {
        plane: 'hrc-admission',
        code: 'execution-identity-mismatch',
        field: 'startRequest.initialInput.inputId',
        expected: 'input-1',
        actual: null,
      },
    })
  })

  it('names the differing field, expected and actual on every identity refusal', async () => {
    const planMismatch = validResponse()
    planMismatch.plan.identity.traceId = 'other-trace'
    planMismatch.plan.identity.runtimeId = 'other-runtime'
    expect(await compile(planMismatch)).toMatchObject({
      rejectedBy: 'hrc-admission',
      admissionDiagnostic: {
        check: 'plan-identity',
        field: 'plan.identity.runtimeId',
        expected: 'runtime-1',
        actual: 'other-runtime',
        fields: [
          { name: 'plan.identity.runtimeId', requested: 'runtime-1', compiled: 'other-runtime' },
          { name: 'plan.identity.traceId', requested: 'trace-1', compiled: 'other-trace' },
        ],
      },
    })

    const agentMismatch = validResponse()
    agentMismatch.plan.agent.id = 'someone-else'
    expect(await compile(agentMismatch)).toMatchObject({
      admissionDiagnostic: { field: 'plan.agent.id', expected: 'astra', actual: 'someone-else' },
    })

    const correlationMismatch = validResponse()
    ;(
      correlationMismatch.plan.execution.dispatchRequest.startRequest as {
        spec: { correlation: { operationId: string } }
      }
    ).spec.correlation.operationId = 'other-operation'
    expect(await compile(correlationMismatch)).toMatchObject({
      admissionDiagnostic: {
        check: 'start-request-identity',
        field: 'startRequest.spec.correlation.operationId',
        expected: 'op-1',
        actual: 'other-operation',
        fields: [
          {
            name: 'startRequest.spec.correlation.operationId',
            requested: 'op-1',
            compiled: 'other-operation',
          },
        ],
      },
    })
  })

  it('carries an HRC admission diagnostic on every admission refusal, and none on a producer refusal', async () => {
    const hashMismatch = validResponse()
    hashMismatch.plan.execution.profile.startRequestHash = 'not-a-neutral-start-request-hash'
    const hash = await compile(hashMismatch)
    expect(hash).toMatchObject({
      admitted: false,
      rejectedBy: 'hrc-admission',
      admissionDiagnostic: {
        level: 'error',
        plane: 'hrc-admission',
        code: 'execution-hash-mismatch',
        field: 'plan.execution.profile.startRequestHash',
        actual: 'not-a-neutral-start-request-hash',
      },
    })
    expect(
      (hash as { admissionDiagnostic?: { message?: string } }).admissionDiagnostic?.message
    ).toContain('plan.execution.profile.startRequestHash')

    const hosting = validResponse()
    hosting.plan.execution.hosting = {
      executionTransport: 'jsonrpc-stdio',
      terminalRequired: false,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
    }
    expect(await compile(hosting)).toMatchObject({
      rejectedBy: 'hrc-admission',
      admissionDiagnostic: { code: 'execution-hosting-invalid', field: 'plan.execution.hosting' },
    })

    const producer = await compile({
      schemaVersion: 'aspc-compile-harness-invocation-response/v2',
      ok: false,
      diagnostics: [{ code: 'producer-refusal' }],
    })
    expect(producer).toMatchObject({ rejectedBy: 'producer', code: 'compile-not-ok' })
    expect(producer).not.toHaveProperty('admissionDiagnostic')
  })

  it('refuses a v2 plan without durable plan identity metadata', async () => {
    for (const field of ['planHash', 'compileId', 'createdAt'] as const) {
      const response = validResponse()
      response.plan[field] = ''

      expect(await compile(response)).toMatchObject({
        admitted: false,
        code: 'v2-plan-required',
      })
    }
  })
})
