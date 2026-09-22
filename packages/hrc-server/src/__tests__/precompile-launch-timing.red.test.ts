import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import type { AspcCompileHarnessInvocationResponse } from 'spaces-aspc-protocol'
import {
  type RuntimeCompileRequest,
  type RuntimeIdentityAllocation,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import { compileBrokerRuntimePlan } from '../agent-spaces-adapter/compile-adapter'

// Launch spans are persisted to <state root>/metrics as of T-07706. Without an
// isolated state root these fixture runs write `runtime-spawn`-shaped records
// into the operator's REAL metrics store and skew every startup percentile.
let stateRoot: string
let originalStateDir: string | undefined

beforeAll(() => {
  originalStateDir = process.env['HRC_STATE_DIR']
  stateRoot = mkdtempSync(join(tmpdir(), 'hrc-precompile-timing-'))
  process.env['HRC_STATE_DIR'] = stateRoot
})

afterAll(() => {
  // Deliberately NOT `process.env[...] = originalStateDir` when it was unset:
  // assigning undefined stores the literal string 'undefined', which resolves to
  // a bogus relative state root rather than restoring the default (see T-07707).
  if (originalStateDir === undefined) Reflect.deleteProperty(process.env, 'HRC_STATE_DIR')
  else process.env['HRC_STATE_DIR'] = originalStateDir
  rmSync(stateRoot, { recursive: true, force: true })
})

type TimingFields = Record<string, unknown>
type TimingEntry = { message: string; fields: TimingFields }

function makeLogger() {
  const info: TimingEntry[] = []
  const warnings: TimingEntry[] = []
  return {
    info,
    warnings,
    logger: {
      info: (message: string, fields: TimingFields) => info.push({ message, fields }),
      warn: (message: string, fields: TimingFields) => warnings.push({ message, fields }),
    },
  }
}

function makeIdAllocator() {
  return {
    requestId: () => 'request_timing',
    operationId: () => 'operation_timing',
    runtimeId: () => 'runtime-compile',
    invocationId: () => 'invocation_timing',
    initialInputId: () => 'input_timing',
    runId: () => 'run_timing',
    traceId: () => 'trace_timing',
  }
}

function makeIntent(): HrcRuntimeIntent {
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
    initialPrompt: 'measure the compile RPC',
  }
}

function makeSuccessfulCompileResponse(
  request: RuntimeCompileRequest
): AspcCompileHarnessInvocationResponse {
  const identity = request.identity as RuntimeIdentityAllocation
  const startRequest = {
    spec: {
      invocationId: identity.invocationId,
      driver: { kind: 'codex-app-server' },
      correlation: {
        requestId: identity.requestId,
        operationId: identity.operationId,
        hostSessionId: identity.hostSessionId,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
        traceId: identity.traceId,
      },
    },
    ...(identity.initialInputId === undefined
      ? {}
      : { initialInput: { inputId: identity.initialInputId } }),
  } as never
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v2',
    ok: true,
    diagnostics: [],
    plan: {
      schemaVersion: 'agent-runtime-plan/v2',
      agent: { id: 'timing' },
      identity,
      planHash: 'plan-timing',
      compileId: 'compile-timing',
      createdAt: '2026-09-22T00:00:00.000Z',
      diagnostics: [],
      selection: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.5',
        presentation: false,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'catalog-default',
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
          profileId: 'profile-timing',
          profileHash: 'profile-hash-timing',
          compatibilityHash: 'compatibility-timing',
          startRequestHash: neutralStartRequestHash(startRequest),
        },
        dispatchRequest: { startRequest },
      },
    },
  } as unknown as AspcCompileHarnessInvocationResponse
}

async function waitForWarning(
  entries: TimingEntry[],
  phase: RegExp,
  timeoutMs: number
): Promise<TimingEntry> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const entry = entries.find(({ fields }) => String(fields['phase']).match(phase))
    if (entry) return entry
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('compile bound diagnostic was not emitted')
}

describe('dark pre-compile launch timing (T-06402; T-08596 closure)', () => {
  // T-08596: the ASPC facade child-spawn and hello-handshake spans are gone
  // with the facade spawn. The compile RPC span below is the surviving timing
  // surface for daemon/aspd-backed compiles.
  it('emits a tagged compile RPC span inside compileBrokerRuntimePlan', async () => {
    const capture = makeLogger()
    const compileHarnessInvocation = async (request: { compileRequest: RuntimeCompileRequest }) =>
      makeSuccessfulCompileResponse(request.compileRequest)
    const deps = {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
      timing: {
        transport: 'preview' as const,
        runtimeId: 'runtime-compile',
        stateRoot,
        logger: capture.logger,
      },
    }

    const result = await compileBrokerRuntimePlan(
      {
        intent: makeIntent(),
        scopeRef: 'agent:timing:project:hrc-runtime',
        hostSessionId: 'host_timing',
        generation: 1,
      },
      deps
    )

    expect(result.admitted).toBe(true)
    const entry = capture.info.find(({ fields }) => String(fields['phase']).match(/compile.*rpc/i))
    expect(entry?.message).toBe('broker.timing')
    expect(entry?.fields).toMatchObject({ transport: 'preview', runtimeId: 'runtime-compile' })
    expect(typeof entry?.fields['durMs']).toBe('number')
  })

  it('warns while a compile span is over its bound without aborting the eventual launch', async () => {
    const capture = makeLogger()
    let releaseCompile: ((response: AspcCompileHarnessInvocationResponse) => void) | undefined
    let capturedRequest: RuntimeCompileRequest | undefined
    let settled = false
    const compileHarnessInvocation = (request: { compileRequest: RuntimeCompileRequest }) => {
      capturedRequest = request.compileRequest
      return new Promise<AspcCompileHarnessInvocationResponse>((resolve) => {
        releaseCompile = resolve
      })
    }
    const deps = {
      compileHarnessInvocation,
      ids: makeIdAllocator(),
      timing: {
        transport: 'headless' as const,
        runtimeId: 'runtime-compile',
        stateRoot,
        boundMs: 5,
        logger: capture.logger,
      },
    }

    const operation = compileBrokerRuntimePlan(
      {
        intent: makeIntent(),
        scopeRef: 'agent:timing:project:hrc-runtime',
        hostSessionId: 'host_slow_compile',
        generation: 1,
      },
      deps
    ).finally(() => {
      settled = true
    })

    const warning = await waitForWarning(capture.warnings, /compile.*rpc/i, 250)

    expect(warning.message).toBe('broker.timing')
    expect(warning.fields).toMatchObject({
      transport: 'headless',
      runtimeId: 'runtime-compile',
      boundMs: 5,
    })
    expect(settled).toBe(false)
    expect(capturedRequest).toBeDefined()
    expect(releaseCompile).toBeDefined()
    if (!capturedRequest || !releaseCompile) {
      throw new Error('compile timing fixture did not capture its pending request')
    }

    releaseCompile(makeSuccessfulCompileResponse(capturedRequest))
    const result = await operation
    expect(result.admitted).toBe(true)
  })
})
