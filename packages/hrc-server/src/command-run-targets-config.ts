import { readFile } from 'node:fs/promises'

import { HrcInternalError } from 'hrc-core'
import type { HrcCommandLaunchSpec } from 'hrc-core'

export const HRC_COMMAND_RUN_TARGETS_FILE_ENV = 'HRC_COMMAND_RUN_TARGETS_FILE'

export function validateConfiguredCommandRunTarget(
  configuredTargetId: string,
  command: HrcCommandLaunchSpec
): void {
  if (!command.argv || command.argv.length === 0) {
    throw new HrcInternalError('configured command-run target has no argv', {
      configuredTargetId,
    })
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCommandRunTargetsConfig(
  value: unknown,
  sourcePath: string
): Record<string, HrcCommandLaunchSpec> {
  if (!isPlainRecord(value)) {
    throw new Error(
      `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} ${sourcePath} must contain a JSON object of target ids to command launch specs`
    )
  }

  const targets: Record<string, HrcCommandLaunchSpec> = {}
  for (const [targetId, spec] of Object.entries(value)) {
    if (targetId.trim().length === 0) {
      throw new Error(
        `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} ${sourcePath} contains an empty target id`
      )
    }
    if (!isPlainRecord(spec)) {
      throw new Error(
        `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} ${sourcePath} target "${targetId}" must be a JSON object`
      )
    }
    const command = spec as HrcCommandLaunchSpec
    try {
      validateConfiguredCommandRunTarget(targetId, command)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} ${sourcePath} target "${targetId}" is invalid: ${message}`,
        { cause: error }
      )
    }
    targets[targetId] = command
  }

  return targets
}

export async function loadCommandRunTargetsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, HrcCommandLaunchSpec>> {
  const sourcePath = env[HRC_COMMAND_RUN_TARGETS_FILE_ENV]?.trim()
  if (!sourcePath) return {}

  let raw: string
  try {
    raw = await readFile(sourcePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} is set to ${sourcePath}, but the file could not be read: ${message}`,
      { cause: error }
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${HRC_COMMAND_RUN_TARGETS_FILE_ENV} ${sourcePath} is not valid JSON: ${message}`,
      { cause: error }
    )
  }

  return parseCommandRunTargetsConfig(parsed, sourcePath)
}

export async function resolveCommandRunTargets(
  configured: Record<string, HrcCommandLaunchSpec> | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, HrcCommandLaunchSpec>> {
  if (configured !== undefined) {
    for (const [targetId, command] of Object.entries(configured)) {
      validateConfiguredCommandRunTarget(targetId, command)
    }
    return configured
  }
  return loadCommandRunTargetsFromEnv(env)
}
