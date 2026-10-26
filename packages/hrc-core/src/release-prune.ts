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
 * from current. Neither knows every process on the host, so both also keep any
 * release a live process holds open or was started from (T-11830: a scratch
 * daemon on another runtime root deleted the release production ran from).
 */
import { existsSync } from 'node:fs'
import { open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import { runBoundedSubprocess } from './bounded-subprocess.js'

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
  | {
      pruned: true
      current: string
      removed: string[]
      kept: string[]
      failed: string[]
      /** Releases kept because a live process holds or was started from them, with its pids. */
      heldBy: Record<string, number[]>
    }

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

const RELEASE_MANIFEST_BASENAME = 'praesidium-release.json'
const PROBE_TIMEOUT_MS = 5_000
const PROBE_MAX_STDOUT_BYTES = 64 * 1024 * 1024

type LiveHolders = Map<string, Set<number>>

function addHolder(holders: LiveHolders, id: string, pid: number): void {
  const pids = holders.get(id) ?? new Set<number>()
  pids.add(pid)
  holders.set(id, pids)
}

/** The candidate release a resolved path lies in, if any. */
function candidateOf(releaseRoot: string, candidates: Set<string>, path: string) {
  const id = relative(releaseRoot, path).split(sep)[0]
  return id !== undefined && candidates.has(id) ? id : undefined
}

/**
 * The candidate an argv path names. argv keeps the spelling the process was
 * started with (`/tmp/...` for `/private/tmp/...`, a symlinked home), so the
 * prefix up to the release root's own name is resolved before comparing.
 */
async function candidateOfArgvPath(
  releaseRoot: string,
  candidates: Set<string>,
  path: string,
  resolved: Map<string, string | undefined>
) {
  const marker = `${sep}${basename(releaseRoot)}${sep}`
  const at = path.indexOf(marker)
  if (!path.startsWith(sep) || at < 0) return undefined
  const prefix = path.slice(0, at + marker.length - 1)
  if (!resolved.has(prefix)) resolved.set(prefix, await realpathOrUndefined(prefix))
  if (resolved.get(prefix) !== releaseRoot) return undefined
  return candidateOf(releaseRoot, candidates, join(releaseRoot, path.slice(prefix.length)))
}

/**
 * Processes holding a candidate open: its directory as cwd, its manifest (every
 * atomic daemon keeps its own open for life, because nothing else it runs from
 * stays open), or a `bin/` executable mapped as an image (the Rust kernel and
 * rusthrc). One lsof over every named path. The prune's own handle on current's
 * manifest is the control: lsof exits 1 whenever a name has no holder, so only
 * our pid on that line distinguishes "nobody holds these" from a failed probe.
 */
async function openFileHolders(
  releaseRoot: string,
  candidates: Set<string>,
  current: string
): Promise<LiveHolders | undefined> {
  const control = join(current, RELEASE_MANIFEST_BASENAME)
  const names: string[] = []
  for (const id of candidates) {
    const release = join(releaseRoot, id)
    names.push(release)
    if (existsSync(join(release, RELEASE_MANIFEST_BASENAME))) {
      names.push(join(release, RELEASE_MANIFEST_BASENAME))
    }
    try {
      for (const entry of await readdir(join(release, 'bin'), { withFileTypes: true })) {
        if (entry.isFile()) names.push(join(release, 'bin', entry.name))
      }
    } catch {}
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(control, 'r')
    const result = await runBoundedSubprocess(['lsof', '-nP', '-Fpn', '--', control, ...names], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_MAX_STDOUT_BYTES,
    })
    const holders: LiveHolders = new Map()
    let controlSeen = false
    let pid: number | undefined
    for (const line of result.stdout.split('\n')) {
      if (/^p[0-9]+$/.test(line)) pid = Number(line.slice(1))
      if (!line.startsWith('n/') || pid === undefined) continue
      const path = line.slice(1)
      if (path === control && pid === process.pid) controlSeen = true
      const id = candidateOf(releaseRoot, candidates, path)
      if (id !== undefined) addHolder(holders, id, pid)
    }
    return controlSeen ? holders : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * Processes started from a candidate: the executable or script path in argv
 * lies inside it (helpers a daemon spawns by their release path). Only those
 * two words count, so a path quoted elsewhere in an argv names nothing. Our
 * own pid in the listing is the control.
 */
async function argvHolders(
  releaseRoot: string,
  candidates: Set<string>
): Promise<LiveHolders | undefined> {
  try {
    const result = await runBoundedSubprocess(['ps', '-axww', '-o', 'pid=,args='], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_MAX_STDOUT_BYTES,
    })
    if (result.exitCode !== 0) return undefined
    const holders: LiveHolders = new Map()
    const resolved = new Map<string, string | undefined>()
    let controlSeen = false
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*([0-9]+)\s+(.*)$/.exec(line)
      if (match === null) continue
      const pid = Number(match[1])
      if (pid === process.pid) controlSeen = true
      const words = (match[2] ?? '').split(/\s+/)
      for (const word of [words[0], words.slice(1).find((w) => !w.startsWith('-'))]) {
        if (word === undefined) continue
        const id = await candidateOfArgvPath(releaseRoot, candidates, word, resolved)
        if (id !== undefined) addHolder(holders, id, pid)
      }
    }
    return controlSeen ? holders : undefined
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

  const entries = (await readdir(releaseRoot, { withFileTypes: true })).filter(
    // A symlink here is not a release tree we created; leave it alone.
    (entry) =>
      entry.isDirectory() && (entry.name === LEGACY_GC_DEBRIS_DIRNAME || isReleaseId(entry.name))
  )
  const kept: string[] = []
  const candidates = new Set<string>()
  for (const { name } of entries) {
    if (
      name !== LEGACY_GC_DEBRIS_DIRNAME &&
      (keepIds.has(name) || (options.onlyOlderThanCurrent === true && name >= currentId))
    ) {
      kept.push(name)
    } else {
      candidates.add(name)
    }
  }

  // T-11830: every live process on this host may run from a candidate, whatever
  // runtime root it serves. Missing evidence never authorizes deletion.
  const heldBy: Record<string, number[]> = {}
  if (candidates.size > 0) {
    const [heldOpen, startedFrom] = await Promise.all([
      openFileHolders(releaseRoot, candidates, current),
      argvHolders(releaseRoot, candidates),
    ])
    if (heldOpen === undefined || startedFrom === undefined) {
      return { pruned: false, reason: 'live-holders-unavailable' }
    }
    for (const holders of [heldOpen, startedFrom]) {
      for (const [id, pids] of holders) {
        heldBy[id] = [...new Set([...(heldBy[id] ?? []), ...pids])].sort((a, b) => a - b)
      }
    }
  }

  const removed: string[] = []
  const failed: string[] = []
  for (const name of candidates) {
    if (heldBy[name] !== undefined) {
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
  return { pruned: true, current: currentId, removed, kept, failed, heldBy }
}
