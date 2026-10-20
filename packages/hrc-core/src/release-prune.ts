/**
 * Old atomic HRC releases are deleted outright (Lance ruling, T-10024): there is
 * no quarantine and no sweep. Steady state is ONE release directory, the one
 * `hrc-runtime-current` points to. A second one lives only between an install
 * and the next daemon restart, because the running daemon loads `.ts` lazily
 * from its own tree. A live Rust kernel also retains its executable release
 * until it exits, independently of daemon activation.
 *
 * Both callers prune through here: install after its cutover (keeping the
 * release the running daemon reports), and the daemon at startup once it runs
 * from current. Both also retain the live kernel socket owner's release.
 */
import { existsSync } from 'node:fs'
import { readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import { runBoundedSubprocess } from './bounded-subprocess.js'
import { resolveRuntimeRoot } from './paths.js'

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
  /** Socket whose live owner may still execute from an older release. */
  kernelSocketPath?: string
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

/** Resolve the socket owner's mapped executables, never the mutable current link. */
async function kernelExecutablePaths(socketPath: string): Promise<string[] | undefined> {
  try {
    if (!existsSync(socketPath)) return []
    const owners = await runBoundedSubprocess(['lsof', '-nP', '-Fpn', socketPath], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1_048_576,
    })
    if (owners.exitCode !== 0) return undefined
    const pids = [
      ...new Set(
        owners.stdout
          .split('\n')
          .filter((line) => /^p[0-9]+$/.test(line))
          .map((line) => line.slice(1))
      ),
    ]
    if (pids.length === 0) return undefined
    const paths: string[] = []
    for (const pid of pids) {
      const mapped = await runBoundedSubprocess(
        ['lsof', '-nP', '-a', '-p', pid, '-d', 'txt', '-Fn'],
        {
          timeoutMs: 5_000,
          maxStdoutBytes: 1_048_576,
        }
      )
      if (mapped.exitCode !== 0) return undefined
      const names = mapped.stdout.split('\n').filter((line) => line.startsWith('n/'))
      if (names.length === 0) return undefined
      paths.push(...names.map((line) => line.slice(1)))
    }
    return paths
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

  const kernelPaths = await kernelExecutablePaths(
    options.kernelSocketPath ?? join(resolveRuntimeRoot(), 'hrc-kernel.sock')
  )
  // Missing ownership evidence must never authorize deletion of a live image.
  if (kernelPaths === undefined) return { pruned: false, reason: 'kernel-owner-unavailable' }
  for (const path of kernelPaths) {
    const parts = relative(releaseRoot, path).split(sep)
    const id = parts[0]
    if (id !== undefined && parts.length > 1 && isReleaseId(id)) keepIds.add(id)
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
