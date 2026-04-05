#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  formatScopeRef,
  parseScopeHandle,
  parseScopeRef,
  parseSessionHandle,
  validateScopeHandle,
  validateScopeRef,
} from 'agent-scope'

import {
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from 'hrc-core'
import type {
  HrcAppSessionSpec,
  HrcRuntimeIntent,
  HrcStatusResponse,
  HrcStatusSessionView,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'
import { getAgentsRoot, getProjectsRoot } from 'spaces-config'

// -- Helpers ------------------------------------------------------------------

function fatal(message: string): never {
  process.stderr.write(`hrc: ${message}\n`)
  process.exit(1)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined) {
    fatal(`missing required argument: ${name}`)
  }
  return value
}

function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === flag) {
      const value = args[i + 1]
      if (value === undefined) {
        fatal(`${flag} requires a value`)
      }
      return value
    }
    // Support --flag=value syntax
    if (arg?.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1)
    }
  }
  return undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

function createDefaultRuntimeIntent(
  provider: 'anthropic' | 'openai',
  cwd = process.cwd()
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
      preferredMode: 'interactive',
    },
  }
}

function resolveRunScopeInput(input: string): {
  parsed: ReturnType<typeof parseScopeRef>
  scopeRef: string
  laneRef: 'main' | `lane:${string}`
} {
  if (input.includes('~')) {
    const session = parseSessionHandle(input)
    return {
      parsed: parseScopeRef(session.scopeRef),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
    }
  }

  const handleResult = validateScopeHandle(input)
  if (handleResult.ok) {
    const parsed = parseScopeHandle(input)
    return {
      parsed: parseScopeRef(parsed.scopeRef),
      scopeRef: formatScopeRef(parsed),
      laneRef: 'main',
    }
  }

  const refResult = validateScopeRef(input)
  if (refResult.ok) {
    return {
      parsed: parseScopeRef(input),
      scopeRef: input,
      laneRef: 'main',
    }
  }

  throw new Error(
    `Invalid scope input "${input}": not a valid ScopeHandle, SessionHandle, or ScopeRef`
  )
}

function buildRunBundle(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): { kind: 'agent-default' } | { kind: 'agent-project'; agentName: string; projectRoot?: string } {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (existsSync(profilePath)) {
    return {
      kind: 'agent-project',
      agentName,
      ...(projectRoot ? { projectRoot } : {}),
    }
  }
  return { kind: 'agent-default' }
}

function encodeManagedAppSessionKey(publicAppSessionKey: string): string {
  return encodeURIComponent(publicAppSessionKey)
}

function withPublicAppSessionKey<T extends { session: { appSessionKey: string } }>(
  result: T,
  publicAppSessionKey: string
): T {
  return {
    ...result,
    session: {
      ...result.session,
      appSessionKey: publicAppSessionKey,
    },
  }
}

function parseRunPrompt(args: string[]): string | undefined {
  let prompt: string | undefined

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--label') {
      if (args[i + 1] === undefined) {
        fatal('--label requires a value')
      }
      i += 1
      continue
    }

    if (arg.startsWith('--label=')) {
      continue
    }

    if (arg === '--force-restart' || arg === '--no-attach') {
      continue
    }

    if (arg.startsWith('-')) {
      fatal(`unknown run option: ${arg}`)
    }

    if (prompt !== undefined) {
      fatal('run accepts at most one positional prompt')
    }
    prompt = arg
  }

  return prompt
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

// -- Command handlers ---------------------------------------------------------

async function cmdServer(args: string[]): Promise<void> {
  const daemon = hasFlag(args, '--daemon') || hasFlag(args, '-d') || hasFlag(args, '--background')

  if (daemon) {
    return daemonize()
  }

  return serverForeground()
}

async function daemonize(): Promise<void> {
  const runtimeRoot = resolveRuntimeRoot()
  await mkdir(runtimeRoot, { recursive: true })

  const logPath = `${runtimeRoot}/server.log`
  const pidPath = `${runtimeRoot}/server.pid`

  const proc = Bun.spawn(['bun', process.argv[1] ?? import.meta.path, 'server'], {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: 'ignore',
    env: { ...process.env },
  })

  // Detach so the parent can exit without killing the child
  proc.unref()

  await writeFile(pidPath, `${proc.pid}\n`)
  process.stderr.write(`hrc: daemon started (pid ${proc.pid}), log at ${logPath}\n`)
}

async function serverForeground(): Promise<void> {
  const { createHrcServer } = await import('hrc-server')

  const runtimeRoot = resolveRuntimeRoot()
  const stateRoot = resolveStateRoot()
  const pidPath = `${runtimeRoot}/server.pid`

  const server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath: resolveControlSocketPath(),
    lockPath: `${runtimeRoot}/server.lock`,
    spoolDir: resolveSpoolDir(),
    dbPath: resolveDatabasePath(),
    tmuxSocketPath: resolveTmuxSocketPath(),
  })

  // Write PID file for foreground too (used by status/stop)
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(pidPath, `${process.pid}\n`)

  process.stderr.write(`hrc: server listening on ${resolveControlSocketPath()}\n`)

  const shutdown = async () => {
    process.stderr.write('hrc: shutting down...\n')
    await server.stop()
    // Clean up PID file
    try {
      await unlink(pidPath)
    } catch {}
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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

async function cmdSessionApply(args: string[]): Promise<void> {
  const appIdFlag = parseFlag(args, '--app')
  const hostSessionIdFlag = parseFlag(args, '--host-session-id')
  const filePath = parseFlag(args, '--file')
  const jsonPayload = parseFlag(args, '--json')

  if (!filePath && !jsonPayload) {
    fatal('session apply requires --file <path> or --json <payload>')
  }

  if (filePath && jsonPayload) {
    fatal('session apply accepts only one of --file or --json')
  }

  const raw =
    filePath !== undefined ? await readFile(filePath, 'utf-8') : (jsonPayload as string | undefined)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '')
  } catch {
    fatal('session apply payload must be valid JSON')
  }

  const request = toSessionApplyRequest(parsed, appIdFlag, hostSessionIdFlag)

  const client = createClient()
  const result = await client.applyAppSessions(request)
  printJson(result)
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
    case 'apply':
      return cmdSessionApply(rest)
    default:
      fatal(
        subcommand
          ? `unknown session subcommand: ${subcommand}`
          : 'session subcommand required (resolve, list, get, apply)'
      )
  }
}

async function cmdWatch(args: string[]): Promise<void> {
  const fromSeqRaw = parseFlag(args, '--from-seq')
  const follow = hasFlag(args, '--follow')

  const fromSeq = fromSeqRaw !== undefined ? Number.parseInt(fromSeqRaw, 10) : undefined
  if (fromSeqRaw !== undefined && (!Number.isFinite(fromSeq) || (fromSeq ?? 0) < 1)) {
    fatal('--from-seq must be a positive integer')
  }

  const client = createClient()
  for await (const event of client.watch({ fromSeq, follow })) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
}

async function cmdHealth(): Promise<void> {
  const client = createClient()
  const result = await client.getHealth()
  printJson(result)
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
  const client = createClient()
  const result = await client.getStatus()

  if (jsonFlag) {
    printJson(result)
  } else {
    printStatusHuman(result as HrcStatusResponse)
  }
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

async function cmdRun(args: string[]): Promise<void> {
  const scopeInput = requireArg(args, 0, '<scope>')
  const label = parseFlag(args, '--label')
  const forceRestart = hasFlag(args, '--force-restart')
  const noAttach = hasFlag(args, '--no-attach')
  const prompt = parseRunPrompt(args)

  const { parsed, scopeRef, laneRef } = resolveRunScopeInput(scopeInput)
  const laneId = laneRef === 'main' ? 'main' : laneRef.slice(5)
  const publicAppSessionKey = `${scopeRef}/lane:${laneId}`
  const appSessionKey = encodeManagedAppSessionKey(publicAppSessionKey)

  const agentsRoot = getAgentsRoot()
  if (!agentsRoot) {
    fatal('run requires an agents root; set ASP_AGENTS_ROOT or configure agents-root')
  }

  const agentRoot = join(agentsRoot, parsed.agentId)
  const projectsRoot = getProjectsRoot()
  const projectRoot =
    parsed.projectId && projectsRoot ? join(projectsRoot, parsed.projectId) : undefined
  const cwd = projectRoot ?? agentRoot
  const bundle = buildRunBundle(agentRoot, parsed.agentId, projectRoot)

  const intent = {
    placement: {
      agentRoot,
      ...(projectRoot ? { projectRoot } : {}),
      cwd,
      runMode: 'task' as const,
      bundle,
    },
    harness: {
      provider: 'anthropic' as const,
      interactive: true,
    },
    execution: {
      preferredMode: 'interactive' as const,
    },
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  }

  const client = createClient()
  const result = await client.ensureAppSession({
    selector: {
      appId: 'hrc-cli',
      appSessionKey,
    },
    spec: {
      kind: 'harness',
      runtimeIntent: intent,
    },
    label: label ?? scopeInput,
    restartStyle: 'fresh_pty',
    ...(forceRestart ? { forceRestart: true } : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  })

  if (noAttach) {
    printJson(withPublicAppSessionKey(result, publicAppSessionKey))
    return
  }

  const descriptor = await client.attachAppSession({
    appId: 'hrc-cli',
    appSessionKey,
  })
  await attachDescriptor(client, descriptor)
}

async function cmdRuntimeEnsure(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const providerRaw = parseFlag(args, '--provider') ?? 'anthropic'
  const restartStyle = parseFlag(args, '--restart-style')

  if (providerRaw !== 'anthropic' && providerRaw !== 'openai') {
    fatal('--provider must be one of: anthropic, openai')
  }

  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    fatal('--restart-style must be one of: reuse_pty, fresh_pty')
  }

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
    default:
      fatal(
        subcommand
          ? `unknown runtime subcommand: ${subcommand}`
          : 'runtime subcommand required (ensure, list)'
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

async function cmdClearContext(args: string[]): Promise<void> {
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

async function cmdAttach(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const client = createClient()
  const descriptor = await client.getAttachDescriptor(runtimeId)
  await bindGhosttySurfaceIfPresent(client, descriptor)
  printJson(descriptor)
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
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
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

  // Selector: --app/--key or --host-session (exactly one required)
  if (!hostSession && !(appId && appSessionKey)) {
    fatal('bridge target requires --host-session or --app/--key selector')
  }
  if (hostSession && appId) {
    fatal('bridge target accepts --host-session or --app/--key, not both')
  }

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const selector: import('hrc-core').HrcBridgeTargetSelector =
    appId && appSessionKey
      ? { appSession: { appId, appSessionKey } }
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

function toSessionApplyRequest(
  parsed: unknown,
  appIdFlag: string | undefined,
  hostSessionIdFlag: string | undefined
): {
  appId: string
  hostSessionId: string
  sessions: Array<{
    appSessionKey: string
    label?: string | undefined
    metadata?: Record<string, unknown> | undefined
  }>
} {
  if (Array.isArray(parsed)) {
    if (!appIdFlag) {
      fatal('session apply requires --app when the payload is an array')
    }
    if (!hostSessionIdFlag) {
      fatal('session apply requires --host-session-id when the payload is an array')
    }

    return {
      appId: appIdFlag,
      hostSessionId: hostSessionIdFlag,
      sessions: parsed.map((entry, index) => parseCliAppSession(entry, index)),
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    fatal('session apply payload must be a JSON object or array')
  }

  const appIdValue =
    typeof (parsed as Record<string, unknown>)['appId'] === 'string'
      ? ((parsed as Record<string, unknown>)['appId'] as string).trim()
      : appIdFlag
  const hostSessionIdValue =
    typeof (parsed as Record<string, unknown>)['hostSessionId'] === 'string'
      ? ((parsed as Record<string, unknown>)['hostSessionId'] as string).trim()
      : hostSessionIdFlag
  const sessions = (parsed as Record<string, unknown>)['sessions']

  if (!appIdValue) {
    fatal('session apply requires appId in the payload or via --app')
  }
  if (!hostSessionIdValue) {
    fatal('session apply requires hostSessionId in the payload or via --host-session-id')
  }
  if (!Array.isArray(sessions)) {
    fatal('session apply payload object must include a sessions array')
  }

  return {
    appId: appIdValue,
    hostSessionId: hostSessionIdValue,
    sessions: sessions.map((entry, index) => parseCliAppSession(entry, index)),
  }
}

function parseCliAppSession(
  value: unknown,
  index: number
): {
  appSessionKey: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
} {
  if (!value || typeof value !== 'object') {
    fatal(`session apply entry ${index} must be an object`)
  }

  const record = value as Record<string, unknown>
  const appSessionKey = requireCliString(record, 'appSessionKey', index)
  const label = optionalCliString(record, 'label', index)
  const metadata = record['metadata']
  if (
    metadata !== undefined &&
    (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
  ) {
    fatal(`session apply entry ${index} metadata must be an object`)
  }

  return {
    appSessionKey,
    ...(label ? { label } : {}),
    ...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
  }
}

function requireCliString(record: Record<string, unknown>, field: string, index: number): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fatal(`session apply entry ${index} requires ${field}`)
  }

  return value.trim()
}

function optionalCliString(
  record: Record<string, unknown>,
  field: string,
  index: number
): string | undefined {
  const value = record[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    fatal(`session apply entry ${index} field ${field} must be a string`)
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

// -- App-session commands (Phase 4) -------------------------------------------

async function cmdAppSessionEnsure(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const kind = parseFlag(args, '--kind')
  const label = parseFlag(args, '--label')
  const specJson = parseFlag(args, '--spec')
  const restartStyle = parseFlag(args, '--restart-style')
  const forceRestart = hasFlag(args, '--force-restart')
  const providerRaw = parseFlag(args, '--provider') ?? 'anthropic'

  if (!appId) fatal('--app is required for app-session ensure')
  if (!appSessionKey) fatal('--key is required for app-session ensure')

  const effectiveKind = kind ?? 'harness'
  if (effectiveKind !== 'harness' && effectiveKind !== 'command') {
    fatal('--kind must be one of: harness, command')
  }

  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    fatal('--restart-style must be one of: reuse_pty, fresh_pty')
  }

  if (providerRaw !== 'anthropic' && providerRaw !== 'openai') {
    fatal('--provider must be one of: anthropic, openai')
  }

  let spec: HrcAppSessionSpec
  if (specJson) {
    try {
      spec = JSON.parse(specJson) as HrcAppSessionSpec
    } catch {
      fatal('--spec must be valid JSON')
    }
  } else if (effectiveKind === 'command') {
    spec = { kind: 'command', command: {} }
  } else {
    spec = {
      kind: 'harness',
      runtimeIntent: createDefaultRuntimeIntent(providerRaw),
    }
  }

  const client = createClient()
  const result = await client.ensureAppSession({
    selector: { appId, appSessionKey },
    spec,
    ...(label ? { label } : {}),
    ...(restartStyle ? { restartStyle } : {}),
    ...(forceRestart ? { forceRestart: true } : {}),
  })
  printJson(result)
}

async function cmdAppSessionList(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const kind = parseFlag(args, '--kind')
  const includeRemoved = hasFlag(args, '--include-removed')

  if (kind !== undefined && kind !== 'harness' && kind !== 'command') {
    fatal('--kind must be one of: harness, command')
  }

  const client = createClient()
  const result = await client.listAppSessions({
    ...(appId ? { appId } : {}),
    ...(kind ? { kind: kind as 'harness' | 'command' } : {}),
    ...(includeRemoved ? { includeRemoved: true } : {}),
  })
  printJson(result)
}

async function cmdAppSessionGet(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')

  if (!appId) fatal('--app is required for app-session get')
  if (!appSessionKey) fatal('--key is required for app-session get')

  const client = createClient()
  const result = await client.getAppSessionByKey(appId, appSessionKey)
  printJson(result)
}

async function cmdAppSessionRemove(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const keepRuntime = hasFlag(args, '--keep-runtime')

  if (!appId) fatal('--app is required for app-session remove')
  if (!appSessionKey) fatal('--key is required for app-session remove')

  const client = createClient()
  const result = await client.removeAppSession({
    selector: { appId, appSessionKey },
    ...(keepRuntime ? { terminateRuntime: false } : {}),
  })
  printJson(result)
}

async function cmdAppSessionApply(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const filePath = parseFlag(args, '--file')
  const jsonPayload = parseFlag(args, '--json')
  const pruneMissing = hasFlag(args, '--prune-missing')

  if (!appId) fatal('--app is required for app-session apply')
  if (!filePath && !jsonPayload)
    fatal('app-session apply requires --file <path> or --json <payload>')
  if (filePath && jsonPayload) fatal('app-session apply accepts only one of --file or --json')

  const raw = filePath !== undefined ? await readFile(filePath, 'utf-8') : (jsonPayload as string)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fatal('app-session apply payload must be valid JSON')
  }

  if (!Array.isArray(parsed)) {
    fatal('app-session apply payload must be a JSON array of session entries')
  }

  const client = createClient()
  const result = await client.applyManagedAppSessions({
    appId,
    sessions: parsed as Array<{
      appSessionKey: string
      spec: HrcAppSessionSpec
      label?: string
      metadata?: Record<string, unknown>
    }>,
    ...(pruneMissing ? { pruneMissing: true } : {}),
  })
  printJson(result)
}

async function cmdAppSessionCapture(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')

  if (!appId) fatal('--app is required for app-session capture')
  if (!appSessionKey) fatal('--key is required for app-session capture')

  const client = createClient()
  const result = await client.captureAppSession({ appId, appSessionKey })
  process.stdout.write(result.text)
  if (!result.text.endsWith('\n')) {
    process.stdout.write('\n')
  }
}

async function cmdAppSessionAttach(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')

  if (!appId) fatal('--app is required for app-session attach')
  if (!appSessionKey) fatal('--key is required for app-session attach')

  const client = createClient()
  const descriptor = await client.attachAppSession({ appId, appSessionKey })
  printJson(descriptor)
}

async function cmdAppSessionLiteralInput(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const text = parseFlag(args, '--text')
  const enter = hasFlag(args, '--enter')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')

  if (!appId) fatal('--app is required for app-session literal-input')
  if (!appSessionKey) fatal('--key is required for app-session literal-input')
  if (!text) fatal('--text is required for app-session literal-input')

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const client = createClient()
  const result = await client.sendLiteralInput({
    selector: { appId, appSessionKey },
    text,
    enter,
    ...(expectedHostSessionId || expectedGeneration !== undefined
      ? {
          fence: {
            ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
            ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
          },
        }
      : {}),
  })
  printJson(result)
}

async function cmdAppSessionInterrupt(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const hard = hasFlag(args, '--hard')

  if (!appId) fatal('--app is required for app-session interrupt')
  if (!appSessionKey) fatal('--key is required for app-session interrupt')

  const client = createClient()
  const result = await client.interruptAppSession({
    selector: { appId, appSessionKey },
    ...(hard ? { hard: true } : {}),
  })
  printJson(result)
}

async function cmdAppSessionTerminate(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const hard = hasFlag(args, '--hard')

  if (!appId) fatal('--app is required for app-session terminate')
  if (!appSessionKey) fatal('--key is required for app-session terminate')

  const client = createClient()
  const result = await client.terminateAppSession({
    selector: { appId, appSessionKey },
    ...(hard ? { hard: true } : {}),
  })
  printJson(result)
}

async function cmdAppSessionTurn(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const text = parseFlag(args, '--text')
  const runId = parseFlag(args, '--run-id')
  const expectedHostSessionId = parseFlag(args, '--expected-host-session-id')
  const expectedGenerationRaw = parseFlag(args, '--expected-generation')
  const followLatest = hasFlag(args, '--follow-latest')

  if (!appId) fatal('--app is required for app-session turn')
  if (!appSessionKey) fatal('--key is required for app-session turn')
  if (!text) fatal('--text is required for app-session turn')

  const expectedGeneration =
    expectedGenerationRaw !== undefined ? Number.parseInt(expectedGenerationRaw, 10) : undefined
  if (
    expectedGenerationRaw !== undefined &&
    (!Number.isFinite(expectedGeneration) || (expectedGeneration ?? 0) < 0)
  ) {
    fatal('--expected-generation must be a non-negative integer')
  }

  const fenceValue =
    expectedHostSessionId !== undefined || expectedGeneration !== undefined || followLatest
      ? {
          ...(expectedHostSessionId ? { expectedHostSessionId } : {}),
          ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
          ...(followLatest ? { followLatest: true } : {}),
        }
      : undefined

  const client = createClient()
  const result = await client.dispatchAppHarnessTurn({
    selector: { appId, appSessionKey },
    prompt: text,
    input: { text },
    ...(runId ? { runId } : {}),
    fence: fenceValue,
    fences: fenceValue,
  })
  printJson(result)
}

async function cmdAppSessionInflight(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const runId = parseFlag(args, '--run-id')
  const text = parseFlag(args, '--text')
  const inputType = parseFlag(args, '--input-type')

  if (!appId) fatal('--app is required for app-session inflight')
  if (!appSessionKey) fatal('--key is required for app-session inflight')
  if (!text) fatal('--text is required for app-session inflight')

  const client = createClient()
  const result = await client.sendAppHarnessInFlightInput({
    selector: { appId, appSessionKey },
    prompt: text,
    input: { text },
    ...(runId ? { runId } : {}),
    ...(inputType ? { inputType } : {}),
  })
  printJson(result)
}

async function cmdAppSessionClearContext(args: string[]): Promise<void> {
  const appId = parseFlag(args, '--app')
  const appSessionKey = parseFlag(args, '--key')
  const relaunch = hasFlag(args, '--relaunch')

  if (!appId) fatal('--app is required for app-session clear-context')
  if (!appSessionKey) fatal('--key is required for app-session clear-context')

  const client = createClient()
  const result = await client.clearAppSessionContext({
    selector: { appId, appSessionKey },
    ...(relaunch ? { relaunch: true } : {}),
  })
  printJson(result)
}

async function cmdAppSession(args: string[]): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  switch (subcommand) {
    case 'ensure':
      return cmdAppSessionEnsure(rest)
    case 'list':
      return cmdAppSessionList(rest)
    case 'get':
      return cmdAppSessionGet(rest)
    case 'remove':
      return cmdAppSessionRemove(rest)
    case 'apply':
      return cmdAppSessionApply(rest)
    case 'capture':
      return cmdAppSessionCapture(rest)
    case 'attach':
      return cmdAppSessionAttach(rest)
    case 'literal-input':
      return cmdAppSessionLiteralInput(rest)
    case 'interrupt':
      return cmdAppSessionInterrupt(rest)
    case 'terminate':
      return cmdAppSessionTerminate(rest)
    case 'turn':
      return cmdAppSessionTurn(rest)
    case 'inflight':
      return cmdAppSessionInflight(rest)
    case 'clear-context':
      return cmdAppSessionClearContext(rest)
    default:
      fatal(
        subcommand
          ? `unknown app-session subcommand: ${subcommand}`
          : 'app-session subcommand required (ensure, list, get, remove, apply, capture, attach, literal-input, interrupt, terminate, turn, inflight, clear-context)'
      )
  }
}

// -- Usage --------------------------------------------------------------------

function printUsage(): void {
  process.stderr.write(`hrc — HRC operator CLI

Usage: hrc <command> [options]

Commands:
  server [-d|--daemon|--background]   Start the HRC server (foreground by default)
  session resolve --scope <ref> [--lane <ref>]  Resolve or create a session
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  session apply --app <appId> --host-session-id <hostSessionId> (--file <path> | --json <payload>)
  watch [--from-seq <n>] [--follow]   Watch HRC event stream (NDJSON)
  health                              Check server health
  status [--json]                     Show server status and capabilities
  runtime ensure <hostSessionId> [--provider <provider>] [--restart-style <style>]
  runtime list [--host-session-id <id>]  List runtimes
  launch list [--host-session-id <id>] [--runtime-id <id>]  List launches
  adopt <runtimeId>                   Adopt a dead/stale runtime
  run <scope> [prompt] [--label <text>] [--force-restart] [--no-attach]
  turn send <hostSessionId> --prompt <text> [--provider <provider>]
  inflight send <runtimeId> --run-id <runId> --input <text> [--input-type <type>]
  capture <runtimeId>                 Capture tmux pane text
  attach <runtimeId>                  Print tmux attach descriptor JSON
  surface bind <runtimeId> --kind <kind> --id <surfaceId>
  surface unbind --kind <kind> --id <surfaceId> [--reason <reason>]
  surface list <runtimeId>            List active surface bindings for a runtime
  bridge target --bridge <bridge> (--host-session <id> | --app <appId> --key <appSessionKey>) [--transport <t>] [--target <tgt>]
  bridge deliver-text --bridge <bridgeId> --text <text> [--enter] [--oob-suffix <s>]
  bridge register <hostSessionId> --transport <name> --target <value>  (compat)
  bridge deliver <bridgeId> --text <text>                              (compat)
  bridge list <runtimeId>             List active local bridges for a runtime
  bridge close <bridgeId>             Close a local bridge
  app-session ensure --app <appId> --key <key> [--kind harness|command] [--spec <json>]
  app-session list [--app <appId>] [--kind harness|command] [--include-removed]
  app-session get --app <appId> --key <key>
  app-session remove --app <appId> --key <key> [--keep-runtime]
  app-session apply --app <appId> (--file <path> | --json <payload>) [--prune-missing]
  app-session capture --app <appId> --key <key>
  app-session attach --app <appId> --key <key>
  app-session literal-input --app <appId> --key <key> --text <text> [--enter]
  app-session interrupt --app <appId> --key <key> [--hard]
  app-session terminate --app <appId> --key <key> [--hard]
  app-session turn --app <appId> --key <key> --text <text> [--run-id <runId>] [--expected-host-session-id <id>] [--expected-generation <n>] [--follow-latest]
  app-session inflight --app <appId> --key <key> --text <text> [--run-id <runId>] [--input-type <type>]
  app-session clear-context --app <appId> --key <key> [--relaunch]
  clear-context <hostSessionId> [--relaunch]
  interrupt <runtimeId>               Send Ctrl-C to a runtime pane
  terminate <runtimeId>               Terminate a runtime session
`)
}

// -- Main dispatch ------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const rest = args.slice(1)

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
      case 'watch':
        return await cmdWatch(rest)
      case 'health':
        return await cmdHealth()
      case 'status':
        return await cmdStatus(rest)
      case 'runtime':
        return await cmdRuntime(rest)
      case 'launch':
        return await cmdLaunch(rest)
      case 'adopt':
        return await cmdAdopt(rest)
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
      case 'app-session':
        return await cmdAppSession(rest)
      case 'clear-context':
        return await cmdClearContext(rest)
      case 'interrupt':
        return await cmdInterrupt(rest)
      case 'terminate':
        return await cmdTerminate(rest)
      default:
        fatal(`unknown command: ${command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fatal(message)
  }
}

main()
