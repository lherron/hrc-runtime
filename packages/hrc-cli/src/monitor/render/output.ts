import type { HrcMonitorEvent } from 'hrc-core'
import { MonitorResult } from 'hrc-events'
import { stringField } from '../../monitor-fields.js'
import { type MonitorOutputFormat, createMonitorRenderer, toMonitorJsonEvent } from './index.js'

export type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

export type MonitorEventWriter = {
  write(event: MonitorOutputEvent): void
  flush(): void
}

type MonitorWriterOptions = {
  maxLines?: number | undefined
  scopeWidth?: number | undefined
}

const VALID_RESULTS = new Set<string>(MonitorResult)

export function createMonitorEventWriter(
  stdout: { write(chunk: string): boolean },
  selectorStr: string,
  options: MonitorWriterOptions,
  format: MonitorOutputFormat
): MonitorEventWriter {
  if (format === 'json' || format === 'ndjson') {
    return {
      write(event) {
        const replayed = event['replayed'] === true
        const output = toMonitorJsonEvent(event, selectorStr, replayed)
        const eventName = stringField(output, 'event') ?? 'unknown'
        const result = stringField(output, 'result')
        if (
          result &&
          eventName !== 'monitor.completed' &&
          eventName !== 'monitor.stalled' &&
          !VALID_RESULTS.has(result)
        ) {
          output['result'] = undefined
        }
        stdout.write(`${JSON.stringify(output)}\n`)
      },
      flush() {},
    }
  }

  const renderer = createMonitorRenderer(format, options)
  return {
    write(event) {
      if (stringField(event, 'event') === 'monitor.snapshot') return
      stdout.write(renderer.push(event))
    },
    flush() {
      stdout.write(renderer.flush())
    },
  }
}

export async function drainMonitorStdout(stdout: {
  drain?: (() => Promise<void>) | undefined
}): Promise<void> {
  await stdout.drain?.()
}
