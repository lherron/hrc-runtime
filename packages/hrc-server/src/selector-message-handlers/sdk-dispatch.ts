import type { HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

/**
 * The in-process SDK executor is retired. Keep this route boundary so legacy
 * SDK-shaped requests receive the typed runtime-unavailable response emitted by
 * failSdkHarnessPath instead of falling through to an unmatched route or 500.
 */
export async function handleSdkDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  void prompt
  void options
  this.failSdkHarnessPath('handleSdkDispatchTurn', session, intent, runId)
}
