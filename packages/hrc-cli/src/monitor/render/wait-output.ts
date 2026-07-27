import type { HrcMonitorConditionOutcome, HrcMonitorEvent } from 'hrc-core'
import { stringField } from '../../monitor-fields.js'

export type WaitOutputEvent = HrcMonitorEvent | Record<string, unknown>

export function finalWaitOutcomeEvent(outcome: HrcMonitorConditionOutcome): WaitOutputEvent {
  return (
    outcome.eventStream
      ?.slice()
      .reverse()
      .find((event) => {
        const name = stringField(event, 'event')
        return name === 'monitor.completed' || name === 'monitor.stalled'
      }) ?? {
      event: outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
      result: outcome.result,
      outcome: outcome.outcome,
      exitCode: outcome.exitCode,
      replayed: false,
      ts: new Date().toISOString(),
    }
  )
}

export function writeWaitFinalEvent(event: WaitOutputEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }
  const parts = [stringField(event, 'event') ?? 'monitor.completed']
  for (const key of [
    'selector',
    'condition',
    'scopeRef',
    'result',
    'outcome',
    'phase',
    'reason',
    'failureKind',
    'runId',
    'exitCode',
  ]) {
    const value = event[key]
    if (value !== undefined) parts.push(`${key}=${String(value)}`)
  }
  process.stdout.write(`${parts.join(' ')}\n`)
}

export function writeWaitUsageError(message: string, json: boolean): void {
  void json
  process.stderr.write(`error: ${message}\n`)
}
