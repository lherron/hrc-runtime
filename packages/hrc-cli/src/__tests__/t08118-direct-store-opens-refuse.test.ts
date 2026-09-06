import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { HrcClient } from 'hrc-sdk'
import { HrcStoreSchemaBehindError, openHrcDatabase } from 'hrc-store-sqlite'

import { type ServerRuntimeStatus, formatServerRuntimeStatus } from '../cli-runtime/server-status'
import { cmdEventsDrain } from '../events-drain'
import { cmdMailInspect } from '../mail-inspect'
import { cmdMonitorShow } from '../monitor-show'
import { cmdMonitorWait } from '../monitor/wait-command'
import { cmdMonitorWatch } from '../monitor/watch-command'
import { cmdRunAnnotate, cmdRunExport } from '../run-invocation'
import { pruneCompletedTaskWorktrees } from '../worktree-prune'

/**
 * T-08118 acceptance in miniature: between `just install` and
 * `hrc server restart` the CLI carries migrations the live store has not
 * applied. Each of the six commands that open the store directly must refuse
 * rather than migrate it under the daemon still running the previous release.
 *
 * The store is put "behind" by deleting the ledger row for
 * `0036_event_repository_query_indexes` — a `CREATE INDEX IF NOT EXISTS`-only
 * migration, so the store is genuinely behind this binary while remaining
 * usable for anything that does not care.
 */
const REPLAYABLE_MIGRATION = '0036_event_repository_query_indexes'
const SELECTOR = 'runtime:rt-t08118'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function track<T extends { mockRestore(): void }>(mock: T): T {
  cleanups.push(() => mock.mockRestore())
  return mock
}

function behindStateRoot(): { stateRoot: string; dbPath: string } {
  const stateRoot = mkdtempSync(join(tmpdir(), 'hrc-t08118-cli-'))
  cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }))
  const dbPath = join(stateRoot, 'state.sqlite')
  openHrcDatabase(dbPath).close()
  const raw = new Database(dbPath)
  raw.exec(`DELETE FROM hrc_migrations WHERE id = '${REPLAYABLE_MIGRATION}'`)
  raw.close()

  const previous = process.env['HRC_STATE_DIR']
  process.env['HRC_STATE_DIR'] = stateRoot
  cleanups.push(() => {
    process.env['HRC_STATE_DIR'] = previous ?? ''
  })
  return { stateRoot, dbPath }
}

function stubStatus(dbPath: string): void {
  track(
    spyOn(HrcClient.prototype, 'getStatus').mockImplementation(
      async () =>
        ({
          ok: true,
          uptime: 1,
          startedAt: '2026-09-06T00:00:00.000Z',
          runtimeRoot: dirname(dbPath),
          stateRoot: dirname(dbPath),
          socketPath: join(dirname(dbPath), 'hrc.sock'),
          dbPath,
          cwd: '/tmp',
          binaryPath: '/tmp/hrc-server',
          packagePath: '/tmp/hrc-server-package',
          sessionCount: 0,
          runtimeCount: 0,
          apiVersion: 'v1',
          capabilities: {
            semanticCore: {},
            platform: {},
            bridgeDelivery: {},
            backend: { tmux: { available: false } },
          },
          sessions: [],
        }) as never
    )
  )
  track(spyOn(HrcClient.prototype, 'getHealth').mockImplementation(async () => ({ ok: true })))
}

async function expectSchemaRefusal(run: () => Promise<unknown> | unknown): Promise<void> {
  let thrown: unknown
  try {
    await run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(HrcStoreSchemaBehindError)
  const error = thrown as HrcStoreSchemaBehindError
  expect(error.pending).toEqual([REPLAYABLE_MIGRATION])
  expect(error.message).toContain('hrc server restart')
}

function storeMigrationIds(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true })
  try {
    return raw
      .query<{ id: string }, []>('SELECT id FROM hrc_migrations ORDER BY id')
      .all()
      .map((row) => row.id)
  } finally {
    raw.close()
  }
}

describe('T-08118 the six direct-open commands refuse a behind store', () => {
  it('hrc mail inspect', async () => {
    const { dbPath } = behindStateRoot()
    const before = storeMigrationIds(dbPath)
    await expectSchemaRefusal(() => cmdMailInspect('EN-00001', {}))
    expect(storeMigrationIds(dbPath)).toEqual(before)
  })

  it('hrc run invocation (export)', async () => {
    const { dbPath } = behindStateRoot()
    const before = storeMigrationIds(dbPath)
    await expectSchemaRefusal(() => cmdRunExport(['run-does-not-exist']))
    expect(storeMigrationIds(dbPath)).toEqual(before)
  })

  it('hrc run invocation (annotate)', async () => {
    const { dbPath } = behindStateRoot()
    await expectSchemaRefusal(() =>
      cmdRunAnnotate(['run-does-not-exist', '--correlation', '{"taskId":"T-08118"}'])
    )
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })

  it('hrc monitor show', async () => {
    const { dbPath } = behindStateRoot()
    stubStatus(dbPath)
    await expectSchemaRefusal(() => cmdMonitorShow([]))
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })

  it('hrc monitor watch', async () => {
    const { dbPath } = behindStateRoot()
    stubStatus(dbPath)
    // No injected deps: the injected-`buildMonitorState` seam would bypass the
    // very open under test, so watch runs its live path. `process.exit` is
    // stubbed only as a backstop — a propagating refusal never reaches it.
    track(
      spyOn(process, 'exit').mockImplementation((code?: number) => {
        throw new Error(`unexpected process.exit(${code ?? 0})`)
      })
    )
    await expectSchemaRefusal(() => cmdMonitorWatch([SELECTOR, '--last', '1']))
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })

  it('hrc monitor wait', async () => {
    const { dbPath } = behindStateRoot()
    stubStatus(dbPath)
    await expectSchemaRefusal(() =>
      cmdMonitorWait([SELECTOR, '--until', 'turn-finished', '--timeout', '1s'], {
        stdout: { write: () => true } as never,
        stderr: { write: () => true } as never,
      })
    )
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })

  it('hrc worktree prune', async () => {
    const { dbPath } = behindStateRoot()
    const projectRoot = mkdtempSync(join(tmpdir(), 'hrc-t08118-wt-'))
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }))
    mkdirSync(join(projectRoot, '.git'), { recursive: true })
    const worktreePath = join(projectRoot, 'wt-T-08118')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${join(projectRoot, '.git')}\n`)

    await expectSchemaRefusal(() =>
      pruneCompletedTaskWorktrees(
        { projectId: 'demo', projectRoot },
        {
          run: (_command, args) =>
            args.includes('list')
              ? {
                  status: 0,
                  stdout: `worktree ${projectRoot}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch refs/heads/clod-T-08118\n\n`,
                  stderr: '',
                }
              : { status: 0, stdout: '', stderr: '' },
          readTask: (taskId) => ({ id: taskId, state: 'completed' }) as never,
        }
      )
    )
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })
})

/**
 * The behavioural tests above prove the seven call sites that exist today.
 * This one is the guarantee that does not rot: a new CLI command that opens the
 * store directly and forgets `migrate: false` fails the build rather than
 * shipping a fresh copy of T-08118.
 */
describe('T-08118 conformance: no hrc-cli source opens the store migrating', () => {
  it('every openHrcDatabase call in hrc-cli source passes migrate: false', () => {
    const root = join(import.meta.dir, '..')
    const offenders: string[] = []
    const seen: string[] = []

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
          walk(path)
          continue
        }
        if (!entry.endsWith('.ts')) continue
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(/openHrcDatabase\(([^\n]*)/g)) {
          seen.push(path)
          if (!match[1]?.includes('migrate: false')) offenders.push(`${path}: ${match[0].trim()}`)
        }
      }
    }
    walk(root)

    expect(offenders).toEqual([])
    // A guard that passes because it inspected nothing is not a guard: the
    // call sites it is meant to police must actually be present.
    expect(seen.length).toBeGreaterThanOrEqual(7)
  })
})

describe('T-08118 hrc server status surfaces the armed window', () => {
  function statusWithSchema(schema: ServerRuntimeStatus['schema']): ServerRuntimeStatus {
    return {
      ok: true,
      status: 'healthy',
      exitCode: 0,
      running: true,
      schema,
      runtimeRoot: '/tmp/run',
      stateRoot: '/tmp/state',
      pidAlive: true,
      pidPath: '/tmp/run/server.pid',
      daemon: {
        running: true,
        pidAlive: true,
        pidPath: '/tmp/run/server.pid',
        pidFileExists: true,
      },
      socketPath: '/tmp/run/hrc.sock',
      socketResponsive: true,
      socket: { path: '/tmp/run/hrc.sock', responsive: true },
      lockPath: '/tmp/run/server.lock',
      lockExists: true,
      tmuxSocketPath: '/tmp/run/tmux.sock',
      apiHealth: { ok: true },
      tmux: {
        available: false,
        socketPath: '/tmp/run/tmux.sock',
        running: false,
        sessionCount: 0,
        sessions: [],
      },
    }
  }

  it('reports schemaAhead with the restart instruction while installed > running', () => {
    const rendered = formatServerRuntimeStatus(
      statusWithSchema({
        readable: true,
        storeVersion: '0060_a',
        releaseVersion: '0061_b',
        pending: ['0061_b'],
        schemaAhead: true,
      })
    )
    expect(rendered).toContain('store schema: 0060_a — schemaAhead')
    expect(rendered).toContain('hrc server restart')
  })

  it('does NOT claim schemaAhead once the store matches — the state it must stay quiet in', () => {
    const rendered = formatServerRuntimeStatus(
      statusWithSchema({
        readable: true,
        storeVersion: '0061_b',
        releaseVersion: '0061_b',
        pending: [],
        schemaAhead: false,
      })
    )
    expect(rendered).toContain('store schema: 0061_b (matches this release)')
    expect(rendered).not.toContain('schemaAhead')
  })

  it('says unknown rather than "not ahead" when the store cannot be read', () => {
    const rendered = formatServerRuntimeStatus(
      statusWithSchema({
        readable: false,
        releaseVersion: '0061_b',
        pending: [],
        schemaAhead: false,
        error: 'store not found at /tmp/state/state.sqlite',
      })
    )
    expect(rendered).toContain('store schema: unknown (store not found')
  })
})

describe('T-08118 hrc admin events drain refuses the live store', () => {
  it('refuses when the drain target is the live store it would migrate', async () => {
    const { dbPath } = behindStateRoot()
    await expect(cmdEventsDrain({ dbPath, sourceRef: 'node:dead-container' })).rejects.toThrow(
      /refusing to drain the live HRC store/
    )
    expect(storeMigrationIds(dbPath)).not.toContain(REPLAYABLE_MIGRATION)
  })
})
