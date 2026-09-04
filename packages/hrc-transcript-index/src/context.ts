import type { HrcDatabase } from 'hrc-store-sqlite'

import type { TranscriptIndexStats, TranscriptIndexerLogLevel } from './contracts.js'

export type TranscriptIndexerContext = {
  readonly db: HrcDatabase
  readonly enabled: boolean
  readonly tickIntervalMs: number
  readonly batchSize: number
  stopping: boolean
  tickTimer: ReturnType<typeof setInterval> | undefined
  tickInFlight: Promise<void> | undefined
  invocationsReindexed: number
  log(level: TranscriptIndexerLogLevel, event: string, detail: Record<string, unknown>): void
  tickOnce(): Promise<void>
  stats(): TranscriptIndexStats
}
