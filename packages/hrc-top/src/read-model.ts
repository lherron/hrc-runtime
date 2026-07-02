import type { HrcTargetView, TargetCapabilityView } from 'hrc-core'
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

export type HrcTopRow = {
  id: string
  target: HrcTargetView
  sessionRef: string
  state: HrcTargetView['state']
  runtime?: HrcTopRuntimeSummary | undefined
  hasContinuation: boolean
  capabilities: TargetCapabilityView
  last: HrcTopLastActivity
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

export function projectTargetRow(target: HrcTargetView): HrcTopRow {
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
  }
}

export function buildReadModel(
  targets: readonly HrcTargetView[],
  now: Date = new Date()
): HrcTopReadModel {
  const rows = targets.map(projectTargetRow)
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
  client: Pick<HrcClient, 'listTargets'>,
  scope: HrcTopScope = {}
): Promise<HrcTopReadModel> {
  const projectId = scope.projectId ?? process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const targets = await client.listTargets({
    projectId: scope.allProjects ? undefined : projectId,
    lane: scope.lane,
    includeDormant: true,
  })
  return buildReadModel(targets)
}
