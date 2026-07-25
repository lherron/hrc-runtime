import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { HrcReleaseStatus, PraesidiumBuild, PraesidiumReleaseManifest } from 'hrc-core'

export const PRAESIDIUM_RELEASE_MANIFEST_BASENAME = 'praesidium-release.json'

const BUILD_FIELDS = [
  'schema',
  'repository',
  'canonicalRemote',
  'sourceCommit',
  'setName',
  'setVersion',
  'builtAt',
] as const
const RELEASE_FIELDS = ['schema', 'releaseId', 'hrcBuild', 'aspBuild', 'installedAt'] as const

type CapturedAtomicRelease = Omit<
  Extract<HrcReleaseStatus, { mode: 'atomic' }>,
  'runningEqualsInstalled'
> & { installedLinkPath: string }

type CapturedUnmanagedRelease = Omit<
  Extract<HrcReleaseStatus, { mode: 'unmanaged' }>,
  'runningEqualsInstalled'
>

export type CapturedServerRelease = CapturedAtomicRelease | CapturedUnmanagedRelease

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

function requireNonEmptyString(
  value: Record<string, unknown>,
  field: string,
  context: string
): string {
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
  if (!isRecord(value) || !hasExactFields(value, BUILD_FIELDS)) {
    throw new Error(`${context} must contain exactly ${BUILD_FIELDS.join(', ')}`)
  }
  if (value['schema'] !== 1) throw new Error(`${context}.schema must be 1`)
  const repository = requireNonEmptyString(value, 'repository', context)
  const canonicalRemote = requireNonEmptyString(value, 'canonicalRemote', context)
  const sourceCommit = requireNonEmptyString(value, 'sourceCommit', context)
  const setName = requireNonEmptyString(value, 'setName', context)
  const setVersion = requireNonEmptyString(value, 'setVersion', context)
  const builtAt = requireNonEmptyString(value, 'builtAt', context)
  if (repository !== expected.repository) {
    throw new Error(`${context}.repository must be ${expected.repository}`)
  }
  if (setName !== expected.setName) {
    throw new Error(`${context}.setName must be ${expected.setName}`)
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

export function parsePraesidiumReleaseManifest(
  value: unknown,
  expectedReleaseId?: string
): PraesidiumReleaseManifest {
  if (!isRecord(value) || !hasExactFields(value, RELEASE_FIELDS)) {
    throw new Error(`release manifest must contain exactly ${RELEASE_FIELDS.join(', ')}`)
  }
  if (value['schema'] !== 1) throw new Error('release manifest schema must be 1')
  const releaseId = requireNonEmptyString(value, 'releaseId', 'release manifest')
  const installedAt = requireNonEmptyString(value, 'installedAt', 'release manifest')
  if (expectedReleaseId !== undefined && releaseId !== expectedReleaseId) {
    throw new Error(
      `release manifest ID ${releaseId} does not match directory ${expectedReleaseId}`
    )
  }
  if (!Number.isFinite(Date.parse(installedAt))) {
    throw new Error('release manifest installedAt must be an ISO timestamp')
  }
  return {
    schema: 1,
    releaseId,
    hrcBuild: parsePraesidiumBuild(
      value['hrcBuild'],
      { repository: 'hrc-runtime', setName: 'hrc' },
      'release manifest.hrcBuild'
    ),
    aspBuild: parsePraesidiumBuild(
      value['aspBuild'],
      { repository: 'agent-spaces', setName: 'asp' },
      'release manifest.aspBuild'
    ),
    installedAt,
  }
}

function atomicReleaseRootForPackage(packagePath: string): string | undefined {
  const releasePath = dirname(dirname(packagePath))
  if (
    basename(dirname(releasePath)) !== 'hrc-runtime-releases' ||
    !/^release-[A-Za-z0-9._-]+$/.test(basename(releasePath))
  ) {
    return undefined
  }
  return releasePath
}

/**
 * Capture immutable process identity once. Atomic releases fail closed when
 * their colocated manifest is missing or malformed; source/worktree daemons
 * remain explicit unmanaged processes.
 */
export function captureServerRelease(
  packagePath: string,
  processStartedAt: string
): CapturedServerRelease {
  const realPackagePath = realpathSync(packagePath)
  const releasePath = atomicReleaseRootForPackage(realPackagePath)
  if (releasePath === undefined) {
    return {
      mode: 'unmanaged',
      packagePath: realPackagePath,
      processStartedAt,
    }
  }

  const releaseId = basename(releasePath)
  const manifestPath = join(releasePath, PRAESIDIUM_RELEASE_MANIFEST_BASENAME)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `atomic HRC release ${releaseId} has no valid ${PRAESIDIUM_RELEASE_MANIFEST_BASENAME}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const manifest = parsePraesidiumReleaseManifest(parsed, releaseId)
  return {
    mode: 'atomic',
    releaseId,
    releasePath,
    manifestPath,
    hrcBuild: manifest.hrcBuild,
    aspBuild: manifest.aspBuild,
    installedAt: manifest.installedAt,
    processStartedAt,
    installedLinkPath: join(dirname(dirname(releasePath)), 'hrc-runtime-current'),
  }
}

/** Project captured identity plus the one intentionally live install comparison. */
export function projectServerRelease(captured: CapturedServerRelease): HrcReleaseStatus {
  if (captured.mode === 'unmanaged') {
    return { ...captured, runningEqualsInstalled: false }
  }

  let runningEqualsInstalled = false
  try {
    runningEqualsInstalled = realpathSync(captured.installedLinkPath) === captured.releasePath
  } catch {
    runningEqualsInstalled = false
  }
  const { installedLinkPath: _installedLinkPath, ...release } = captured
  return { ...release, runningEqualsInstalled }
}
