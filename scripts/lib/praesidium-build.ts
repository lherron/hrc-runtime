import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PraesidiumBuild } from 'hrc-core'

export const PRAESIDIUM_BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const

export const ASP_PACKAGE_NAMES = [
  'agent-scope',
  'cli-kit',
  'spaces-config',
  'spaces-runtime',
  'spaces-execution',
  'spaces-harness-broker-protocol',
  'spaces-harness-broker-client',
  'spaces-harness-broker',
  'spaces-runtime-contracts',
  'spaces-aspc-protocol',
  'spaces-aspc',
  'spaces-aspc-facade',
  'spaces-harness-claude',
  'spaces-harness-codex',
  'spaces-harness-pi',
  'spaces-harness-pi-sdk',
  'agent-spaces',
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`
}

/** Read and cross-check the complete ASP package set selected by the release lock/install. */
export async function readCoherentInstalledAspBuild(releasePath: string): Promise<PraesidiumBuild> {
  let coherent: PraesidiumBuild | undefined
  for (const packageName of ASP_PACKAGE_NAMES) {
    const manifestPath = join(releasePath, 'node_modules', packageName, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    if (manifest.name !== packageName || manifest.version === undefined) {
      throw new Error(`installed ASP manifest mismatch at ${manifestPath}`)
    }
    const build = parsePraesidiumBuild(
      manifest.praesidiumBuild,
      { repository: 'agent-spaces', setName: 'asp' },
      `${packageName}.praesidiumBuild`
    )
    if (build.setVersion !== manifest.version) {
      throw new Error(
        `${packageName} installed version ${manifest.version} disagrees with build ${build.setVersion}`
      )
    }
    if (coherent === undefined) coherent = build
    else if (stableJson(coherent) !== stableJson(build)) {
      throw new Error(`${packageName} does not share the installed coherent ASP build tuple`)
    }
  }
  if (coherent === undefined) throw new Error('installed ASP package set is empty')
  return coherent
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
