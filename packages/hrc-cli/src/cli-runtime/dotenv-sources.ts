/**
 * Provenance of values the CLI auto-loaded from .env.local files (see hrc-sdk
 * loadDotEnvLocal). Recorded once at the entrypoint so resolution code can say
 * where an ambient value came from instead of acting on it silently.
 */
let dotEnvSources: Readonly<Record<string, string>> = {}

export function recordDotEnvSources(sources: Record<string, string>): void {
  dotEnvSources = { ...sources }
}

export function dotEnvSource(key: string): string | undefined {
  return dotEnvSources[key]
}

/**
 * The stderr note for a bare-agent default project that came from a
 * file-loaded ASP_PROJECT. Undefined when the value came from the real
 * environment, or when it did not decide the project (e.g. the cwd won).
 */
export function dotEnvProjectNote(input: {
  projectId: string | undefined
  aspProject: string | undefined
  source: string | undefined
}): string | undefined {
  const { projectId, aspProject, source } = input
  if (source === undefined || aspProject === undefined || projectId !== aspProject) {
    return undefined
  }
  return `[hrc] project '${projectId}' from ASP_PROJECT in ${source}; pass '<agent>@<project>' or --project-id to choose another\n`
}
