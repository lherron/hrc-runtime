import type { HrcRuntimeIntent } from 'hrc-core'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSpaceRef(value: unknown): value is `space:${string}@${string}` {
  return typeof value === 'string' && /^space:.+@.+$/.test(value)
}

/**
 * Convert only the ASP observation's structural bundle reference into HRC's
 * placement vocabulary. Selection is deliberately not interpreted here.
 */
export function observedRuntimeBundle(
  value: unknown
): HrcRuntimeIntent['placement']['bundle'] | undefined {
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'agent-project' && typeof value['agentName'] === 'string') {
    const projectRoot = value['projectRoot']
    return {
      kind: 'agent-project',
      agentName: value['agentName'],
      ...(typeof projectRoot === 'string' ? { projectRoot } : {}),
    }
  }
  if (value['kind'] === 'compose' && Array.isArray(value['compose'])) {
    const compose: `space:${string}@${string}`[] = []
    for (const ref of value['compose']) {
      if (!isSpaceRef(ref)) return undefined
      compose.push(ref)
    }
    return { kind: 'compose', compose }
  }
  return undefined
}
