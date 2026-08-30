import { describe, expect, it } from 'bun:test'

import { lsofOpenPathsArgv, parseLsofOpenPaths } from '../release-gc'

describe('release-gc open-paths probe (T-07740)', () => {
  it('passes -b so a stalled network mount cannot wedge a synchronous probe', () => {
    // Without -b, lsof makes blocking stat() calls on every mount before it
    // answers. This probe is spawnSync: a stall here blocks the whole GC.
    expect(lsofOpenPathsArgv([1, 2])).toContain('-b')
  })

  it('stays pid-scoped, because -b silently returns nothing for path arguments', () => {
    // The coupling is load-bearing. -b forbids the stat() lsof needs to resolve
    // a path argument to a dev/inode, so a path-scoped probe under -b reports
    // no open files at all — and "no open files" here reads as "unreferenced",
    // which deletes a release a live process is running from.
    const argv = lsofOpenPathsArgv([100, 200])
    expect(argv).toContain('-p')
    expect(argv.at(-1)).toBe('100,200')
    expect(argv).not.toContain('+D')
  })

  it('reads absolute names as paths and ignores lsof non-path n fields', () => {
    // Observed verbatim from `lsof -Fpn` on a socket fd; the old parser took
    // every line starting with "n" and fed "count=3, state=0x10" to the
    // release-id matcher as though it were an open path.
    const { covered, paths } = parseLsofOpenPaths(
      ['p123', 'fcwd', 'n/opt/releases/release-a/bin', 'f5', 'ncount=3, state=0x10', ''].join('\n')
    )

    expect(covered).toEqual([123])
    expect(paths).toEqual(['/opt/releases/release-a/bin'])
  })

  it('collects every covered pid so partial coverage is distinguishable from silence', () => {
    const { covered } = parseLsofOpenPaths(['p1', 'n/a', 'p2', 'n/b'].join('\n'))
    expect(covered).toEqual([1, 2])
  })
})
