import type { HrcDatabase } from 'hrc-store-sqlite'

export type RuntimeActivitySource =
  | 'turn'
  | 'broker-event'
  | 'agent-hook'
  | 'agent-message'
  | 'housekeeping'

const QUALIFYING_RUNTIME_ACTIVITY_SOURCES: ReadonlySet<RuntimeActivitySource> = new Set([
  'turn',
  'broker-event',
  'agent-hook',
  'agent-message',
])

export function isQualifyingRuntimeActivity(source: RuntimeActivitySource): boolean {
  return QUALIFYING_RUNTIME_ACTIVITY_SOURCES.has(source)
}

type RuntimeActivityPatchInput =
  | {
      source: Exclude<RuntimeActivitySource, 'housekeeping'>
      occurredAt: string
      updatedAt: string
    }
  | {
      source: 'housekeeping'
      updatedAt: string
    }

/** Build runtime mutation timestamps from the centralized activity contract. */
export function runtimeActivityPatch(
  db: HrcDatabase,
  runtimeId: string,
  input: RuntimeActivityPatchInput
): { updatedAt: string; lastActivityAt?: string } {
  if (!isQualifyingRuntimeActivity(input.source)) {
    return { updatedAt: input.updatedAt }
  }

  const previous = db.runtimes.getByRuntimeId(runtimeId)?.lastActivityAt
  const occurredAt = 'occurredAt' in input ? input.occurredAt : input.updatedAt
  return {
    updatedAt: input.updatedAt,
    lastActivityAt:
      previous !== undefined && Date.parse(previous) > Date.parse(occurredAt)
        ? previous
        : occurredAt,
  }
}
