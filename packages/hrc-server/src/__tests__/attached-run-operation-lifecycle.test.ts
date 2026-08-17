import { describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

import { handlePrepareAttachedRun, handleResumeAttachedRun } from '../turn-dispatch-handlers.js'

const session: HrcSessionRecord = {
  hostSessionId: 'hsid-attached-run',
  scopeRef: 'agent:cody:project:hrc-runtime:task:T-07280',
  laneRef: 'main',
  generation: 1,
  status: 'active',
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
  ancestorScopeRefs: [],
}

const runtime = {
  runtimeId: 'rt-attached-run',
  hostSessionId: session.hostSessionId,
  scopeRef: session.scopeRef,
  laneRef: session.laneRef,
  generation: session.generation,
  transport: 'tmux',
  harness: 'codex-cli',
  provider: 'openai',
  status: 'starting',
  supportsInflightInput: true,
  adopted: false,
  controllerKind: 'harness-broker',
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
} as HrcRuntimeSnapshot

describe('attached-run operation lifecycle', () => {
  it('keeps a prepared run resumable after its accepted response settles', async () => {
    let settleAccepted!: () => void
    const accepted = new Promise<void>((resolve) => {
      settleAccepted = resolve
    })
    let resumeCalls = 0
    const attachedRunOperations = new Map<
      string,
      { result: Promise<unknown>; resumeDeadlineTimer?: ReturnType<typeof setTimeout> }
    >()
    const server = {
      db: {
        sessions: {
          getByHostSessionId: (hostSessionId: string) =>
            hostSessionId === session.hostSessionId ? session : null,
        },
      },
      attachedRunOperations,
      maybeAutoRotateStaleSession: async () => ({ session }),
      dispatchTurnForSession: async () => {
        await accepted
        return Response.json({
          runId: 'run-attached-run',
          hostSessionId: session.hostSessionId,
          generation: session.generation,
          runtimeId: runtime.runtimeId,
          transport: 'tmux',
          status: 'started',
          supportsInFlightInput: true,
        })
      },
      getHarnessBrokerController: () => ({
        waitForAttachedStartReady: async (pendingStartId: string) => ({
          pendingStartId,
          runtime,
        }),
        resumeAttachedStart: () => {
          resumeCalls += 1
          return { ok: true as const, response: { runtimeId: runtime.runtimeId } }
        },
        cancelAttachedStart: () => undefined,
      }),
      attachRuntime: () =>
        Response.json({
          transport: 'tmux',
          argv: ['tmux', 'attach-session'],
          bindingFence: {
            hostSessionId: session.hostSessionId,
            runtimeId: runtime.runtimeId,
            generation: session.generation,
          },
        }),
    }

    const preparedResponse = await handlePrepareAttachedRun.call(
      server as never,
      new Request('http://hrc/v1/runs/prepare-attached', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostSessionId: session.hostSessionId,
          intent: {
            harness: { provider: 'openai', id: 'codex-cli', interactive: true },
            execution: { preferredMode: 'interactive' },
          },
          prompt: 'start the attached run',
        }),
      })
    )
    const prepared = (await preparedResponse.json()) as {
      status: string
      pendingStartId: string
    }
    expect(prepared.status).toBe('prepared')
    const acceptedOperation = attachedRunOperations.get(prepared.pendingStartId)?.result
    expect(acceptedOperation).toBeDefined()

    // Interactive dispatch returns at durable acceptance while the controller is
    // still paused at its attach-before-invocation gate. Settling that response
    // must not erase the resume handle the CLI is about to consume.
    settleAccepted()
    await acceptedOperation
    await Promise.resolve()

    const resumedResponse = await handleResumeAttachedRun.call(
      server as never,
      new Request('http://hrc/v1/runs/resume-attached', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingStartId: prepared.pendingStartId }),
      })
    )
    const resumed = (await resumedResponse.json()) as { status: string }

    expect(resumed.status).toBe('started')
    expect(resumeCalls).toBe(1)
  })
})
