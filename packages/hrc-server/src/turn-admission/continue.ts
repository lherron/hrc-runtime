import { type HrcRuntimeIntent, HrcRuntimeUnavailableError } from 'hrc-core'
import { requireSession } from '../require-helpers.js'
import { createAdmittedPlan } from './plan.js'
import { parseDurableColdBootTurnInput } from './routes/broker-headless-queue.js'
import type { DispatchTurnForSessionOptions } from './routes/turn-dispatch-session-dispatch.js'
import type { AdmissionContext } from './types.js'

/** Closed provenance set: neither source creates or re-admits user work. */
export type AdmittedContinuation =
  | {
      kind: 'queued-snapshot'
      runId: string
      snapshotId: string
      prompt: string
      intent: HrcRuntimeIntent | undefined
      options: DispatchTurnForSessionOptions
    }
  | { kind: 'accepted-cold-boot'; runId: string; runtimeId: string }

export async function continueAdmittedTurn(
  ctx: AdmissionContext,
  source: AdmittedContinuation
): Promise<Response> {
  const run = ctx.db.runs.getByRunId(source.runId)
  const correlation = ctx.db.runs.getCorrelationJson(source.runId)
  let durable: { kind?: string; prompt?: string } | undefined
  try {
    durable = correlation === null ? undefined : JSON.parse(correlation)
  } catch {
    /* Refuse corrupt provenance below. */
  }
  const cold =
    source.kind === 'accepted-cold-boot' ? parseDurableColdBootTurnInput(correlation) : undefined
  if (
    run === null ||
    run.transport !== 'headless' ||
    run.completedAt !== undefined ||
    (source.kind === 'queued-snapshot'
      ? run.status !== 'queued' ||
        run.queueSnapshotId !== source.snapshotId ||
        source.snapshotId.length === 0 ||
        run.dispatchedInputId === undefined ||
        durable?.kind !== 'durable_headless_turn_input' ||
        typeof durable.prompt !== 'string'
      : run.status !== 'accepted' ||
        run.runtimeId !== source.runtimeId ||
        run.dispatchedInputId !== undefined ||
        cold === undefined)
  ) {
    throw new HrcRuntimeUnavailableError('continuation has no admitted durable owner', {
      runId: source.runId,
      source: source.kind,
    })
  }
  const session = requireSession(ctx.db, run.hostSessionId)
  const runtime =
    source.kind === 'accepted-cold-boot'
      ? ctx.db.runtimes.getByRuntimeId(source.runtimeId)
      : undefined
  if (
    source.kind === 'accepted-cold-boot' &&
    (runtime == null || runtime.hostSessionId !== session.hostSessionId)
  )
    throw new HrcRuntimeUnavailableError('continuation runtime does not own its accepted run', {
      runId: source.runId,
    })
  const release = ctx.turnAdmissionGate.admit({ existingAcceptedRun: true })
  try {
    const options: DispatchTurnForSessionOptions =
      source.kind === 'queued-snapshot'
        ? { ...source.options, runId: run.runId }
        : {
            ...cold?.dispatch,
            responseFormat: cold?.responseFormat,
            runId: run.runId,
            waitForCompletion: false,
          }
    const prompt = source.kind === 'queued-snapshot' ? source.prompt : cold?.prompt
    if (prompt === undefined) throw new Error('verified continuation lost its prompt')
    const intent = source.kind === 'queued-snapshot' ? source.intent : undefined
    const effectiveDoor = options.submissionDoor ?? 'invoke'
    // Only admission owns the brand; the existing durable receipt supplies provenance.
    const plan = createAdmittedPlan({
      session,
      participant: undefined,
      doorReport: undefined,
      observation: undefined,
      launchCarry: undefined,
      runtimeIntent: intent,
      effectiveDoor,
      options,
      request: {
        door: 'turns' as const,
        intent: effectiveDoor,
        target: session,
        body: prompt,
        principal: 'system',
        executionFormat: 'format1' as const,
        options,
        replay: async () => {
          throw new Error('continuations cannot replay admission')
        },
      },
    })
    return source.kind === 'queued-snapshot'
      ? await ctx.executeAdmittedTurn(plan, intent, prompt, options)
      : await ctx.executeHeadlessBrokerInputTurn(plan, runtime!, prompt, run.runId, options)
  } finally {
    release()
  }
}
