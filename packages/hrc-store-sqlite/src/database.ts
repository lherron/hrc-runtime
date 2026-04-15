import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { MessageRepository } from './message-repository.js'
import { listAppliedMigrations, runMigrations } from './migrations.js'
import {
  AppManagedSessionRepository,
  AppSessionRepository,
  ContinuityRepository,
  EventRepository,
  LaunchRepository,
  LocalBridgeRepository,
  RunRepository,
  RuntimeBufferRepository,
  RuntimeRepository,
  SessionRepository,
  SurfaceBindingRepository,
} from './repositories.js'

export type HrcDatabase = {
  sqlite: Database
  close(): void
  migrations: {
    applied: string[]
  }
  continuities: ContinuityRepository
  sessions: SessionRepository
  appManagedSessions: AppManagedSessionRepository
  appSessions: AppSessionRepository
  runtimes: RuntimeRepository
  runs: RunRepository
  launches: LaunchRepository
  events: EventRepository
  localBridges: LocalBridgeRepository
  surfaceBindings: SurfaceBindingRepository
  runtimeBuffers: RuntimeBufferRepository
  messages: MessageRepository
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

export function createHrcDatabase(path: string): Database {
  if (!isEphemeralPath(path)) {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

export function openHrcDatabase(dbPath: string): HrcDatabase {
  const sqlite = createHrcDatabase(dbPath)
  runMigrations(sqlite)

  return {
    sqlite,
    close() {
      sqlite.close()
    },
    migrations: {
      applied: listAppliedMigrations(sqlite),
    },
    continuities: new ContinuityRepository(sqlite),
    sessions: new SessionRepository(sqlite),
    appManagedSessions: new AppManagedSessionRepository(sqlite),
    appSessions: new AppSessionRepository(sqlite),
    runtimes: new RuntimeRepository(sqlite),
    runs: new RunRepository(sqlite),
    launches: new LaunchRepository(sqlite),
    events: new EventRepository(sqlite),
    localBridges: new LocalBridgeRepository(sqlite),
    surfaceBindings: new SurfaceBindingRepository(sqlite),
    runtimeBuffers: new RuntimeBufferRepository(sqlite),
    messages: new MessageRepository(sqlite),
  }
}
