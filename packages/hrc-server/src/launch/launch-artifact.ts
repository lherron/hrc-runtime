import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcLaunchArtifact } from 'hrc-core'

const REQUIRED_FIELDS = [
  'launchId',
  'hostSessionId',
  'generation',
  'runtimeId',
  'harness',
  'provider',
  'argv',
  'env',
  'cwd',
  'callbackSocketPath',
  'spoolDir',
  'correlationEnv',
] as const

export async function writeLaunchArtifact(
  artifact: HrcLaunchArtifact,
  dir: string
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${artifact.launchId}.json`)
  await writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf-8')
  return filePath
}

export async function readLaunchArtifact(path: string): Promise<HrcLaunchArtifact> {
  const raw = await readFile(path, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in launch artifact: ${path}`)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Launch artifact is not an object: ${path}`)
  }

  const obj = parsed as Record<string, unknown>

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`Launch artifact missing required field '${field}': ${path}`)
    }
  }

  if (typeof obj['launchId'] !== 'string') {
    throw new Error(`Launch artifact 'launchId' must be a string: ${path}`)
  }
  if (typeof obj['generation'] !== 'number') {
    throw new Error(`Launch artifact 'generation' must be a number: ${path}`)
  }
  if (!Array.isArray(obj['argv'])) {
    throw new Error(`Launch artifact 'argv' must be an array: ${path}`)
  }
  if ((obj['argv'] as unknown[]).length === 0) {
    throw new Error(`Launch artifact 'argv' must not be empty: ${path}`)
  }

  return parsed as HrcLaunchArtifact
}
