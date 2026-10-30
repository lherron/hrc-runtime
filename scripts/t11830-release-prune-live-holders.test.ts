/**
 * T-11830 — a daemon's startup release prune must never delete a release that
 * a live process on this host was started from or holds open.
 *
 * Workflow-level, on fully scratch roots including a scratch releases root:
 * every release is a real tree cloned from this checkout, every holder is a
 * real process, and the prune under test is the one daemon B runs at startup.
 * Never ~/.bun/install/hrc-runtime-releases, never the live daemon.
 *
 *   R1        daemon A serves runtime root X from it      -> kept
 *   R_UNREF   nothing references it                      -> removed (control)
 *   R_NATIVE  a native holder executes R_NATIVE/bin/rusthrc   -> kept
 *   R_HELPER  a process was started as `bun R_HELPER/…`   -> kept
 *   R2        current; daemon B starts from it at root Y  -> kept (current)
 *
 * The native holder and daemon A start through the current link, as production does
 * (`bun ~/.bun/bin/hrc server serve`), so neither argv names its release: the
 * native holder is visible only by its executable image, A only by what it holds open.
 *
 * The 2026-10-26 incident is R1: B, a scratch daemon on another root, deleted
 * the release max3's production daemon (A) was running from. Once every holder
 * exits, a fresh daemon from current removes all of them (second phase).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CHECKOUT = join(import.meta.dir, '..')

// R1 sorts first: daemon A prunes at its own startup too, and only ids older
// than its current go, so A must leave the rest of the fixture alone.
const R1 = 'release-20261020000000000-1'
const R_UNREF = 'release-20261021000000000-2'
const R_NATIVE = 'release-20261022000000000-3'
const R_HELPER = 'release-20261023000000000-4'
const R2 = 'release-20261024000000000-5'

/** Identity keys stripped from every spawned process: a daemon gets only what the test gives it. */
const IDENTITY_KEY = /^(HRC_|ASP_|AGENT_|WRKQ_|CLAUDE|CODEX_)/

type Proc = { pid: number; kill: () => Promise<void> }

const roots: string[] = []
const procs: Proc[] = []

afterEach(async () => {
  for (const proc of procs.splice(0)) await proc.kill()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function run(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${exitCode}: ${stderr}`)
}

function manifest(releaseId: string): string {
  return `${JSON.stringify(
    {
      schema: 1,
      releaseId,
      hrcBuild: {
        schema: 1,
        repository: 'hrc-runtime',
        canonicalRemote: 'ssh://example.test/hrc-runtime.git',
        sourceCommit: '1111111111111111111111111111111111111111',
        setName: 'hrc',
        setVersion: '0.5.13-dev.t11830',
        builtAt: '2026-10-26T00:00:00.000Z',
      },
      aspContracts: [{ name: 'agent-scope', version: '0.1.1-dev.t11830' }],
      installedAt: '2026-10-26T00:00:00.000Z',
    },
    null,
    2
  )}\n`
}

/** A real release tree: this checkout's packages and dependencies, cloned (APFS) not linked. */
async function makeRelease(releaseRoot: string, releaseId: string): Promise<string> {
  const release = join(releaseRoot, releaseId)
  await mkdir(join(release, 'bin'), { recursive: true })
  await run(['cp', '-cR', join(CHECKOUT, 'packages'), join(release, 'packages')])
  await run(['cp', '-cR', join(CHECKOUT, 'node_modules'), join(release, 'node_modules')])
  await writeFile(join(release, 'praesidium-release.json'), manifest(releaseId))
  return release
}

async function setCurrent(installRoot: string, releaseId: string): Promise<void> {
  const link = join(installRoot, 'hrc-runtime-current')
  await rm(link, { force: true })
  await symlink(join(installRoot, 'hrc-runtime-releases', releaseId), link)
}

function daemonEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !IDENTITY_KEY.test(key)) env[key] = value
  }
  return {
    ...env,
    HRC_RUNTIME_DIR: join(root, 'run'),
    HRC_STATE_DIR: join(root, 'state'),
    HRC_LAUNCHD_LABEL: `com.praesidium.hrc-t11830-${root.split('/').pop()}-scratch`,
    HRC_SHADOW_TEARDOWN_ENABLED: '0',
    HRC_WRKQ_DB: process.env['HRC_WRKQ_DB'] ?? 'rpc://127.0.0.1:1',
  }
}

function track(child: ReturnType<typeof Bun.spawn>): Proc {
  const proc = {
    pid: child.pid,
    kill: async () => {
      child.kill('SIGKILL')
      await child.exited
    },
  }
  procs.push(proc)
  return proc
}

type Daemon = Proc & { log: string }

/** `hrc server serve` from `tree`: a release path, or the current link as production starts it. */
async function startDaemon(tree: string, root: string): Promise<Daemon> {
  await mkdir(join(root, 'run'), { recursive: true })
  await mkdir(join(root, 'state'), { recursive: true })
  await writeFile(
    join(root, 'state', 'federation.json'),
    JSON.stringify({ nodeId: `t11830-${root.split('/').pop()}` }),
    { mode: 0o600 }
  )
  const log = join(root, 'daemon.log')
  const out = openSync(log, 'a')
  const child = Bun.spawn(
    [process.execPath, join(tree, 'packages', 'hrc-cli', 'src', 'cli.ts'), 'server', 'serve'],
    { cwd: root, env: daemonEnv(root), stdout: out, stderr: out, stdin: 'ignore' }
  )
  const daemon = { ...track(child), log }
  await waitForEvent(daemon, 'server.start.ready')
  return daemon
}

function events(daemon: Daemon, event: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  for (const raw of readFileSync(daemon.log, 'utf8').split('\n')) {
    if (!raw.startsWith('{')) continue
    try {
      const line = JSON.parse(raw) as { event?: unknown; data?: Record<string, unknown> }
      if (line.event === event) found.push(line.data ?? {})
    } catch {}
  }
  return found
}

async function waitForEvent(daemon: Daemon, event: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [first] = events(daemon, event)
    if (first !== undefined) return first
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${event}:\n${readFileSync(daemon.log, 'utf8')}`)
}

/** The prune line, failure line included, so a refused prune fails the assertion with its reason. */
async function waitForPrune(daemon: Daemon): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [line] = [
      ...events(daemon, 'server.start.release_prune'),
      ...events(daemon, 'server.start.release_prune_failed'),
    ]
    if (line !== undefined) return line
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for the startup prune:\n${readFileSync(daemon.log, 'utf8')}`)
}

/** A stand-in native holder: a real process whose executable image is the release's bin/rusthrc. */
async function startNative(release: string, currentLink: string): Promise<Proc> {
  await run(['cp', '-c', process.execPath, join(release, 'bin', 'rusthrc')])
  const child = Bun.spawn(
    [join(currentLink, 'bin', 'rusthrc'), '-e', 'console.log("ready"); setInterval(() => {}, 1e9)'],
    {
      stdout: 'pipe',
      stderr: 'ignore',
    }
  )
  await readyLine(child)
  return track(child)
}

/** A helper process started from a script in the release (argv names it; it holds nothing open). */
async function startHelper(release: string): Promise<Proc> {
  const script = join(release, 'packages', 'hrc-server', 't11830-helper.ts')
  await writeFile(script, 'console.log("ready")\nsetInterval(() => {}, 1e9)\n')
  const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'ignore' })
  await readyLine(child)
  return track(child)
}

async function readyLine(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(value).includes('ready')) throw new Error('holder did not start')
}

describe('T-11830 startup release prune vs live holders', () => {
  it('keeps every release a live process runs from; removes them once the holders exit', async () => {
    const scratch = await mkdtemp('/tmp/hrc-t11830-')
    roots.push(scratch)
    const installRoot = join(scratch, 'install')
    const releaseRoot = join(installRoot, 'hrc-runtime-releases')
    const release: Record<string, string> = {}
    for (const id of [R1, R_UNREF, R_NATIVE, R_HELPER, R2]) {
      release[id] = await makeRelease(releaseRoot, id)
    }
    const list = async () => (await readdir(releaseRoot)).sort()

    const currentLink = join(installRoot, 'hrc-runtime-current')
    // Each holder starts while its release is current. Daemon A runs from R1
    // at runtime root X, launched through the current link.
    await setCurrent(installRoot, R1)
    const daemonA = await startDaemon(currentLink, join(scratch, 'X'))
    expect(await waitForPrune(daemonA)).toMatchObject({ removed: [] })
    await setCurrent(installRoot, R_NATIVE)
    const native = await startNative(release[R_NATIVE] as string, currentLink)
    const helper = await startHelper(release[R_HELPER] as string)

    // Install R2. Daemon B starts from the installed tree at runtime root Y.
    await setCurrent(installRoot, R2)
    const daemonB = await startDaemon(release[R2] as string, join(scratch, 'Y'))
    const prune = await waitForPrune(daemonB)
    console.log(`daemon B startup prune: ${JSON.stringify(prune)}`)

    expect(await list()).toEqual([R1, R_NATIVE, R_HELPER, R2])
    expect(prune).toMatchObject({ pruned: true, current: R2, removed: [R_UNREF], failed: [] })
    expect(prune['heldBy']).toMatchObject({
      [R_NATIVE]: [native.pid],
      [R_HELPER]: [helper.pid],
      [R1]: [daemonA.pid],
    })

    // Every holder exits; a fresh daemon from current removes all of it.
    for (const proc of [daemonA, native, helper, daemonB]) await proc.kill()
    const daemonC = await startDaemon(release[R2] as string, join(scratch, 'Z'))
    const cleanup = await waitForPrune(daemonC)
    console.log(`daemon C startup prune: ${JSON.stringify(cleanup)}`)
    expect(cleanup).toMatchObject({ pruned: true, current: R2, failed: [] })
    expect(await list()).toEqual([R2])
  }, 180_000)
})
