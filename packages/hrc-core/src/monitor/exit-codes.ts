/** Frozen process exit codes for the redesigned monitor condition surface. */
export const MONITOR_EXIT_CODES = {
  matchedAfterArm: 0,
  usage: 2,
  alreadyTrueAtArm: 10,
  noSessionEver: 11,
  runtimeDeathObstruction: 12,
  timeout: 20,
  stall: 21,
  contextChange: 22,
  monitorError: 23,
} as const

export type MonitorExitCode = (typeof MONITOR_EXIT_CODES)[keyof typeof MONITOR_EXIT_CODES]
