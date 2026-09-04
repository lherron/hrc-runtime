import { createTranscriptIndexer } from 'hrc-transcript-index'
import type { TranscriptIndexer } from 'hrc-transcript-index'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'

/** Bind the package-owned transcript projection to the daemon store and logger. */
export function createServerTranscriptIndexer(
  server: HrcServerInstanceForHandlers
): TranscriptIndexer {
  return createTranscriptIndexer(
    { db: server.db, log: writeServerLog },
    {
      enabled: server.hrcTranscriptIndexEnabled,
      tickIntervalMs: server.hrcTranscriptIndexTickIntervalMs,
      batchSize: server.options.hrcTranscriptIndexBatchSize ?? 1_000,
    }
  )
}
