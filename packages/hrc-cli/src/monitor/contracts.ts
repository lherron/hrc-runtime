import type { HrcMonitorState } from 'hrc-core'
import type { TerminalFence } from '../monitor-terminal-fence.js'
import type { MonitorOutputFormat } from './render/index.js'

/** Structured args accepted when monitor watch is invoked directly. */
export type MonitorWatchArgs = {
  selector?: string | undefined
  selectors?: string[] | undefined
  json?: boolean | undefined
  pretty?: boolean | undefined
  format?: MonitorOutputFormat | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  last?: number | undefined
  until?: string | undefined
  untilConditions?: string[] | undefined
  untilAny?: string[] | undefined
  untilAll?: string[] | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  since?: string | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
  signal?: AbortSignal | undefined
  kind?: string | undefined
  tool?: string | undefined
  grep?: string | undefined
  milestone?: boolean | undefined
  allEvents?: boolean | undefined
  forever?: boolean | undefined
  implicitTerminal?: boolean | undefined
  terminalFence?: TerminalFence | undefined
  deadlineAt?: number | undefined
}

/** Injectable dependencies retained as the monitor-watch test seam. */
export type MonitorWatchDeps = {
  buildMonitorState: (signal?: AbortSignal) => Promise<HrcMonitorState>
  stdout: { write(chunk: string): boolean; drain?: () => Promise<void> }
  stderr: { write(chunk: string): boolean }
}
