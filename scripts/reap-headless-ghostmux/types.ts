import { Chalk } from 'chalk'

export type Options = {
  dryRun: boolean
  simulate: boolean
  assumeYes: boolean
  paneRole: string
  titleRegex: string
  reapTimeoutMs: number
  hrcDbPath: string
  timing: boolean
}

export type Pane = {
  id: string
  title: string
}

// Discovery now keys off the durable ghostmux metadata role rather than the
// surface TITLE (T-05237 renamed headless titles from `hrc headless agent:...`
// to the compact `<proj> · <task> · <agent>` form, which broke the old title
// regex). A DiscoveredPane carries the resolved metadata forward so queryStatus
// does not re-fetch it.
export type DiscoveredPane = Pane & {
  metadata: Record<string, unknown>
}

// The role stamped on each per-agent headless pane inside the consolidated
// "Headless Sessions" window (T-05237). The window anchor itself carries
// `headless-window-anchor` and is intentionally excluded.
export const HEADLESS_PANE_ROLE = 'headless-agent-pane'
export const MIN_IDLE_MINUTES = 30
export const MIN_IDLE_MS = MIN_IDLE_MINUTES * 60 * 1000

export type PaneStatus = Pane & {
  agent: string
  scopeRef: string
  runtimeId: string
  runtimeStatus: string
  transport: string
  controllerKind: string
  activeRunId: string
  turnStatus: string
  runId: string
  lastActivityUtc: string
  lastActivityLocal: string
  latestTurnEventKind: string
  // Presentation-aware reap fields (T-04923, Phase C of T-04905). Sourced from
  // the persisted broker hosting state (runtime_state_json). OPTIONAL because the
  // legacy metadata path (and the original eligibleStatus fixtures) never set
  // them — `undefined` means "no hosting-state info, fall back to the raw
  // transport gate"; `''` means "json_extract returned NULL → malformed/absent
  // broker.presentation block".
  presentationKind?: string
  substrateKind?: string
}

export const color = new Chalk({
  level: process.env.NO_COLOR ? 0 : process.stdout.isTTY || process.env.FORCE_COLOR ? 1 : 0,
})
