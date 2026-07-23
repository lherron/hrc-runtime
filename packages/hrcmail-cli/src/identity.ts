import { normalizeSessionRef } from 'hrc-core'
import type { HrcMailActor } from 'hrc-core'
import { resolveProfileAwareScopeInput } from 'hrc-sdk'
import { inferProjectIdFromCwd } from 'spaces-config'

function taskIdFromSessionRef(sessionRef: string | undefined): string | undefined {
  return sessionRef?.match(/:task:([^/:]+)/)?.[1]
}

export function resolveMailTarget(input: string): string {
  const caller = process.env['HRC_SESSION_REF']
  const projectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()
  const taskId = taskIdFromSessionRef(caller)
  const resolved = resolveProfileAwareScopeInput(input, {
    scope: {
      defaultLaneId: 'main',
      ...(projectId === undefined ? {} : { projectId }),
      ...(taskId === undefined ? {} : { taskId }),
    },
  })
  return `${resolved.scopeRef}/lane:${resolved.laneId}`
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
