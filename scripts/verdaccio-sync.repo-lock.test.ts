import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'lib', 'verdaccio-sync.ts'), 'utf8')

// 2026-08-29: under the praesidium dev workspace `resolveInstallRoot` names
// ~/praesidium, whose bun.lock resolves agent-spaces to `workspace:`. The sync
// read THAT lock, judged every package "source-linked; not registry-managed", and
// `just pull-deps` exited 0 having advanced nothing — while `just install` built
// the release from hrc-runtime/bun.lock, still on the old tuple. The lock a
// release ships is this repo's, so every lock read/write must target REPO_ROOT;
// only node_modules probes may follow the workspace.
describe('verdaccio sync targets the repo lockfile', () => {
  test('lock reads default to REPO_LOCK, never the install root', () => {
    expect(source).toContain("const REPO_LOCK = join(REPO_ROOT, 'bun.lock')")
    expect(source).not.toMatch(/join\(ROOT, 'bun\.lock'\)/)
    expect(source).toMatch(/lockfileVersions\(lockPath = REPO_LOCK\)/)
  })

  test('manifest discovery walks the repo, not the install root', () => {
    expect(source).not.toMatch(/discover\(ROOT\)/)
    expect(source.match(/discover\(REPO_ROOT\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('the lock is advanced lockfile-only in a staging copy and copied back', () => {
    const advance = source.slice(
      source.indexOf('async function advanceRepoLockfile'),
      source.indexOf('function relativeTo')
    )
    expect(advance).toContain("'--lockfile-only'")
    expect(advance).toContain("copyFile(join(staging, 'bun.lock'), REPO_LOCK)")
    // The repo's tracked manifests are never pinned, even transiently.
    expect(advance).not.toContain('rewriteManifests(discover')
  })

  test('a pull that leaves the lock behind latest throws instead of exiting 0', () => {
    const sync = source.slice(source.indexOf('export async function syncFromVerdaccio'))
    expect(sync).toContain('sync did not advance')
    expect(sync).toContain('await assertLockCoherent(spec.groups)')
  })

  test("git runs in the repo, so the lock commit is this repo's history", () => {
    expect(source).toMatch(/function run\(cmd: string, args: string\[\], cwd = REPO_ROOT\)/)
  })
})
