export function agentSources(context: Record<string, unknown>) {
  const supplied = (context['agentSources'] ?? {}) as Record<string, unknown>
  return {
    aspHome: supplied['aspHome'] ?? '/Users/lherron/praesidium/var/spaces-repo',
    agentsRoot: supplied['agentsRoot'] ?? '/Users/lherron/praesidium/var/agents',
    provenance: typeof context['agentRoot'] === 'string' ? 'caller-agent-root' : 'caller',
  }
}

export function agentName(context: Record<string, unknown>): string {
  return String(context['agentId'] ?? 'probe')
}

export function projectRoot(context: Record<string, unknown>): string | undefined {
  const project = (context['project'] ?? { mode: 'none' }) as Record<string, unknown>
  return project['mode'] === 'root' && typeof project['projectRoot'] === 'string'
    ? project['projectRoot']
    : undefined
}

export function bundleRef(context: Record<string, unknown>) {
  const root = projectRoot(context)
  return {
    kind: 'agent-project',
    agentName: agentName(context),
    ...(root !== undefined ? { projectRoot: root } : {}),
  }
}
