import { describe, expect, it, spyOn } from 'bun:test'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { AspcCompileHarnessInvocationResponse } from 'spaces-aspc-protocol'
import type { RuntimeCompileRequest, RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import { compileBrokerRuntimePlan } from '../agent-spaces-adapter/compile-adapter'
import { startAspcFacadeBrokerClient } from '../option-resolvers'

import { makeBrokerProfile, makeCompileResponse } from './broker-compile-fixtures'

type TimingFields = Record<string, unknown>
type TimingEntry = { message: string; fields: TimingFields }

type TimingContext = {
  transport: 'headless' | 'interactive' | 'preview'
  runtimeId: string
  boundMs?: number
  logger: {
    info(message: string, fields: TimingFields): void
    warn(message: string, fields: TimingFields): void
  }
}

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
  const { profile } = makeBrokerProfile(identity)
  const compileResponse = makeCompileResponse(identity, [profile])
  if (!compileResponse.ok) {
    throw new Error('timing fixture compile unexpectedly failed')
  }
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
}

function fakeFacadeClient() {
  return {
    hello: async () => ({
      protocolVersion: 'aspc/1',
      facadeInfo: { name: 'timing-test' },
      capabilities: { compileHarnessInvocation: true, cohostedBroker: true },
    }),
    close: async () => undefined,
  } as unknown as AspcFacadeBrokerClient
}

async function startWithTiming(timing: TimingContext): Promise<AspcFacadeBrokerClient> {
  const start = startAspcFacadeBrokerClient as unknown as (
    timing: TimingContext
  ) => Promise<AspcFacadeBrokerClient>
  return start(timing)
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

describe('dark pre-compile launch timing (T-06402)', () => {
  it('emits a tagged ASPC facade child-spawn span inside the start helper', async () => {
    const capture = makeLogger()
    const startSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () =>
      fakeFacadeClient()
    )
    try {
      await startWithTiming({
        transport: 'headless',
        runtimeId: 'runtime-spawn',
        logger: capture.logger,
      })
    } finally {
      startSpy.mockRestore()
    }

    const entry = capture.info.find(({ fields }) => String(fields['phase']).match(/facade.*spawn/i))
    expect(entry?.message).toBe('broker.timing')
    expect(entry?.fields).toMatchObject({ transport: 'headless', runtimeId: 'runtime-spawn' })
    expect(typeof entry?.fields['durMs']).toBe('number')
  })

  it('emits a separately tagged ASPC facade hello-handshake span inside the start helper', async () => {
    const capture = makeLogger()
    const startSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () =>
      fakeFacadeClient()
    )
    try {
      await startWithTiming({
        transport: 'interactive',
        runtimeId: 'runtime-hello',
        logger: capture.logger,
      })
    } finally {
      startSpy.mockRestore()
    }

    const entry = capture.info.find(({ fields }) => String(fields['phase']).match(/facade.*hello/i))
    expect(entry?.message).toBe('broker.timing')
    expect(entry?.fields).toMatchObject({
      transport: 'interactive',
      runtimeId: 'runtime-hello',
    })
    expect(typeof entry?.fields['durMs']).toBe('number')
  })

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
        logger: capture.logger,
      },
    }

    const result = await compileBrokerRuntimePlan(
      { intent: makeIntent(), hostSessionId: 'host_timing', generation: 1 },
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
        boundMs: 5,
        logger: capture.logger,
      },
    }

    const operation = compileBrokerRuntimePlan(
      { intent: makeIntent(), hostSessionId: 'host_slow_compile', generation: 1 },
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
