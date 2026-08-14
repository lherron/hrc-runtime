import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  CollectiveHistoryReplicationRepository,
  CollectiveHistoryRepository,
} from './collective-history-repository.js'
import { ExternalRegistrationGrantRepository } from './external-registration-grant-repository.js'
import { FederationAcceptedRequestRepository } from './federation-accepted-request-repository.js'
import { FederationOutboxRepository } from './federation-outbox-repository.js'
import { FederationPeerAcceptanceRepository } from './federation-peer-acceptance-repository.js'
import { ScopeRetirementRepository } from './federation-reconciliation.js'
import { HrcMailDriveRepository } from './mail/drive-repository.js'
import { HrcMailEnvelopeRepository } from './mail/envelope-repository.js'
import { HrcMailFederatedOriginRepository } from './mail/federated-origin-repository.js'
import { HrcMailStopRefusalRepository } from './mail/stop-refusal-repository.js'
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
import { FirstTurnWatchRepository } from './repositories/first-turn-watch-repository.js'
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
import { SteerContributionRepository } from './repositories/steer-contribution-repository.js'
import { RosterClaimRepository } from './roster-claim-repository.js'
import { SessionIndexRepository } from './session-index-repository.js'
import { SessionTaskClaimAuthorityRepository } from './session-task-claim-repository.js'
import { type SqliteSlowStatement, instrumentSqliteStatements } from './statement-telemetry.js'

export type OpenHrcDatabaseOptions = {
  busyTimeoutMs?: number | undefined
  slowStatementThresholdMs?: number | undefined
  onSlowStatement?: ((statement: SqliteSlowStatement) => void) | undefined
}

export type HrcDatabase = {
  sqlite: Database
  close(): void
  migrations: {
    applied: string[]
  }
  continuities: ContinuityRepository
  sessions: SessionRepository
  sessionIndex: SessionIndexRepository
  sessionTaskClaimAuthorities: SessionTaskClaimAuthorityRepository
  rosterClaims: RosterClaimRepository
  externalRegistrationGrants: ExternalRegistrationGrantRepository
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
  collectiveHistory: CollectiveHistoryRepository
  collectiveHistoryReplications: CollectiveHistoryReplicationRepository
  mailEnvelopes: HrcMailEnvelopeRepository
  mailFederatedOrigins: HrcMailFederatedOriginRepository
  mailDrives: HrcMailDriveRepository
  mailStopRefusals: HrcMailStopRefusalRepository
  federationAcceptedRequests: FederationAcceptedRequestRepository
  federationPeerAcceptances: FederationPeerAcceptanceRepository
  federationOutbox: FederationOutboxRepository
  scopeRetirements: ScopeRetirementRepository
  compiledRuntimePlans: CompiledRuntimePlanRepository
  lifecyclePolicies: LifecyclePolicyRepository
  runtimeOperations: RuntimeOperationRepository
  brokerInvocations: BrokerInvocationRepository
  steerContributions: SteerContributionRepository
  brokerInvocationEvents: BrokerInvocationEventRepository
  runtimeArtifacts: RuntimeArtifactRepository
  permissionDecisions: PermissionDecisionRepository
  firstTurnWatch: FirstTurnWatchRepository
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000

function resolveBusyTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_BUSY_TIMEOUT_MS
}

export function createHrcDatabase(
  path: string,
  options: Pick<OpenHrcDatabaseOptions, 'busyTimeoutMs'> = {}
): Database {
  if (!isEphemeralPath(path)) {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path)
  db.exec(`PRAGMA busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)};`)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

export function openHrcDatabase(dbPath: string, options: OpenHrcDatabaseOptions = {}): HrcDatabase {
  const rawSqlite = createHrcDatabase(dbPath, options)
  const sqlite =
    options.onSlowStatement === undefined
      ? rawSqlite
      : instrumentSqliteStatements(rawSqlite, {
          slowStatementThresholdMs: options.slowStatementThresholdMs ?? 250,
          onSlowStatement: options.onSlowStatement,
        })
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
    sessionIndex: new SessionIndexRepository(sqlite),
    sessionTaskClaimAuthorities: new SessionTaskClaimAuthorityRepository(sqlite),
    rosterClaims: new RosterClaimRepository(sqlite),
    externalRegistrationGrants: new ExternalRegistrationGrantRepository(sqlite),
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
    collectiveHistory: new CollectiveHistoryRepository(sqlite),
    collectiveHistoryReplications: new CollectiveHistoryReplicationRepository(sqlite),
    mailEnvelopes: new HrcMailEnvelopeRepository(sqlite),
    mailFederatedOrigins: new HrcMailFederatedOriginRepository(sqlite),
    mailDrives: new HrcMailDriveRepository(sqlite),
    mailStopRefusals: new HrcMailStopRefusalRepository(sqlite),
    federationAcceptedRequests: new FederationAcceptedRequestRepository(sqlite),
    federationPeerAcceptances: new FederationPeerAcceptanceRepository(sqlite),
    federationOutbox: new FederationOutboxRepository(sqlite),
    scopeRetirements: new ScopeRetirementRepository(sqlite),
    compiledRuntimePlans: new CompiledRuntimePlanRepository(sqlite),
    lifecyclePolicies: new LifecyclePolicyRepository(sqlite),
    runtimeOperations: new RuntimeOperationRepository(sqlite),
    brokerInvocations: new BrokerInvocationRepository(sqlite),
    steerContributions: new SteerContributionRepository(sqlite),
    brokerInvocationEvents: new BrokerInvocationEventRepository(sqlite),
    runtimeArtifacts: new RuntimeArtifactRepository(sqlite),
    permissionDecisions: new PermissionDecisionRepository(sqlite),
    firstTurnWatch: new FirstTurnWatchRepository(sqlite),
  }
}
