import { describe, expect, it } from 'bun:test'

import {
  LSOF_HELD_UNIX_SOCKET_ARGV,
  parseLsofUnixSocketPaths,
} from '../startup-reconcile/lease-identity'

describe('parseLsofUnixSocketPaths', () => {
  it.each([
    ['macOS', 'n/tmp/codex-app-server-renderer-control.test.sock'],
    ['Linux', 'n/tmp/codex-app-server-renderer-control.test.sock type=STREAM'],
  ])('parses the %s lsof NAME field shape', (_platform, nameField) => {
    const paths = parseLsofUnixSocketPaths(`p123\nf4\n${nameField}\n`)

    expect(paths).toEqual(new Set(['/tmp/codex-app-server-renderer-control.test.sock']))
  })
})

describe('LSOF_HELD_UNIX_SOCKET_ARGV (T-07740)', () => {
  it('passes -b so a stalled network mount cannot outlive the abort budget', () => {
    // Without -b, lsof blocking-stat()s every mount before answering. A process
    // stuck in that call on a degraded network mount cannot be killed until the
    // call returns, so AbortSignal.timeout() cannot bound the enumeration:
    // 18339ms and 8397ms were observed against a 5s budget.
    expect(LSOF_HELD_UNIX_SOCKET_ARGV).toContain('-b')
  })

  it('enumerates system-wide with -U rather than per-socket arguments', () => {
    // -b is INCOMPATIBLE with per-file arguments: it forbids the stat() lsof
    // needs to resolve a path to a dev/inode, so `lsof -b -Fn -- <path>` reports
    // nothing held, silently, with exit 0. Since unheld + past grace means
    // delete, narrowing this call to specific paths while -b is present would
    // remove live sockets. The two are a package deal.
    expect(LSOF_HELD_UNIX_SOCKET_ARGV).toContain('-U')
    expect(LSOF_HELD_UNIX_SOCKET_ARGV).toEqual(['lsof', '-b', '-w', '-U', '-Fn'])
  })
})
