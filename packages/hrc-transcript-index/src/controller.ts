import type { HrcDatabase } from 'hrc-store-sqlite'

import type { TranscriptIndexerContext } from './context.js'
import type {
  TranscriptIndexStats,
  TranscriptIndexerDependencies,
  TranscriptIndexerLogLevel,
  TranscriptIndexerOptions,
} from './contracts.js'
import { runLedgerTail } from './tail/ledger-tail.js'

export class TranscriptIndexer implements TranscriptIndexerContext {
  readonly db: HrcDatabase
  readonly enabled: boolean
  readonly tickIntervalMs: number
  readonly batchSize: number
  stopping = false
  tickTimer: ReturnType<typeof setInterval> | undefined
  tickInFlight: Promise<void> | undefined
  invocationsReindexed = 0

  constructor(
    private readonly dependencies: TranscriptIndexerDependencies,
    options: TranscriptIndexerOptions
  ) {
    this.db = dependencies.db
    this.enabled = options.enabled
    this.tickIntervalMs = options.tickIntervalMs
    this.batchSize = options.batchSize
  }

  log(level: TranscriptIndexerLogLevel, event: string, detail: Record<string, unknown>): void {
    this.dependencies.log(level, event, detail)
  }

  start(): void {
    if (!this.enabled || this.tickTimer !== undefined || this.stopping) return
    this.requestTick()
    this.tickTimer = setInterval(() => this.requestTick(), this.tickIntervalMs)
    this.tickTimer.unref?.()
  }

  private requestTick(): void {
    void this.tickOnce().catch((error: unknown) => {
      this.log('WARN', 'transcript.index.tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    await this.tickInFlight
  }

  tickOnce(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight
    const operation = runLedgerTail(this).finally(() => {
      if (this.tickInFlight === operation) this.tickInFlight = undefined
    })
    this.tickInFlight = operation
    return operation
  }

  stats(): TranscriptIndexStats {
    const stored = this.db.transcriptIndex.stats()
    const ledgerMaxEventId = this.db.brokerInvocationEvents.maxEventId()
    return {
      ...stored,
      ledgerMaxEventId,
      lagEvents: Math.max(0, ledgerMaxEventId - stored.lastEventId),
      invocationsReindexed: this.invocationsReindexed,
    }
  }

  async rebuild(): Promise<void> {
    await this.tickInFlight
    if (this.stopping) return
    this.db.transcriptIndex.truncateAll()
    await this.tickOnce()
  }
}

export function createTranscriptIndexer(
  dependencies: TranscriptIndexerDependencies,
  options: TranscriptIndexerOptions
): TranscriptIndexer {
  return new TranscriptIndexer(dependencies, options)
}
