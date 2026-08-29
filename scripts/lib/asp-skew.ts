/**
 * Skew between the ASP graph the SUITE resolves and the one a RELEASE ships.
 *
 * Before the praesidium dev workspace these could not disagree: hrc-runtime
 * resolved agent-spaces from bun.lock, and so did the release. The workspace links
 * agent-spaces from SOURCE at the sibling checkout's HEAD, while atomic-install
 * still builds from `bun.lock --frozen-lockfile`. So "green in the workspace" no
 * longer implies "green in the release", and the surface that used to report lock
 * lag (verdaccio-sync) now correctly stays silent for source-linked packages —
 * silencing true reports along with the false ones. This module is what reports it
 * instead.
 *
 * The lag itself is NOT a defect: a consumer running behind its producer is this
 * platform's intended steady state. Only the CLAIM that a green suite means a
 * shippable release is wrong, so callers warn and only `check-asp-skew` refuses.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ANCHOR = 'agent-scope'
const REGISTRY = process.env['VERDACCIO_REGISTRY'] ?? 'http://mini:4873/'

export type AspSkew = {
  status: 'in-sync' | 'skew' | 'no-sibling' | 'unresolved'
  lockedVersion?: string
  lockedSourceCommit?: string
  siblingRoot?: string
  siblingHead?: string
  ahead: string[]
}

function git(args: string[], cwd: string): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

/** The version bun.lock pins for the anchor package — what a release will install. */
export function readLockedAnchorVersion(repoRoot: string): string | undefined {
  const lockPath = join(repoRoot, 'bun.lock')
  if (!existsSync(lockPath)) return undefined
  const match = readFileSync(lockPath, 'utf8').match(new RegExp(`"${ANCHOR}@([^"]+)"`))
  return match?.[1]
}

async function sourceCommitOf(version: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${REGISTRY.replace(/\/$/, '')}/${ANCHOR}/${encodeURIComponent(version)}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!response.ok) return undefined
    const manifest = (await response.json()) as {
      praesidiumBuild?: { sourceCommit?: string }
    }
    return manifest.praesidiumBuild?.sourceCommit
  } catch {
    return undefined
  }
}

export async function readAspSkew(repoRoot: string): Promise<AspSkew> {
  const lockedVersion = readLockedAnchorVersion(repoRoot)
  const siblingRoot = resolve(repoRoot, '..', 'agent-spaces')
  if (!existsSync(join(siblingRoot, '.git'))) {
    return { status: 'no-sibling', lockedVersion, ahead: [] }
  }
  const siblingHead = git(['rev-parse', 'HEAD'], siblingRoot)
  const lockedSourceCommit = lockedVersion ? await sourceCommitOf(lockedVersion) : undefined
  if (lockedSourceCommit === undefined || siblingHead === undefined) {
    return { status: 'unresolved', lockedVersion, siblingRoot, siblingHead, ahead: [] }
  }
  if (lockedSourceCommit === siblingHead) {
    return {
      status: 'in-sync',
      lockedVersion,
      lockedSourceCommit,
      siblingRoot,
      siblingHead,
      ahead: [],
    }
  }
  const log = git(['log', '--oneline', `${lockedSourceCommit}..HEAD`], siblingRoot)
  return {
    status: 'skew',
    lockedVersion,
    lockedSourceCommit,
    siblingRoot,
    siblingHead,
    ahead: log ? log.split('\n').filter(Boolean) : [],
  }
}

/** One line naming both graphs; safe to print at the head of every suite run. */
export function formatAspGraphBanner(skew: AspSkew): string {
  const source = skew.siblingHead ? skew.siblingHead.slice(0, 8) : 'unknown'
  const locked = skew.lockedSourceCommit ? skew.lockedSourceCommit.slice(0, 8) : 'unknown'
  if (skew.status === 'no-sibling') {
    return `[asp-graph] locked@${locked} (${skew.lockedVersion ?? 'unknown'}); no sibling agent-spaces checkout — suite and release resolve the SAME graph`
  }
  if (skew.status === 'in-sync') {
    return `[asp-graph] source@${source} == locked@${locked} — suite and release resolve the same ASP graph`
  }
  if (skew.status === 'unresolved') {
    return `[asp-graph] source@${source} vs locked ${skew.lockedVersion ?? 'unknown'} (sourceCommit unavailable) — could not compare graphs`
  }
  return `[asp-graph] source@${source} vs locked@${locked} — ${skew.ahead.length} agent-spaces commit(s) AHEAD of the tuple a release ships; a green suite here is not evidence about the release`
}

export function formatAspSkewDetail(skew: AspSkew): string[] {
  if (skew.status !== 'skew') return []
  return [
    `  locked tuple : ${skew.lockedVersion} @ ${skew.lockedSourceCommit}`,
    `  sibling HEAD : ${skew.siblingHead}`,
    ...skew.ahead.map((line) => `    ${line}`),
  ]
}
