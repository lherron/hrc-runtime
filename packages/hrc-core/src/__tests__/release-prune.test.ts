import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneReleaseDirs } from '../release-prune.js'

// T-10024: install and daemon startup delete old releases outright. Every case
// here is a way that deletion could take a tree something still runs from.

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(releaseIds: string[], currentId: string) {
  const root = await mkdtemp(join(tmpdir(), 'hrc-release-prune-'))
  roots.push(root)
  const releaseRoot = join(root, 'hrc-runtime-releases')
  for (const id of releaseIds) {
    await mkdir(join(releaseRoot, id, 'packages'), { recursive: true })
    await writeFile(join(releaseRoot, id, 'praesidium-release.json'), '{}')
  }
  const currentLink = join(root, 'hrc-runtime-current')
  await symlink(join(releaseRoot, currentId), currentLink)
  return {
    root,
    releaseRoot,
    currentLink,
    lockDir: join(root, 'hrc-runtime-install.lock'),
    path: (id: string) => join(releaseRoot, id),
    list: async () => (await readdir(releaseRoot)).sort(),
  }
}

const A = 'release-20261001000000000-1'
const B = 'release-20261002000000000-2'
const C = 'release-20261003000000000-3'
const D = 'release-20261004000000000-4'

describe('pruneReleaseDirs', () => {
  it('keeps current and the running release, deletes every other release and gc debris', async () => {
    const f = await fixture([A, B, C], C)
    await mkdir(join(f.releaseRoot, '.gc-quarantine', A), { recursive: true })
    await writeFile(join(f.releaseRoot, 'notes.txt'), 'not a release')

    const result = await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(C),
      keep: [f.path(B)],
    })

    expect(result).toMatchObject({ pruned: true, current: C, failed: [] })
    expect(await f.list()).toEqual([B, C, 'notes.txt'].sort())
  })

  it('keeps only current when nothing else is named', async () => {
    const f = await fixture([A, B, C], C)
    await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(C),
    })
    expect(await f.list()).toEqual([C])
  })

  it('deletes nothing when the current link was never switched to the expected release', async () => {
    // Cutover failed or has not happened: current still names the old release,
    // which may be the one the daemon runs from.
    const f = await fixture([A, B, C], B)
    const result = await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(C),
    })
    expect(result).toEqual({ pruned: false, reason: 'current-link-mismatch' })
    expect(await f.list()).toEqual([A, B, C])
  })

  it('deletes nothing when the current link is missing', async () => {
    const f = await fixture([A, B], B)
    await rm(f.currentLink)
    const result = await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(B),
    })
    expect(result).toEqual({ pruned: false, reason: 'current-link-mismatch' })
    expect(await f.list()).toEqual([A, B])
  })

  it('deletes nothing when current is outside the release root (bootstrap to a checkout)', async () => {
    const f = await fixture([A, B], B)
    const checkout = join(f.root, 'release-checkout')
    await mkdir(checkout)
    await rm(f.currentLink)
    await symlink(checkout, f.currentLink)
    const result = await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: checkout,
    })
    expect(result).toEqual({ pruned: false, reason: 'current-outside-release-root' })
    expect(await f.list()).toEqual([A, B])
  })

  it('deletes nothing while an install holds the lock', async () => {
    const f = await fixture([A, B], B)
    await mkdir(f.lockDir)
    const result = await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(B),
      installLockDir: f.lockDir,
    })
    expect(result).toEqual({ pruned: false, reason: 'install-in-progress' })
    expect(await f.list()).toEqual([A, B])
  })

  it('onlyOlderThanCurrent spares a release an install is still preparing', async () => {
    // The daemon prunes without the install lock; an install that took the
    // lock after the daemon checked it is building a NEWER release id.
    const f = await fixture([A, B, C, D], C)
    await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(C),
      onlyOlderThanCurrent: true,
    })
    expect(await f.list()).toEqual([C, D])
  })

  it('never follows a symlinked entry out of the release root', async () => {
    const f = await fixture([B], B)
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'precious'), 'x')
    await symlink(outside, join(f.releaseRoot, A))
    await pruneReleaseDirs({
      releaseRoot: f.releaseRoot,
      currentLink: f.currentLink,
      expectedCurrent: f.path(B),
    })
    expect(existsSync(join(outside, 'precious'))).toBe(true)
    expect(await f.list()).toEqual([A, B])
  })

  it('resolves a symlinked release root and still keeps current', async () => {
    const f = await fixture([A, B], B)
    const aliasRoot = join(f.root, 'alias-releases')
    await symlink(f.releaseRoot, aliasRoot)
    await pruneReleaseDirs({
      releaseRoot: aliasRoot,
      currentLink: f.currentLink,
      expectedCurrent: join(aliasRoot, B),
      keep: [join(aliasRoot, A)],
    })
    expect(await f.list()).toEqual([A, B])
  })
})
