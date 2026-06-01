import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HrcBadRequestError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  HrcContinuationRef,
  HrcHarness,
  HrcLaunchArtifact,
  HrcLaunchPromptMaterial,
  HrcRuntimeIntent,
  HrcSessionRecord,
} from 'hrc-core'
import { buildCliInvocation } from './agent-spaces-adapter/index.js'
import {
  deriveInteractiveHarness,
  shouldUseGhosttyTransport,
} from './broker-decisions.js'
import { writeServerLog } from './server-log.js'

const WORKSPACE_ROOT = resolve(import.meta.dir, '..', '..', '..')

export function shellIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `invalid shell identifier "${value}"`,
      { value }
    )
  }

  return value
}

export function joinShellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ')
}

export function normalizeDispatchIntent(
  intent: HrcRuntimeIntent | undefined,
  session: HrcSessionRecord,
  runId: string
): HrcRuntimeIntent {
  if (!intent) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required when the session has no prior intent'
    )
  }

  const cwd =
    intent.placement?.cwd ??
    intent.placement?.projectRoot ??
    intent.placement?.agentRoot ??
    process.cwd()
  const projectRoot = intent.placement?.projectRoot ?? cwd
  const agentRoot = intent.placement?.agentRoot ?? projectRoot

  return {
    ...intent,
    placement: {
      ...intent.placement,
      agentRoot,
      projectRoot,
      cwd,
      runMode: intent.placement?.runMode ?? 'task',
      // Callers may legitimately omit a bundle; do not claim an agent identity here.
      bundle: intent.placement?.bundle ?? { kind: 'compose', compose: [] },
      dryRun: intent.placement?.dryRun ?? true,
      correlation: {
        sessionRef: {
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
        },
        hostSessionId: session.hostSessionId,
        runId,
      },
    },
  }
}

export async function buildDispatchInvocation(
  intent: HrcRuntimeIntent,
  options: {
    continuation?: HrcContinuationRef | undefined
  } = {}
): Promise<{
  argv: string[]
  env: Record<string, string>
  cwd: string
  frontend: HrcHarness
  interactionMode: 'headless' | 'interactive'
  ioMode: 'inherit' | 'pipes' | 'pty'
  prompts?: HrcLaunchPromptMaterial | undefined
  codexAppServer?: HrcLaunchArtifact['codexAppServer'] | undefined
}> {
  let env: Record<string, string> = {}
  let cwd = intent.placement.cwd ?? process.cwd()
  let interactionMode: 'headless' | 'interactive' = 'interactive'
  let ioMode: 'inherit' | 'pipes' | 'pty' = 'pty'
  let prompts: HrcLaunchPromptMaterial | undefined

  let buildError: unknown
  let unavailableCommand: string | undefined
  const invocationIntent = shouldUseGhosttyTransport(intent)
    ? {
        ...intent,
        harness: {
          ...intent.harness,
          interactive: true as const,
        },
      }
    : intent

  try {
    const invocation = await buildCliInvocation(invocationIntent, {
      ...(options.continuation ? { continuation: options.continuation } : {}),
    })
    env = invocation.env
    cwd = await resolveDispatchCwd(invocation.cwd, invocationIntent)
    interactionMode = invocation.interactionMode
    ioMode = invocation.ioMode
    prompts = invocation.prompts
    if (await isLaunchCommandAvailable(invocation.argv[0])) {
      return {
        argv: invocation.argv,
        env,
        cwd,
        frontend: invocation.frontend,
        interactionMode,
        ioMode,
        ...(prompts ? { prompts } : {}),
        ...(invocation.codexAppServer ? { codexAppServer: invocation.codexAppServer } : {}),
      }
    }
    unavailableCommand = invocation.argv[0]
    writeServerLog('WARN', 'dispatch.invocation.command_unavailable', {
      provider: invocation.provider,
      frontend: invocation.frontend,
      command: invocation.argv[0],
      cwd: invocation.cwd,
    })
  } catch (error) {
    if (error instanceof Error && /provider mismatch/i.test(error.message)) {
      throw new HrcUnprocessableEntityError(HrcErrorCode.PROVIDER_MISMATCH, error.message, {
        provider: intent.harness.provider,
        ...(options.continuation ? { continuationProvider: options.continuation.provider } : {}),
      })
    }

    buildError = error
    writeServerLog('WARN', 'dispatch.invocation.build_failed', {
      provider: intent.harness.provider,
      interactive: intent.harness.interactive,
      error,
    })
  }

  // Only fall through to the test harness shim when explicitly opted in. The
  // shim is an integration-test fixture — in production, a failed invocation
  // build or missing harness command should surface loudly instead of running
  // a placeholder that appears to succeed.
  if (process.env['HRC_ALLOW_HARNESS_SHIM'] !== '1') {
    if (buildError) {
      const detail = buildError instanceof Error ? buildError.message : String(buildError)
      throw new HrcRuntimeUnavailableError(`failed to build harness invocation: ${detail}`)
    }
    throw new HrcRuntimeUnavailableError(
      `harness command not found on PATH: ${unavailableCommand ?? '<unknown>'}`
    )
  }

  const shimPath = await findHarnessShimPath()
  if (!shimPath) {
    throw new HrcRuntimeUnavailableError('no interactive harness executable is available')
  }

  writeServerLog('WARN', 'dispatch.invocation.using_shim', {
    provider: intent.harness.provider,
    shimPath,
    cwd,
  })

  return {
    argv: [shimPath],
    env,
    cwd,
    frontend:
      intent.harness.id === 'pi' || intent.harness.id === 'pi-cli'
        ? 'pi-cli'
        : deriveInteractiveHarness(intent.harness),
    interactionMode,
    ioMode,
    ...(prompts ? { prompts } : {}),
  }
}

async function resolveDispatchCwd(preferredCwd: string, intent: HrcRuntimeIntent): Promise<string> {
  const preferredStats = await stat(preferredCwd).catch(() => null)
  if (preferredStats?.isDirectory()) {
    return preferredCwd
  }

  if (intent.placement.dryRun !== true) {
    return preferredCwd
  }

  const fallbackCwd = process.cwd()
  const fallbackStats = await stat(fallbackCwd).catch(() => null)
  if (fallbackStats?.isDirectory()) {
    writeServerLog('WARN', 'dispatch.invocation.cwd_missing_dry_run_fallback', {
      preferredCwd,
      fallbackCwd,
      provider: intent.harness.provider,
    })
    return fallbackCwd
  }

  return preferredCwd
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

async function isLaunchCommandAvailable(command: string | undefined): Promise<boolean> {
  if (!command) {
    return false
  }
  if (command.includes('/')) {
    const stats = await stat(command).catch(() => null)
    return stats?.isFile() === true
  }

  const pathEntries = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  for (const entry of pathEntries) {
    const candidate = join(entry, command)
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return true
    }
  }

  return false
}

async function findHarnessShimPath(): Promise<string | null> {
  const candidates = [
    join(WORKSPACE_ROOT, 'integration-tests/fixtures/hrc-shim/hrc-harness-shim.sh'),
    join(WORKSPACE_ROOT, 'integration-tests/fixtures/hrc-shim/harness'),
  ]

  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return candidate
    }
  }

  return null
}
