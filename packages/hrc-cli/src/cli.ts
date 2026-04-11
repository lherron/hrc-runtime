#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import {
  formatScopeRef,
  parseScopeHandle,
  parseScopeRef,
  parseSessionHandle,
  validateScopeHandle,
  validateScopeRef,
} from 'agent-scope'

import {
  HrcDomainError,
  HrcErrorCode,
  resolveControlSocketPath,
  resolveDatabasePath,
  resolveRuntimeRoot,
  resolveSpoolDir,
  resolveStateRoot,
  resolveTmuxSocketPath,
} from 'hrc-core'
import type { HrcRuntimeIntent, HrcStatusResponse, HrcStatusSessionView } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'
import { getAgentsRoot, getProjectsRoot, parseAgentProfile } from 'spaces-config'

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

/**
 * Infer a project ID from ASP_PROJECT env var or from cwd being a direct
 * child of the configured projects root.
 */
function inferProjectId(): string | undefined {
  const fromEnv = process.env['ASP_PROJECT']
  if (fromEnv) return fromEnv

  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) return undefined
  const cwd = resolve(process.cwd())
  const resolvedRoot = resolve(projectsRoot)
  // cwd must be a direct child of projectsRoot (e.g. ~/praesidium/agent-spaces)
  if (resolve(join(cwd, '..')) === resolvedRoot) {
    return basename(cwd)
  }
  return undefined
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
    `invalid scope "${input}". Expected one of:\n  agent name       e.g. larry\n  agent@project    e.g. larry@agent-spaces\n  with task        e.g. larry@agent-spaces:T-00123\n  with lane        e.g. larry@agent-spaces:T-00123~repair\n  canonical ref    e.g. agent:larry:project:agent-spaces:task:T-00123`
  )
}

function resolveProviderFromAgent(agentRoot: string): 'anthropic' | 'openai' {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) return 'anthropic'
  try {
    const source = readFileSync(profilePath, 'utf8').replace(
      /^(\s*)schema_version(\s*=)/m,
      '$1schemaVersion$2'
    )
    const profile = parseAgentProfile(source, profilePath)
    if (profile.identity?.harness === 'codex') return 'openai'
  } catch {
    // Profile parse failed — fall back to default
  }
  return 'anthropic'
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

async function parseRunPrompt(args: string[]): Promise<string | undefined> {
  let prompt: string | undefined
  let source: 'positional' | '-p' | '--prompt-file' | undefined

  const setPrompt = (value: string, from: 'positional' | '-p' | '--prompt-file') => {
    if (prompt !== undefined) {
      fatal(
        source === from
          ? `run accepts at most one ${from === 'positional' ? 'positional prompt' : `${from} value`}`
          : `run prompt sources are mutually exclusive (${source} vs ${from})`
      )
    }
    prompt = value
    source = from
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (
      arg === '--force-restart' ||
      arg === '--no-attach' ||
      arg === '--dry-run' ||
      arg === '--debug'
    ) {
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
      fatal(`unknown run option: ${arg}`)
    }

    setPrompt(arg, 'positional')
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

  // Ignore SIGHUP so the daemon survives when the parent terminal/session exits
  // (e.g., Claude Code terminating). SIGINT and SIGTERM still trigger graceful shutdown.
  process.on('SIGHUP', () => {})
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
    default:
      fatal(
        subcommand
          ? `unknown session subcommand: ${subcommand}`
          : 'session subcommand required (resolve, list, get)'
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
  const allFlag = hasFlag(args, '--all')
  const client = createClient()
  const result = await client.getStatus(allFlag ? { includeArchived: true } : undefined)

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

/**
 * Convert common failure modes from `hrc run` into actionable error messages.
 * Preserves the original message for unrecognized cases. Returns an Error with
 * the wrapped message so the top-level `fatal()` handler prints it with the
 * `hrc:` prefix.
 */
function explainRunError(err: unknown, scopeInput: string, sessionRef?: string): Error {
  const raw = err instanceof Error ? err.message : String(err)

  // Daemon not running — discoverSocket throws this
  if (raw.includes('HRC daemon socket not found')) {
    return new Error(`${raw}\n  Start it with: hrc server --daemon`)
  }

  // Bun fetch connection-refused when socket exists but nothing is listening
  if (/typo in the url or port|ECONNREFUSED|Unable to connect/i.test(raw)) {
    return new Error(
      'cannot reach HRC daemon (socket present but not responding).\n' +
        '  The daemon may have crashed. Try: hrc server --daemon'
    )
  }

  if (err instanceof HrcDomainError) {
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
      return new Error(
        `conflict on "${scopeInput}": ${err.message}\n  Another alias already owns a different canonical session for this key.`
      )
    }

    if (err.code === HrcErrorCode.UNSUPPORTED_CAPABILITY) {
      return new Error(`cannot run "${scopeInput}": ${err.message}`)
    }

    // Other domain errors — show the code so operators can look it up
    return new Error(`"${scopeInput}" [${err.code}]: ${err.message}`)
  }

  // Fallback: pass the raw message through. Top-level fatal() adds the `hrc:`
  // prefix, and most helper errors already mention the scope in-line.
  return err instanceof Error ? err : new Error(raw)
}

async function cmdRun(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`Usage: hrc run <scope> [options]

  Launch or reattach an agent harness in a managed tmux session.

  <scope>  Agent scope: agent, agent@project, or full scope ref.
           When run from a project directory, the project is inferred
           automatically (e.g. "larry" becomes "larry@agent-spaces").

  By default, rerunning the same scope reattaches to the existing
  runtime and preserves the PTY/context. Use --force-restart to
  replace the runtime with a fresh PTY.

Options:
  --force-restart      Replace any existing runtime with a fresh PTY
  --no-attach          Start/ensure without attaching to the tmux session
  --dry-run            Local plan preview — no server calls, no side effects
  --debug              Keep tmux shell alive after harness exits
  -p <text>            Initial prompt to send to the harness
  --prompt-file <path> Read initial prompt from a file
`)
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const noAttach = hasFlag(args, '--no-attach')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const prompt = await parseRunPrompt(args)

  let sessionRef: string | undefined
  try {
    let { parsed, scopeRef, laneRef } = resolveRunScopeInput(scopeInput)

    // Infer project from environment or cwd when a bare agent name is given.
    if (!parsed.projectId) {
      const inferredProject = inferProjectId()
      if (inferredProject) {
        const qualifiedInput = `${scopeInput}@${inferredProject}`
        ;({ parsed, scopeRef, laneRef } = resolveRunScopeInput(qualifiedInput))
      }
    }

    const laneId = laneRef === 'main' ? 'main' : laneRef.slice(5)
    sessionRef = `${scopeRef}/lane:${laneId}`

    const agentsRoot = getAgentsRoot()
    if (!agentsRoot) {
      throw new Error(
        'run requires an agents root.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.'
      )
    }

    const agentRoot = join(agentsRoot, parsed.agentId)
    if (!existsSync(agentRoot)) {
      throw new Error(
        `agent "${parsed.agentId}" not found at ${agentRoot}.\n` +
          `  Check the spelling, or confirm ASP_AGENTS_ROOT (${agentsRoot}) contains this agent.`
      )
    }

    const projectsRoot = getProjectsRoot()
    const projectRoot =
      parsed.projectId && projectsRoot ? join(projectsRoot, parsed.projectId) : undefined
    const cwd = projectRoot ?? agentRoot
    const bundle = buildRunBundle(agentRoot, parsed.agentId, projectRoot)

    // Read agent profile to determine harness/provider
    const provider = resolveProviderFromAgent(agentRoot)

    const intent: HrcRuntimeIntent = {
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
        preferredMode: 'interactive' as const,
      },
      ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
      ...(debug ? { launch: { env: { HRC_DEBUG: '1' } } } : {}),
    }

    const restartStyle: 'reuse_pty' | 'fresh_pty' = forceRestart ? 'fresh_pty' : 'reuse_pty'

    if (dryRun) {
      printLocalRunPreview(scopeInput, sessionRef, intent, restartStyle, prompt)
      return
    }

    const client = createClient()

    const resolved = await client.resolveSession({ sessionRef, runtimeIntent: intent })
    const runtime = await client.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent,
      restartStyle,
    })

    // ensureRuntime only allocates the tmux pane — the harness process is
    // started by dispatchTurn. Always dispatch so the agent actually launches.
    // The server requires a non-empty prompt; when the user did not supply
    // one we send the scope as a placeholder. The priming prompt in argv is
    // built server-side from the agent profile and is not affected by this.
    // If the runtime is already busy (reused PTY with a running harness),
    // the server responds with RUNTIME_BUSY — in that case we silently skip
    // the dispatch and fall through to attach.
    try {
      await client.dispatchTurn({
        hostSessionId: resolved.hostSessionId,
        prompt: prompt && prompt.length > 0 ? prompt : scopeInput,
      })
    } catch (err) {
      if (!(err instanceof HrcDomainError) || err.code !== HrcErrorCode.RUNTIME_BUSY) {
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
    throw explainRunError(err, scopeInput, sessionRef)
  }
}

function printLocalRunPreview(
  scope: string,
  sessionRef: string,
  intent: HrcRuntimeIntent,
  restartStyle: 'reuse_pty' | 'fresh_pty',
  prompt: string | undefined
): void {
  const w = (s: string) => process.stdout.write(`${s}\n`)

  w(`hrc run ${scope} --dry-run  (local plan preview — no server state consulted)\n`)
  w(`  sessionRef:   ${sessionRef}`)
  w(`  restartStyle: ${restartStyle}`)
  w(`  agentRoot:    ${intent.placement.agentRoot}`)
  w(`  projectRoot:  ${intent.placement.projectRoot ?? '(none)'}`)
  w(`  cwd:          ${intent.placement.cwd}`)
  w(`  provider:     ${intent.harness.provider}`)
  w(`  initialPrompt: ${prompt !== undefined ? `${prompt.length} chars` : '(none)'}`)

  const envOverrides = intent.launch?.env
  if (envOverrides && Object.keys(envOverrides).length > 0) {
    w('  env overrides:')
    for (const key of Object.keys(envOverrides).sort()) {
      const val = envOverrides[key]
      if (val === undefined) continue
      const display = val.length > 120 ? `${val.slice(0, 117)}...` : val
      w(`    ${key}=${display}`)
    }
  }

  w('')
  w('  Note: this preview shows the request the client would send. Server-side')
  w('  details (existing runtime, PTY state, tmux session) are not consulted.')
  w('  Run without --dry-run to execute.')
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

function printUsage(): void {
  process.stderr.write(`hrc — HRC operator CLI

Usage: hrc <command> [options]

Commands:
  server [-d|--daemon|--background]   Start the HRC server (foreground by default)
  session resolve --scope <ref> [--lane <ref>]  Resolve or create a session
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  watch [--from-seq <n>] [--follow]   Watch HRC event stream (NDJSON)
  health                              Check server health
  status [--json]                     Show server status and capabilities
  runtime ensure <hostSessionId> [--provider <provider>] [--restart-style <style>]
  runtime list [--host-session-id <id>]  List runtimes
  launch list [--host-session-id <id>] [--runtime-id <id>]  List launches
  adopt <runtimeId>                   Adopt a dead/stale runtime
  run <scope> [prompt] [--force-restart] [--no-attach] [--dry-run]
  turn send <hostSessionId> --prompt <text> [--provider <provider>]
  inflight send <runtimeId> --run-id <runId> --input <text> [--input-type <type>]
  capture <runtimeId>                 Capture tmux pane text
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
