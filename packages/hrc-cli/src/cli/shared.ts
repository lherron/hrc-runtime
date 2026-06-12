import { CliUsageError } from 'cli-kit'

import { HrcClient, discoverSocket } from 'hrc-sdk'

export function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

export function fatal(message: string): never {
  throw new CliUsageError(message)
}

export function writePlacementWarnings(warnings: string[] | undefined): void {
  if (!warnings || warnings.length === 0) return
  for (const warning of warnings) {
    process.stderr.write(`[hrc] warning: ${warning}\n`)
  }
}

export function formatAgentNotFound(
  agentId: string,
  searchedAgentRoots: string[] | undefined
): string {
  if (searchedAgentRoots && searchedAgentRoots.length > 0) {
    return `agent "${agentId}" not found; searched: ${searchedAgentRoots.join(', ')}`
  }
  return `agent "${agentId}" not found; no agent roots configured.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.`
}

export class CliStatusExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
    this.name = 'CliStatusExit'
  }
}
