/**
 * Old atomic HRC releases are deleted outright (Lance ruling, T-10024): there is
 * no quarantine and no sweep. Steady state is ONE release directory, the one
 * `hrc-runtime-current` points to. A second one lives only between an install
 * and the next daemon restart, because the running daemon loads `.ts` lazily
 * from its own tree.
 *
 * Both callers prune through here: install after its cutover (keeping the
 * release the running daemon reports), and the daemon at startup once it runs
 * from current.
 */
import { existsSync } from 'node:fs'
import { readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const RELEASE_ID_PATTERN = /^release-[A-Za-z0-9._-]+$/
/** The directory the retired `hrc admin release gc` renamed releases into. */
const LEGACY_GC_DEBRIS_DIRNAME = '.gc-quarantine'

export type ReleasePruneOptions = {
  releaseRoot: string
  currentLink: string
  /**
   * The release the caller believes is current. Pruning refuses unless
   * `currentLink` resolves to exactly this directory, so a link that was never
   * switched (or that a concurrent install switched again) deletes nothing.
   */
  expectedCurrent: string
  /** Further release directories to keep, e.g. the one the running daemon reports. */
  keep?: string[]
  /**
   * Delete only releases whose id sorts before current's. Release ids embed
   * their creation timestamp, so a release an install is still preparing sorts
   * after current. The daemon prunes without holding the install lock and
   * passes this; install holds the lock and does not.
   */
  onlyOlderThanCurrent?: boolean
  /** When set and present, an install is in progress and nothing is pruned. */
  installLockDir?: string
}

export type ReleasePruneResult =
  | { pruned: false; reason: string }
  | { pruned: true; current: string; removed: string[]; kept: string[]; failed: string[] }

function isReleaseId(name: string): boolean {
  return RELEASE_ID_PATTERN.test(name)
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

export async function pruneReleaseDirs(options: ReleasePruneOptions): Promise<ReleasePruneResult> {
  if (options.installLockDir !== undefined && existsSync(options.installLockDir)) {
    return { pruned: false, reason: 'install-in-progress' }
  }
  const releaseRoot = await realpathOrUndefined(options.releaseRoot)
  if (releaseRoot === undefined) return { pruned: false, reason: 'release-root-missing' }
  const current = await realpathOrUndefined(options.currentLink)
  const expected = await realpathOrUndefined(options.expectedCurrent)
  if (current === undefined || expected === undefined || current !== expected) {
    return { pruned: false, reason: 'current-link-mismatch' }
  }
  const currentId = basename(current)
  if (dirname(current) !== releaseRoot || !isReleaseId(currentId)) {
    return { pruned: false, reason: 'current-outside-release-root' }
  }

  const keepIds = new Set([currentId])
  for (const path of options.keep ?? []) {
    const resolved = (await realpathOrUndefined(path)) ?? path
    if (dirname(resolved) === releaseRoot) keepIds.add(basename(resolved))
  }

  const removed: string[] = []
  const kept: string[] = []
  const failed: string[] = []
  for (const entry of await readdir(releaseRoot, { withFileTypes: true })) {
    const name = entry.name
    const isDebris = name === LEGACY_GC_DEBRIS_DIRNAME
    if (!isDebris && !isReleaseId(name)) continue
    // A symlink here is not a release tree we created; leave it alone.
    if (!entry.isDirectory()) continue
    if (
      !isDebris &&
      (keepIds.has(name) || (options.onlyOlderThanCurrent === true && name >= currentId))
    ) {
      kept.push(name)
      continue
    }
    try {
      await rm(join(releaseRoot, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { pruned: true, current: currentId, removed, kept, failed }
}
