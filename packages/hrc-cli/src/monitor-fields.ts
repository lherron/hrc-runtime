/**
 * Shared, private field-reader helpers for the monitor command family.
 *
 * Previously these `stringField`/`numberField`/`booleanField` readers were
 * declared byte-identically in `monitor-render.ts`, `monitor-watch.ts`, and
 * `monitor-wait.ts`. They are consolidated here verbatim (behavior-preserving).
 */

import type { HrcMonitorEvent } from 'hrc-core'

/** A monitor event as read by the renderers/condition engine. */
export type MonitorFieldSource = HrcMonitorEvent | Record<string, unknown>

export function stringField(event: MonitorFieldSource, key: string): string | undefined {
  const value = (event as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

export function numberField(event: MonitorFieldSource, key: string): number | undefined {
  const value = (event as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

export function booleanField(event: MonitorFieldSource, key: string): boolean | undefined {
  const value = (event as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}
