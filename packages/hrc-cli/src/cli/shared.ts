import { CliUsageError } from 'cli-kit'

import {
  HrcClient,
  discoverSocket,
  writePlacementWarnings as writeSdkPlacementWarnings,
} from 'hrc-sdk'

export { formatAgentNotFound } from 'hrc-sdk'

export function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

export function fatal(message: string): never {
  throw new CliUsageError(message)
}

export function writePlacementWarnings(warnings: string[] | undefined): void {
  writeSdkPlacementWarnings('hrc', warnings)
}

export class CliStatusExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
    this.name = 'CliStatusExit'
  }
}
