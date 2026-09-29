/**
 * Task-claim handling and the summon authority entry points for the summon gate
 * server. Split out of `summon-gate-server.ts`.
 */

import { HrcConflictError, HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { BirthDesignationEstablishmentDecision } from 'hrc-core'
import type { SessionTaskClaimAuthority } from 'hrc-store-sqlite'

import { assertLocalPersonaAllowed } from '../local-persona-policy.js'
import { writeServerLog } from '../server-log.js'
import { withScopeSummonLock, withSessionMintLock } from './authority-lock.js'
import { establishLocalPlacement } from './establishment.js'
import { RegistryRefusedError } from './registry-client.js'
import { type SummonGateServerContext, gateDepsFor } from './summon-gate-server-context.js'
import type {
  SummonAuthorityRequest,
  SummonAuthorityResult,
} from './summon-gate-server-placement.js'
import { DIRECTIVE_REFUSAL_CODES } from './summon-gate-server-preflight.js'
import { type SummonGateDeps, type SummonGateResult, evaluateSummonGate } from './summon-gate.js'
import {
  type TaskClaimAuthority,
  type TaskClaimClient,
  createTaskClaimClient,
  taskClaimRequestForScope,
} from './task-claim-client.js'

function claimClientFor(server: SummonGateServerContext): TaskClaimClient {
  return server.taskClaimClient ?? createTaskClaimClient()
}

async function releaseClaimBestEffort(
  server: SummonGateServerContext,
  authority: TaskClaimAuthority,
  phase: 'establishment' | 'session-mint'
): Promise<void> {
  const parsed = taskClaimRequestForScope(authority.claimedScope)
  if (parsed === undefined) {
    writeServerLog('ERROR', 'federation.claim_birth.release_failed', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
      diagnostic: 'persisted claimedScope is not a project task scope',
      staleClaim: true,
    })
    return
  }
  try {
    await claimClientFor(server).release(authority, parsed.projectId)
    writeServerLog('INFO', 'federation.claim_birth.released_after_failure', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
    })
  } catch (error) {
    writeServerLog('ERROR', 'federation.claim_birth.release_failed', {
      taskId: authority.taskId,
      claimedNode: authority.claimedNode,
      claimGeneration: authority.claimGeneration,
      phase,
      diagnostic: error instanceof Error ? error.message : String(error),
      staleClaim: true,
    })
  }
}

/** Persist bearer authority beside, never inside, the public session record. */
export function persistSessionTaskClaimAuthority(
  server: SummonGateServerContext,
  hostSessionId: string,
  authority: TaskClaimAuthority,
  createdAt: string
): SessionTaskClaimAuthority {
  return server.db.sessionTaskClaimAuthorities.insert({
    hostSessionId,
    taskId: authority.taskId,
    claimedBy: authority.claimedBy,
    claimedScope: authority.claimedScope,
    claimedNode: authority.claimedNode,
    claimedAt: authority.claimedAt,
    claimGeneration: authority.claimGeneration,
    claimToken: authority.claimToken,
    createdAt,
  })
}

async function commitAuthorizedEstablishment(input: {
  deps: SummonGateDeps
  request: SummonAuthorityRequest
  mode: SummonGateResult['mode']
  homeNodeId: string
  birthDesignation?: BirthDesignationEstablishmentDecision | undefined
  label: 'policy'
}): Promise<void> {
  let established: Awaited<ReturnType<typeof establishLocalPlacement>>
  try {
    established = await establishLocalPlacement({
      registry: input.deps.registry,
      ledger: input.deps.ledger,
      request: {
        scopeRef: input.request.scopeRef,
        homeNodeId: input.homeNodeId,
        ...(input.birthDesignation === undefined
          ? {}
          : { birthDesignation: input.birthDesignation }),
        now: new Date().toISOString(),
      },
    })
  } catch (error) {
    const refused = error instanceof RegistryRefusedError
    const detail = error instanceof Error ? error.message : String(error)
    const reason = refused ? 'registry-refused' : 'registry-unreachable'
    const retryable = !refused
    const diagnostic = refused
      ? `The binding registry refused ${input.label} establishment for ${input.request.scopeRef} (${detail}). Check this node's peer entry and bearer token in federation.json.`
      : `Cannot establish ${input.label} authority for ${input.request.scopeRef} at the binding registry (${detail}). Refusing to mint without a collective binding; retry once the registry is reachable.`
    writeServerLog('WARN', 'federation.summon_gate.refusal', {
      path: input.request.path,
      scopeRef: input.request.scopeRef,
      reason,
      wouldBeDecision: 'refuse',
      enforced: true,
      mode: input.mode,
      retryable,
      localNodeId: input.deps.localNodeId,
      intent: input.request.intent,
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason,
      retryable,
    })
  }

  if (established.outcome === 'designation-mismatch') {
    // The establish fence (T-07655). Reaching it means this node resolved a
    // tier-5 designated birth and the registry had already designated a
    // DIFFERENT node — a designation that changed under a slow local pass. It
    // is deliberately not `bound-elsewhere`: nothing was born, so an operator
    // reading it must not go looking for a binding that does not exist.
    const designation = established.designation
    const diagnostic = `${input.request.scopeRef} is designated to be born on ${designation.homeNodeId} (following ${designation.senderScopeRef}, birth envelope ${designation.birthEnvelopeId}); this node is ${input.deps.localNodeId} and its tier-5 birth was refused. ${designation.homeNodeId} births it from the same ledger insert; an explicit start, a pin, or a +node= dispatch supersedes the designation.`
    writeServerLog('WARN', 'federation.summon_gate.refusal', {
      path: input.request.path,
      scopeRef: input.request.scopeRef,
      reason: 'birth-designation-mismatch',
      wouldBeDecision: 'refuse',
      enforced: true,
      mode: input.mode,
      retryable: false,
      localNodeId: input.deps.localNodeId,
      homeNodeId: designation.homeNodeId,
      designationEpoch: designation.designationEpoch,
      intent: input.request.intent,
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason: 'birth-designation-mismatch',
      retryable: false,
      homeNodeId: designation.homeNodeId,
      birthDesignation: designation,
    })
  }

  if (established.outcome === 'bound-elsewhere') {
    const diagnostic = `${input.request.scopeRef} became bound on ${established.binding.homeNodeId} while ${input.label} establishment was being committed on ${input.deps.localNodeId}; the existing birth wins. Summon it on ${established.binding.homeNodeId}.`
    writeServerLog('WARN', 'federation.summon_gate.refusal', {
      path: input.request.path,
      scopeRef: input.request.scopeRef,
      reason: 'bound-elsewhere',
      wouldBeDecision: 'refuse',
      enforced: true,
      mode: input.mode,
      retryable: false,
      localNodeId: input.deps.localNodeId,
      homeNodeId: established.binding.homeNodeId,
      intent: input.request.intent,
      diagnostic,
    })
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, diagnostic, {
      scopeRef: input.request.scopeRef,
      path: input.request.path,
      reason: 'bound-elsewhere',
      retryable: false,
      homeNodeId: established.binding.homeNodeId,
    })
  }
}

/**
 * Asks the gate whether this node may summon `scopeRef`, and enforces the
 * answer only when the flag says to.
 *
 * Advisory mode returns normally after logging the would-be refusal — the
 * caller proceeds exactly as it did before this task existed.
 */
async function assertAuthority(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest,
  participantClaim: boolean
): Promise<SummonAuthorityResult | undefined> {
  assertLocalPersonaAllowed(server, request.scopeRef)
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const result = await evaluateSummonGate({
    scopeRef: request.scopeRef,
    path: request.path,
    // Absent ⇒ implicit (spec §5). The default lives here, at the one seam
    // every path funnels through, so no call site can pick a different one.
    intent: request.intent ?? 'implicit',
    ...(participantClaim ? { participantClaim: true } : {}),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    ...(request.knownSession === undefined ? {} : { knownSession: request.knownSession }),
    // A direct participant supplies its own process. Its address claim still
    // needs the registry-first placement decision, but HRC's ability to launch
    // the profile's harness is irrelevant to that already hosted process.
    deps: participantClaim ? { ...deps, capabilityFor: undefined } : deps,
    ...(request.capabilityHint === undefined ? {} : { capabilityHint: request.capabilityHint }),
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })

  if (result.enforced && result.evaluation.decision === 'refuse') {
    // Directive refusals keep their own typed codes here too: the dm/ensure
    // door must not report a mistyped node as `stale_context` when the
    // exact/suffix door reports it as `unknown_node`.
    const directiveCode = DIRECTIVE_REFUSAL_CODES[result.evaluation.reason]
    if (directiveCode !== undefined) {
      throw new HrcDomainError(directiveCode, result.evaluation.diagnostic, {
        scopeRef: request.scopeRef,
        path: request.path,
        reason: result.evaluation.reason,
        retryable: result.evaluation.retryable,
        ...(result.evaluation.homeNodeId === undefined
          ? {}
          : { homeNodeId: result.evaluation.homeNodeId }),
      })
    }
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, result.evaluation.diagnostic, {
      scopeRef: request.scopeRef,
      path: request.path,
      reason: result.evaluation.reason,
      retryable: result.evaluation.retryable,
      ...(result.evaluation.homeNodeId === undefined
        ? {}
        : { homeNodeId: result.evaluation.homeNodeId }),
      ...(result.evaluation.capability === undefined
        ? {}
        : { capability: result.evaluation.capability }),
      ...(result.evaluation.capabilitySource === undefined
        ? {}
        : { capability_source: result.evaluation.capabilitySource }),
      // Carried so the kicker can report a deferral ONCE per designation epoch
      // instead of once per wake, and can name the sender an operator would
      // otherwise have to reconstruct from the ledger by hand (T-07655).
      ...(result.evaluation.birthDesignation === undefined
        ? {}
        : { birthDesignation: result.evaluation.birthDesignation }),
    })
  }

  // Registry-first establishment deliberately admits this crash window: the
  // collective binding committed but the daemon stopped before its local row.
  // The consulted binding is the authority; install that exact row before the
  // caller can mint a session. This also preserves an existing policy birth
  // when a valid child credential arrives after another node won first birth.
  if (
    result.evaluation.decision === 'allow' &&
    result.evaluation.reason === 'registry-bound-local' &&
    result.evaluation.registryBinding !== undefined
  ) {
    deps.ledger.installActive(result.evaluation.registryBinding)
  }

  if (
    result.evaluation.decision === 'allow' &&
    result.evaluation.reason === 'virgin-establishment' &&
    result.evaluation.homeNodeId !== undefined
  ) {
    await commitAuthorizedEstablishment({
      deps,
      request,
      mode: result.mode,
      homeNodeId: result.evaluation.homeNodeId,
      ...(result.evaluation.birthDesignation === undefined
        ? {}
        : { birthDesignation: result.evaluation.birthDesignation }),
      label: 'policy',
    })
  }

  return result
}

export async function assertSummonAuthority(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest
): Promise<SummonAuthorityResult | undefined> {
  return await assertAuthority(server, request, false)
}

/** Session-mint boundary: unwind fresh claim authority if provisioning fails. */
async function withAuthority<T>(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest,
  mint: (claimAuthority: TaskClaimAuthority | undefined) => T | Promise<T>,
  participantClaim: boolean
): Promise<T> {
  return await withScopeSummonLock(server as object, request.scopeRef, async () => {
    const authorizeAndMint = async () => {
      const authority = await assertAuthority(server, request, participantClaim)
      try {
        return await mint(authority?.claimAuthority)
      } catch (error) {
        if (authority?.claimAuthority !== undefined) {
          await releaseClaimBestEffort(server, authority.claimAuthority, 'session-mint')
        }
        throw error
      }
    }
    return request.laneRef === undefined
      ? await authorizeAndMint()
      : await withSessionMintLock(
          server as object,
          request.scopeRef,
          request.laneRef,
          authorizeAndMint
        )
  })
}

export async function withSummonAuthority<T>(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest,
  mint: (claimAuthority: TaskClaimAuthority | undefined) => T | Promise<T>
): Promise<T> {
  return await withAuthority(server, request, mint, false)
}

/** Registry-first authority for an address served by an external participant. */
export async function withParticipantAddressAuthority<T>(
  server: SummonGateServerContext,
  address: { scopeRef: string; laneRef: string },
  mint: (claimAuthority: TaskClaimAuthority | undefined) => T | Promise<T>
): Promise<T> {
  return await withAuthority(
    server,
    { ...address, path: 'resolve-session', intent: 'explicit_local' },
    mint,
    true
  )
}
