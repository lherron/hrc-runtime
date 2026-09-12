/**
 * Private, node-local desktop-thread registration (T-08294 §3–§4).
 *
 * This is integration plumbing on the internal callback socket, NOT a public
 * operator API and NOT generic EPR. The difference from
 * `/v1/registrations` (external-registration-*.ts) is deliberate and total:
 *
 *   EPR mints a RANDOM `reg-<hex>` scope from a configured class, hands out a
 *   one-time credential, runs a hello/established handshake over a participant
 *   socket, and expires on a TTL. None of that is wanted here. A desktop
 *   conversation must get a PERMANENT READABLE address that a person can type,
 *   keyed on evidence the desktop app already persists, with no credential, no
 *   handshake and no expiry.
 *
 * What IS reused, on purpose: the internal callback transport and its spool
 * (launch/callback-client.ts, launch/spool.ts), the shared scope-claim mutex, and
 * `lifecycleOwner: 'external'` — the one behavioral guard that keeps HRC from
 * killing, reaping or cold-restarting something it does not own.
 *
 * Ordering inside the mutex is load-bearing and mirrors the claim paths:
 *   1. native-key lookup (idempotency BEFORE any allocation, so a duplicate
 *      registration can never consume a second readable name),
 *   2. slot allocation + session mint + reservation row in ONE transaction,
 *   3. mutex released only after the reservation is committed, so the next
 *      registrant — and every ordinary exact/suffix claimant — observes it.
 */

import { homedir } from 'node:os'

import { parseScopeRef } from 'agent-scope'
import { HrcBadRequestError, HrcErrorCode, type WrkqProjectRegistryEntry } from 'hrc-core'
import type { DesktopThreadRegistration } from 'hrc-store-sqlite'

import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

import { withScopeClaimMutex } from '../scope-claim-core.js'
import { writeServerLog } from '../server-log.js'
import { createHostSessionId, timestamp } from '../server-util.js'
import {
  DESKTOP_AGENT_ID,
  DESKTOP_LANE_REF,
  admitDesktopThread,
  canonicalPath,
  desktopRegistrationKey,
  isArchivedRolloutPath,
  isNativeThreadId,
  parseDesktopSessionMeta,
  resolveDesktopHomeIdentity,
} from './native-identity.js'
import {
  type DesktopAttachmentDisposition,
  scheduleDesktopObserverAttachment,
} from './observer-supervisor.js'
import { desktopHomeFamily, ensureDesktopPlacement } from './placement.js'
import { resolveDesktopProjectBinding } from './project-binding.js'
import { allocateDesktopSlot, desktopSlotAvailability } from './scope-reservation.js'

/**
 * What the hook helper reports. Every field is evidence the helper observed in
 * desktop's own process; none of it is an instruction about identity.
 */
export type DesktopRegistrationRequest = {
  readonly nativeThreadId: string
  /** The rollout JSONL desktop persists for this thread (hook `transcript_path`). */
  readonly rolloutPath?: string | undefined
  readonly codexHome?: string | undefined
  readonly sqliteHome?: string | undefined
  /** The workspace the hook reported. `session_meta.cwd` outranks it when present. */
  readonly workspaceCwd?: string | undefined
  /** Compatibility metadata only — never part of identity. */
  readonly bundleExecutable?: string | undefined
  readonly bundleVersion?: string | undefined
  /** `startup` | `resume` | `user-prompt-submit`; recorded for the boundary report. */
  readonly hookSource?: string | undefined
  /** The UUID-style address this conversation used before registration. */
  readonly legacyScopeRef?: string | undefined
}

export type DesktopScopeCache = {
  readonly scopeRef: string
  readonly agentId: string
  readonly projectId: string
  readonly slotToken: string
  readonly laneRef: string
  readonly hostSessionId: string
  readonly nativeThreadId: string
  readonly homeIdentity: string
  readonly projectRoot: string
  readonly registeredAt: string
}

export type DesktopRegistrationResponse =
  | {
      readonly status: 'registered'
      readonly cache: DesktopScopeCache
      readonly created: boolean
      readonly observation: { readonly state: string; readonly detail?: string | undefined }
      readonly attachment: DesktopAttachmentDisposition
    }
  | {
      readonly status: 'pending'
      readonly reason: string
      readonly detail: string
    }

function malformed(message: string, field?: string): never {
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    message,
    field === undefined ? {} : { field }
  )
}

export function parseDesktopRegistrationRequest(input: unknown): DesktopRegistrationRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    malformed('request body must be an object')
  }
  const body = input as Record<string, unknown>
  const allowed = new Set([
    'nativeThreadId',
    'rolloutPath',
    'codexHome',
    'sqliteHome',
    'workspaceCwd',
    'bundleExecutable',
    'bundleVersion',
    'hookSource',
    'legacyScopeRef',
  ])
  const unsupported = Object.keys(body).find((field) => !allowed.has(field))
  if (unsupported !== undefined) {
    malformed(`unsupported desktop registration field "${unsupported}"`, unsupported)
  }
  if (!isNativeThreadId(body['nativeThreadId'])) {
    malformed('nativeThreadId must be a native desktop thread UUID', 'nativeThreadId')
  }
  const optionalString = (field: string): string | undefined => {
    const value = body[field]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') malformed(`${field} must be a string`, field)
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  return {
    nativeThreadId: body['nativeThreadId'],
    ...maybe('rolloutPath', optionalString('rolloutPath')),
    ...maybe('codexHome', optionalString('codexHome')),
    ...maybe('sqliteHome', optionalString('sqliteHome')),
    ...maybe('workspaceCwd', optionalString('workspaceCwd')),
    ...maybe('bundleExecutable', optionalString('bundleExecutable')),
    ...maybe('bundleVersion', optionalString('bundleVersion')),
    ...maybe('hookSource', optionalString('hookSource')),
    ...maybe('legacyScopeRef', optionalString('legacyScopeRef')),
  }
}

function maybe<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>)
}

/** Read the first line of a rollout without loading a multi-megabyte transcript. */
async function readFirstRolloutLine(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return undefined
    // Rollout `session_meta` lines carry the full base instructions, so the
    // first record is large — but bounded. 256 KiB covers every observed header
    // and refuses to page in a whole conversation.
    const head = await file.slice(0, 256 * 1024).text()
    const newline = head.indexOf('\n')
    return newline === -1 ? head : head.slice(0, newline)
  } catch {
    return undefined
  }
}

/**
 * Register (or re-return) the permanent mapping for one desktop conversation.
 *
 * Never throws for an unregisterable conversation: an unresolved project, an
 * absent rollout or a guardian thread all return `pending` with a nameable
 * reason, because the hook must be able to keep the LEGACY behavior and report
 * "integration pending" rather than fail Lance's turn (§4).
 */
export async function registerDesktopThread(
  this: HrcServerInstanceForHandlers,
  request: DesktopRegistrationRequest,
  options: {
    /** Test seam; production reads `wrkq projects --json` through the daemon cache. */
    readonly registryProjects?: readonly WrkqProjectRegistryEntry[] | undefined
  } = {}
): Promise<DesktopRegistrationResponse> {
  const home = resolveDesktopHomeIdentity({
    ...(request.codexHome === undefined ? {} : { codexHome: request.codexHome }),
    ...(request.sqliteHome === undefined ? {} : { sqliteHome: request.sqliteHome }),
    ...(request.rolloutPath === undefined ? {} : { rolloutPath: request.rolloutPath }),
    homeDir: process.env['HOME'] ?? homedir(),
  })
  if ('unresolved' in home) {
    return { status: 'pending', reason: 'home_unresolved', detail: home.unresolved }
  }

  const registrationKey = desktopRegistrationKey(home.homeIdentity, request.nativeThreadId)

  // Idempotency FIRST. A duplicate registration — the same conversation hitting
  // both SessionStart and UserPromptSubmit, or reopening after a restart — must
  // return the SAME mapping, never allocate a second readable name.
  const existing = this.db.desktopThreadRegistrations.getByRegistrationKey(registrationKey)
  if (existing !== null) {
    const pending = await ensureDesktopPlacement(this, existing.scopeRef, registrationKey)
    if (pending !== undefined) return pending
    const now = timestamp()
    this.db.desktopThreadRegistrations.updateObservation(registrationKey, {
      ...(request.rolloutPath === undefined ? {} : { rolloutPath: request.rolloutPath }),
      ...(request.bundleExecutable === undefined ? {} : { bundlePath: request.bundleExecutable }),
      ...(request.bundleVersion === undefined ? {} : { bundleVersion: request.bundleVersion }),
      updatedAt: now,
    })
    writeServerLog('INFO', 'desktop_registration.replayed', {
      registrationKey,
      scopeRef: existing.scopeRef,
      nativeThreadId: existing.nativeThreadId,
      hookSource: request.hookSource,
    })
    // Re-registration is also the RECOVERY door. A conversation whose observer
    // died — daemon restart, broker crash, a `stop` that released only watcher
    // resources — reattaches here, on the same permanent address. §3 grants HRC
    // exactly this power over its own observer and no power at all over desktop.
    const attachment = scheduleDesktopObserverAttachment(this, existing)
    return {
      status: 'registered',
      created: false,
      cache: toCache(existing),
      observation: observationState(this, existing),
      attachment,
    }
  }

  if (
    request.rolloutPath !== undefined &&
    isArchivedRolloutPath(request.rolloutPath, home.homeIdentity)
  ) {
    return {
      status: 'pending',
      reason: 'archived_history',
      detail: `${request.rolloutPath} is archived session history; archived threads are never adopted`,
    }
  }

  // Native metadata is the ONLY admission authority. The compatibility readback
  // records that a freshly started thread may not have persisted a rollout yet,
  // so an absent header is a RETRYABLE pending, not a refusal — and certainly
  // not an excuse to admit an unvalidated thread.
  const firstLine =
    request.rolloutPath === undefined ? undefined : await readFirstRolloutLine(request.rolloutPath)
  if (firstLine === undefined) {
    return {
      status: 'pending',
      reason: 'native_metadata_unavailable',
      detail:
        request.rolloutPath === undefined
          ? 'no rollout path reported; registration needs native session metadata'
          : `rollout ${request.rolloutPath} is not yet readable; retry on the next hook`,
    }
  }
  const meta = parseDesktopSessionMeta(firstLine)
  if (meta === undefined) {
    return {
      status: 'pending',
      reason: 'native_metadata_unparsable',
      detail: `${request.rolloutPath} does not begin with a session_meta record`,
    }
  }
  if (meta.sessionId.toLowerCase() !== request.nativeThreadId.toLowerCase()) {
    return {
      status: 'pending',
      reason: 'native_thread_mismatch',
      detail: `rollout names thread ${meta.sessionId}, hook reported ${request.nativeThreadId}`,
    }
  }
  const admission = admitDesktopThread(meta)
  if (!admission.admitted) {
    writeServerLog('INFO', 'desktop_registration.refused', {
      registrationKey,
      nativeThreadId: request.nativeThreadId,
      reason: admission.reason,
      detail: admission.detail,
    })
    return { status: 'pending', reason: admission.reason, detail: admission.detail }
  }

  // `session_meta.cwd` is desktop's own record of the workspace it opened, so it
  // outranks anything the hook process computed for itself.
  const workspaceCwd = meta.cwd ?? request.workspaceCwd
  if (workspaceCwd === undefined) {
    return {
      status: 'pending',
      reason: 'workspace_unknown',
      detail: 'neither session_meta.cwd nor the hook reported a workspace',
    }
  }
  const binding = resolveDesktopProjectBinding({
    workspaceCwd,
    env: process.env,
    ...(options.registryProjects === undefined
      ? {}
      : { registryProjects: options.registryProjects }),
  })
  if ('pending' in binding) {
    writeServerLog('INFO', 'desktop_registration.project_pending', {
      registrationKey,
      nativeThreadId: request.nativeThreadId,
      workspaceCwd,
      reason: binding.reason,
      detail: binding.detail,
    })
    return { status: 'pending', reason: binding.reason, detail: binding.detail }
  }

  const projectId = binding.bound.projectId
  const family = await desktopHomeFamily(this, `agent:${DESKTOP_AGENT_ID}:project:${projectId}`)
  if ('status' in family) return family
  const record = await withScopeClaimMutex(
    this,
    `roster:${DESKTOP_AGENT_ID}:${projectId}`,
    async () => {
      // Re-read under the mutex: a concurrent registration of the SAME thread
      // may have committed between the lookup above and this point.
      const raced = this.db.desktopThreadRegistrations.getByRegistrationKey(registrationKey)
      if (raced !== null) return { record: raced, created: false }

      const slot = allocateDesktopSlot(this.db, DESKTOP_AGENT_ID, projectId, family.baseTask)
      const pending = await ensureDesktopPlacement(this, slot.scopeRef, registrationKey)
      if (pending !== undefined) return pending
      const now = timestamp()
      const hostSessionId = createHostSessionId()
      const registration: DesktopThreadRegistration = {
        registrationKey,
        homeIdentity: home.homeIdentity,
        sqliteHome: home.sqliteHome,
        nativeThreadId: request.nativeThreadId,
        scopeRef: slot.scopeRef,
        agentId: DESKTOP_AGENT_ID,
        projectId,
        slotToken: slot.slotToken,
        laneRef: DESKTOP_LANE_REF,
        hostSessionId,
        projectRoot: binding.bound.projectRoot,
        workspaceCwd: canonicalPath(workspaceCwd),
        ...(request.rolloutPath === undefined ? {} : { rolloutPath: request.rolloutPath }),
        ...(request.legacyScopeRef === undefined ? {} : { legacyScopeRef: request.legacyScopeRef }),
        ...(request.bundleExecutable === undefined ? {} : { bundlePath: request.bundleExecutable }),
        ...(request.bundleVersion === undefined ? {} : { bundleVersion: request.bundleVersion }),
        registeredVia: request.hookSource ?? 'unknown',
        createdAt: now,
        updatedAt: now,
      }
      const session = this.db.sqlite.transaction(() => {
        const inserted = this.db.sessions.insert({
          hostSessionId,
          scopeRef: slot.scopeRef,
          laneRef: DESKTOP_LANE_REF,
          generation: 1,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          parsedScopeJson: parseScopeRef(slot.scopeRef) as unknown as Record<string, unknown>,
          ancestorScopeRefs: [],
        })
        this.db.continuities.upsert({
          scopeRef: slot.scopeRef,
          laneRef: DESKTOP_LANE_REF,
          activeHostSessionId: hostSessionId,
          updatedAt: now,
        })
        this.db.desktopThreadRegistrations.insert(registration)
        return inserted
      })()

      this.notifyEvent(
        this.appendEvent(session, 'session.created', {
          created: true,
          reason: 'codex-desktop-registration',
          nativeThreadId: request.nativeThreadId,
          homeIdentity: home.homeIdentity,
          projectId,
          projectRoot: binding.bound.projectRoot,
          projectResolvedBy: binding.bound.resolvedBy,
          workspaceCwd: registration.workspaceCwd,
          slotToken: slot.slotToken,
          ...(request.legacyScopeRef === undefined
            ? {}
            : { previousComputedScope: request.legacyScopeRef }),
          ...(meta.cliVersion === undefined ? {} : { bundleVersion: meta.cliVersion }),
        })
      )
      writeServerLog('INFO', 'desktop_registration.allocated', {
        registrationKey,
        scopeRef: slot.scopeRef,
        slot: slot.slotToken,
        projectId,
        projectRoot: binding.bound.projectRoot,
        nativeThreadId: request.nativeThreadId,
        hookSource: request.hookSource,
      })
      return { record: registration, created: true }
    }
  )

  // Scheduled, never awaited: the permanent mapping is already committed, and a
  // slow or unavailable broker must cost the hook nothing.
  if ('status' in record) return record
  const attachment = scheduleDesktopObserverAttachment(this, record.record)
  return {
    status: 'registered',
    created: record.created,
    cache: toCache(record.record),
    observation: observationState(this, record.record),
    attachment,
  }
}

function toCache(record: DesktopThreadRegistration): DesktopScopeCache {
  return {
    scopeRef: record.scopeRef,
    agentId: record.agentId,
    projectId: record.projectId,
    slotToken: record.slotToken,
    laneRef: record.laneRef,
    hostSessionId: record.hostSessionId,
    nativeThreadId: record.nativeThreadId,
    homeIdentity: record.homeIdentity,
    projectRoot: record.projectRoot,
    registeredAt: record.createdAt,
  }
}

/**
 * Observation health, reported separately from the mapping (§5: "Persist and
 * expose separately: observer connection/health, last native activity, observed
 * turn state, queued submission status and desktop availability evidence").
 *
 * A registration with no attached observer is `unattached`, NOT `terminated`.
 * A quiet transcript proves neither process death nor a loaded idle thread, so
 * nothing here may be read as a statement about desktop.
 */
function observationState(
  server: HrcServerInstanceForHandlers,
  record: DesktopThreadRegistration
): { state: string; detail?: string | undefined } {
  const runtimes = server.db.runtimes
    .listByHostSessionId(record.hostSessionId)
    .filter((runtime) => runtime.status !== 'terminated' && runtime.status !== 'disposed')
  if (runtimes.length === 0) {
    return {
      state: 'unattached',
      detail: 'no observer runtime is attached; this says nothing about the desktop thread',
    }
  }
  return { state: 'attached' }
}

/** Reservation lookup used by the hook cache and by diagnostics. */
export function lookupDesktopRegistration(
  server: HrcServerInstanceForHandlers,
  input: { readonly homeIdentity: string; readonly nativeThreadId: string }
): DesktopThreadRegistration | null {
  return server.db.desktopThreadRegistrations.getByNativeKey(
    canonicalPath(input.homeIdentity),
    input.nativeThreadId
  )
}

/**
 * Test/diagnostic helper: is this exact scope still allocatable to a desktop
 * conversation? Exported so the concurrency and >10-name coverage can assert on
 * the same predicate the allocator uses rather than a restatement of it.
 */
export function desktopScopeAvailability(
  server: HrcServerInstanceForHandlers,
  scopeRef: string
): ReturnType<typeof desktopSlotAvailability> {
  return desktopSlotAvailability(server.db, scopeRef)
}

export const desktopRegistrationHandlersMethods = {
  registerDesktopThread,
}

export type DesktopRegistrationHandlersMethods = typeof desktopRegistrationHandlersMethods
