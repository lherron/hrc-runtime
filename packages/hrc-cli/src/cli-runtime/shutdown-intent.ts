import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import { parseScopeRef } from 'agent-scope'
import { resolveRuntimeRoot, splitSessionRef } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

export type ServerLifecycleCallerKind = 'operator' | 'operator-agent' | 'primary' | 'seat'

/**
 * Attribution for a daemon stop/restart. The CLI process that runs
 * `hrc server stop|restart` knows who is asking (HRC_SESSION_REF / HRC_RUN_ID
 * from its env), but it tears the daemon down with a bare SIGTERM — a signal
 * carries no payload, and the launchd-supervised daemon's own env is fixed, so
 * it cannot otherwise learn the initiator. We hand the identity over via a
 * short-lived intent file the daemon consumes in its shutdown handler.
 */
export type ShutdownIntent = {
  action: 'stop' | 'restart'
  callerKind: ServerLifecycleCallerKind | null
  requestedBy: string | null
  requestedRunId: string | null
  reason: string | null
  byPid: number
  at: string
}

export type ServerLifecycleAuthorization =
  | {
      allowed: true
      callerKind: ServerLifecycleCallerKind
      requestedBy: string | null
      reason: string | null
    }
  | {
      allowed: false
      message: string
    }

const SERVER_LIFECYCLE_ENVELOPE_KEYS = [
  'HRC_SESSION_REF',
  'HRC_RUN_ID',
  'ASP_SCOPE_REF',
  'ASP_TASK_ID',
  'ASP_DEFAULT_TASK',
  'ASP_HANDLE',
  // T-08576 D11: HRC emits host-session and generation identity on every
  // correlated birth, including app harnesses that carry no session ref. Their
  // presence is an envelope, so a sessionless one fails closed (T-05999 cond. 1).
  'HRC_HOST_SESSION_ID',
  'AGENT_HOST_SESSION_ID',
  'HRC_GENERATION',
  'AGENT_GENERATION',
] as const

function normalizedOptionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

export type OperatorResolver = (agentId: string) => Promise<boolean> | boolean

/**
 * T-08597: the operator flag is ASP profile interpretation — observed from the
 * installed daemon (`POST /v1/placements/resolve` → identity.operator), never
 * parsed from `agent-profile.toml` in-process. Unreachable daemon or unresoved
 * agent fails closed to `false`: missing operator evidence grants no
 * operator-agent exception (declaration-observation-consumer law).
 */
export async function defaultOperatorResolver(agentId: string): Promise<boolean> {
  let client: HrcClient
  try {
    client = new HrcClient(discoverSocket())
  } catch {
    return false
  }
  try {
    const response = await client.resolvePlacement({ agentId, runMode: 'task' })
    return response.identity.operator === true
  } catch {
    return false
  }
}

async function callerAgentIsOperator(
  agentId: string,
  resolveOperator: OperatorResolver
): Promise<boolean> {
  try {
    return (await resolveOperator(agentId)) === true
  } catch {
    return false
  }
}

/**
 * Authorize a daemon lifecycle mutation from the caller's inherited runtime
 * envelope. A wholly absent envelope is an operator shell. Any present but
 * unparseable or internally inconsistent envelope fails closed.
 */
export async function evaluateServerLifecycleAuthorization(
  env: Readonly<Record<string, string | undefined>>,
  reason: string | undefined,
  options: { resolveOperator?: OperatorResolver | undefined } = {}
): Promise<ServerLifecycleAuthorization> {
  const requestedReason = normalizedOptionalText(reason)
  const sessionRef = env['HRC_SESSION_REF']
  const aspScopeRef = env['ASP_SCOPE_REF']
  const hasEnvelope = SERVER_LIFECYCLE_ENVELOPE_KEYS.some((key) => env[key] !== undefined)

  if (sessionRef === undefined && aspScopeRef === undefined) {
    if (hasEnvelope) {
      return {
        allowed: false,
        message:
          'refusing server lifecycle mutation: partial HRC/ASP session envelope; ' +
          'run from a clean operator shell or a recognized primary scope',
      }
    }
    return {
      allowed: true,
      callerKind: 'operator',
      requestedBy: null,
      reason: requestedReason,
    }
  }

  let scopeRef: string
  let requestedBy: string
  try {
    if (sessionRef !== undefined) {
      const parsed = splitSessionRef(sessionRef)
      scopeRef = parsed.scopeRef
      requestedBy = sessionRef
    } else {
      scopeRef = aspScopeRef as string
      parseScopeRef(scopeRef)
      requestedBy = scopeRef
    }
  } catch {
    return {
      allowed: false,
      message:
        'refusing server lifecycle mutation: malformed HRC/ASP session envelope; ' +
        'run from a clean operator shell or a recognized primary scope',
    }
  }

  if (aspScopeRef !== undefined && aspScopeRef !== scopeRef) {
    return {
      allowed: false,
      message: 'refusing server lifecycle mutation: inconsistent HRC_SESSION_REF and ASP_SCOPE_REF',
    }
  }

  let parsedScope: ReturnType<typeof parseScopeRef>
  try {
    parsedScope = parseScopeRef(scopeRef)
  } catch {
    return {
      allowed: false,
      message:
        'refusing server lifecycle mutation: malformed HRC/ASP session envelope; ' +
        'run from a clean operator shell or a recognized primary scope',
    }
  }

  const taskId = parsedScope.taskId
  for (const key of ['ASP_TASK_ID', 'ASP_DEFAULT_TASK'] as const) {
    const envelopeTask = normalizedOptionalText(env[key])
    if (envelopeTask !== null && envelopeTask !== taskId) {
      return {
        allowed: false,
        message: `refusing server lifecycle mutation: ${key} conflicts with caller scope`,
      }
    }
  }

  if (taskId === 'primary') {
    if (requestedReason === null) {
      return {
        allowed: false,
        message: 'primary-scoped server lifecycle mutations require --reason <text>',
      }
    }
    return {
      allowed: true,
      callerKind: 'primary',
      requestedBy,
      reason: requestedReason,
    }
  }

  if (
    await callerAgentIsOperator(
      parsedScope.agentId,
      options.resolveOperator ?? defaultOperatorResolver
    )
  ) {
    if (requestedReason === null) {
      return {
        allowed: false,
        message: 'operator-agent server lifecycle mutations require --reason <text>',
      }
    }
    return {
      allowed: true,
      callerKind: 'operator-agent',
      requestedBy,
      reason: requestedReason,
    }
  }

  if (taskId?.startsWith('T-')) {
    return {
      allowed: false,
      message: `task-scoped runtime ${scopeRef} may not stop or restart the HRC server; escalate to the project primary or an operator shell`,
    }
  }

  // T-07215 (Lance ruling 2026-08-11): a STANDING SEAT — a well-formed
  // envelope whose task key is neither 'primary' nor a T-XXXXX work task
  // (e.g. a node-operations seat like task:minisvc) — is a lifecycle
  // authority at the same bar as primary: mandatory --reason, full
  // shutdown-intent attribution. The T-05999/T-06007 ruled design only ever
  // denied WORK-TASK scopes; the previous catch-all denial of standing seats
  // was unruled, and on satellite nodes it left no in-band restart path at
  // all (primaries are homed elsewhere and restart is local-socket only).
  if (taskId !== undefined && taskId !== null && taskId !== '') {
    if (requestedReason === null) {
      return {
        allowed: false,
        message: 'seat-scoped server lifecycle mutations require --reason <text>',
      }
    }
    return {
      allowed: true,
      callerKind: 'seat',
      requestedBy,
      reason: requestedReason,
    }
  }

  return {
    allowed: false,
    message: `scoped runtime ${scopeRef} is not a recognized primary lifecycle authority; run from a clean operator shell or escalate to the project primary`,
  }
}

function shutdownIntentPath(): string {
  return `${resolveRuntimeRoot()}/shutdown-intent.json`
}

/**
 * Record who is initiating a stop/restart, just before signalling the daemon.
 * Best-effort: a failure here must never block the actual stop/restart.
 */
export function writeShutdownIntent(
  action: 'stop' | 'restart',
  attribution?: {
    callerKind?: ServerLifecycleCallerKind | null | undefined
    requestedBy?: string | null | undefined
    reason?: string | null | undefined
  }
): void {
  const intent: ShutdownIntent = {
    action,
    callerKind: attribution?.callerKind ?? null,
    requestedBy:
      attribution === undefined
        ? (process.env['HRC_SESSION_REF'] ?? null)
        : (attribution.requestedBy ?? null),
    requestedRunId: process.env['HRC_RUN_ID'] ?? null,
    reason: attribution?.reason ?? null,
    byPid: process.pid,
    at: new Date().toISOString(),
  }
  try {
    writeFileSync(shutdownIntentPath(), `${JSON.stringify(intent)}\n`)
  } catch {}
}

/**
 * Read and delete the shutdown intent, returning it only when fresh. Called by
 * the daemon's shutdown handler so it can attribute `server.shutting_down`. A
 * missing/stale file means the SIGTERM came from outside the CLI (manual kill,
 * launchctl, crash supervisor) — the caller logs that as an unattributed stop.
 */
export function consumeShutdownIntent(maxAgeMs = 30_000): ShutdownIntent | undefined {
  const path = shutdownIntentPath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    unlinkSync(path)
  } catch {}
  try {
    const intent = JSON.parse(raw) as ShutdownIntent
    const age = Date.now() - new Date(intent.at).getTime()
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return undefined
    }
    return intent
  } catch {
    return undefined
  }
}
