/**
 * T-09861 — the lifecycle contract end to end, against scratch daemons: a real
 * `hrc server serve` process per test on isolated roots, driven by the real
 * `hrc server stop|restart` CLI as each caller. Never the live daemon.
 *
 * Seats are seeded into the scratch store BEFORE boot, so every credential a
 * test uses was written by the boot backfill (the "seat born before the
 * release" path, §3). Each refusal asserts the daemon pid is unchanged and no
 * server fact was appended; each grant asserts the provenance facts (§7).
 *
 * Failure modes: var/wrkq-artifacts/T-09861/failure-modes.md.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { lifecycleCredentialPath } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts')
const NOW = '2026-09-28T12:00:00.000Z'

const SEATS = {
  mablePrimary: 'agent:mable:project:hrc-runtime:task:primary',
  mableAspPrimary: 'agent:mable:project:agent-spaces:task:primary',
  clodPrimary: 'agent:clod:project:hrc-runtime:task:primary',
  mableTask: 'agent:mable:project:hrc-runtime:task:T-09861',
  mableMinisvc: 'agent:mable:project:hrc-runtime:task:minisvc',
  clodMinisvc: 'agent:clod:project:hrc-runtime:task:minisvc',
  mableHrcdev: 'agent:mable:project:hrc-runtime:task:hrcdev',
  mableAspHrcdev: 'agent:mable:project:agent-spaces:task:hrcdev',
} as const
type SeatName = keyof typeof SEATS

/** Identity keys stripped from every spawned process: callers get only what a test gives them. */
const IDENTITY_KEY = /^(HRC_|ASP_|AGENT_|WRKQ_|CLAUDE|CODEX_)/
const PASS_THROUGH = new Set(['HRC_WRKQ_DB', 'HRC_ALLOW_HARNESS_SHIM'])

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (IDENTITY_KEY.test(key) && !PASS_THROUGH.has(key)) continue
    env[key] = value
  }
  return env
}

type Scratch = {
  root: string
  runtimeRoot: string
  stateRoot: string
  runtimeIds: Record<SeatName, string>
  daemonLog: string
  env: Record<string, string>
}

const scratches: Scratch[] = []

afterEach(async () => {
  for (const scratch of scratches.splice(0)) {
    const pid = readPid(scratch)
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await rm(scratch.root, { recursive: true, force: true })
  }
})

function readPid(scratch: Scratch): number | undefined {
  try {
    const pid = Number(readFileSync(join(scratch.runtimeRoot, 'server.pid'), 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function makeScratch(nodeId: string): Promise<Scratch> {
  const root = await mkdtemp('/tmp/hrc-t09861-')
  const runtimeRoot = join(root, 'run')
  const stateRoot = join(root, 'state')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await writeFile(join(stateRoot, 'federation.json'), JSON.stringify({ nodeId }), { mode: 0o600 })

  const db = openHrcDatabase(join(stateRoot, 'state.sqlite'), { migrate: true })
  const runtimeIds = {} as Record<SeatName, string>
  try {
    for (const [name, scopeRef] of Object.entries(SEATS) as [SeatName, string][]) {
      const hostSessionId = `hsid-t09861-${name}`
      const runtimeId = `rt-t09861-${name}`
      db.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'sdk',
        status: 'ready',
        // Externally owned: boot reconciliation leaves it live, like a seat
        // that outlives a daemon restart.
        runtimeStateJson: { lifecycleOwner: 'external' },
        supportsInflightInput: false,
        adopted: false,
        createdAt: NOW,
        updatedAt: NOW,
      })
      runtimeIds[name] = runtimeId
    }
  } finally {
    db.close()
  }

  const scratch: Scratch = {
    root,
    runtimeRoot,
    stateRoot,
    runtimeIds,
    daemonLog: join(runtimeRoot, 'server.log'),
    env: {
      ...baseEnv(),
      HRC_RUNTIME_DIR: runtimeRoot,
      HRC_STATE_DIR: stateRoot,
      // A label no LaunchAgent declares: the daemon is unsupervised and the CLI
      // never finds a launchd owner.
      HRC_LAUNCHD_LABEL: `com.praesidium.hrc-t09861-${nodeId}-scratch`,
      HRC_SHADOW_TEARDOWN_ENABLED: '0',
      HRC_WRKQ_DB: process.env['HRC_WRKQ_DB'] ?? 'rpc://127.0.0.1:1',
    },
  }
  scratches.push(scratch)
  return scratch
}

async function startDaemon(scratch: Scratch): Promise<number> {
  const out = openSync(scratch.daemonLog, 'a')
  const child = Bun.spawn([process.execPath, CLI_PATH, 'server', 'serve'], {
    cwd: scratch.root,
    env: scratch.env,
    stdout: out,
    stderr: out,
    stdin: 'ignore',
  })
  child.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const pid = readPid(scratch)
    if (pid === child.pid && (await statusOf(scratch)) !== undefined) return pid
    await Bun.sleep(50)
  }
  throw new Error(`scratch daemon did not come up:\n${readFileSync(scratch.daemonLog, 'utf8')}`)
}

async function statusOf(scratch: Scratch): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch('http://hrc/v1/status', {
      unix: join(scratch.runtimeRoot, 'hrc.sock'),
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type CliResult = { exitCode: number; stdout: string; stderr: string }

/** Runs the real CLI as `seat` (its runtime id + session ref), or with no identity. */
async function hrcAs(
  scratch: Scratch,
  seat: SeatName | null,
  args: string[],
  overrides: Record<string, string> = {}
): Promise<CliResult> {
  const env: Record<string, string> = { ...scratch.env, ...overrides }
  if (seat !== null) {
    env['HRC_RUNTIME_ID'] = scratch.runtimeIds[seat]
    env['HRC_SESSION_REF'] = `${SEATS[seat]}/lane:main`
    Object.assign(env, overrides)
  }
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: scratch.root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

type ServerFact = { hrcSeq: number; kind: string; payload: Record<string, unknown> }

function serverFacts(scratch: Scratch): ServerFact[] {
  const db = new Database(join(scratch.stateRoot, 'state.sqlite'), { readonly: true })
  try {
    return db
      .query<{ hrc_seq: number; event_kind: string; payload_json: string }, []>(
        `SELECT hrc_seq, event_kind, payload_json FROM hrc_events
          WHERE scope_ref = 'server:hrc' ORDER BY hrc_seq ASC`
      )
      .all()
      .map((row) => ({
        hrcSeq: row.hrc_seq,
        kind: row.event_kind,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      }))
  } finally {
    db.close()
  }
}

async function waitFor<T>(probe: () => T | Promise<T>, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function credentialFile(scratch: Scratch, seat: SeatName): string {
  return readFileSync(
    lifecycleCredentialPath(scratch.runtimeRoot, scratch.runtimeIds[seat]),
    'utf8'
  ).trim()
}

/** Every refusal: non-zero, the refusal line, same pid alive, no new server fact. */
async function expectRefused(
  scratch: Scratch,
  run: () => Promise<CliResult>,
  expected: RegExp
): Promise<CliResult> {
  const pid = readPid(scratch)
  const factsBefore = serverFacts(scratch).length
  const result = await run()
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toMatch(expected)
  expect(readPid(scratch)).toBe(pid)
  expect(alive(pid)).toBe(true)
  expect(serverFacts(scratch).length).toBe(factsBefore)
  return result
}

const E2E_TIMEOUT = 120_000

describe('T-09861 lifecycle contract against scratch daemons', () => {
  it(
    '§8.1/§8.2/§8.19 Mable primaries restart locally; grants land in shutting_down, stopped and lastRestart',
    async () => {
      const scratch = await makeScratch('max3')
      const firstPid = await startDaemon(scratch)
      const bootCredential = credentialFile(scratch, 'mablePrimary')

      const restart = await hrcAs(scratch, 'mablePrimary', [
        'server',
        'restart',
        '--reason',
        'T-09861 e2e grant',
      ])
      expect(restart.stderr).toContain('restart granted on max3')
      expect(restart.stderr).toContain('restart proven')
      expect(restart.exitCode).toBe(0)
      const secondPid = await waitFor(() => {
        const pid = readPid(scratch)
        return pid !== firstPid && alive(pid) ? pid : undefined
      }, 'successor pid')
      expect(alive(firstPid)).toBe(false)

      const facts = serverFacts(scratch)
      const shuttingDown = facts.find((fact) => fact.kind === 'server.shutting_down')
      const stopped = facts.find((fact) => fact.kind === 'server.stopped')
      expect(facts.map((fact) => fact.kind)).toEqual([
        'server.started',
        'server.shutting_down',
        'server.stopped',
        'server.started',
      ])
      expect(shuttingDown?.payload['grant']).toMatchObject({
        requestedBy: SEATS.mablePrimary,
        callerKind: 'mable-primary',
        originNode: 'max3',
        reason: 'T-09861 e2e grant',
        action: 'restart',
      })
      expect(stopped?.payload['grant']).toEqual(shuttingDown?.payload['grant'])
      expect(stopped?.payload['shuttingDownHrcSeq']).toBe(shuttingDown?.hrcSeq)
      const status = await waitFor(() => statusOf(scratch), 'successor status')
      expect(status['lastRestart']).toMatchObject({
        requestedBy: SEATS.mablePrimary,
        reason: 'T-09861 e2e grant',
      })
      expect((status['capabilities'] as { serverLifecycle?: boolean }).serverLifecycle).toBe(true)

      // FM6: the successor re-minted every file; the predecessor's value is dead.
      const reminted = credentialFile(scratch, 'mablePrimary')
      expect(reminted).not.toBe(bootCredential)
      const replay = await fetch('http://hrc/v1/server/lifecycle', {
        unix: join(scratch.runtimeRoot, 'hrc.sock'),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hrc-lifecycle-runtime-id': scratch.runtimeIds.mablePrimary,
          'x-hrc-lifecycle-credential': bootCredential,
          'x-hrc-lifecycle-session-ref': `${SEATS.mablePrimary}/lane:main`,
        },
        body: JSON.stringify({ action: 'restart', reason: 'replay predecessor credential' }),
      })
      expect(replay.status).toBe(403)
      expect(readPid(scratch)).toBe(secondPid)

      // §8.2: a second project's Mable primary is equally authorized.
      const second = await hrcAs(scratch, 'mableAspPrimary', [
        'server',
        'restart',
        '--wait',
        '--reason',
        'T-09861 second project',
      ])
      expect(second.exitCode).toBe(0)
      await waitFor(() => {
        const pid = readPid(scratch)
        return pid !== secondPid && alive(pid)
      }, 'third pid')
      const grants = serverFacts(scratch)
        .filter((fact) => fact.kind === 'server.shutting_down')
        .map((fact) => fact.payload['grant'] as { requestedBy: string; flags: unknown })
      expect(grants[1]?.requestedBy).toBe(SEATS.mableAspPrimary)
      expect(grants[1]?.flags).toEqual({ wait: true, drain: false, force: false })

      // A granted stop: the daemon exits and stays down; the stop fact carries the grant.
      const stop = await hrcAs(scratch, 'mablePrimary', ['server', 'stop', '--reason', 'e2e stop'])
      expect(stop.exitCode).toBe(0)
      expect(stop.stderr).toContain('daemon stopped')
      const last = serverFacts(scratch).at(-1)
      expect(last?.kind).toBe('server.stopped')
      expect(last?.payload['grant']).toMatchObject({ action: 'stop', reason: 'e2e stop' })
      await Bun.sleep(500)
      expect(await statusOf(scratch)).toBeUndefined()
    },
    E2E_TIMEOUT
  )

  it(
    '§8.7/§8.9/§8.10/§8.11/§8.13/§8.14 refusals change nothing: non-mable, task seat, env -i, forged env, mismatch, flags, direct socket',
    async () => {
      const scratch = await makeScratch('max3')
      await startDaemon(scratch)

      // §8.7 another agent's primary, locally and cross-node.
      await expectRefused(
        scratch,
        () => hrcAs(scratch, 'clodPrimary', ['server', 'restart', '--reason', 'x']),
        /\[server_lifecycle_refused\] only mable@<project>:primary or Lance may restart the HRC server on max3; request it from mable@hrc-runtime:primary/
      )
      await expectRefused(
        scratch,
        () =>
          hrcAs(scratch, 'clodPrimary', ['server', 'restart', '--node', 'svc', '--reason', 'x']),
        /may restart the HRC server on svc.*not authorized/
      )
      // §8.9 the implementer's own task seat.
      await expectRefused(
        scratch,
        () => hrcAs(scratch, 'mableTask', ['server', 'restart', '--reason', 'x']),
        /agent:mable:project:hrc-runtime:task:T-09861 is not authorized/
      )
      // §8.10 env unset entirely (env -i).
      const bare = await expectRefused(
        scratch,
        async () => {
          const proc = Bun.spawn(
            [process.execPath, CLI_PATH, 'server', 'restart', '--reason', 'x'],
            {
              cwd: scratch.root,
              env: {
                PATH: process.env['PATH'] ?? '/usr/bin:/bin',
                HOME: process.env['HOME'] ?? '/tmp',
                HRC_RUNTIME_DIR: scratch.runtimeRoot,
                HRC_STATE_DIR: scratch.stateRoot,
              },
              stdout: 'pipe',
              stderr: 'pipe',
            }
          )
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          return { stdout, stderr, exitCode }
        },
        /no lifecycle credential/
      )
      expect(bare.stderr).toContain('launchctl kickstart -k gui/$UID/com.praesidium.hrc-server')
      // §8.10 forged: a mable-primary session ref with no credential ...
      await expectRefused(
        scratch,
        () =>
          hrcAs(scratch, null, ['server', 'restart', '--force', '--reason', 'forged'], {
            HRC_SESSION_REF: `${SEATS.mablePrimary}/lane:main`,
            ASP_SCOPE_REF: SEATS.mablePrimary,
            ASP_TASK_ID: 'primary',
          }),
        /no lifecycle credential/
      )
      // ... and with a foreign credential (clod's real file under mable's name).
      await expectRefused(
        scratch,
        () =>
          hrcAs(scratch, 'clodPrimary', ['server', 'restart', '--reason', 'foreign'], {
            HRC_SESSION_REF: `${SEATS.mablePrimary}/lane:main`,
          }),
        /bound to a different seat/
      )
      // §8.11 mable's real credential presented from another seat's session.
      await expectRefused(
        scratch,
        () =>
          hrcAs(scratch, 'mablePrimary', ['server', 'restart', '--reason', 'copied'], {
            HRC_SESSION_REF: `${SEATS.clodPrimary}/lane:main`,
          }),
        /bound to a different seat/
      )
      const log = readFileSync(scratch.daemonLog, 'utf8')
      expect(log).toContain('WARN server.lifecycle.credential_mismatch')
      expect(log).toContain('WARN server.lifecycle.refused')

      // §8.13 every flag, and stop, from a non-mable seat.
      for (const args of [
        ['server', 'restart', '--force', '--reason', 'x'],
        ['server', 'restart', '--wait', '--reason', 'x'],
        ['server', 'restart', '--drain', '--reason', 'x'],
        ['server', 'stop', '--reason', 'x'],
        ['server', 'stop', '--force', '--reason', 'x'],
      ]) {
        await expectRefused(scratch, () => hrcAs(scratch, 'clodPrimary', args), /not authorized/)
      }
      const admission = (await (
        await fetch('http://hrc/v1/server/turn-admission', {
          unix: join(scratch.runtimeRoot, 'hrc.sock'),
        })
      ).json()) as { state: string }
      expect(admission.state).toBe('open')

      // FM16: an authorized caller without --reason.
      await expectRefused(
        scratch,
        () => hrcAs(scratch, 'mablePrimary', ['server', 'restart']),
        /--reason <text> is required/
      )
      // Rule B off its node: node-local seats on max3.
      for (const seat of ['mableMinisvc', 'mableHrcdev'] as const) {
        await expectRefused(
          scratch,
          () => hrcAs(scratch, seat, ['server', 'restart', '--reason', 'x']),
          /not authorized/
        )
      }

      // §8.14 a direct socket call with no credential.
      const pid = readPid(scratch)
      const direct = await fetch('http://hrc/v1/server/lifecycle', {
        unix: join(scratch.runtimeRoot, 'hrc.sock'),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop', reason: 'curl', force: true }),
      })
      expect(direct.status).toBe(403)
      expect(readPid(scratch)).toBe(pid)
      expect(alive(pid)).toBe(true)
    },
    E2E_TIMEOUT
  )

  it(
    '§8.4/§8.5/§8.8 on svc: mable minisvc restarts svc, clod minisvc is refused, cross-node is refused',
    async () => {
      const scratch = await makeScratch('svc')
      const firstPid = await startDaemon(scratch)
      await expectRefused(
        scratch,
        () => hrcAs(scratch, 'clodMinisvc', ['server', 'restart', '--reason', 'x']),
        /this node's Mable seat \(mable@<project>:minisvc\)/
      )
      for (const node of ['hrcdev', 'max3']) {
        await expectRefused(
          scratch,
          () =>
            hrcAs(scratch, 'mableMinisvc', ['server', 'restart', '--node', node, '--reason', 'x']),
          /node-local seat and may act only on its own node svc/
        )
      }
      const allowed = await hrcAs(scratch, 'mableMinisvc', [
        'server',
        'restart',
        '--reason',
        'svc maintenance',
      ])
      expect(allowed.exitCode).toBe(0)
      await waitFor(() => {
        const pid = readPid(scratch)
        return pid !== firstPid && alive(pid)
      }, 'svc successor')
      const grant = serverFacts(scratch).find((fact) => fact.kind === 'server.stopped')?.payload[
        'grant'
      ]
      expect(grant).toMatchObject({
        requestedBy: SEATS.mableMinisvc,
        callerKind: 'mable-node-local',
      })
    },
    E2E_TIMEOUT
  )

  it(
    '§8.4/§8.6 on hrcdev: mable@hrc-runtime:hrcdev restarts, mable@agent-spaces:hrcdev is refused',
    async () => {
      const scratch = await makeScratch('hrcdev')
      const firstPid = await startDaemon(scratch)
      await expectRefused(
        scratch,
        () => hrcAs(scratch, 'mableAspHrcdev', ['server', 'restart', '--reason', 'x']),
        /this node's Mable seat \(mable@hrc-runtime:hrcdev\).*not authorized/
      )
      const allowed = await hrcAs(scratch, 'mableHrcdev', [
        'server',
        'restart',
        '--force',
        '--reason',
        'hrcdev maintenance',
      ])
      expect(allowed.exitCode).toBe(0)
      await waitFor(() => {
        const pid = readPid(scratch)
        return pid !== firstPid && alive(pid)
      }, 'hrcdev successor')
    },
    E2E_TIMEOUT
  )

  it(
    '§8.16/§8.19 a raw SIGTERM is recorded ungranted; a raw SIGKILL is unattributed at the next boot',
    async () => {
      const scratch = await makeScratch('max3')
      const pid = await startDaemon(scratch)
      process.kill(pid, 'SIGTERM')
      await waitFor(() => !alive(pid), 'SIGTERM exit')
      const afterTerm = serverFacts(scratch)
      expect(afterTerm.map((fact) => fact.kind)).toEqual([
        'server.started',
        'server.shutting_down',
        'server.stopped',
      ])
      expect(afterTerm[1]?.payload).toMatchObject({
        reason: 'SIGTERM',
        grant: null,
        ungranted: true,
      })
      expect(readFileSync(scratch.daemonLog, 'utf8')).toContain(
        'WARN server.lifecycle.ungranted_shutdown'
      )

      const second = await startDaemon(scratch)
      process.kill(second, 'SIGKILL')
      await waitFor(() => !alive(second), 'SIGKILL exit')
      await startDaemon(scratch)
      const kinds = serverFacts(scratch).map((fact) => fact.kind)
      expect(kinds.slice(-3)).toEqual([
        'server.started',
        'server.previous_exit_unattributed',
        'server.started',
      ])
      const status = await waitFor(() => statusOf(scratch), 'status')
      expect(status['lastRestart']).toMatchObject({ requestedBy: null, reason: null })
    },
    E2E_TIMEOUT
  )

  it(
    '§8.18/FM23 a pre-contract daemon is refused with the break-glass text and never signalled',
    async () => {
      const scratch = await makeScratch('max3')
      // The pre-contract daemon: answers status without capabilities.serverLifecycle.
      const sentinel = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
      await writeFile(join(scratch.runtimeRoot, 'server.pid'), `${sentinel.pid}\n`)
      const seen: string[] = []
      const fake = Bun.serve({
        unix: join(scratch.runtimeRoot, 'hrc.sock'),
        fetch(request) {
          const path = new URL(request.url).pathname
          seen.push(`${request.method} ${path}`)
          if (path === '/v1/status') {
            return Response.json({
              ok: true,
              startedAt: NOW,
              runtimeRoot: scratch.runtimeRoot,
              node: { nodeId: 'max3' },
              capabilities: { semanticCore: {} },
            })
          }
          return Response.json({ ok: true })
        },
      })
      try {
        for (const [seat, args, overrides] of [
          ['mablePrimary', ['server', 'restart', '--reason', 'activation'], {}],
          ['mablePrimary', ['server', 'stop', '--force', '--reason', 'activation'], {}],
          [
            null,
            ['server', 'restart', '--force', '--reason', 'forged'],
            { HRC_SESSION_REF: `${SEATS.mablePrimary}/lane:main` },
          ],
        ] as const) {
          const result = await hrcAs(scratch, seat, [...args], { ...overrides })
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain(
            'the running daemon predates the lifecycle contract and cannot authorize this; activate it with the documented break-glass: launchctl kickstart -k gui/$UID/com.praesidium.hrc-server'
          )
        }
        expect(seen.filter((entry) => entry.includes('/v1/server/lifecycle'))).toEqual([])
        expect(alive(sentinel.pid)).toBe(true)
        expect(sentinel.exitCode).toBeNull()
      } finally {
        fake.stop(true)
        sentinel.kill('SIGKILL')
      }
      await rm(join(scratch.runtimeRoot, 'server.pid'), { force: true })
      expect(existsSync(join(scratch.runtimeRoot, 'server.pid'))).toBe(false)
    },
    E2E_TIMEOUT
  )
})
