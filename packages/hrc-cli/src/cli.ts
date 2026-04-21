#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ancestorScopeRefs, resolveScopeInput } from 'agent-scope'

import { HrcDomainError, HrcErrorCode, resolveDatabasePath } from 'hrc-core'
import type {
  HrcLifecycleEvent,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcStatusResponse,
  HrcStatusSessionView,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'
import { buildCliInvocation } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import {
  type TargetDefinition,
  buildRuntimeBundleRef,
  getAgentsRoot,
  inferProjectIdFromCwd,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPlacementPaths,
  resolveAgentPrimingPrompt,
  resolveHarnessProvider,
} from 'spaces-config'
import { displayPrompts, formatDisplayCommand, renderKeyValueSection } from 'spaces-execution'
import { fatal, hasFlag, parseFlag, parseIntegerFlag, printJson, requireArg } from './cli-args.js'
import {
  collectServerRuntimeStatus,
  collectTmuxStatus,
  daemonizeAndWait,
  detectLaunchdOwner,
  execProcess,
  formatServerRuntimeStatus,
  formatTmuxStatus,
  launchctlKickstart,
  resolveServerMode,
  resolveServerPaths,
  stopServerProcess,
  writeServerProcessLog,
} from './cli-runtime.js'
import {
  type EventsOutputFormat,
  createEventsRenderer,
  resolveDefaultFormat,
} from './events-render.js'

// -- .env.local loading -------------------------------------------------------

/**
 * Load .env.local from cwd into process.env.
 * Existing env vars are NOT overwritten (env takes precedence).
 */
function loadDotEnvLocal(): void {
  const envPath = join(process.cwd(), '.env.local')
  let content: string
  try {
    content = readFileSync(envPath, 'utf8')
  } catch {
    return // no .env.local — nothing to do
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadDotEnvLocal()

// -- Helpers ------------------------------------------------------------------

function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

const EVENT_FOLLOW_POLL_MS = 250

function createDefaultRuntimeIntent(
  provider: 'anthropic' | 'openai',
  cwd = process.cwd(),
  preferredMode: 'headless' | 'interactive' | 'nonInteractive' = 'interactive'
): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: cwd,
      projectRoot: cwd,
      cwd,
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: true,
    },
    execution: {
      preferredMode,
    },
  }
}

function loadProjectTarget(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) return undefined
  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) return undefined
  return parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath).targets[targetName]
}

function resolveProviderForHarness(harness: string | undefined): 'anthropic' | 'openai' {
  return resolveHarnessProvider(harness) ?? 'anthropic'
}

function resolveProviderFromAgent(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): 'anthropic' | 'openai' {
  const projectTarget = loadProjectTarget(projectRoot, agentName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return resolveProviderForHarness(projectTarget?.harness)
  try {
    const source = readFileSync(profilePath, 'utf8').replace(
      /^(\s*)schema_version(\s*=)/m,
      '$1schemaVersion$2'
    )
    const profile = parseAgentProfile(source, profilePath)
    const primingPrompt = resolveAgentPrimingPrompt(profile, agentRoot)
    const effective = mergeAgentWithProjectTarget(
      {
        ...profile,
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
      },
      projectTarget,
      'task'
    )
    return resolveProviderForHarness(effective.harness)
  } catch {
    // Profile parse failed — fall back to default
  }
  return resolveProviderForHarness(projectTarget?.harness)
}

type ManagedScopeContext = {
  agentId: string
  projectId?: string | undefined
  scopeRef: string
  sessionRef: string
}

type ExecAttachDescriptor = {
  argv: string[]
  env?: Record<string, string> | undefined
}

function resolveManagedScopeContext(scopeInput: string): ManagedScopeContext {
  let { parsed, scopeRef, laneRef } = resolveScopeInput(scopeInput)

  if (!parsed.projectId) {
    const inferredProject = inferProjectIdFromCwd()
    if (inferredProject) {
      ;({ parsed, scopeRef, laneRef } = resolveScopeInput(`${scopeInput}@${inferredProject}`))
    }
  }

  const laneId = laneRef === 'main' ? 'main' : laneRef.slice(5)
  return {
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    scopeRef,
    sessionRef: `${scopeRef}/lane:${laneId}`,
  }
}

function buildManagedRuntimeIntent(
  scope: ManagedScopeContext,
  options: {
    preferredMode?: 'headless' | 'interactive' | 'nonInteractive' | undefined
    prompt?: string | undefined
    debug?: boolean | undefined
  } = {}
): HrcRuntimeIntent {
  const agentsRoot = getAgentsRoot()
  if (!agentsRoot) {
    throw new Error(
      'run requires an agents root.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.'
    )
  }

  const agentRoot = join(agentsRoot, scope.agentId)
  if (!existsSync(agentRoot)) {
    throw new Error(
      `agent "${scope.agentId}" not found at ${agentRoot}.\n` +
        `  Check the spelling, or confirm ASP_AGENTS_ROOT (${agentsRoot}) contains this agent.`
    )
  }

  const paths = resolveAgentPlacementPaths({
    agentId: scope.agentId,
    projectId: scope.projectId,
    agentRoot,
  })
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: scope.agentId,
    agentRoot,
    projectRoot,
  })
  const provider = resolveProviderFromAgent(agentRoot, scope.agentId, projectRoot)

  return {
    placement: {
      agentRoot,
      ...(projectRoot ? { projectRoot } : {}),
      cwd,
      runMode: 'task' as const,
      bundle,
    },
    harness: {
      provider,
      interactive: true,
    },
    execution: {
      preferredMode: options.preferredMode ?? ('interactive' as const),
    },
    ...(options.prompt !== undefined ? { initialPrompt: options.prompt } : {}),
    ...(options.debug ? { launch: { env: { HRC_DEBUG: '1' } } } : {}),
  }
}

function buildManagedRunIntent(
  scope: ManagedScopeContext,
  options: {
    prompt?: string | undefined
    debug?: boolean | undefined
  } = {}
): HrcRuntimeIntent {
  return buildManagedRuntimeIntent(scope, {
    ...options,
    preferredMode: 'interactive',
  })
}

function buildManagedStartIntent(
  scope: ManagedScopeContext,
  options: {
    prompt?: string | undefined
    debug?: boolean | undefined
  } = {}
): HrcRuntimeIntent {
  return buildManagedRuntimeIntent(scope, {
    ...options,
    preferredMode: 'headless',
  })
}

function buildManagedAttachIntent(scope: ManagedScopeContext): HrcRuntimeIntent {
  return buildManagedRuntimeIntent(scope, {
    preferredMode: 'interactive',
  })
}

async function parseScopePrompt(
  args: string[],
  options: {
    command: 'run' | 'start'
    passthroughFlags: string[]
  }
): Promise<string | undefined> {
  let prompt: string | undefined
  let source: 'positional' | '-p' | '--prompt-file' | undefined

  const setPrompt = (value: string, from: 'positional' | '-p' | '--prompt-file') => {
    if (prompt !== undefined) {
      fatal(
        source === from
          ? `${options.command} accepts at most one ${
              from === 'positional' ? 'positional prompt' : `${from} value`
            }`
          : `${options.command} prompt sources are mutually exclusive (${source} vs ${from})`
      )
    }
    prompt = value
    source = from
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (options.passthroughFlags.includes(arg)) {
      continue
    }

    if (arg === '-p') {
      const value = args[i + 1]
      if (value === undefined) fatal('-p requires a value')
      setPrompt(value, '-p')
      i += 1
      continue
    }

    if (arg === '--prompt-file') {
      const value = args[i + 1]
      if (value === undefined) fatal('--prompt-file requires a value')
      try {
        const contents = await Bun.file(value).text()
        setPrompt(contents, '--prompt-file')
      } catch (err) {
        fatal(
          `--prompt-file: cannot read ${value}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      i += 1
      continue
    }

    if (arg.startsWith('-')) {
      fatal(`unknown ${options.command} option: ${arg}`)
    }

    setPrompt(arg, 'positional')
  }

  return prompt
}

function isRuntimeUnavailableStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale'
}

function runtimeRecency(runtime: HrcRuntimeSnapshot): number {
  const updatedAt = Date.parse(runtime.updatedAt)
  if (Number.isFinite(updatedAt)) {
    return updatedAt
  }

  const createdAt = Date.parse(runtime.createdAt)
  return Number.isFinite(createdAt) ? createdAt : 0
}

function sortRuntimesByRecency(runtimes: HrcRuntimeSnapshot[]): HrcRuntimeSnapshot[] {
  return [...runtimes].sort((left, right) => runtimeRecency(left) - runtimeRecency(right))
}

function hasContinuation(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.continuation != null
}

function isHrcDomainErrorLike(
  err: unknown
): err is Pick<HrcDomainError, 'code' | 'message' | 'detail'> {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    'message' in err &&
    typeof err.message === 'string'
  )
}

export function selectLatestUsableRuntime(
  runtimes: HrcRuntimeSnapshot[]
): HrcRuntimeSnapshot | undefined {
  const usable = sortRuntimesByRecency(runtimes).filter(
    (runtime) => !isRuntimeUnavailableStatus(runtime.status)
  )
  const busyTmux = usable.filter(
    (runtime) => runtime.transport === 'tmux' && runtime.status === 'busy'
  )
  if (busyTmux.length > 0) {
    return busyTmux.at(-1)
  }

  const attachPreparedTmux = usable.filter(
    (runtime) =>
      runtime.transport === 'tmux' && runtime.harnessSessionJson?.['attachPrepared'] === true
  )
  if (attachPreparedTmux.length > 0) {
    return attachPreparedTmux.at(-1)
  }

  const headless = usable.filter((runtime) => runtime.transport === 'headless')
  if (headless.length > 0) {
    return headless.at(-1)
  }

  const resumable = usable.filter(hasContinuation)
  if (resumable.length > 0) {
    return resumable.at(-1)
  }

  return usable.at(-1)
}

function selectNextUsableRuntime(
  runtimes: HrcRuntimeSnapshot[],
  attemptedRuntimeIds: ReadonlySet<string>
): HrcRuntimeSnapshot | undefined {
  return selectLatestUsableRuntime(
    runtimes.filter((runtime) => !attemptedRuntimeIds.has(runtime.runtimeId))
  )
}

export async function attachOpenAiRuntime(
  client: HrcClient,
  hostSessionId: string,
  runtime: HrcRuntimeSnapshot
): Promise<ExecAttachDescriptor> {
  return attachWithRetry(client, hostSessionId, runtime)
}

async function attachWithRetry(
  client: HrcClient,
  hostSessionId: string,
  runtime: HrcRuntimeSnapshot,
  _intent?: HrcRuntimeIntent
): Promise<ExecAttachDescriptor> {
  const attemptedRuntimeIds = new Set<string>()
  let candidate: HrcRuntimeSnapshot | undefined = runtime

  while (candidate) {
    attemptedRuntimeIds.add(candidate.runtimeId)
    try {
      return await client.attachRuntime({ runtimeId: candidate.runtimeId })
    } catch (err) {
      if (!isHrcDomainErrorLike(err) || err.code !== HrcErrorCode.RUNTIME_UNAVAILABLE) {
        throw err
      }

      const refreshedRuntimes = await client.listRuntimes({ hostSessionId })
      candidate = selectNextUsableRuntime(refreshedRuntimes, attemptedRuntimeIds)
    }
  }

  throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'no attachable runtime available')
}

async function bindGhosttySurfaceIfPresent(
  client: HrcClient,
  descriptor: AttachDescriptor
): Promise<void> {
  const ghosttySurfaceId = process.env['GHOSTTY_SURFACE_UUID']?.trim()
  if (!ghosttySurfaceId) {
    return
  }

  await client.bindSurface({
    surfaceKind: 'ghostty',
    surfaceId: ghosttySurfaceId,
    ...descriptor.bindingFence,
  })
}

async function attachDescriptor(client: HrcClient, descriptor: AttachDescriptor): Promise<void> {
  await bindGhosttySurfaceIfPresent(client, descriptor)

  const attached = Bun.spawnSync(descriptor.argv, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (attached.exitCode !== 0) {
    fatal(`attach command exited with code ${attached.exitCode}`)
  }
}

function execAttachCommand(argv: string[], env?: Record<string, string> | undefined): void {
  const attached = Bun.spawnSync(argv, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })

  if (attached.exitCode !== 0) {
    fatal(`attach command exited with code ${attached.exitCode}`)
  }
}

// -- Command handlers ---------------------------------------------------------

async function cmdServer(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || subcommand.startsWith('-')) {
    return cmdServerStart(args, 'foreground')
  }

  switch (subcommand) {
    case 'start':
      return cmdServerStart(args.slice(1), 'foreground')
    case 'serve':
      return cmdServerServe(args.slice(1))
    case 'stop':
      return cmdServerStop(args.slice(1))
    case 'restart':
      return cmdServerRestart(args.slice(1))
    case 'status':
      return cmdServerStatus(args.slice(1))
    case 'health':
      return cmdServerHealth(args.slice(1))
    case 'tmux':
      return cmdServerTmux(args.slice(1))
    default:
      fatal(`unknown server subcommand: ${subcommand}`)
  }
}

/**
 * Run the HRC server in the foreground without probing launchd. Intended
 * for supervisors (launchd, systemd) that invoke hrc directly; user-facing
 * `hrc server start` delegates to launchctl when a Launch Agent is loaded.
 */
async function cmdServerServe(_args: string[]): Promise<void> {
  const status = await collectServerRuntimeStatus()
  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }
  return serverForeground()
}

async function cmdServerStart(args: string[], defaultMode: 'foreground' | 'daemon'): Promise<void> {
  const mode = resolveServerMode(args, defaultMode)
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const status = await collectServerRuntimeStatus()

  if (status.running) {
    fatal(`daemon already running on ${status.socketPath} (pid ${status.pid ?? 'unknown'})`)
  }

  const owner = await detectLaunchdOwner()
  if (owner) {
    await launchctlKickstart(owner)
    process.stderr.write(`hrc: daemon started via launchd (${owner.serviceTarget})\n`)
    return
  }

  if (mode === 'daemon') {
    await daemonizeAndWait(timeoutMs)
    return
  }

  return serverForeground()
}

async function cmdServerStop(args: string[]): Promise<void> {
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const force = hasFlag(args, '--force')
  const before = await collectServerRuntimeStatus()

  if (!before.running && before.pid === undefined) {
    process.stderr.write('hrc: daemon is not running\n')
    return
  }

  const owner = await detectLaunchdOwner()
  if (owner) {
    fatal(
      `daemon is supervised by launchd (${owner.serviceTarget}); launchd will respawn it. ` +
        `To stop permanently: launchctl unload -w ~/Library/LaunchAgents/${owner.label}.plist`
    )
  }

  await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
  process.stderr.write('hrc: daemon stopped\n')
}

async function cmdServerRestart(args: string[]): Promise<void> {
  const mode = resolveServerMode(args, 'daemon')
  const timeoutMs = parseIntegerFlag(args, '--timeout-ms', { defaultValue: 5_000, min: 1 })
  const force = hasFlag(args, '--force')

  const owner = await detectLaunchdOwner()
  if (owner) {
    await launchctlKickstart(owner, { kill: true })
    process.stderr.write(`hrc: daemon restarted via launchd (${owner.serviceTarget})\n`)
    return
  }

  await stopServerProcess({ timeoutMs, force, allowNotRunning: true })
  if (mode === 'daemon') {
    await daemonizeAndWait(timeoutMs)
    process.stderr.write('hrc: daemon restarted\n')
    return
  }

  return serverForeground()
}

async function cmdServerStatus(args: string[]): Promise<void> {
  const jsonFlag = hasFlag(args, '--json')
  const status = await collectServerRuntimeStatus()
  if (jsonFlag) {
    printJson(status)
    return
  }
  process.stdout.write(formatServerRuntimeStatus(status))
}

async function cmdServerHealth(_args: string[]): Promise<void> {
  const client = createClient()
  const result = await client.getHealth()
  printJson(result)
}

async function cmdServerTmux(args: string[]): Promise<void> {
  const subcommand = args[0]
  switch (subcommand) {
    case 'status':
      return cmdTmuxStatus(args.slice(1))
    case 'kill':
      return cmdTmuxKill(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown server tmux subcommand: ${subcommand}`
          : 'server tmux subcommand required (status, kill)'
      )
  }
}

async function serverForeground(): Promise<void> {
  const { createHrcServer } = await import('hrc-server')

  const paths = resolveServerPaths()

  const server = await createHrcServer({
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    socketPath: paths.socketPath,
    lockPath: paths.lockPath,
    spoolDir: paths.spoolDir,
    dbPath: paths.dbPath,
    tmuxSocketPath: paths.tmuxSocketPath,
  })

  // Write PID file for foreground too (used by status/stop)
  await mkdir(paths.runtimeRoot, { recursive: true })
  await writeFile(paths.pidPath, `${process.pid}\n`)

  writeServerProcessLog('server.listening', {
    pid: process.pid,
    socketPath: paths.socketPath,
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    tmuxSocketPath: paths.tmuxSocketPath,
  })

  const shutdown = async (reason: string) => {
    writeServerProcessLog('server.shutting_down', { pid: process.pid, reason })
    await server.stop()
    // Clean up PID file
    try {
      await unlink(paths.pidPath)
    } catch {}
    process.exit(0)
  }

  // Ignore SIGHUP so the daemon survives when the parent terminal/session exits
  // (e.g., Claude Code terminating). SIGINT and SIGTERM still trigger graceful shutdown.
  process.on('SIGHUP', () => {})
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function cmdSessionResolve(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  if (!scope) fatal('--scope is required for session resolve')

  const lane = parseFlag(args, '--lane') ?? 'default'
  const sessionRef = `${scope}/lane:${lane}`

  const client = createClient()
  const result = await client.resolveSession({ sessionRef })
  printJson(result)
}

async function cmdSessionList(args: string[]): Promise<void> {
  const scope = parseFlag(args, '--scope')
  const lane = parseFlag(args, '--lane')

  const client = createClient()
  const sessions = await client.listSessions({
    ...(scope ? { scopeRef: scope } : {}),
    ...(lane ? { laneRef: lane } : {}),
  })
  printJson(sessions)
}

async function cmdSessionGet(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')

  const client = createClient()
  const session = await client.getSession(hostSessionId)
  printJson(session)
}

async function cmdSession(args: string[]): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  switch (subcommand) {
    case 'resolve':
      return cmdSessionResolve(rest)
    case 'list':
      return cmdSessionList(rest)
    case 'get':
      return cmdSessionGet(rest)
    case 'clear-context':
      return cmdSessionClearContext(rest)
    default:
      fatal(
        subcommand
          ? `unknown session subcommand: ${subcommand}`
          : 'session subcommand required (resolve, list, get, clear-context)'
      )
  }
}

async function cmdEvents(args: string[]): Promise<void> {
  const parsedArgs = parseEventsArgs(args)
  if (parsedArgs.help) {
    printEventsUsage()
    return
  }

  const { follow, format, scopeRef, maxLines, scopeWidth } = parsedArgs
  const fromSeqRaw = parsedArgs.fromSeqRaw

  const fromSeq = fromSeqRaw !== undefined ? Number.parseInt(fromSeqRaw, 10) : undefined
  if (fromSeqRaw !== undefined && (!Number.isFinite(fromSeq) || (fromSeq ?? 0) < 1)) {
    fatal('--from-seq must be a positive integer')
  }

  const renderer = createEventsRenderer(format, { maxLines, scopeWidth })
  try {
    for await (const event of watchLocalEvents({ fromSeq, follow, scopeRef })) {
      process.stdout.write(renderer.push(event))
    }
  } finally {
    const tail = renderer.flush()
    if (tail.length > 0) process.stdout.write(tail)
  }
}

async function* watchLocalEvents(options: {
  fromSeq?: number | undefined
  follow: boolean
  scopeRef?: string | undefined
}): AsyncIterable<HrcLifecycleEvent> {
  const db = openHrcDatabase(resolveDatabasePath())
  let nextSeq = options.fromSeq ?? 1

  try {
    while (true) {
      const events = db.hrcEvents.listFromHrcSeq(nextSeq)
      if (events.length === 0) {
        if (!options.follow) {
          return
        }
        await Bun.sleep(EVENT_FOLLOW_POLL_MS)
        continue
      }

      for (const event of events) {
        nextSeq = event.hrcSeq + 1
        if (options.scopeRef && !matchesEventScopeSelection(event.scopeRef, options.scopeRef)) {
          continue
        }
        yield event
      }

      if (!options.follow) {
        return
      }
    }
  } finally {
    db.close()
  }
}

function printEventsUsage(): void {
  process.stdout.write(`Usage: hrc events [scope] [--from-seq <n>] [--follow] [--format <mode>]

Stream HRC lifecycle events from the local state database.

Arguments:
  scope                 Optional scope selector. Accepts the usual HRC handle forms:
                        <agentId>
                        <agentId>@<projectId>
                        <agentId>@<projectId>:<taskId>

Filtering:
  agent@project         Includes that project scope and all descendant threads/tasks.
  agent@project:task    Includes only that task scope and descendant task roles.

Options:
  --from-seq <n>        Start at HRC sequence number <n>.
  --follow              Keep polling for new events.
  --format <mode>       Output mode: tree (default when TTY), compact, verbose, json, ndjson.
  --pretty              Alias for --format=tree (legacy flag).
  --max-lines <n>       Tree mode: truncate each body block to <n> lines (default 10, 0=unlimited).
  --scope-width <n>     Tree mode: per-row scoperef badge width in chars (default 20).
  --help, -h            Show this help.

Examples:
  hrc events
  hrc events candice@agent-spaces --pretty
  hrc events alice@test:sometask --follow
  hrc events --format=compact
  hrc events --format=verbose
  hrc events --max-lines=0                # show full body for every event
  hrc events --scope-width=12 --pretty    # tighter badges for narrow terminals
`)
}

function parseEventsArgs(args: string[]): {
  fromSeqRaw?: string | undefined
  follow: boolean
  format: EventsOutputFormat
  help: boolean
  scopeRef?: string | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
} {
  let fromSeqRaw: string | undefined
  let follow = false
  let explicitFormat: EventsOutputFormat | undefined
  let pretty = false
  let help = false
  let selectorInput: string | undefined
  let maxLines: number | undefined
  let scopeWidth: number | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--follow') {
      follow = true
      continue
    }
    if (arg === '--pretty') {
      pretty = true
      continue
    }
    if (arg === '--format') {
      const value = args[i + 1]
      if (value === undefined) {
        fatal('--format requires a value')
      }
      explicitFormat = parseEventsFormat(value)
      i += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      explicitFormat = parseEventsFormat(arg.slice('--format='.length))
      continue
    }
    if (arg === '--from-seq') {
      const value = args[i + 1]
      if (value === undefined) {
        fatal('--from-seq requires a value')
      }
      fromSeqRaw = value
      i += 1
      continue
    }
    if (arg.startsWith('--from-seq=')) {
      fromSeqRaw = arg.slice('--from-seq='.length)
      continue
    }
    if (arg === '--max-lines') {
      const value = args[i + 1]
      if (value === undefined) fatal('--max-lines requires a value')
      maxLines = parseNonNegativeInt(value, '--max-lines')
      i += 1
      continue
    }
    if (arg.startsWith('--max-lines=')) {
      maxLines = parseNonNegativeInt(arg.slice('--max-lines='.length), '--max-lines')
      continue
    }
    if (arg === '--scope-width') {
      const value = args[i + 1]
      if (value === undefined) fatal('--scope-width requires a value')
      scopeWidth = parseNonNegativeInt(value, '--scope-width')
      i += 1
      continue
    }
    if (arg.startsWith('--scope-width=')) {
      scopeWidth = parseNonNegativeInt(arg.slice('--scope-width='.length), '--scope-width')
      continue
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option for events: ${arg}`)
    }
    if (selectorInput !== undefined) {
      fatal('events accepts at most one scope selector')
    }
    selectorInput = arg
  }

  let scopeRef: string | undefined
  if (selectorInput !== undefined) {
    scopeRef = resolveScopeInput(selectorInput).scopeRef
  }

  const format =
    explicitFormat ?? (pretty ? 'tree' : resolveDefaultFormat(Boolean(process.stdout.isTTY)))

  return { fromSeqRaw, follow, format, help, scopeRef, maxLines, scopeWidth }
}

function parseNonNegativeInt(raw: string, flagName: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    fatal(`${flagName} must be a non-negative integer (got "${raw}")`)
  }
  return n
}

function parseEventsFormat(raw: string): EventsOutputFormat {
  switch (raw) {
    case 'tree':
    case 'compact':
    case 'verbose':
    case 'json':
    case 'ndjson':
      return raw
    default:
      fatal(`--format must be one of: tree, compact, verbose, json, ndjson (got "${raw}")`)
      return 'ndjson' // unreachable
  }
}

function matchesEventScopeSelection(eventScopeRef: string, selectedScopeRef: string): boolean {
  if (eventScopeRef === selectedScopeRef) {
    return true
  }
  try {
    return ancestorScopeRefs(eventScopeRef).includes(selectedScopeRef)
  } catch {
    return false
  }
}

// -- Status capability display (T-00998) ---------------------------------------

// -- Session-centric status helpers (T-01025) ---------------------------------

/**
 * Format tmux identifiers: "sessionName / paneId" or "(none)".
 */
function formatTmuxRef(sessionName?: string, paneId?: string): string {
  if (!sessionName && !paneId) return '(none)'
  const parts: string[] = []
  if (sessionName) parts.push(sessionName)
  if (paneId) parts.push(paneId)
  return parts.join(' / ')
}

/**
 * Render one session entry from the unified status response into lines.
 */
function pushSessionBlock(lines: string[], entry: HrcStatusSessionView): void {
  const s = entry.session
  const label = s.scopeRef || s.hostSessionId
  lines.push(`  ${label} [${s.hostSessionId}] (${s.status})`)

  const ar = entry.activeRuntime
  if (!ar) {
    lines.push('    runtime:  (no active runtime)')
    lines.push('    surfaces: (no active surfaces)')
    return
  }

  const rt = ar.runtime
  const rtParts = [rt.runtimeId, rt.harness, rt.transport].filter(Boolean)
  if (rt.status) rtParts.push(rt.status)
  lines.push(`    runtime:  ${rtParts.join(' / ')}`)

  if (ar.tmux) {
    lines.push(`    tmux:     ${formatTmuxRef(ar.tmux.sessionName, ar.tmux.paneId)}`)
  }

  if (ar.surfaceBindings.length > 0) {
    const surfStr = ar.surfaceBindings.map((b) => `${b.surfaceKind}:${b.surfaceId}`).join(', ')
    lines.push(`    surfaces: ${surfStr}`)
  } else {
    lines.push('    surfaces: (no active surfaces)')
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${rm}m ${s}s`
}

function formatCapabilityValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)'
  return String(value)
}

function printCapabilityGroup(
  lines: string[],
  title: string,
  entries: Record<string, unknown>
): void {
  lines.push('')
  lines.push(`Capabilities: ${title}`)
  for (const [key, val] of Object.entries(entries)) {
    lines.push(`  ${key}: ${formatCapabilityValue(val)}`)
  }
}

function printStatusHuman(status: HrcStatusResponse): void {
  const lines: string[] = []

  lines.push('HRC Server Status')
  lines.push(`  uptime:     ${formatUptime(status.uptime)}`)
  lines.push(`  started:    ${status.startedAt}`)
  if (status.apiVersion) {
    lines.push(`  apiVersion: ${status.apiVersion}`)
  }
  lines.push(`  socket:     ${status.socketPath}`)
  lines.push(`  database:   ${status.dbPath}`)

  // -- Per-session view (T-01025) -------------------------------------------
  if (status.sessions && status.sessions.length > 0) {
    lines.push('')
    lines.push(`Sessions: (${status.sessions.length})`)
    for (const entry of status.sessions) {
      pushSessionBlock(lines, entry)
    }
  } else {
    lines.push(`  sessions:   ${status.sessionCount}`)
    lines.push(`  runtimes:   ${status.runtimeCount}`)
  }

  // -- Capabilities ---------------------------------------------------------
  if (status.capabilities) {
    const caps = status.capabilities

    if (caps.semanticCore) {
      printCapabilityGroup(lines, 'Semantic Core', caps.semanticCore)
    }

    if (caps.platform) {
      printCapabilityGroup(lines, 'Platform', caps.platform)
    }

    if (caps.bridgeDelivery) {
      printCapabilityGroup(lines, 'Bridge Delivery', caps.bridgeDelivery)
    }

    lines.push('')
    lines.push('Capabilities: Backend')
    if (caps.backend?.tmux) {
      const tmux = caps.backend.tmux
      const ver = tmux.version ? ` (${tmux.version})` : ''
      lines.push(`  tmux: ${tmux.available ? 'available' : 'unavailable'}${ver}`)
    } else {
      lines.push('  tmux: unavailable')
    }
  }

  lines.push('')
  process.stdout.write(lines.join('\n'))
}

async function cmdStatus(args: string[]): Promise<void> {
  const jsonFlag = hasFlag(args, '--json')
  const allFlag = hasFlag(args, '--all')
  const client = createClient()
  const result = await client.getStatus(allFlag ? { includeArchived: true } : undefined)

  if (jsonFlag) {
    printJson(result)
  } else {
    printStatusHuman(result as HrcStatusResponse)
  }
}

async function cmdTmuxStatus(args: string[]): Promise<void> {
  const jsonFlag = hasFlag(args, '--json')
  const status = await collectTmuxStatus()
  if (jsonFlag) {
    printJson(status)
    return
  }
  process.stdout.write(formatTmuxStatus(status))
}

async function cmdTmuxKill(args: string[]): Promise<void> {
  if (!hasFlag(args, '--yes')) {
    fatal('tmux kill is destructive; rerun with --yes to kill the HRC tmux server')
  }

  const status = await collectTmuxStatus()
  if (!status.available) {
    fatal(status.error ?? 'tmux unavailable')
  }

  if (!status.running) {
    process.stderr.write('hrc: tmux server is not running\n')
    return
  }

  const result = await execProcess(['tmux', '-S', status.socketPath, 'kill-server'])
  if (result.exitCode !== 0) {
    fatal(`${result.stderr}\n${result.stdout}`.trim() || 'tmux kill-server failed')
  }

  process.stderr.write(`hrc: tmux server killed (${status.sessionCount} session(s))\n`)
}

async function cmdRuntimeList(args: string[]): Promise<void> {
  const hostSessionId = parseFlag(args, '--host-session-id')
  const client = createClient()
  const runtimes = await client.listRuntimes(hostSessionId ? { hostSessionId } : undefined)
  printJson(runtimes)
}

async function cmdLaunchList(args: string[]): Promise<void> {
  const hostSessionId = parseFlag(args, '--host-session-id')
  const runtimeId = parseFlag(args, '--runtime-id')
  const client = createClient()
  const launches = await client.listLaunches({
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(runtimeId ? { runtimeId } : {}),
  })
  printJson(launches)
}

async function cmdAdopt(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.adoptRuntime(runtimeId)
  printJson(result)
}

/**
 * Convert common failure modes from `hrc run` into actionable error messages.
 * Preserves the original message for unrecognized cases. Returns an Error with
 * the wrapped message so the top-level `fatal()` handler prints it with the
 * `hrc:` prefix.
 */
function explainScopeCommandError(
  command: 'attach' | 'run' | 'start',
  err: unknown,
  scopeInput: string,
  sessionRef?: string
): Error {
  const raw = err instanceof Error ? err.message : String(err)

  // Daemon not running — discoverSocket throws this
  if (raw.includes('HRC daemon socket not found')) {
    return new Error(`${raw}\n  Start it with: hrc server start --daemon`)
  }

  // Bun fetch connection-refused when socket exists but nothing is listening
  if (/typo in the url or port|ECONNREFUSED|Unable to connect/i.test(raw)) {
    return new Error(
      'cannot reach HRC daemon (socket present but not responding).\n' +
        '  The daemon may have crashed. Try: hrc server restart'
    )
  }

  if (isHrcDomainErrorLike(err)) {
    const detail = (err.detail ?? {}) as { scopeRef?: string; sessionRef?: string }
    const storedScope = detail.scopeRef

    // Hydration guard: server rejected a stored non-canonical scopeRef
    if (
      err.code === HrcErrorCode.INVALID_SELECTOR &&
      raw.includes('canonical agent ScopeRef') &&
      storedScope &&
      !storedScope.startsWith('agent:')
    ) {
      return new Error(
        `cannot reattach to "${scopeInput}": an existing session is stored with a legacy scopeRef "${storedScope}".\n  This database predates the canonical scope cleanup (T-01077).\n  Fix: wipe HRC state.\n    rm ~/.local/state/hrc/state.sqlite*`
      )
    }

    // Generic invalid sessionRef (user-facing input problem)
    if (err.code === HrcErrorCode.INVALID_SELECTOR) {
      return new Error(
        `invalid sessionRef for "${scopeInput}": ${err.message}\n` +
          `  sessionRef sent: ${sessionRef ?? '(not yet computed)'}`
      )
    }

    if (err.code === HrcErrorCode.STALE_CONTEXT) {
      return new Error(`conflict on "${scopeInput}": ${err.message}`)
    }

    if (err.code === HrcErrorCode.UNSUPPORTED_CAPABILITY) {
      return new Error(`cannot ${command} "${scopeInput}": ${err.message}`)
    }

    // Other domain errors — show the code so operators can look it up
    return new Error(`"${scopeInput}" [${err.code}]: ${err.message}`)
  }

  // Fallback: pass the raw message through. Top-level fatal() adds the `hrc:`
  // prefix, and most helper errors already mention the scope in-line.
  return err instanceof Error ? err : new Error(raw)
}

function printManagedScopeUsage(command: 'run' | 'start'): void {
  const summary =
    command === 'run'
      ? 'Launch or reattach an agent harness in a managed tmux session.'
      : 'Resolve a session and start its managed runtime without attaching.'
  const attachSummary =
    command === 'run'
      ? '\n  By default, rerunning the same scope reattaches to the existing\n  runtime and preserves the PTY/context. Use --force-restart to\n  replace the runtime with a fresh PTY.\n'
      : ''
  const noAttachOption =
    command === 'run'
      ? '  --no-attach          Start/ensure without attaching to the tmux session\n'
      : ''
  const newSessionOption =
    command === 'start'
      ? '  --new-session        Rotate to a fresh host session before starting\n'
      : ''

  process.stdout.write(`Usage: hrc ${command} <scope> [options]

  ${summary}

  <scope>  Agent scope: agent, agent@project, or full scope ref.
           When run from a project directory, the project is inferred
           automatically (e.g. "larry" becomes "larry@agent-spaces").${attachSummary}

Options:
  --force-restart      Replace any existing runtime with a fresh PTY
${noAttachOption}${newSessionOption}  --dry-run            Local plan preview — no server calls, no side effects
  --debug              Keep tmux shell alive after harness exits
  -p <text>            Initial prompt to send to the harness
  --prompt-file <path> Read initial prompt from a file
`)
}

async function cmdRun(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printManagedScopeUsage('run')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const noAttach = hasFlag(args, '--no-attach')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const prompt = await parseScopePrompt(args, {
    command: 'run',
    passthroughFlags: ['--force-restart', '--no-attach', '--dry-run', '--debug'],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput)
    sessionRef = scope.sessionRef
    const intent = buildManagedRunIntent(scope, { prompt, debug })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview('run', scopeInput, sessionRef, intent, restartStyle, prompt)
      return
    }

    const client = createClient()

    const resolved = await client.resolveSession({ sessionRef, runtimeIntent: intent })
    const runtime = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent,
      restartStyle,
    })

    try {
      await client.dispatchTurn({
        hostSessionId: resolved.hostSessionId,
        prompt: prompt && prompt.length > 0 ? prompt : scopeInput,
      })
    } catch (err) {
      if (!isHrcDomainErrorLike(err) || err.code !== HrcErrorCode.RUNTIME_BUSY) {
        throw err
      }
    }

    if (noAttach) {
      printJson({
        sessionRef,
        hostSessionId: resolved.hostSessionId,
        created: resolved.created,
        runtime,
      })
      return
    }

    const descriptor = await client.getAttachDescriptor(runtime.runtimeId)
    await attachDescriptor(client, descriptor)
  } catch (err) {
    throw explainScopeCommandError('run', err, scopeInput, sessionRef)
  }
}

async function cmdStart(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printManagedScopeUsage('start')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const newSession = hasFlag(args, '--new-session')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const prompt = await parseScopePrompt(args, {
    command: 'start',
    passthroughFlags: ['--force-restart', '--new-session', '--dry-run', '--debug'],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput)
    sessionRef = scope.sessionRef
    const intent = buildManagedStartIntent(scope, { prompt, debug })
    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      await printLocalRunPreview('start', scopeInput, sessionRef, intent, restartStyle, prompt)
      return
    }

    const client = createClient()
    const resolved = await client.resolveSession({ sessionRef, runtimeIntent: intent })
    const targetSession =
      newSession && !resolved.created
        ? await client.clearContext({
            hostSessionId: resolved.hostSessionId,
            dropContinuation: true,
          })
        : resolved
    const runtime = await client.startRuntime({
      hostSessionId: targetSession.hostSessionId,
      intent,
      restartStyle,
    })

    printJson({
      sessionRef,
      hostSessionId: targetSession.hostSessionId,
      created: resolved.created || newSession,
      runtime,
    })
  } catch (err) {
    throw explainScopeCommandError('start', err, scopeInput, sessionRef)
  }
}

async function printLocalRunPreview(
  command: 'run' | 'start',
  scope: string,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined
): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`)

  w(`hrc ${command} ${scope} --dry-run  (local plan preview — no server state consulted)`)

  // Build the actual argv/env that the harness would launch with, then render
  // it through the shared display module so this matches `asp run --dry-run`
  // and `hrc launch exec` runtime output: framed system prompt + priming, then
  // metadata, env block, and a command line with `<N chars>` placeholders.
  try {
    const invocation = await buildCliInvocation(intent)
    const sysPrompt = extractSystemPromptFromArgv(invocation.argv)
    const primingPrompt = extractPrimingFromArgv(invocation.argv)
    const envEntries = Object.keys(invocation.env)
      .sort()
      .map((k): [string, string] => {
        const val = invocation.env[k] ?? ''
        return [k, val.length > 160 ? `${val.slice(0, 157)}...` : val]
      })
    const envBlock = renderKeyValueSection('env', envEntries)
    const argvHead = invocation.argv[0] ?? ''
    const display = formatDisplayCommand(argvHead, invocation.argv.slice(1))

    // Metadata lives below the framed prompts: scope/session info first,
    // then the resolved invocation context, then env overrides if any.
    const betweenLines: string[] = []
    betweenLines.push('')
    betweenLines.push(`  sessionRef:   ${sessionRef}`)
    betweenLines.push(`  restartStyle: ${restartStyle}`)
    betweenLines.push(`  agentRoot:    ${intent.placement.agentRoot}`)
    betweenLines.push(`  projectRoot:  ${intent.placement.projectRoot ?? '(none)'}`)
    betweenLines.push(`  cwd:          ${intent.placement.cwd}`)
    betweenLines.push(`  provider:     ${intent.harness.provider}`)
    betweenLines.push(
      `  initialPrompt: ${prompt !== undefined ? `${prompt.length} chars` : '(none)'}`
    )
    betweenLines.push('')
    betweenLines.push(`  invocation cwd:      ${invocation.cwd}`)
    betweenLines.push(`  invocation provider: ${invocation.provider}`)
    betweenLines.push(`  invocation frontend: ${invocation.frontend}`)

    const envOverrides = intent.launch?.env
    if (envOverrides && Object.keys(envOverrides).length > 0) {
      betweenLines.push('')
      betweenLines.push('  env overrides:')
      for (const key of Object.keys(envOverrides).sort()) {
        const val = envOverrides[key]
        if (val === undefined) continue
        const valDisplay = val.length > 120 ? `${val.slice(0, 117)}...` : val
        betweenLines.push(`    ${key}=${valDisplay}`)
      }
    }

    if (envBlock.length > 0) {
      betweenLines.push('')
      betweenLines.push(...envBlock)
    }

    await displayPrompts({
      systemPrompt: sysPrompt?.content,
      systemPromptMode: sysPrompt?.mode,
      primingPrompt,
      betweenLines,
      command: display,
      showCommand: true,
    })

    if (invocation.warnings && invocation.warnings.length > 0) {
      w('')
      w('  warnings:')
      for (const warning of invocation.warnings) {
        w(`    - ${warning}`)
      }
    }
  } catch (err) {
    w('')
    w(`  (spec build failed: ${err instanceof Error ? err.message : String(err)})`)
  }

  w('')
  w('  Note: this preview shows the request the client would send. Server-side')
  w('  details (existing runtime, PTY state, tmux session) are not consulted.')
  w('  Run without --dry-run to execute.')
}

/**
 * Extract the system prompt from a harness argv. Mirrors the logic in
 * `hrc-server/launch/exec.ts` so dry-run output matches runtime output.
 */
function extractSystemPromptFromArgv(
  argv: readonly string[]
): { content: string; mode: 'append' | 'replace' } | undefined {
  const appendIdx = argv.indexOf('--append-system-prompt')
  if (appendIdx !== -1 && argv[appendIdx + 1] !== undefined) {
    return { content: argv[appendIdx + 1] as string, mode: 'append' }
  }
  const replaceIdx = argv.indexOf('--system-prompt')
  if (replaceIdx !== -1 && argv[replaceIdx + 1] !== undefined) {
    return { content: argv[replaceIdx + 1] as string, mode: 'replace' }
  }
  return undefined
}

/**
 * Extract the priming prompt: convention is the value after `--`.
 */
function extractPrimingFromArgv(argv: readonly string[]): string | undefined {
  const dashIdx = argv.indexOf('--')
  if (dashIdx === -1) return undefined
  const value = argv[dashIdx + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function cmdRuntimeEnsure(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const providerRaw = parseFlag(args, '--provider') ?? 'anthropic'
  const restartStyleRaw = parseFlag(args, '--restart-style')

  if (providerRaw !== 'anthropic' && providerRaw !== 'openai') {
    fatal('--provider must be one of: anthropic, openai')
  }

  if (
    restartStyleRaw !== undefined &&
    restartStyleRaw !== 'reuse_pty' &&
    restartStyleRaw !== 'fresh_pty'
  ) {
    fatal('--restart-style must be one of: reuse_pty, fresh_pty')
  }
  const restartStyle =
    restartStyleRaw === 'reuse_pty' || restartStyleRaw === 'fresh_pty' ? restartStyleRaw : undefined

  const client = createClient()
  const result = await client.ensureRuntime({
    hostSessionId,
    intent: createDefaultRuntimeIntent(providerRaw),
    ...(restartStyle ? { restartStyle } : {}),
  })
  printJson(result)
}

async function cmdRuntime(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'ensure':
      return cmdRuntimeEnsure(args.slice(1))
    case 'list':
      return cmdRuntimeList(args.slice(1))
    case 'capture':
      return cmdCapture(args.slice(1))
    case 'interrupt':
      return cmdInterrupt(args.slice(1))
    case 'terminate':
      return cmdTerminate(args.slice(1))
    case 'adopt':
      return cmdAdopt(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown runtime subcommand: ${subcommand}`
          : 'runtime subcommand required (ensure, list, capture, interrupt, terminate, adopt)'
      )
  }
}

async function cmdTurnSend(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const prompt = parseFlag(args, '--prompt')
  const providerRaw = parseFlag(args, '--provider') ?? 'anthropic'
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')
  const followLatest = hasFlag(args, '--follow-latest')

  if (!prompt) {
    fatal('--prompt is required for turn send')
  }

  if (providerRaw !== 'anthropic' && providerRaw !== 'openai') {
    fatal('--provider must be one of: anthropic, openai')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const client = createClient()
  const result = await client.dispatchTurn({
    hostSessionId,
    prompt,
    runtimeIntent: createDefaultRuntimeIntent(providerRaw),
    fences:
      expectedHostSessionId !== undefined || expectedGeneration !== undefined || followLatest
        ? {
            ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
            ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
            ...(followLatest ? { followLatest: true } : {}),
          }
        : undefined,
  })
  printJson(result)
}

async function cmdTurn(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'send':
      return cmdTurnSend(args.slice(1))
    default:
      fatal(
        subcommand ? `unknown turn subcommand: ${subcommand}` : 'turn subcommand required (send)'
      )
  }
}

async function cmdLaunch(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'list':
      return cmdLaunchList(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown launch subcommand: ${subcommand}`
          : 'launch subcommand required (list)'
      )
  }
}

async function cmdInflightSend(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const runId = parseFlag(args, '--run-id')
  const input = parseFlag(args, '--input')
  const inputType = parseFlag(args, '--input-type')

  if (!runId) {
    fatal('--run-id is required for inflight send')
  }

  if (!input) {
    fatal('--input is required for inflight send')
  }

  const client = createClient()
  const result = await client.sendInFlightInput({
    runtimeId,
    runId,
    input,
    prompt: input,
    ...(inputType ? { inputType } : {}),
  })
  printJson(result)
}

async function cmdInflight(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'send':
      return cmdInflightSend(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown inflight subcommand: ${subcommand}`
          : 'inflight subcommand required (send)'
      )
  }
}

async function cmdSessionClearContext(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const relaunch = hasFlag(args, '--relaunch')

  const client = createClient()
  const result = await client.clearContext({
    hostSessionId,
    ...(relaunch ? { relaunch: true } : {}),
  })
  printJson(result)
}

async function cmdCapture(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.capture(runtimeId)
  process.stdout.write(result.text)
  if (!result.text.endsWith('\n')) {
    process.stdout.write('\n')
  }
}

function printAttachUsage(): void {
  process.stdout.write(`Usage: hrc attach <scope> [--dry-run]

  Resolve a managed session by scope and attach to its latest active runtime.

  Compatibility:
  attach <runtimeId>  Print the attach descriptor JSON for an explicit runtime ID.
`)
}

async function printLocalAttachPreview(scope: string, sessionRef: string): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`)

  w(`hrc attach ${scope} --dry-run  (local plan preview — no server state consulted)\n`)
  w(`  sessionRef:    ${sessionRef}`)
  w('  runtimeLookup: latest non-unavailable runtime for the resolved host session')
  w('  recovery:      detached OpenAI sessions materialize a fresh tmux runtime on attach')
  w('  action:        POST /v1/runtimes/attach for that runtime, then exec returned argv')
  w('')
  w('  Note: this preview does not resolve the session or inspect runtime state.')
  w('  Run without --dry-run to execute.')
}

async function cmdAttach(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printAttachUsage()
    return
  }

  const target = requireArg(args, 0, '<scope>')
  const dryRun = hasFlag(args, '--dry-run')

  if (target.startsWith('rt-')) {
    if (dryRun) {
      fatal('attach --dry-run expects a scope, not a runtimeId')
    }
    const client = createClient()
    const descriptor = await client.getAttachDescriptor(target)
    await bindGhosttySurfaceIfPresent(client, descriptor)
    printJson(descriptor)
    return
  }

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(target)
    sessionRef = scope.sessionRef
    const intent = buildManagedAttachIntent(scope)

    if (dryRun) {
      await printLocalAttachPreview(target, sessionRef)
      return
    }

    const client = createClient()
    const resolved = await client.resolveSession({ sessionRef })
    if (resolved.created) {
      throw new Error(`no active runtime found for "${target}"`)
    }

    const runtimes = await client.listRuntimes({ hostSessionId: resolved.hostSessionId })
    const runtime = selectLatestUsableRuntime(runtimes)
    if (!runtime) {
      throw new Error(`no active runtime found for "${target}"`)
    }

    const descriptor: ExecAttachDescriptor = await attachWithRetry(
      client,
      resolved.hostSessionId,
      runtime,
      intent
    )
    execAttachCommand(descriptor.argv, descriptor.env)
  } catch (err) {
    throw explainScopeCommandError('attach', err, target, sessionRef)
  }
}

async function cmdInterrupt(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.interrupt(runtimeId)
  printJson(result)
}

async function cmdTerminate(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.terminate(runtimeId)
  printJson(result)
}

async function cmdSurfaceBind(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const surfaceKind = parseFlag(args, '--kind')
  const surfaceId = parseFlag(args, '--id')

  if (!surfaceKind) {
    fatal('--kind is required for surface bind')
  }
  if (!surfaceId) {
    fatal('--id is required for surface bind')
  }

  const client = createClient()
  const descriptor = await client.getAttachDescriptor(runtimeId)
  const result = await client.bindSurface({
    surfaceKind,
    surfaceId,
    ...descriptor.bindingFence,
  })
  printJson(result)
}

async function cmdSurfaceUnbind(args: string[]): Promise<void> {
  const surfaceKind = parseFlag(args, '--kind')
  const surfaceId = parseFlag(args, '--id')
  const reason = parseFlag(args, '--reason')

  if (!surfaceKind) {
    fatal('--kind is required for surface unbind')
  }
  if (!surfaceId) {
    fatal('--id is required for surface unbind')
  }

  const client = createClient()
  const result = await client.unbindSurface({
    surfaceKind,
    surfaceId,
    ...(reason ? { reason } : {}),
  })
  printJson(result)
}

async function cmdSurfaceList(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.listSurfaces({ runtimeId })
  printJson(result)
}

async function cmdSurface(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'bind':
      return cmdSurfaceBind(args.slice(1))
    case 'unbind':
      return cmdSurfaceUnbind(args.slice(1))
    case 'list':
      return cmdSurfaceList(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown surface subcommand: ${subcommand}`
          : 'surface subcommand required (bind, unbind, list)'
      )
  }
}

async function cmdBridgeRegister(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const transport = parseFlag(args, '--transport')
  const target = parseFlag(args, '--target')
  const runtimeId = parseFlag(args, '--runtime-id')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')

  if (!transport) {
    fatal('--transport is required for bridge register')
  }
  if (!target) {
    fatal('--target is required for bridge register')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const client = createClient()
  const result = await client.registerBridgeTarget({
    hostSessionId,
    ...(runtimeId ? { runtimeId } : {}),
    transport,
    target,
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

async function cmdBridgeDeliver(args: string[]): Promise<void> {
  const bridgeId = requireArg(args, 0, '<bridgeId>')
  const text = parseFlag(args, '--text')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')

  if (!text) {
    fatal('--text is required for bridge deliver')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const client = createClient()
  const result = await client.deliverBridge({
    bridgeId,
    text,
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

async function cmdBridgeList(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const result = await client.listBridges({ runtimeId })
  printJson(result)
}

async function cmdBridgeClose(args: string[]): Promise<void> {
  const bridgeId = requireArg(args, 0, '<bridgeId>')
  const client = createClient()
  const result = await client.closeBridge({ bridgeId })
  printJson(result)
}

async function cmdBridgeTarget(args: string[]): Promise<void> {
  const bridge = parseFlag(args, '--bridge')
  const hostSession = parseFlag(args, '--host-session')
  const sessionRef = parseFlag(args, '--session-ref')
  const transport = parseFlag(args, '--transport')
  const target = parseFlag(args, '--target')
  const runtimeId = parseFlag(args, '--runtime-id')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')

  // --bridge is a convenience alias for --transport tmux --target <value>
  const effectiveTransport = transport ?? (bridge ? 'tmux' : undefined)
  const effectiveTarget = target ?? bridge

  if (!effectiveTransport) {
    fatal('--transport (or --bridge) is required for bridge target')
  }
  if (!effectiveTarget) {
    fatal('--target (or --bridge) is required for bridge target')
  }

  // Selector: exactly one of --host-session or --session-ref
  if (!hostSession && !sessionRef) {
    fatal('bridge target requires --host-session or --session-ref selector')
  }
  if (hostSession && sessionRef) {
    fatal('bridge target accepts --host-session or --session-ref, not both')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const selector: import('hrc-core').HrcBridgeTargetSelector = sessionRef
    ? { sessionRef }
    : { hostSessionId: hostSession as string }

  const client = createClient()
  const result = await client.acquireBridgeTarget({
    selector,
    transport: effectiveTransport,
    target: effectiveTarget,
    ...(runtimeId ? { runtimeId } : {}),
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

async function cmdBridgeDeliverText(args: string[]): Promise<void> {
  const bridge = parseFlag(args, '--bridge')
  const text = parseFlag(args, '--text')
  const enter = hasFlag(args, '--enter')
  const oobSuffix = parseFlag(args, '--oob-suffix')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')

  if (!bridge) {
    fatal('--bridge is required for bridge deliver-text')
  }
  if (!text) {
    fatal('--text is required for bridge deliver-text')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const client = createClient()
  const result = await client.deliverBridgeText({
    bridgeId: bridge,
    text,
    enter,
    ...(oobSuffix ? { oobSuffix } : {}),
    ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
  })
  printJson(result)
}

async function cmdBridge(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'target':
      return cmdBridgeTarget(args.slice(1))
    case 'deliver-text':
      return cmdBridgeDeliverText(args.slice(1))
    case 'register':
      return cmdBridgeRegister(args.slice(1))
    case 'deliver':
      return cmdBridgeDeliver(args.slice(1))
    case 'list':
      return cmdBridgeList(args.slice(1))
    case 'close':
      return cmdBridgeClose(args.slice(1))
    default:
      fatal(
        subcommand
          ? `unknown bridge subcommand: ${subcommand}`
          : 'bridge subcommand required (target, deliver-text, register, deliver, list, close)'
      )
  }
}

// -- Usage --------------------------------------------------------------------

const INFO_TEXT = `hrc — HRC operator CLI

ABOUT
  HRC is the local runtime control plane for agent sessions.

  It gives an agent target a stable identity, preserves continuity across
  launches, manages live runtimes, and lets an operator or another agent
  inspect, attach, start, interrupt, or clear that runtime state.

  Use hrc to control HRC itself.
  Use hrcchat to semantically message agents.

CORE MODEL
  HRC tracks three main things:

  target
    The logical agent you want to control.

  session
    The stable continuity record for that target and lane.

  runtime
    A live execution bound to a session.

  In practice:
  use a target handle to select who you mean,
  a session when you care about continuity,
  and a runtime when you need to act on a live process.

ADDRESSING TARGETS
  HRC accepts shorthand target handles:

    <agentId>
    <agentId>@<projectId>
    <agentId>@<projectId>:<taskId>
    <agentId>@<projectId>:<taskId>/<roleName>

  Examples:
    cody
    cody@agent-spaces
    cody@agent-spaces:T-123
    cody@agent-spaces:T-123/reviewer

  A handle may also include a lane:

    <handle>~<lane>

  Examples:
    cody@agent-spaces
    cody@agent-spaces~repair
    cody@agent-spaces:T-123/reviewer~planning

  Notes:
    Managed handle commands such as run/start/attach normally use main when
    lane is omitted.
    Low-level session resolve defaults to default unless --lane is passed.
    If project is omitted, HRC may infer it from the current directory.

COMMON CONTROL FLOWS
  Start or reattach a managed runtime and attach to it:
    hrc run cody@agent-spaces

  Start detached without attaching:
    hrc start cody@agent-spaces

  Attach to an already-running target:
    hrc attach cody@agent-spaces

  Send a turn to an existing session:
    hrc turn send <hostSessionId> --prompt "Continue."

  Inspect live output:
    hrc capture <runtimeId>

  Stream lifecycle events:
    hrc events --pretty

  Clear continuity / rotate generation:
    hrc session clear-context <hostSessionId>

SAFETY RULES
  Prefer stable target handles first.
  Prefer inspection before mutation.
  clear-context changes continuity state.
  interrupt and terminate affect live runtimes.
  tmux kill is destructive to all interactive HRC runtimes.

USE HRCCHAT FOR MESSAGING
  hrc is not the semantic messaging interface.

  For agent-to-agent or human-to-agent messaging, use:
    hrcchat info
    hrcchat who
    hrcchat dm cody@agent-spaces "Review the repo."
    hrcchat messages cody@agent-spaces

ENVIRONMENT
  HRC_RUNTIME_DIR   Override runtime root
  HRC_STATE_DIR     Override persistent state root
  ASP_PROJECT       Default project context for shorthand resolution
  ASP_AGENTS_ROOT   Agents root for managed run/start resolution
  HRC_SESSION_REF   Caller identity for HRC-aware child processes

COMMANDS
  server            Daemon lifecycle, health, and tmux backend control
  status            API status, sessions, capabilities
  events            Stream HRC event envelopes
  session           Resolve, list, and inspect sessions
  runtime           Ensure, inspect, and control runtimes
  launch            List launches
  run               Resolve, launch, and attach
  start             Resolve and start detached
  attach            Attach to a live runtime
  turn              Dispatch turns to a session
  inflight          Send in-flight runtime input
  capture           Capture live runtime output
  surface           Manage surface bindings
  bridge            Manage low-level local bridge delivery

NEXT STEP
  Run hrc <command> --help for command-specific flags and edge cases.
`

function printInfo(): void {
  process.stdout.write(INFO_TEXT)
}

function printUsage(): void {
  process.stderr.write(`hrc — HRC operator CLI

Usage: hrc <command> [options]

Commands:
  info                                Show HRC orientation and first-contact guidance
  server [start] [--foreground|--daemon]     Start the HRC server (foreground by default)
  server serve                               Run the server in the foreground (for launchd/systemd)
  server stop [--timeout-ms <n>] [--force]   Stop the HRC daemon only
  server restart [--foreground|--daemon]     Restart the HRC daemon only (daemon by default)
  server status [--json]                     Show daemon/socket/pid state without requiring the API
  server health                       Check daemon health through the API
  server tmux status [--json]         Show HRC tmux socket/session state
  server tmux kill --yes              Kill the HRC tmux server and all interactive runtimes
  session resolve --scope <ref> [--lane <ref>]  Resolve or create a session
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  session clear-context <hostSessionId> [--relaunch]
  status [--json]                     Show server status and capabilities
  events [scope] [--from-seq <n>] [--follow] [--pretty]
                                     Watch HRC event stream (NDJSON or pretty)
  runtime ensure <hostSessionId> [--provider <provider>] [--restart-style <style>]
  runtime list [--host-session-id <id>]  List runtimes
  runtime capture <runtimeId>         Capture tmux pane text
  runtime interrupt <runtimeId>       Send Ctrl-C to a runtime pane
  runtime terminate <runtimeId>       Terminate a runtime session
  runtime adopt <runtimeId>           Adopt a dead/stale runtime
  launch list [--host-session-id <id>] [--runtime-id <id>]  List launches
  start <scope> [prompt] [--force-restart] [--new-session] [--dry-run]
  run <scope> [prompt] [--force-restart] [--no-attach] [--dry-run]
  turn send <hostSessionId> --prompt <text> [--provider <provider>]
  inflight send <runtimeId> --run-id <runId> --input <text> [--input-type <type>]
  capture <runtimeId>                 Capture tmux pane text
  attach <scope> [--dry-run]          Attach to the latest active tmux runtime for a scope
  attach <runtimeId>                  Print tmux attach descriptor JSON
  surface bind <runtimeId> --kind <kind> --id <surfaceId>
  surface unbind --kind <kind> --id <surfaceId> [--reason <reason>]
  surface list <runtimeId>            List active surface bindings for a runtime
  bridge target --bridge <bridge> (--host-session <id> | --session-ref <sessionRef>) [--transport <t>] [--target <tgt>]
  bridge deliver-text --bridge <bridgeId> --text <text> [--enter] [--oob-suffix <s>]
  bridge register <hostSessionId> --transport <name> --target <value>  (compat)
  bridge deliver <bridgeId> --text <text>                              (compat)
  bridge list <runtimeId>             List active local bridges for a runtime
  bridge close <bridgeId>             Close a local bridge
`)
}

// -- Main dispatch ------------------------------------------------------------

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  const rest = args.slice(1)

  if (command === 'info') {
    printInfo()
    return
  }

  if (!command || command === '--help' || command === '-h') {
    printUsage()
    if (!command) process.exit(1)
    return
  }

  try {
    switch (command) {
      case 'server':
        return await cmdServer(rest)
      case 'session':
        return await cmdSession(rest)
      case 'events':
        return await cmdEvents(rest)
      case 'status':
        return await cmdStatus(rest)
      case 'runtime':
        return await cmdRuntime(rest)
      case 'launch':
        return await cmdLaunch(rest)
      case 'start':
        return await cmdStart(rest)
      case 'run':
        return await cmdRun(rest)
      case 'turn':
        return await cmdTurn(rest)
      case 'inflight':
        return await cmdInflight(rest)
      case 'capture':
        return await cmdCapture(rest)
      case 'attach':
        return await cmdAttach(rest)
      case 'surface':
        return await cmdSurface(rest)
      case 'bridge':
        return await cmdBridge(rest)
      default:
        fatal(`unknown command: ${command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fatal(message)
  }
}

if (import.meta.main) {
  main()
}
