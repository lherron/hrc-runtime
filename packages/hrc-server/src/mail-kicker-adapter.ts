import { createMailKicker, createSocketInjectionPort } from 'hrc-mail-kicker'
import type { MailKicker } from 'hrc-mail-kicker'
import { HrcClient } from 'hrc-sdk'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'

/** Bind the package-owned kicker state machine to this daemon's runtime capabilities. */
export function createServerMailKicker(server: HrcServerInstanceForHandlers): MailKicker {
  return createMailKicker(
    {
      store: server.db,
      port: createSocketInjectionPort(new HrcClient(server.options.socketPath)),
      ledger: server.wrkqLedger,
      nodeId: server.federationNodeId,
      foreignHomeMemo: server.foreignHomeMemo,
      log: writeServerLog,
    },
    {
      enabled: server.hrcMailKickerEnabled,
      sweepIntervalMs: server.hrcMailKickerSweepIntervalMs,
    }
  )
}
