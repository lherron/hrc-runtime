import { RUNTIME_STATUS_LEVEL_BY_STATUS } from 'hrc-core'

/** Is this runtime, by its own status column, no longer live? */
export function isRuntimeTerminal(status: string): boolean {
  const level = (RUNTIME_STATUS_LEVEL_BY_STATUS as Record<string, string | null>)[status]
  return level === 'runtime-dead'
}
