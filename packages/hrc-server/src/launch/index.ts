// hrc-launch: wrapper for launch artifact exec, hook ingestion, callback spooling

export { readLaunchArtifact, writeLaunchArtifact } from './launch-artifact.js'
export { postCallback } from './callback-client.js'
export { readSpoolEntries, replaySpoolEntries, spoolCallback } from './spool.js'
export type { SpoolEntry, SpoolPostCallback, SpoolReplayResult } from './spool.js'
export { buildHookEnvelope } from './hook.js'
export type { HookEnvelope, HookEnvelopeEnv } from './hook.js'
