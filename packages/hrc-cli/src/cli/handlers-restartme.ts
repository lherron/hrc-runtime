import { spawnSync } from 'node:child_process'

import { parseScopeRef } from 'agent-scope'
import { HrcErrorCode, splitSessionRef } from 'hrc-core'

import { isHrcDomainErrorLike } from './errors.js'
import { CliStatusExit, createClient, fatal, lifecycleCredentialHeaders } from './shared.js'

/**
 * T-09872 — `hrc restartme --handoff H-x | --cancel`. Self-only: the daemon
 * identifies the caller from its lifecycle credential and arms a restart that
 * fires when the caller's current turn ends. The handoff check here prevents
 * forgetting; it is not a security boundary (the daemon never calls wrkq).
 */

type CallerScope = { agentId: string; projectId: string }

function callerScope(): CallerScope | undefined {
  const sessionRef = process.env['HRC_SESSION_REF']?.trim()
  if (!sessionRef) return undefined
  try {
    const parsed = parseScopeRef(splitSessionRef(sessionRef).scopeRef)
    if (parsed.projectId === undefined) return undefined
    return { agentId: parsed.agentId, projectId: parsed.projectId }
  } catch {
    return undefined
  }
}

function refuse(code: string, message: string): never {
  process.stderr.write(`hrc: [${code}] ${message}\n`)
  throw new CliStatusExit(1)
}

function handoffRecipe(scope: CallerScope | undefined): string {
  const handle = scope === undefined ? '<agent>@<project>' : `${scope.agentId}@${scope.projectId}`
  return [
    'write a handoff for your successor first:',
    `  wrkq handoff create --scope ${handle} -t '<title>' --body-file - <<'EOF'`,
    '  <objective, decisions, durable evidence, remaining work, concrete next action>',
    '  EOF',
    'then rerun with --handoff <id>:',
    '  hrc restartme --handoff H-xxxxx',
  ].join('\n')
}

type WrkqHandoff = {
  id?: unknown
  status?: unknown
  agent_id?: unknown
  project_id?: unknown
  scope_ref?: unknown
}

function checkHandoff(handoffId: string, scope: CallerScope): void {
  const result = spawnSync('wrkq', ['handoff', 'get', handoffId, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    refuse(
      'handoff_unverified',
      `could not run wrkq to check ${handoffId}: ${result.error.message}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = undefined
  }
  const record = (parsed as { handoff?: WrkqHandoff } | undefined)?.handoff ?? parsed
  if (result.status !== 0 || record === null || typeof record !== 'object') {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? ''
    refuse('handoff_not_found', `wrkq has no handoff ${handoffId}${detail ? ` (${detail})` : ''}`)
  }
  const handoff = record as WrkqHandoff
  if (handoff.agent_id !== scope.agentId || handoff.project_id !== scope.projectId) {
    refuse(
      'handoff_scope_mismatch',
      `${handoffId} belongs to ${String(handoff.scope_ref ?? `${String(handoff.agent_id)}@${String(handoff.project_id)}`)}, not ${scope.agentId}@${scope.projectId}; ${handoffRecipe(scope)}`
    )
  }
  if (handoff.status !== 'pending') {
    refuse(
      'handoff_not_pending',
      `${handoffId} is ${String(handoff.status)}, not pending; ${handoffRecipe(scope)}`
    )
  }
}

export async function cmdRestartMe(opts: { handoff?: string; cancel?: boolean }): Promise<void> {
  const handoffId = opts.handoff?.trim()
  const cancel = opts.cancel === true
  if (cancel && handoffId !== undefined) fatal('--handoff and --cancel are mutually exclusive')
  const scope = callerScope()
  if (!cancel && !handoffId) {
    refuse(
      'handoff_required',
      `hrc restartme needs a pending wrkq handoff; ${handoffRecipe(scope)}`
    )
  }
  if (!cancel && handoffId !== undefined) {
    if (scope === undefined) {
      refuse(
        'not_an_agent_runtime',
        'hrc restartme restarts the calling agent runtime, and HRC_SESSION_REF names none'
      )
    }
    checkHandoff(handoffId, scope)
  }

  const client = createClient()
  const status = await client.getStatus()
  if (status.capabilities?.selfRestart !== true) {
    refuse(
      'self_restart_unsupported',
      `the running HRC daemon predates hrc restartme; ask mable@${scope?.projectId ?? '<project>'}:primary to restart it`
    )
  }

  let response: Awaited<ReturnType<typeof client.restartSelf>>
  try {
    response = await client.restartSelf(
      cancel ? { cancel: true } : { handoffId: handoffId as string },
      lifecycleCredentialHeaders(status.runtimeRoot)
    )
  } catch (error) {
    if (isHrcDomainErrorLike(error) && error.code === HrcErrorCode.SELF_RESTART_REFUSED) {
      const refusal = (error.detail as { refusal?: string } | undefined)?.refusal
      refuse(refusal ?? 'self_restart_refused', error.message)
    }
    if (isHrcDomainErrorLike(error) && error.code === HrcErrorCode.RUNTIME_UNAVAILABLE) {
      const reason = (error.detail as { reason?: string } | undefined)?.reason
      refuse(reason ?? 'runtime_unavailable', error.message)
    }
    throw error
  }

  if (response.outcome === 'armed') {
    process.stdout.write(
      `restart armed (handoff ${response.handoffId}); end your turn now — the restart happens when this turn ends.\n`
    )
    return
  }
  process.stdout.write(
    response.cancelled
      ? `restart cancelled (handoff ${response.handoffId}); this seat will not restart.\n`
      : 'no restart was armed; nothing to cancel.\n'
  )
}
