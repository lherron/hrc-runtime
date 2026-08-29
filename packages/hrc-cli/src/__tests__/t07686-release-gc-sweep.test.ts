import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SWEEP_SENTINEL,
  type SweepDependencies,
  collectSweep,
  findLiveOmissions,
  isHrcDaemonArgv,
  isSweepHelperArgv,
} from '../release-gc-sweep.js'
import { ReleaseGcAbort } from '../release-gc.js'

const ROOT = '/tmp/rel/hrc-runtime-releases'
const A = 'release-20260801000000000-1'
const B = 'release-20260802000000000-2'
const LSTART = 'Fri Aug 29 01:00:00 2026'

interface Trace {
  chmods: string[]
  sentinels: string[]
  removed: string[]
}

function deps(over: Partial<SweepDependencies> = {}, trace?: Trace): SweepDependencies {
  return {
    listQuarantined: () => [A, B],
    listPids: () => [{ pid: 100, command: '/usr/sbin/cupsd', lstart: LSTART }],
    probeOpenPaths: () => ({ paths: [], inspectedPids: [100], privileged: true }),
    listServerProcesses: () => [],
    isSocketLive: () => false,
    isInstallLockHeld: () => false,
    statMode: () => ({ mode: 0o700, uid: 501 }),
    listSubtreeDirs: (d) => [d, join(d, 'node_modules'), join(d, 'node_modules', 'deep')],
    chmod: (p) => trace?.chmods.push(p),
    writeSentinel: (d) => trace?.sentinels.push(d),
    remove: (d) => trace?.removed.push(d),
    readDiskFree: () => 'disk 91%',
    ...over,
  }
}

/**
 * Assert the typed refusal REASON, not the message text. The spec requires the
 * reasons be distinguishable to an operator, so the tests hold that contract
 * rather than matching prose that is free to change.
 */
function expectRefusal(fn: () => unknown, reason: string): ReleaseGcAbort {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ReleaseGcAbort)
  const abort = caught as ReleaseGcAbort
  expect(abort.reason).toBe(reason)
  return abort
}

function sweep(over: Partial<SweepDependencies> = {}, apply = true, trace?: Trace) {
  return collectSweep({ apply, releaseRoot: ROOT, deps: deps(over, trace) })
}

describe('T-07686 quiescence gate', () => {
  test('a surviving user-owned daemon refuses daemon-still-up, naming the pid', () => {
    const abort = expectRefusal(
      () =>
        sweep({
          listServerProcesses: () => [{ pid: 4806, command: 'bun /x/.bun/bin/hrc server serve' }],
        }),
      'daemon-still-up'
    )
    expect(abort.message).toContain('4806')
  })

  // The mini case: a second daemon from a worktree, with no launchd job at all.
  test('a worktree-launched second daemon also refuses — the gate is over processes, not job state', () => {
    expect(() =>
      sweep({
        listServerProcesses: () => [
          {
            pid: 83388,
            command: 'bun /x/under-construction/T-07650/packages/hrc-cli/bin/hrc.js server serve',
          },
        ],
      })
    ).toThrow(ReleaseGcAbort)
  })

  test('a live socket refuses even with no ps hit', () => {
    expect(() => sweep({ isSocketLive: () => true })).toThrow(ReleaseGcAbort)
  })

  test('install lock held refuses', () => {
    expectRefusal(() => sweep({ isInstallLockHeld: () => true }), 'install-in-progress')
  })

  test('a permissive release root refuses root-permissive and names the chmod', () => {
    const abort = expectRefusal(
      () => sweep({ statMode: () => ({ mode: 0o755, uid: 501 }) }),
      'root-permissive'
    )
    expect(abort.message).toContain('chmod 700')
  })
})

describe('T-07686 reference matching', () => {
  test('a cwd-only holder refuses — the class ps cannot see', () => {
    expectRefusal(
      () =>
        sweep({
          listPids: () => [{ pid: 200, command: 'sleep 30', lstart: LSTART }],
          probeOpenPaths: () => ({
            paths: [`/x/hrc-runtime-releases/.gc-quarantine/${A}`],
            inspectedPids: [200],
            privileged: true,
          }),
        }),
      'not-quiescent'
    )
  })

  test('argv naming the PRE-quarantine path refuses — argv is fixed at exec, rename does not rewrite it', () => {
    expectRefusal(
      () =>
        sweep({
          listPids: () => [
            { pid: 200, command: `bun /x/hrc-runtime-releases/${A}/b.js`, lstart: LSTART },
          ],
          probeOpenPaths: () => ({ paths: [], inspectedPids: [200], privileged: true }),
        }),
      'not-quiescent'
    )
  })

  test('a process merely MENTIONING the quarantine path does not refuse (no real id)', () => {
    const trace: Trace = { chmods: [], sentinels: [], removed: [] }
    const report = sweep(
      {
        listPids: () => [
          { pid: 200, command: 'grep -r gc-quarantine /Users/x/notes', lstart: LSTART },
        ],
        probeOpenPaths: () => ({ paths: [], inspectedPids: [200], privileged: true }),
      },
      true,
      trace
    )
    expect(report.summary.swept).toBe(2)
  })
})

describe('T-07686 probe completeness', () => {
  test('an unprivileged probe refuses probe-unprivileged, distinctly from probe-failed', () => {
    expectRefusal(
      () =>
        sweep({ probeOpenPaths: () => ({ paths: [], inspectedPids: [100], privileged: false }) }),
      'probe-unprivileged'
    )
  })

  test('an exit-0 probe that omitted a live pid contradicts itself and refuses probe-incomplete', () => {
    expectRefusal(
      () =>
        sweep({
          listPids: () => [
            { pid: 100, command: '/usr/sbin/cupsd', lstart: LSTART },
            { pid: 300, command: '/usr/libexec/secd', lstart: LSTART },
          ],
          probeOpenPaths: () => ({ paths: [], inspectedPids: [100], privileged: true }),
        }),
      'probe-incomplete'
    )
  })
})

describe('T-07686 bracketed scan', () => {
  test('process churn between passes refuses scan-incoherent', () => {
    let call = 0
    expectRefusal(
      () =>
        sweep({
          listPids: () => {
            call += 1
            // a new pid appears by the closing snapshot of every attempt
            return call % 3 === 0
              ? [
                  { pid: 100, command: '/usr/sbin/cupsd', lstart: LSTART },
                  { pid: 999, command: 'git fetch', lstart: LSTART },
                ]
              : [{ pid: 100, command: '/usr/sbin/cupsd', lstart: LSTART }]
          },
        }),
      'scan-incoherent'
    )
  })

  test('a REUSED pid is churn, not the same process — lstart is the incarnation key', () => {
    let call = 0
    expectRefusal(
      () =>
        sweep({
          listPids: () => {
            call += 1
            return [
              {
                pid: 100,
                command: '/usr/sbin/cupsd',
                lstart: call % 3 === 0 ? 'Fri Aug 29 02:00:00 2026' : LSTART,
              },
            ]
          },
        }),
      'scan-incoherent'
    )
  })

  test('a stable incarnation set across the bracket proceeds', () => {
    expect(sweep().summary.swept).toBe(2)
  })
})

describe('T-07686 no refusal path mutates state', () => {
  // The rev-8 defect: tightening ran before the probe, so a refusal still caused
  // a persistent, restart-unrecoverable EACCES. A safety refusal that harms
  // inverts the point of the gate.
  const refusals: [string, Partial<SweepDependencies>][] = [
    ['daemon-still-up', { listServerProcesses: () => [{ pid: 1, command: 'hrc server serve' }] }],
    ['root-permissive', { statMode: () => ({ mode: 0o755, uid: 501 }) }],
    ['install-in-progress', { isInstallLockHeld: () => true }],
    [
      'probe-unprivileged',
      { probeOpenPaths: () => ({ paths: [], inspectedPids: [100], privileged: false }) },
    ],
    [
      'not-quiescent',
      {
        probeOpenPaths: () => ({
          paths: [`/x/.gc-quarantine/${A}/lib`],
          inspectedPids: [100],
          privileged: true,
        }),
      },
    ],
  ]

  for (const [reason, over] of refusals) {
    test(`${reason} leaves modes, sentinels and files bit-for-bit unmodified`, () => {
      const trace: Trace = { chmods: [], sentinels: [], removed: [] }
      expect(() => sweep(over, true, trace)).toThrow(ReleaseGcAbort)
      expect(trace.chmods).toEqual([])
      expect(trace.sentinels).toEqual([])
      expect(trace.removed).toEqual([])
    })
  }
})

describe('T-07686 per-candidate mutation order', () => {
  test('sentinel precedes the mode change, which precedes the unlink', () => {
    const order: string[] = []
    const report = collectSweep({
      apply: true,
      releaseRoot: ROOT,
      deps: deps({
        writeSentinel: (d) => order.push(`sentinel:${d}`),
        chmod: (p) => order.push(`chmod:${p}`),
        remove: (d) => order.push(`remove:${d}`),
      }),
    })
    expect(report.summary.swept).toBe(2)
    const first = order.filter((o) => o.includes(A))
    expect(first[0]).toStartWith('sentinel:')
    expect(first[first.length - 1]).toStartWith('remove:')
    expect(first.some((o) => o.startsWith('chmod:'))).toBe(true)
    // and the sentinel for A lands before ANY chmod for A
    expect(order.indexOf(`sentinel:${join(ROOT, '.gc-quarantine', A)}`)).toBeLessThan(
      order.findIndex((o) => o.startsWith('chmod:') && o.includes(A))
    )
  })

  test('the tightening is RECURSIVE — every directory at depth, not just the release root', () => {
    const trace: Trace = { chmods: [], sentinels: [], removed: [] }
    sweep({}, true, trace)
    const forA = trace.chmods.filter((p) => p.includes(A))
    expect(forA.length).toBe(3)
    expect(forA.some((p) => p.endsWith('node_modules/deep'))).toBe(true)
  })

  test('dry-run mutates nothing — asserted on the injected effects, not the report', () => {
    const trace: Trace = { chmods: [], sentinels: [], removed: [] }
    const report = sweep({}, false, trace)
    expect(report.summary.wouldSweep).toBe(2)
    expect(trace.removed).toEqual([])
    expect(trace.chmods).toEqual([])
    expect(trace.sentinels).toEqual([])
  })

  test('a daemon appearing mid-loop stops the remainder as daemon-resurrected', () => {
    const trace: Trace = { chmods: [], sentinels: [], removed: [] }
    let calls = 0
    const report = collectSweep({
      apply: true,
      releaseRoot: ROOT,
      deps: deps(
        {
          listServerProcesses: () => {
            calls += 1
            return calls > 2 ? [{ pid: 7, command: 'bun hrc server serve' }] : []
          },
        },
        trace
      ),
    })
    expect(report.results.some((r) => r.reason?.includes('daemon-resurrected'))).toBe(true)
    expect(trace.removed.length).toBeLessThan(2)
  })

  test('only well-formed release ids under the quarantine are candidates', () => {
    const report = sweep({ listQuarantined: () => [A, 'scratch', 'not-a-release'] }, false)
    expect(report.candidates).toEqual([A])
  })
})

// Structural. A module that can delete must be the only one, and the ordering
// properties above must not be refactorable away without a test noticing.
describe('T-07686 scope boundary — exactly one remover', () => {
  const sweepSrc = readFileSync(join(import.meta.dir, '..', 'release-gc-sweep.ts'), 'utf8')
  const gcSrc = readFileSync(join(import.meta.dir, '..', 'release-gc.ts'), 'utf8')

  test('phase 1 still imports no unlinking primitive', () => {
    const imports = gcSrc
      .split('\n')
      .filter((l) => l.startsWith('import '))
      .join('\n')
    for (const p of ['rmSync', 'rmdirSync', 'unlinkSync', 'rimraf']) {
      expect(imports).not.toContain(p)
    }
  })

  test('the sweep declares its probe buffer, sentinel and status allowlist', () => {
    expect(sweepSrc).toContain('PROBE_MAX_BUFFER')
    expect(sweepSrc).toContain('maxBuffer: PROBE_MAX_BUFFER')
    expect(sweepSrc).toContain('__PROBE_COMPLETE')
    // signal deaths must be rejected: the measured __PROBE_COMPLETE:143 case
    expect(sweepSrc).toContain('status >= 128')
  })

  test('both cmdServerStart branches consult the maintenance lock', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'cli', 'handlers-server.ts'), 'utf8')
    const start = server.slice(
      server.indexOf('export async function cmdServerStart'),
      server.indexOf('export async function cmdServerRestart')
    )
    // launchd-owner branch, daemon branch, foreground branch
    expect(start.split('assertNoMaintenanceSweep()').length - 1).toBeGreaterThanOrEqual(3)
  })

  test('the sentinel constant is exported so --restore can refuse on it', () => {
    expect(SWEEP_SENTINEL).toBe('.sweep-in-progress')
  })
})

// Real argv strings captured from max3 and mini on 2026-08-29. `server serve` is
// a shared verb across four different daemons on this fleet, so the discriminator
// is pinned against the actual population rather than a hand-written sample —
// the first live dry-run refused on `taskboard server serve`, which every unit
// test had missed.
describe('T-07686 daemon discriminator, pinned to real fleet argv', () => {
  const MUST_MATCH = [
    'bun /Users/lherron/.bun/bin/hrc server serve',
    'bun /Users/lab/.bun/bin/hrc server serve',
    'bun /Users/lherron/.bun/bin/hrc-dev server serve',
    'bun /Users/lherron/praesidium/hrc-runtime/packages/hrc-cli/bin/hrc.js server serve',
    'bun /Users/lab/praesidium/under-construction/T-07650/packages/hrc-cli/bin/hrc.js server serve',
  ]
  const MUST_NOT_MATCH = [
    'bun /Users/lherron/.bun/bin/taskboard server serve --dev',
    'bun /Users/lherron/.bun/bin/acp server serve',
    'grep -r "server serve" /Users/lherron/notes',
  ]

  for (const command of MUST_MATCH) {
    test(`matches: ${command.slice(0, 60)}`, () => {
      expect(isHrcDaemonArgv({ pid: 1, command })).not.toBeNull()
    })
  }
  for (const command of MUST_NOT_MATCH) {
    test(`does NOT match: ${command.slice(0, 60)}`, () => {
      expect(isHrcDaemonArgv({ pid: 1, command })).toBeNull()
    })
  }
})

// Both defects below aborted a real max3 maintenance window on 2026-08-29 at the
// dry-run step. Neither was visible to any fixture written before the live run.
describe('T-07686 probe-incomplete must not fire on transients (live window abort)', () => {
  const MARKER = 'hrc-sweep-marker-999-'

  test('a pid that EXITED between snapshot and scan is GONE, not an omission', () => {
    const snapshot = [
      { pid: 30396, command: '/System/.../mdworker_shared -s mdworker' },
      { pid: 100, command: '/usr/sbin/cupsd' },
    ]
    // mdworker is uninspected AND no longer alive at the re-check
    const omitted = findLiveOmissions(snapshot, [100], [100], [], MARKER)
    expect(omitted).toEqual([])
  })

  test('a pid still ALIVE at the re-check and uninspected IS an omission', () => {
    const snapshot = [{ pid: 555, command: '/usr/libexec/somethingd' }]
    const omitted = findLiveOmissions(snapshot, [], [555], [], MARKER)
    expect(omitted.map((o) => o.pid)).toEqual([555])
  })

  test("the probe's OWN ps helper is excluded by identity, not by luck", () => {
    const helper = 'sh -c ps -Axo pid=,lstart=,command=; echo "__PROBE_COMPLETE:$?"'
    expect(isSweepHelperArgv(helper, MARKER)).toBe(true)
    // even while alive and uninspected, it must not count
    const omitted = findLiveOmissions([{ pid: 29734, command: helper }], [], [29734], [], MARKER)
    expect(omitted).toEqual([])
  })

  test('the marker child is excluded by identity', () => {
    const child = `sh -c exec 9<'/tmp/${MARKER}17'; sleep 30`
    expect(isSweepHelperArgv(child, MARKER)).toBe(true)
  })

  test('the sweep process itself and its parent are excluded', () => {
    const omitted = findLiveOmissions(
      [{ pid: 42, command: 'bun hrc admin release sweep' }],
      [],
      [42],
      [42],
      MARKER
    )
    expect(omitted).toEqual([])
  })
})

describe('T-07686 daemon matcher anchors on the binary token (live window abort)', () => {
  // The operator's own zsh, running a heredoc that quoted the command text, was
  // reported as a surviving daemon. Substring matching hits any process whose
  // command line merely CONTAINS the words.
  const SHELLS_THAT_MUST_NOT_MATCH = [
    '/bin/zsh -c launchctl bootout gui/501/com.praesidium.hrc-dev # hrc-dev server serve',
    '/bin/zsh -lc "echo running hrc server serve now"',
    'bun /Users/lherron/.bun/bin/taskboard server serve --dev',
    'bun /Users/lherron/.bun/bin/acp server serve',
  ]
  for (const command of SHELLS_THAT_MUST_NOT_MATCH) {
    test(`does NOT match: ${command.slice(0, 62)}`, () => {
      expect(isHrcDaemonArgv({ pid: 1, command })).toBeNull()
    })
  }

  test('still matches every real daemon shape', () => {
    for (const command of [
      'bun /Users/lherron/.bun/bin/hrc server serve',
      'bun /Users/lherron/.bun/bin/hrc-dev server serve',
      'bun /Users/lab/praesidium/under-construction/T-07650/packages/hrc-cli/bin/hrc.js server serve',
    ]) {
      expect(isHrcDaemonArgv({ pid: 1, command })).not.toBeNull()
    }
  })
})
