import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'
import type { DispatchTurnForSessionOptions } from '../turn-admission/routes/turn-dispatch-session-dispatch'
import { submissionResponse, submitThroughAdmission } from '../turn-admission/submit'
import type { AdmittedPlan } from '../turn-admission/types'

/** Component tests enter through the same pipeline; a raw session is never an executor permit. */
export async function withTestAdmission(
  server: unknown,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions,
  execute: (ctx: HrcServerInstanceForHandlers, plan: AdmittedPlan) => Promise<Response>
): Promise<Response> {
  const ctx = server as HrcServerInstanceForHandlers
  return submissionResponse(
    await submitThroughAdmission(
      ctx,
      {
        door: 'turns',
        intent: options.submissionDoor ?? 'enqueue',
        target: session,
        body: prompt,
        principal: 'system',
        runtimeIntent: intent,
        executionFormat: options.executionFormat ?? 'format1',
        responseFormat: options.responseFormat,
        allowStaleGeneration: true,
        options,
        replay: async () => {
          throw new Error('component dispatch is not an idempotent replay')
        },
      },
      async (plan) => ({ kind: 'accepted', value: await execute(ctx, plan) })
    )
  )
}
export function dispatchTestTurn(
  server: unknown,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  return withTestAdmission(server, session, intent, prompt, options, (ctx, plan) =>
    ctx.executeAdmittedTurn(plan, intent, prompt, plan.options)
  )
}
export function dispatchTestRoute(
  server: unknown,
  method:
    | 'handleHeadlessDispatchTurn'
    | 'handleHeadlessBrokerDispatchTurn'
    | 'handleInteractiveTmuxBrokerDispatchTurn'
    | 'executeHeadlessBrokerStartTurn',
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchTurnForSessionOptions
): Promise<Response> {
  return withTestAdmission(server, session, intent, prompt, { ...options, runId }, (ctx, plan) =>
    ctx[method](plan, intent, prompt, runId, { ...options, ...plan.options } as never)
  )
}

/** For the few presentation component tests whose executor dependencies are local stubs. */
export async function withStandaloneTestAdmission(
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  execute: (plan: AdmittedPlan) => Promise<Response>
): Promise<Response> {
  const { createHrcTestFixture } = await import('./fixtures/hrc-test-fixture')
  const { createHrcServer } = await import('../index')
  const fixture = await createHrcTestFixture('sealed-component-')
  fixture.seedSession(session.hostSessionId, session.scopeRef)
  const server = await createHrcServer(fixture.serverOpts())
  try {
    const target = (server as HrcServerInstanceForHandlers).db.sessions.getByHostSessionId(
      session.hostSessionId
    )!
    ;(server as HrcServerInstanceForHandlers).db.continuities.upsert({
      scopeRef: target.scopeRef,
      laneRef: target.laneRef,
      activeHostSessionId: target.hostSessionId,
      updatedAt: fixture.now(),
    })
    return await withTestAdmission(
      server,
      target,
      {
        ...intent,
        placement: {
          agentRoot: fixture.tmpDir,
          projectRoot: fixture.tmpDir,
          cwd: fixture.tmpDir,
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
      },
      prompt,
      { submissionDoor: 'enqueue' },
      (_ctx, plan) => execute(plan)
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
}
