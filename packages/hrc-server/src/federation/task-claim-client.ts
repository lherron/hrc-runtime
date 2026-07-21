import { parseScopeRef } from 'agent-scope'

export type TaskClaimAuthority = {
  taskId: string
  claimedBy: string
  claimedScope: string
  claimedNode: string
  claimedAt: string
  claimGeneration: number
  claimToken: string
}

export type TaskClaimRequest = {
  taskId: string
  principalRef: string
  scopeRef: string
  projectId: string
}

export interface TaskClaimClient {
  claim(request: TaskClaimRequest): Promise<TaskClaimAuthority>
  release(authority: TaskClaimAuthority, projectId: string): Promise<void>
}

export class TaskClaimCommandError extends Error {
  constructor(
    message: string,
    readonly operation: 'claim' | 'release',
    readonly exitCode?: number | undefined
  ) {
    super(message)
    this.name = 'TaskClaimCommandError'
  }
}

type SpawnResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type TaskClaimCommandRunner = (
  argv: readonly string[],
  env?: Record<string, string | undefined>
) => Promise<SpawnResult>

async function runCommand(
  argv: readonly string[],
  env?: Record<string, string | undefined>
): Promise<SpawnResult> {
  const process = Bun.spawn([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...globalThis.process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}

export function taskClaimCommandEnvironment(
  source: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  const db = source['HRC_WRKQ_DB']?.trim()
  if (db) {
    env['WRKQ_DB'] = db
    env['WRKQ_DB_PATH'] = undefined
    env['WRKQ_DB_PATH_FILE'] = undefined
  }
  const tokenFile = source['HRC_WRKQD_TOKEN_FILE']?.trim()
  if (tokenFile) {
    // wrkq intentionally gives WRKQD_TOKEN precedence over the file. A stale
    // operator-shell token must not shadow the daemon's explicit credential.
    env['WRKQD_TOKEN'] = undefined
    env['WRKQD_TOKEN_FILE'] = tokenFile
  }
  return env
}

function failureDiagnostic(operation: 'claim' | 'release', result: SpawnResult): string {
  const detail = result.stderr.trim()
  return detail.length > 0
    ? detail
    : `wrkq ${operation} exited ${result.exitCode} without a diagnostic`
}

function parseClaim(stdout: string): TaskClaimAuthority {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // Never echo stdout here: a successful claim response contains its bearer.
    throw new TaskClaimCommandError(
      'wrkq claim returned malformed JSON; the response was withheld because it may contain claim authority',
      'claim'
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskClaimCommandError('wrkq claim returned a non-object response', 'claim')
  }
  const row = parsed as Record<string, unknown>
  const task = row['task']
  const claimedBy = row['claimedBy']
  const claimedScope = row['claimedScope']
  const claimedNode = row['claimedNode']
  const claimedAt = row['claimedAt']
  const claimGeneration = row['claimGeneration']
  const claimToken = row['claimToken']
  if (
    typeof task !== 'string' ||
    typeof claimedBy !== 'string' ||
    typeof claimedScope !== 'string' ||
    typeof claimedNode !== 'string' ||
    typeof claimedAt !== 'string' ||
    typeof claimGeneration !== 'number' ||
    !Number.isSafeInteger(claimGeneration) ||
    claimGeneration < 1 ||
    typeof claimToken !== 'string' ||
    claimToken.length === 0
  ) {
    throw new TaskClaimCommandError(
      'wrkq claim response omitted required claim authority fields',
      'claim'
    )
  }
  return {
    taskId: task,
    claimedBy,
    claimedScope,
    claimedNode,
    claimedAt,
    claimGeneration,
    claimToken,
  }
}

/**
 * Process-bound client used deliberately instead of importing wrkq internals.
 * HRC remains behind its CLI/RPC boundary while still consuming structured JSON.
 */
export function createTaskClaimClient(
  options: {
    command?: string | undefined
    run?: TaskClaimCommandRunner | undefined
  } = {}
): TaskClaimClient {
  const command = options.command ?? process.env['HRC_WRKQ_COMMAND']?.trim() ?? 'wrkq'
  const run = options.run ?? runCommand
  return {
    async claim(request) {
      const result = await run(
        [
          command,
          '--project',
          request.projectId,
          '--as',
          request.principalRef,
          'claim',
          request.taskId,
          '--scope',
          request.scopeRef,
          '--json',
        ],
        taskClaimCommandEnvironment()
      )
      if (result.exitCode !== 0) {
        throw new TaskClaimCommandError(
          failureDiagnostic('claim', result),
          'claim',
          result.exitCode
        )
      }
      const authority = parseClaim(result.stdout)
      if (
        authority.taskId !== request.taskId ||
        authority.claimedBy !== request.principalRef ||
        authority.claimedScope !== request.scopeRef
      ) {
        throw new TaskClaimCommandError(
          'wrkq claim returned authority for a different task, principal, or scope',
          'claim'
        )
      }
      return authority
    },

    async release(authority, projectId) {
      const result = await run(
        [
          command,
          '--project',
          projectId,
          '--as',
          authority.claimedBy,
          'release',
          authority.taskId,
          '--scope',
          authority.claimedScope,
          '--json',
        ],
        {
          ...taskClaimCommandEnvironment(),
          WRKQ_CLAIM_TOKEN: authority.claimToken,
          WRKQ_CLAIM_GENERATION: String(authority.claimGeneration),
        }
      )
      if (result.exitCode !== 0) {
        throw new TaskClaimCommandError(
          failureDiagnostic('release', result),
          'release',
          result.exitCode
        )
      }
    },
  }
}

export function taskClaimRequestForScope(scopeRef: string): TaskClaimRequest | undefined {
  let parsed: ReturnType<typeof parseScopeRef>
  try {
    parsed = parseScopeRef(scopeRef)
  } catch {
    return undefined
  }
  if (parsed.projectId === undefined || parsed.taskId === undefined) return undefined
  return {
    taskId: parsed.taskId,
    principalRef: `agent:${parsed.agentId}`,
    scopeRef,
    projectId: parsed.projectId,
  }
}
