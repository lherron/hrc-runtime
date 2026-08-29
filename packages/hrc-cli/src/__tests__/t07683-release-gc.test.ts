import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  QUARANTINE_DIRNAME,
  ReleaseGcAbort,
  type ReleaseGcDependencies,
  collectReleaseGc,
  isReleaseId,
  matchReleaseIdsUnderRoot,
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
    listPids: () => [{ pid: 100, command: `bun ${ROOT}/${REFERENCED}/b.js` }],
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
          paths: [`${ROOT}/${REFERENCED}/node_modules/a/clip.node`],
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
        readRuntimeRecords: () => [`{"cmd":"${ROOT}/${REFERENCED}/b"}`],
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
            { pid: 100, command: `bun ${ROOT}/${REFERENCED}/b.js` },
            { pid: 200, command: `bun ${ROOT}/${OLD[0]}/b.js` },
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
          { pid: 100, command: `bun ${ROOT}/${REFERENCED}/b.js` },
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

// Pins a defect the live run caught and no behavioural test can see without
// spawning megabytes: the probe emitted 2,854,925 bytes, spawnSync's 1MB default
// silently returned 1,572,702, and coverage collapsed from ~1160 pids to 715.
// Under-observation reads a referenced release as unreferenced, so it is unsafe.
describe('T-07683 probe must not silently under-observe', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'release-gc.ts'), 'utf8')

  test('spawns probes with an explicit maxBuffer, never the 1MB default', () => {
    expect(source).toContain('PROBE_MAX_BUFFER')
    expect(source).toContain('maxBuffer: PROBE_MAX_BUFFER')
    const budget = source.match(/const PROBE_MAX_BUFFER = (\d+) \* 1024 \* 1024/)
    expect(budget).not.toBeNull()
    expect(Number.parseInt(budget?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(16)
  })

  test('treats a truncated probe as failure, not as a short valid reading', () => {
    expect(source).toContain("=== 'ENOBUFS'")
    expect(source).toContain('was truncated')
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

// Real argv captured from mini 2026-08-29, where BOTH principals were permanently
// un-gc-able: lherron's gc refused on lab's broker and lab's refused on
// lherron's. The matcher keyed on the bare `hrc-runtime-releases/` segment,
// which every principal on a shared node has.
describe('T-07686 gc evidence is anchored to the CALLER release root', () => {
  const LHERRON_ROOT = '/Users/lherron/.bun/install/hrc-runtime-releases'
  const LAB_ROOT = '/Users/lab/.bun/install/hrc-runtime-releases'
  const LHERRON_ID = 'release-20260828001459971-3051'
  const LAB_ID = 'release-20260828010227066-27611'
  const LAB_BROKER = `/opt/homebrew/bin/tmux -S /Users/lab/praesidium/var/run/hrc/btmux/x.sock new-session -d exec '${LAB_ROOT}/${LAB_ID}/node_modules/.bin/harness-broker' run`
  const LHERRON_BROKER = `/opt/homebrew/bin/tmux -S /Users/lherron/praesidium/var/run/hrc/btmux/y.sock new-session -d exec '${LHERRON_ROOT}/${LHERRON_ID}/node_modules/.bin/harness-broker' run`

  test("lab's broker is not evidence against lherron's root", () => {
    expect(matchReleaseIdsUnderRoot(LAB_BROKER, new Set([LAB_ID]), LHERRON_ROOT)).toEqual([])
  })

  test("lherron's broker is not evidence against lab's root", () => {
    expect(matchReleaseIdsUnderRoot(LHERRON_BROKER, new Set([LHERRON_ID]), LAB_ROOT)).toEqual([])
  })

  test('a holder under MY root is still caught', () => {
    expect(matchReleaseIdsUnderRoot(LHERRON_BROKER, new Set([LHERRON_ID]), LHERRON_ROOT)).toEqual([
      LHERRON_ID,
    ])
  })

  test('the PRE-quarantine argv path under my root is still caught (T-07686 §6.1)', () => {
    const argv = `bun ${LHERRON_ROOT}/${LHERRON_ID}/packages/hrc-cli/bin/hrc.js server serve`
    expect(matchReleaseIdsUnderRoot(argv, new Set([LHERRON_ID]), LHERRON_ROOT)).toEqual([
      LHERRON_ID,
    ])
  })

  test('the quarantined path under my root is caught too', () => {
    const argv = `bun ${LHERRON_ROOT}/.gc-quarantine/${LHERRON_ID}/x.js`
    expect(matchReleaseIdsUnderRoot(argv, new Set([LHERRON_ID]), LHERRON_ROOT)).toEqual([
      LHERRON_ID,
    ])
  })

  test('an uninspectable FOREIGN-root pid no longer aborts the gc', () => {
    const report = collectReleaseGc({
      keep: 1,
      releaseRoot: ROOT,
      deps: deps({
        listPids: () => [
          { pid: 100, command: `bun ${ROOT}/${REFERENCED}/b.js` },
          // lab's broker: foreign root, uninspectable by construction
          { pid: 29104, command: LAB_BROKER },
        ],
        readOpenPaths: () => ({ covered: [100], paths: [], failed: false }),
      }),
    })
    expect(report.omittedPidCount).toBe(1)
    expect(report.summary.total).toBeGreaterThan(0)
  })
})
