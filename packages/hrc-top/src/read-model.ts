import type {
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcTargetView,
  TargetCapabilityView,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

export type HrcTopScope = {
  projectId?: string | undefined
  lane?: string | undefined
  allProjects?: boolean | undefined
}

export type HrcTopLastActivity =
  | {
      source: 'runtime.lastActivityAt'
      at: string
    }
  | {
      source: 'unknown'
      at: undefined
    }

export type HrcTopRuntimeSummary = {
  runtimeId: string
  status: string
}

export type HrcTopMessageContext = {
  messageId: string
  messageSeq: number
  createdAt: string
  phase: HrcMessageRecord['phase'] | string
  from: HrcMessageAddress
  to: HrcMessageAddress
  bodyPreview: string
}

export type HrcTopRow = {
  id: string
  target: HrcTargetView
  sessionRef: string
  state: HrcTargetView['state']
  runtime?: HrcTopRuntimeSummary | undefined
  hasContinuation: boolean
  capabilities: TargetCapabilityView
  last: HrcTopLastActivity
  message?: HrcTopMessageContext | undefined
}

export type HrcTopHeaderCounts = {
  live: number
  dormant: number
}

export type HrcTopReadModel = {
  rows: HrcTopRow[]
  counts: HrcTopHeaderCounts
  refreshedAt: string
}

function lastActivityForTarget(target: HrcTargetView): HrcTopLastActivity {
  if (target.runtime?.lastActivityAt) {
    return { source: 'runtime.lastActivityAt', at: target.runtime.lastActivityAt }
  }
  return { source: 'unknown', at: undefined }
}

function isLiveTarget(target: HrcTargetView): boolean {
  return target.state === 'bound' || target.state === 'busy' || target.state === 'summoned'
}

export function projectTargetRow(
  target: HrcTargetView,
  message?: HrcTopMessageContext | undefined
): HrcTopRow {
  return {
    id: target.runtime?.runtimeId ?? target.activeHostSessionId ?? target.sessionRef,
    target,
    sessionRef: target.sessionRef,
    state: target.state,
    runtime: target.runtime
      ? {
          runtimeId: target.runtime.runtimeId,
          status: target.runtime.status,
        }
      : undefined,
    hasContinuation: target.continuation?.key !== undefined,
    capabilities: target.capabilities,
    last: lastActivityForTarget(target),
    ...(message ? { message } : {}),
  }
}

export function buildReadModel(
  targets: readonly HrcTargetView[],
  now: Date = new Date(),
  messageContextByRowId: ReadonlyMap<string, HrcTopMessageContext> = new Map()
): HrcTopReadModel {
  const rows = targets.map((target) => {
    const base = projectTargetRow(target)
    return base.message ? base : projectTargetRow(target, messageContextByRowId.get(base.id))
  })
  return {
    rows,
    counts: {
      live: targets.filter(isLiveTarget).length,
      dormant: targets.filter((target) => target.state === 'dormant').length,
    },
    refreshedAt: now.toISOString(),
  }
}

export async function loadReadModel(
  client: Pick<HrcClient, 'listTargets'> & Partial<Pick<HrcClient, 'listMessages'>>,
  scope: HrcTopScope = {}
): Promise<HrcTopReadModel> {
  const projectId = scope.projectId ?? process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const targets = await client.listTargets({
    projectId: scope.allProjects ? undefined : projectId,
    lane: scope.lane,
    includeDormant: true,
  })
  const listMessages = client.listMessages
  if (typeof listMessages !== 'function') {
    return buildReadModel(targets)
  }

  const messageContextByRowId = await resolveMessageContexts({ listMessages }, targets)
  return buildReadModel(targets, new Date(), messageContextByRowId)
}

async function resolveMessageContexts(
  client: Pick<HrcClient, 'listMessages'>,
  targets: readonly HrcTargetView[]
): Promise<Map<string, HrcTopMessageContext>> {
  const contexts = new Map<string, HrcTopMessageContext>()
  for (const target of targets) {
    const row = projectTargetRow(target)
    const record = await latestMessageForTarget(client, target).catch(() => undefined)
    const context = messageContextFromRecord(record)
    if (context) contexts.set(row.id, context)
  }
  return contexts
}

async function latestMessageForTarget(
  client: Pick<HrcClient, 'listMessages'>,
  target: HrcTargetView
): Promise<unknown | undefined> {
  const runId = target.runtime?.activeRunId
  if (runId) {
    const byRun = await listMessageRecords(
      client,
      requestPhaseFilter({ runId, order: 'desc', limit: 1 })
    )
    if (byRun[0]) return byRun[0]
  }

  const participantFilter: HrcMessageFilter = {
    participant: { kind: 'session', sessionRef: target.sessionRef },
    hostSessionId: target.activeHostSessionId,
    generation: target.generation,
    order: 'desc',
    limit: 1,
  }
  const byParticipant = await listMessageRecords(client, participantFilter)
  return byParticipant[0]
}

function requestPhaseFilter(input: {
  runId: string
  order: 'desc'
  limit: number
}): HrcMessageFilter & { phase: 'request' } {
  const filter = { ...input, phase: 'request' as const } as HrcMessageFilter & {
    phase: 'request'
  }
  Object.defineProperty(filter, 'toJSON', {
    enumerable: false,
    value: () => ({
      runId: input.runId,
      phases: ['request'],
      order: input.order,
      limit: input.limit,
    }),
  })
  return filter
}

async function listMessageRecords(
  client: Pick<HrcClient, 'listMessages'>,
  filter: HrcMessageFilter
): Promise<unknown[]> {
  const response = await client.listMessages(filter)
  if (Array.isArray(response)) return response
  if (
    typeof response === 'object' &&
    response !== null &&
    Array.isArray((response as { messages?: unknown }).messages)
  ) {
    return (response as { messages: unknown[] }).messages
  }
  return []
}

function messageContextFromRecord(record: unknown): HrcTopMessageContext | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const source = record as Partial<HrcMessageRecord>
  if (!source.messageId || source.messageId.trim().length === 0) return undefined
  if (
    typeof source.messageSeq !== 'number' ||
    typeof source.createdAt !== 'string' ||
    typeof source.body !== 'string' ||
    !source.from ||
    !source.to
  ) {
    return undefined
  }
  return {
    messageId: source.messageId,
    messageSeq: source.messageSeq,
    createdAt: source.createdAt,
    phase: source.phase ?? '',
    from: source.from,
    to: source.to,
    bodyPreview: bodyPreview(source.body),
  }
}

function bodyPreview(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`
}
