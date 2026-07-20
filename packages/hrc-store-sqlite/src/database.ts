import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { FederationAcceptedRequestRepository } from './federation-accepted-request-repository.js'
import { FederationOutboxRepository } from './federation-outbox-repository.js'
import { ScopeRetirementRepository } from './federation-reconciliation.js'
import { MessageRepository } from './message-repository.js'
import { listAppliedMigrations, runMigrations } from './migrations.js'
import {
  ActiveInputDeliveryRepository,
  LocalBridgeRepository,
  RuntimeBufferRepository,
  SurfaceBindingRepository,
} from './repositories/bridge-repositories.js'
import {
  BrokerInvocationEventRepository,
  BrokerInvocationRepository,
  CompiledRuntimePlanRepository,
  LifecyclePolicyRepository,
  PermissionDecisionRepository,
  RuntimeArtifactRepository,
  RuntimeOperationRepository,
} from './repositories/broker-repositories.js'
import { EventRepository, HrcLifecycleEventRepository } from './repositories/event-repositories.js'
import {
  LaunchRepository,
  RunRepository,
  RuntimeRepository,
} from './repositories/runtime-repositories.js'
import {
  AppManagedSessionRepository,
  AppSessionRepository,
  ContinuityRepository,
  SessionRepository,
} from './repositories/session-repositories.js'

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
  hrcEvents: HrcLifecycleEventRepository
  localBridges: LocalBridgeRepository
  surfaceBindings: SurfaceBindingRepository
  runtimeBuffers: RuntimeBufferRepository
  activeInputDeliveries: ActiveInputDeliveryRepository
  messages: MessageRepository
  federationAcceptedRequests: FederationAcceptedRequestRepository
  federationOutbox: FederationOutboxRepository
  scopeRetirements: ScopeRetirementRepository
  compiledRuntimePlans: CompiledRuntimePlanRepository
  lifecyclePolicies: LifecyclePolicyRepository
  runtimeOperations: RuntimeOperationRepository
  brokerInvocations: BrokerInvocationRepository
  brokerInvocationEvents: BrokerInvocationEventRepository
  runtimeArtifacts: RuntimeArtifactRepository
  permissionDecisions: PermissionDecisionRepository
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
    hrcEvents: new HrcLifecycleEventRepository(sqlite),
    localBridges: new LocalBridgeRepository(sqlite),
    surfaceBindings: new SurfaceBindingRepository(sqlite),
    runtimeBuffers: new RuntimeBufferRepository(sqlite),
    activeInputDeliveries: new ActiveInputDeliveryRepository(sqlite),
    messages: new MessageRepository(sqlite),
    federationAcceptedRequests: new FederationAcceptedRequestRepository(sqlite),
    federationOutbox: new FederationOutboxRepository(sqlite),
    scopeRetirements: new ScopeRetirementRepository(sqlite),
    compiledRuntimePlans: new CompiledRuntimePlanRepository(sqlite),
    lifecyclePolicies: new LifecyclePolicyRepository(sqlite),
    runtimeOperations: new RuntimeOperationRepository(sqlite),
    brokerInvocations: new BrokerInvocationRepository(sqlite),
    brokerInvocationEvents: new BrokerInvocationEventRepository(sqlite),
    runtimeArtifacts: new RuntimeArtifactRepository(sqlite),
    permissionDecisions: new PermissionDecisionRepository(sqlite),
  }
}
