import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HolderEnumerationAbortedError,
  LSOF_HELD_UNIX_SOCKET_ARGV,
  parseLsofUnixSocketPaths,
  sweepOrphanedRendererControlSockets,
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

describe('sweepOrphanedRendererControlSockets — deterministic holder semantics (T-07740)', () => {
  const roots: string[] = []
  const servers: Server[] = []

  async function makeRoot(): Promise<{ runtimeRoot: string; btmuxDir: string }> {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'hbo-det-'))
    roots.push(runtimeRoot)
    const btmuxDir = join(runtimeRoot, 'btmux')
    await mkdir(btmuxDir, { recursive: true })
    return { runtimeRoot, btmuxDir }
  }

  // The listener stays open purely so the socket INODE exists for stat()/
  // isSocket(); node unlinks the path on close, which would delete the fixture.
  // Real holder state is irrelevant here — every test injects the enumerator,
  // which is the entire point of this suite.
  async function candidate(btmuxDir: string, name = 'orphan'): Promise<string> {
    const socketPath = join(btmuxDir, `codex-app-server-renderer-control.${name}.sock`)
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    servers.push(server)
    return socketPath
  }

  afterAll(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })

  it('preserves a held socket and never stats it for age', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const socketPath = await candidate(btmuxDir)

    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => new Set([socketPath]),
    })

    expect(result).toMatchObject({ scanned: 1, skippedHeld: 1, removed: 0, errors: 0 })
    expect(result.holderEnumerationOutcome).toBe('ok')
    expect(existsSync(socketPath)).toBe(true)
  })

  it('removes an unheld socket past grace', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const socketPath = await candidate(btmuxDir)

    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => new Set<string>(),
    })

    expect(result).toMatchObject({ scanned: 1, removed: 1, skippedHeld: 0, errors: 0 })
    expect(existsSync(socketPath)).toBe(false)
  })

  it('preserves an unheld socket still within grace', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const socketPath = await candidate(btmuxDir)

    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 10 * 60 * 1000,
      emitSummary: false,
      enumerateHeldPaths: async () => new Set<string>(),
    })

    expect(result).toMatchObject({ scanned: 1, skippedWithinGrace: 1, removed: 0 })
    expect(existsSync(socketPath)).toBe(true)
  })

  it('preserves EVERY candidate when holder discovery fails, and says why', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const a = await candidate(btmuxDir, 'a')
    const b = await candidate(btmuxDir, 'b')

    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => {
        throw new Error("lsof: WARNING: can't stat() smbfs file system /Volumes/...")
      },
    })

    // Holder state is mandatory evidence for removal; without it, nothing goes.
    expect(result).toMatchObject({ scanned: 2, removed: 0, errors: 2 })
    expect(result.holderEnumerationOutcome).toBe('failed')
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(true)
  })

  it('reports an aborted enumeration as aborted, not as whatever stderr said', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const socketPath = await candidate(btmuxDir)

    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => {
        throw new HolderEnumerationAbortedError(5_000)
      },
    })

    // The distinction the original defect erased: a killed lsof exits non-zero
    // carrying a benign mount warning on stderr, which reads as a cause and is
    // not one.
    expect(result.holderEnumerationOutcome).toBe('aborted')
    expect(result).toMatchObject({ removed: 0, errors: 1 })
    expect(existsSync(socketPath)).toBe(true)
  })

  it('treats a differently-spelled held path as held rather than deleting it', async () => {
    // The enumerator reports the path a process actually bound; the sweep
    // composes its own from runtimeRoot. A symlinked runtime root makes those
    // two strings differ for the same inode — the general form of the macOS
    // /tmp vs /private/tmp split. String equality misses, and a miss past grace
    // DELETES a live socket, so the matcher must resolve before concluding.
    const realRoot = await mkdtemp(join(tmpdir(), 'hbo-real-'))
    roots.push(realRoot)
    const linkRoot = `${realRoot}-link`
    await symlink(realRoot, linkRoot)
    roots.push(linkRoot)

    const btmuxDir = join(realRoot, 'btmux')
    await mkdir(btmuxDir, { recursive: true })
    const boundPath = await candidate(btmuxDir)

    const result = await sweepOrphanedRendererControlSockets(linkRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => new Set([boundPath]),
    })

    expect(result).toMatchObject({ scanned: 1, skippedHeld: 1, removed: 0 })
    expect(existsSync(boundPath)).toBe(true)
  })

  it('still deletes a genuinely unheld socket (the fail-safe is not a blanket refusal)', async () => {
    const { runtimeRoot, btmuxDir } = await makeRoot()
    const socketPath = await candidate(btmuxDir)

    // An enumerator that reports an unrelated holder set: the candidate resolves
    // fine and is genuinely unheld, so it goes. This pins that the fail-safe in
    // isHeld() does not degrade into "never delete anything".
    const result = await sweepOrphanedRendererControlSockets(runtimeRoot, {
      graceMs: 0,
      emitSummary: false,
      enumerateHeldPaths: async () => new Set([join(btmuxDir, 'someone-else.sock')]),
    })

    expect(result).toMatchObject({ removed: 1 })
    expect(existsSync(socketPath)).toBe(false)
  })
})
