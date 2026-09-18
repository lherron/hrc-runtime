import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AspContractPackage, PraesidiumBuild } from 'hrc-core'

export const PRAESIDIUM_BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const

/**
 * T-08596 (T-08569A closure) — the thin ASP contract set: the only
 * agent-spaces packages an HRC release installs. Stamped into
 * praesidium-release.json as `aspContracts` (names plus installed versions)
 * instead of the deleted coherent execution-build tuple.
 */
export const ASP_CONTRACT_PACKAGE_NAMES = [
  'agent-scope',
  'cli-kit',
  'spaces-aspc-protocol',
  'spaces-harness-broker-protocol',
  'spaces-harness-broker-client',
  'spaces-runtime-contracts',
] as const

type PackageManifest = {
  name?: string
  version?: string
  praesidiumBuild?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  )
}

function nonEmpty(value: Record<string, unknown>, field: string, context: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result.trim() === '') {
    throw new Error(`${context}.${field} must be a non-empty string`)
  }
  return result
}

export function parsePraesidiumBuild(
  value: unknown,
  expected: { repository: string; setName: 'asp' | 'hrc' },
  context = 'praesidiumBuild'
): PraesidiumBuild {
  if (!isRecord(value) || !hasExactFields(value, PRAESIDIUM_BUILD_FIELDS)) {
    throw new Error(`${context} must contain exactly ${PRAESIDIUM_BUILD_FIELDS.join(', ')}`)
  }
  if (value['schema'] !== 1) throw new Error(`${context}.schema must be 1`)
  const repository = nonEmpty(value, 'repository', context)
  const canonicalRemote = nonEmpty(value, 'canonicalRemote', context)
  const sourceCommit = nonEmpty(value, 'sourceCommit', context)
  const setName = nonEmpty(value, 'setName', context)
  const setVersion = nonEmpty(value, 'setVersion', context)
  const builtAt = nonEmpty(value, 'builtAt', context)
  if (repository !== expected.repository || setName !== expected.setName) {
    throw new Error(
      `${context} must identify ${expected.repository}/${expected.setName}, received ${repository}/${setName}`
    )
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error(`${context}.sourceCommit must be a 40-character Git commit`)
  }
  if (!Number.isFinite(Date.parse(builtAt))) {
    throw new Error(`${context}.builtAt must be an ISO timestamp`)
  }
  return {
    schema: 1,
    repository,
    canonicalRemote,
    sourceCommit,
    setName: expected.setName,
    setVersion,
    builtAt,
  }
}

/** Read the installed versions of the thin ASP contract set for the release manifest. */
export async function readInstalledAspContracts(
  releasePath: string
): Promise<AspContractPackage[]> {
  const contracts: AspContractPackage[] = []
  for (const packageName of ASP_CONTRACT_PACKAGE_NAMES) {
    const manifestPath = join(releasePath, 'node_modules', packageName, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (manifest.name !== packageName || manifest.version === undefined) {
      throw new Error(`installed ASP contract mismatch at ${manifestPath}`)
    }
    contracts.push({ name: packageName, version: manifest.version })
  }
  return contracts
}

export async function readPublishedHrcBuild(
  path: string,
  expectedCanonical?: boolean
): Promise<PraesidiumBuild> {
  const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (expectedCanonical !== undefined && document['canonical'] !== expectedCanonical) {
    throw new Error(
      `HRC publisher output canonical=${String(document['canonical'])}; expected ${expectedCanonical}`
    )
  }
  return parsePraesidiumBuild(
    document['build'],
    { repository: 'hrc-runtime', setName: 'hrc' },
    'HRC publisher output.build'
  )
}
