import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageAddress } from 'hrc-core'

import { type HrcDatabase, openHrcDatabase } from '../database.js'
import { MessageRepository } from '../message-repository.js'
import { EventRepository, HrcLifecycleEventRepository } from '../repositories/event-repositories.js'

const COMPETING_WRITER_SOURCE = String.raw`
  import { Database } from 'bun:sqlite'
  import { existsSync, writeFileSync } from 'node:fs'

  const dbPath = process.env.T07194_DB_PATH
  const readyPath = process.env.T07194_READY_PATH
  const startPath = process.env.T07194_START_PATH
  const donePath = process.env.T07194_DONE_PATH
  if (!dbPath || !readyPath || !startPath || !donePath) process.exit(2)

  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA journal_mode = WAL;')
  writeFileSync(readyPath, 'ready')
  while (!existsSync(startPath)) Bun.sleepSync(2)
  db.query('INSERT INTO competing_writes DEFAULT VALUES').run()
  writeFileSync(donePath, 'done')
  db.close()
`

const humanAddress: HrcMessageAddress = { kind: 'entity', entity: 'human' }

let tmpDir: string
let dbPath: string
let db: HrcDatabase
let writerSequence = 0

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 't07194-busy-snapshot-'))
  dbPath = join(tmpDir, 'state.sqlite')
  db = openHrcDatabase(dbPath, { busyTimeoutMs: 5_000 })
  db.sqlite.exec('CREATE TABLE competing_writes (id INTEGER PRIMARY KEY)')
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await Bun.sleep(2)
  }
}

function hookFirstMatchingRead(
  sqlite: Database,
  matches: (sql: string) => boolean,
  afterRead: () => void
): Database {
  let invoked = false
  return new Proxy(sqlite, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (property === 'query' && typeof value === 'function') {
        return (sql: string, ...args: unknown[]) => {
          const statement = Reflect.apply(value, target, [sql, ...args]) as Statement<
            unknown,
            SQLQueryBindings[]
          >
          if (invoked || !matches(sql)) return statement
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const statementValue = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget
              ) as unknown
              if (statementProperty === 'get' && typeof statementValue === 'function') {
                return (...bindings: unknown[]) => {
                  const result = Reflect.apply(statementValue, statementTarget, bindings)
                  invoked = true
                  afterRead()
                  return result
                }
              }
              return typeof statementValue === 'function'
                ? statementValue.bind(statementTarget)
                : statementValue
            },
          })
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function againstCompetingCommit<T>(
  matchesRead: (sql: string) => boolean,
  operation: (sqlite: Database) => T
): Promise<T> {
  const sequence = ++writerSequence
  const readyPath = join(tmpDir, `writer-${sequence}.ready`)
  const startPath = join(tmpDir, `writer-${sequence}.start`)
  const donePath = join(tmpDir, `writer-${sequence}.done`)
  const writer = Bun.spawn({
    cmd: [process.execPath, '-e', COMPETING_WRITER_SOURCE],
    env: {
      ...process.env,
      T07194_DB_PATH: dbPath,
      T07194_READY_PATH: readyPath,
      T07194_START_PATH: startPath,
      T07194_DONE_PATH: donePath,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  await waitForFile(readyPath)

  const hooked = hookFirstMatchingRead(db.sqlite, matchesRead, () => {
    writeFileSync(startPath, 'start')

    // Under BEGIN DEFERRED the child commits during this window, invalidating
    // the reader's WAL snapshot. Under BEGIN IMMEDIATE it waits for this
    // transaction to commit, then completes inside SQLite's busy timeout.
    const deadline = Date.now() + 500
    while (!existsSync(donePath) && Date.now() < deadline) Bun.sleepSync(2)
  })

  let result: T | undefined
  let operationError: unknown
  try {
    result = operation(hooked)
  } catch (error) {
    operationError = error
  }

  const exitCode = await writer.exited
  if (exitCode !== 0) {
    const stderr = await new Response(writer.stderr).text()
    throw new Error(`competing writer exited ${exitCode}: ${stderr}`)
  }
  if (operationError !== undefined) throw operationError
  expect(existsSync(donePath)).toBe(true)
  return result as T
}

function seedSession(hostSessionId: string): void {
  const now = new Date().toISOString()
  db.sessions.insert({
    hostSessionId,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07194',
    laneRef: 'default',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

describe('T-07194 read-before-write transactions', () => {
  it('idempotently inserts a message while another WAL connection commits', async () => {
    const result = await againstCompetingCommit(
      (sql) => sql.includes('FROM messages WHERE message_id = ?'),
      (sqlite) =>
        new MessageRepository(sqlite).insertIdempotent({
          messageId: 'msg-t07194',
          kind: 'dm',
          phase: 'request',
          from: humanAddress,
          to: humanAddress,
          body: 'survives the competing commit',
        })
    )

    expect(result.outcome).toBe('inserted')
    expect(db.messages.getById('msg-t07194')?.body).toBe('survives the competing commit')
  })

  it('appends a raw event while another WAL connection commits', async () => {
    seedSession('hsid-t07194-raw')
    const event = await againstCompetingCommit(
      (sql) => sql.includes('SELECT next_seq FROM event_stream_cursor'),
      (sqlite) =>
        new EventRepository(sqlite).append({
          ts: new Date().toISOString(),
          hostSessionId: 'hsid-t07194-raw',
          scopeRef: 'agent:cody:project:hrc-runtime:task:T-07194',
          laneRef: 'default',
          generation: 1,
          source: 'hook',
          eventKind: 'test.competing_commit',
          eventJson: {},
        })
    )

    expect(event.seq).toBeGreaterThan(0)
  })

  it('appends a lifecycle event while another WAL connection commits', async () => {
    seedSession('hsid-t07194-lifecycle')
    const event = await againstCompetingCommit(
      (sql) => sql.includes('SELECT next_seq FROM event_stream_cursor'),
      (sqlite) =>
        new HrcLifecycleEventRepository(sqlite).append({
          ts: new Date().toISOString(),
          hostSessionId: 'hsid-t07194-lifecycle',
          scopeRef: 'agent:cody:project:hrc-runtime:task:T-07194',
          laneRef: 'default',
          generation: 1,
          category: 'runtime',
          eventKind: 'runtime.competing_commit',
          payload: {},
        })
    )

    expect(event.hrcSeq).toBeGreaterThan(0)
  })
})
