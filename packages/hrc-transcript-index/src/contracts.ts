import type { HrcDatabase } from 'hrc-store-sqlite'

export type TranscriptIndexerLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type TranscriptIndexerDependencies = {
  db: HrcDatabase
  log(level: TranscriptIndexerLogLevel, event: string, detail: Record<string, unknown>): void
}

export type TranscriptIndexerOptions = {
  enabled: boolean
  tickIntervalMs: number
  batchSize: number
}

export type TranscriptIndexStats = {
  turnsIndexed: number
  lastEventId: number
  ledgerMaxEventId: number
  lagEvents: number
  invocationsReindexed: number
}
