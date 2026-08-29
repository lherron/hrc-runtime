import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  QUARANTINE_DIRNAME,
  ReleaseGcAbort,
  type ReleaseGcDependencies,
  collectReleaseGc,
  isReleaseId,
} from '../release-gc.js'

const ROOT = '/tmp/rel/hrc-runtime-releases'
const INSTALLED = 'release-20260828220414033-6006'
const RUNNING = 'release-20260828161013364-33848'
const REFERENCED = 'release-20260826075816884-24432'
const OLD = ['release-20260827000000000-1', 'release-20260826000000000-2']

function deps(over: Partial<ReleaseGcDependencies> = {}): ReleaseGcDependencies {
  const renamed: string[] = []
  return {
    listReleaseDirs: () => [INSTALLED, RUNNING, REFERENCED, ...OLD],
    listPids: () => [{ pid: 100, command: `bun /x/hrc-runtime-releases/${REFERENCED}/b.js` }],
    readOpenPaths: () => ({ covered: [100], paths: [], failed: false }),
    readRuntimeRecords: () => [],
    readServerStatus: () => ({ running: true, releasePath: `${ROOT}/${RUNNING}` }),
    readInstalledLink: () => `${ROOT}/${INSTALLED}`,
    isInstallLockHeld: () => false,
    readDiskFree: () => 'disk 91%',
    rename: (from, to) => {
      renamed.push(`${from} -> ${to}`)
    },
    ...over,
  }
}

function keptIds(report: ReturnType<typeof collectReleaseGc>): string[] {
  return report.results.filter((r) => r.disposition === 'keep').map((r) => r.releaseId)
}

describe('T-07683 release gc fences', () => {
  test('installed and running are BOTH kept when they differ (post-install pre-restart window)', () => {
    const report = collectReleaseGc({ keep: 1, releaseRoot: ROOT, deps: deps() })
    expect(report.installed).toBe(INSTALLED)
    expect(report.running).toBe(RUNNING)
    expect(keptIds(report)).toContain(INSTALLED)
    expect(keptIds(report)).toContain(RUNNING)
    const quarantinable = report.results.filter((r) => r.disposition !== 'keep')
    expect(quarantinable.map((r) => r.releaseId)).not.toContain(RUNNING)
  })

  test('a referenced release far outside --keep is kept (the measured rank-47 case)', () => {
    const report = collectReleaseGc({ keep: 1, releaseRoot: ROOT, deps: deps() })
    const referenced = report.results.find((r) => r.releaseId === REFERENCED)
    expect(referenced?.disposition).toBe('keep')
    expect(referenced?.rank).toBeGreaterThan(1)
    expect(referenced?.reasons).toContain('referenced: argv')
  })

  // Each observer alone, with the other two blinded. Necessity is time-varying,
  // so it is pinned by fixture rather than by today's process table.
  test('argv-only reference is kept', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({ readOpenPaths: () => ({ covered: [100], paths: [], failed: false }) }),
    })
    expect(keptIds(report)).toContain(REFERENCED)
  })

  test('open-path-only reference is kept (mapped .node from a release it did not start from)', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({
        listPids: () => [{ pid: 100, command: 'bun /Users/x/.bun/bin/hrc server serve' }],
        readOpenPaths: () => ({
          covered: [100],
          paths: [`/x/hrc-runtime-releases/${REFERENCED}/node_modules/a/clip.node`],
          failed: false,
        }),
      }),
    })
    expect(keptIds(report)).toContain(REFERENCED)
  })

  test('runtime-record-only reference is kept', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({
        listPids: () => [{ pid: 100, command: 'bun /Users/x/.bun/bin/hrc server serve' }],
        readOpenPaths: () => ({ covered: [100], paths: [], failed: false }),
        readRuntimeRecords: () => [`{"cmd":"/x/hrc-runtime-releases/${REFERENCED}/b"}`],
      }),
    })
    expect(keptIds(report)).toContain(REFERENCED)
  })

  test('an uninspected pid running from the release root aborts', () => {
    expect(() =>
      collectReleaseGc({
        keep: 1,
        releaseRoot: ROOT,
        deps: deps({
          listPids: () => [
            { pid: 100, command: `bun /x/hrc-runtime-releases/${REFERENCED}/b.js` },
            { pid: 200, command: `bun /x/hrc-runtime-releases/${OLD[0]}/b.js` },
          ],
          readOpenPaths: () => ({ covered: [100], paths: [], failed: false }),
        }),
      })
    ).toThrow(ReleaseGcAbort)
  })

  test('uninspected pids with no release-root argv are tolerated, not an abort', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({
        listPids: () => [
          { pid: 100, command: `bun /x/hrc-runtime-releases/${REFERENCED}/b.js` },
          { pid: 300, command: '/usr/libexec/secd' },
        ],
        readOpenPaths: () => ({ covered: [100], paths: [], failed: false }),
      }),
    })
    expect(report.omittedPidCount).toBe(1)
  })

  test('total probe failure aborts', () => {
    expect(() =>
      collectReleaseGc({
        keep: 1,
        releaseRoot: ROOT,
        deps: deps({ readOpenPaths: () => ({ covered: [], paths: [], failed: true }) }),
      })
    ).toThrow(ReleaseGcAbort)
  })

  test('unreadable installed link aborts', () => {
    expect(() =>
      collectReleaseGc({
        keep: 1,
        releaseRoot: ROOT,
        deps: deps({
          readInstalledLink: () => {
            throw new ReleaseGcAbort('installed-link-unreadable', 'dangling')
          },
        }),
      })
    ).toThrow(ReleaseGcAbort)
  })

  test('unmanaged daemon proceeds; running fence simply protects nothing', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({ readServerStatus: () => ({ running: true }) }),
    })
    expect(report.running).toBeUndefined()
    expect(keptIds(report)).toContain(INSTALLED)
  })

  test('install lock held refuses', () => {
    expect(() =>
      collectReleaseGc({
        keep: 1,
        releaseRoot: ROOT,
        deps: deps({ isInstallLockHeld: () => true }),
      })
    ).toThrow(ReleaseGcAbort)
  })

  test('non-release entries and .gc-quarantine are neither touched nor counted', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({
        listReleaseDirs: () => [INSTALLED, QUARANTINE_DIRNAME, 'scratch', ...OLD],
      }),
    })
    const ids = report.results.map((r) => r.releaseId)
    expect(ids).not.toContain(QUARANTINE_DIRNAME)
    expect(ids).not.toContain('scratch')
    expect(report.summary.total).toBe(3)
  })

  test('dry-run mutates nothing — asserted on the injected rename, not the report', () => {
    const calls: string[] = []
    collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({ rename: (f, t) => calls.push(`${f}->${t}`) }),
    })
    expect(calls).toEqual([])
  })

  test('--keep >= 1 is enforced', () => {
    expect(() => collectReleaseGc({ keep: 0, releaseRoot: ROOT, deps: deps() })).toThrow(
      ReleaseGcAbort
    )
  })

  test('release id validation rejects non-release names', () => {
    expect(isReleaseId('release-20260828220414033-6006')).toBe(true)
    expect(isReleaseId(QUARANTINE_DIRNAME)).toBe(false)
    expect(isReleaseId('scratch')).toBe(false)
  })
})

// The scope line against T-07686. Structural, not behavioural: a module that
// cannot delete cannot be made to delete by an edit that forgets why.
describe('T-07683 scope boundary — no removal capability', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'release-gc.ts'), 'utf8')

  test('imports no unlinking primitive', () => {
    // Scan the import STATEMENTS, not prose — the file's own header legitimately
    // uses the word "unlinking" to describe the prohibition.
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n')
    expect(imports).toContain('renameSync')
    for (const primitive of ['rmSync', 'rmdirSync', 'unlinkSync', 'rmdir', 'unlink', 'rimraf']) {
      expect(imports).not.toContain(primitive)
    }
  })

  test('exposes no remover in its injected dependency surface', () => {
    const deps = source.slice(
      source.indexOf('export interface ReleaseGcDependencies'),
      source.indexOf('export interface ReleaseGcOptions')
    )
    for (const name of ['remove', 'delete', 'unlink', 'rm']) {
      expect(deps).not.toContain(`${name}?:`)
    }
    expect(deps).toContain('rename?:')
  })

  test('never spawns a deleting command', () => {
    expect(source).not.toContain("'rm'")
    expect(source).not.toContain('rm -rf')
  })
})
