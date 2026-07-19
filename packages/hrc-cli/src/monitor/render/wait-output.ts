import {
  type HrcMonitorCondition,
  type HrcMonitorConditionOutcome,
  type HrcMonitorEvent,
  type HrcSelector,
  formatSelector,
} from 'hrc-core'
import { stringField } from '../../monitor-fields.js'

export type WaitOutputEvent = HrcMonitorEvent | Record<string, unknown>

export function normalizeWaitOutcome(
  outcome: HrcMonitorConditionOutcome,
  selector: HrcSelector,
  condition: HrcMonitorCondition
): HrcMonitorConditionOutcome {
  const monitorError = outcome.eventStream?.find(
    (event) =>
      stringField(event, 'event') === 'monitor.error' ||
      stringField(event, 'result') === 'monitor_error'
  )
  if (monitorError && outcome.result !== 'monitor_error') {
    const finalEvent = completedEvent(selector, condition, {
      result: 'monitor_error',
      exitCode: 3,
    })
    return {
      result: 'monitor_error',
      exitCode: 3,
      eventStream: [...(outcome.eventStream ?? []), finalEvent],
    }
  }
  return outcome
}

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
      exitCode: outcome.exitCode,
      replayed: false,
      ts: new Date().toISOString(),
    }
  )
}

function completedEvent(
  selector: HrcSelector,
  condition: HrcMonitorCondition,
  outcome: Pick<HrcMonitorConditionOutcome, 'result' | 'exitCode'>
): WaitOutputEvent {
  return {
    event: outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
    selector: formatSelector(selector),
    condition,
    result: outcome.result,
    exitCode: outcome.exitCode,
    replayed: false,
    ts: new Date().toISOString(),
  }
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
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { message, usage: true } })}\n`)
    return
  }
  process.stderr.write(`hrc: ${message}\n`)
}
