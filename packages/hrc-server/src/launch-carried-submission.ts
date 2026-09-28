import { setTimeout as delay } from 'node:timers/promises'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { isRunActive } from './require-helpers.js'

/**
 * How long a submission door waits for the broker to name a launch-carried
 * first turn (T-09643).
 *
 * An argv-carried launch (claude-code-tmux, muse-cli-tmux, ...) has no broker
 * `initialInput`, so the durable start graph holds no submission identity. The
 * broker names that turn only when it observes it (`human_submission_<inv>_<n>`,
 * projected onto `runs.broker_submission_id` by the event mapper). The wait ends
 * at that identity -- about boot plus turn start -- never at the provider turn's
 * completion. The bound is a ceiling for a seat that never starts its turn.
 */
export const LAUNCH_CARRIED_SUBMISSION_WAIT_MS = 2 * 60 * 1000

export type LaunchCarriedSubmissionWaitServer = {
  readonly db: HrcDatabase
  /** Test seam only; production uses {@link LAUNCH_CARRIED_SUBMISSION_WAIT_MS}. */
  launchCarriedSubmissionWaitMs?: number | undefined
}

/**
 * Wait for the broker submission identity of a run whose body rode the launch.
 *
 * Both endings without that identity are explicit errors, never an
 * identity-less success: the body is already on the launch, so a door that
 * answered without an identity would give its caller nothing to reconcile a
 * write that happened. A caller must treat these errors as "possibly written".
 */
export async function waitForLaunchCarriedSubmissionIdentity(
  server: LaunchCarriedSubmissionWaitServer,
  runId: string,
  runtimeId: string
): Promise<string> {
  const waitMs = server.launchCarriedSubmissionWaitMs ?? LAUNCH_CARRIED_SUBMISSION_WAIT_MS
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const run = server.db.runs.getByRunId(runId)
    if (run?.brokerSubmissionId !== undefined) return run.brokerSubmissionId
    if (run !== null && !isRunActive(run)) {
      throw new HrcRuntimeUnavailableError(
        'launch-carried run ended without broker submission identity',
        {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        }
      )
    }
    await delay(25)
  }
  throw new HrcRuntimeUnavailableError('launch-carried submission identity timed out', {
    runtimeId,
    runId,
    waitMs,
  })
}
