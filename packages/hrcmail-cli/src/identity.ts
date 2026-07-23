import { normalizeSessionRef } from 'hrc-core'
import type { HrcMailActor, HrcRuntimeIntent } from 'hrc-core'
import { buildHrcRuntimeIntent, resolveProfileAwareScopeInput } from 'hrc-sdk'
import type { ProfileAwareResolvedScopeInput } from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

function taskIdFromSessionRef(sessionRef: string | undefined): string | undefined {
  return sessionRef?.match(/:task:([^/:]+)/)?.[1]
}

function resolveMailScope(input: string): ProfileAwareResolvedScopeInput {
  const caller = process.env['HRC_SESSION_REF']
  const projectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const taskId = taskIdFromSessionRef(caller)
  return resolveProfileAwareScopeInput(input, {
    scope: {
      defaultLaneId: 'main',
      ...(projectId === undefined ? {} : { projectId }),
      ...(taskId === undefined ? {} : { taskId }),
    },
  })
}

export function resolveMailTarget(input: string): string {
  const resolved = resolveMailScope(input)
  return `${resolved.scopeRef}/lane:${resolved.laneId}`
}

export function resolveMailDeliveryTarget(input: string): {
  targetSessionRef: string
  materializationIntent: HrcRuntimeIntent
} {
  const resolved = resolveMailScope(input)
  const agentRoot = resolved.placement.agentRoot
  if (agentRoot === undefined) {
    const searched = resolved.placement.searchedAgentRoots
    throw new Error(
      searched && searched.length > 0
        ? `agent "${resolved.parsed.agentId}" not found; searched: ${searched.join(', ')}`
        : `agent "${resolved.parsed.agentId}" not found; no agent roots configured`
    )
  }
  return {
    targetSessionRef: `${resolved.scopeRef}/lane:${resolved.laneId}`,
    materializationIntent: buildHrcRuntimeIntent({
      agentId: resolved.parsed.agentId,
      agentRoot,
      ...(resolved.placement.projectRoot === undefined
        ? {}
        : { projectRoot: resolved.placement.projectRoot }),
      cwd: resolved.placement.cwd ?? agentRoot,
      runMode: 'task',
      interactive: false,
      preferredMode: 'nonInteractive',
    }),
  }
}

export function resolveMailActor(): HrcMailActor {
  const sessionRef = process.env['HRC_SESSION_REF']
  return sessionRef
    ? {
        kind: 'scope',
        sessionRef: normalizeSessionRef(sessionRef).replace(/\/lane:default$/, '/lane:main'),
      }
    : {
        kind: 'operator',
        principal: process.env['HRC_OPERATOR_PRINCIPAL']?.trim() || 'local-operator',
      }
}

export function resolveOwnMailbox(explicitTarget?: string): string {
  if (explicitTarget) return resolveMailTarget(explicitTarget)
  const actor = resolveMailActor()
  if (actor.kind === 'scope') return actor.sessionRef
  throw new Error('operator inbox requires --target <scope>')
}
