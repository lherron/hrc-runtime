#!/usr/bin/env bun
import { existsSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve as resolvePath } from 'node:path'

import { resolveScopeInput } from 'agent-scope'
import { CliUsageError, exitWithError, parseIntegerValue } from 'cli-kit'
import { Command, CommanderError } from 'commander'

import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcHarness,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  InspectRuntimeResponse,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import type { AttachDescriptor } from 'hrc-sdk'
import { buildCliInvocation } from 'hrc-server'
import {
  PROJECT_MARKER_FILENAME,
  type TargetDefinition,
  buildRuntimeBundleRef,
  findProjectMarker,
  getAgentsRoot,
  inferProjectIdFromCwd,
  mergeAgentWithProjectTarget,
  normalizeHarnessFrontend,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPlacementPaths,
  resolveAgentPrimingPrompt,
  resolveHarnessProvider,
} from 'spaces-config'
import { displayPrompts, formatDisplayCommand, renderKeyValueSection } from 'spaces-execution'
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
import { cmdMonitorShow } from './monitor-show.js'
import { MonitorWaitExit, cmdMonitorWait } from './monitor-wait.js'
import { cmdMonitorWatch } from './monitor-watch.js'
import { printJson } from './print.js'

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

function fatal(message: string): never {
  throw new CliUsageError(message)
}

class CliStatusExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
    this.name = 'CliStatusExit'
  }
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
    if (arg?.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1)
    }
  }
  return undefined
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function parseIntegerFlag(
  args: string[],
  flag: string,
  options: {
    defaultValue: number
    min?: number | undefined
  }
): number {
  const raw = parseFlag(args, flag)
  if (raw === undefined) {
    return options.defaultValue
  }

  return parseIntegerValue(flag, raw, { min: options.min ?? 0 })
}

// -- toLegacyArgv (transitional glue for commander → legacy handler bridge) ---

type LegacyArgvSchema = {
  strings: string[]
  booleans: string[]
  negatedBooleans?: string[]
}

/**
 * Build a legacy-style `string[]` argv from commander-parsed positionals and
 * opts, so existing `(args: string[]): Promise<void>` handlers can be called
 * unchanged.
 *
 * Positionals come BEFORE flags in the emitted array (preserves the
 * runtimeId / hostSessionId positional contract that other groups rely on).
 *
 * `negatedBooleans` are detected from the raw `argv` slice (NOT from `opts`)
 * because commander's auto-negation collapses `--flag` and `--no-flag` into
 * the same attribute, destroying mutual-exclusion checks.
 *
 * @param positionals  Positional arguments forwarded verbatim.
 * @param opts         Parsed options from `cmd.opts()`.
 * @param schema       Declares which flags to emit and how.
 * @param rawArgv      The raw argv slice for the active command (used only for
 *                     negatedBooleans detection). Falls back to `process.argv`.
 */
function toLegacyArgv(
  positionals: string[],
  opts: Record<string, unknown>,
  schema: LegacyArgvSchema,
  rawArgv?: string[]
): string[] {
  const out: string[] = [...positionals]

  // String flags: --flag value
  for (const flag of schema.strings) {
    const key = camelCase(flag)
    const value = opts[key]
    if (value !== undefined && value !== null) {
      out.push(`--${flag}`, String(value))
    }
  }

  // Boolean flags: --flag (emit only when truthy)
  for (const flag of schema.booleans) {
    const key = camelCase(flag)
    if (opts[key]) {
      out.push(`--${flag}`)
    }
  }

  // Negated booleans: detect from raw argv, not from opts.
  // Commander's auto-negation collapses --X and --no-X into one attribute,
  // so we scan the raw argv slice to preserve mutual-exclusion semantics.
  // Both the positive and negated forms are emitted when present in rawArgv,
  // enabling handlers to enforce mutual-exclusion checks.
  if (schema.negatedBooleans && schema.negatedBooleans.length > 0) {
    const argv = rawArgv ?? process.argv
    for (const flag of schema.negatedBooleans) {
      if (argv.includes(`--${flag}`)) {
        out.push(`--${flag}`)
      }
      if (argv.includes(`--no-${flag}`)) {
        out.push(`--no-${flag}`)
      }
    }
  }

  return out
}

/** Convert a kebab-case flag name to camelCase (e.g. "timeout-ms" → "timeoutMs"). */
function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Build legacy argv for "scope commands" (start, run) that accept a
 * positional prompt and short flags like `-p`.
 *
 * These commands use `parseScopePrompt` which handles `-p <text>`,
 * `--prompt-file <path>`, and positional prompt text.  Commander
 * consumes declared options from `cmd.args`, so we must reconstruct
 * the complete legacy argv from both parsed positionals and opts,
 * while preserving `-p` (single-dash short flag) rather than `--p`.
 */
function toLegacyArgvForScopeCommand(
  positionals: string[],
  opts: Record<string, unknown>,
  rawArgv: string[],
  schema: LegacyArgvSchema
): string[] {
  const out: string[] = [...positionals]

  // String flags: --flag value
  for (const flag of schema.strings) {
    const key = camelCase(flag)
    const value = opts[key]
    if (value !== undefined && value !== null) {
      out.push(`--${flag}`, String(value))
    }
  }

  // Boolean flags: --flag (emit only when truthy)
  for (const flag of schema.booleans) {
    const key = camelCase(flag)
    if (opts[key]) {
      out.push(`--${flag}`)
    }
  }

  // Negated booleans: detect from raw argv, not from opts.
  if (schema.negatedBooleans && schema.negatedBooleans.length > 0) {
    for (const flag of schema.negatedBooleans) {
      if (rawArgv.includes(`--${flag}`)) {
        out.push(`--${flag}`)
      }
      if (rawArgv.includes(`--no-${flag}`)) {
        out.push(`--no-${flag}`)
      }
    }
  }

  // Short option: -p <text> (must emit as -p, NOT --p)
  if (opts['p'] !== undefined && opts['p'] !== null) {
    out.push('-p', String(opts['p']))
  }

  return out
}

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

type AgentHarnessResolution = {
  provider: 'anthropic' | 'openai'
  harness: string | undefined
}

export function harnessStringToHarnessId(harness: string | undefined): HrcHarness | undefined {
  return normalizeHarnessFrontend(harness) as HrcHarness | undefined
}

export function resolveAgentHarness(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): AgentHarnessResolution {
  const projectTarget = loadProjectTarget(projectRoot, agentName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return {
      provider: resolveProviderForHarness(projectTarget?.harness),
      harness: projectTarget?.harness,
    }
  }
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
    return {
      provider: resolveProviderForHarness(effective.harness),
      harness: effective.harness,
    }
  } catch {
    // Profile parse failed — fall back to default
  }
  return {
    provider: resolveProviderForHarness(projectTarget?.harness),
    harness: projectTarget?.harness,
  }
}

type ManagedScopeContext = {
  agentId: string
  projectId?: string | undefined
  scopeRef: string
  sessionRef: string
  /** Explicit projectRoot override (from --project-root or inferred from --project-id + cwd). */
  projectRootOverride?: string | undefined
}

type ExecAttachDescriptor = {
  argv: string[]
  env?: Record<string, string> | undefined
}

interface ResolveManagedScopeOptions {
  /** Explicit projectId override (from --project-id). Takes precedence over inference. */
  projectIdOverride?: string | undefined
  /**
   * Explicit projectRoot override (from --project-root). When set, the placement
   * resolver uses this path directly. When --project-id is set without
   * --project-root, projectRoot defaults to process.cwd().
   */
  projectRootOverride?: string | undefined
  /**
   * Registration policy for first-run in an unmarked dir:
   * - 'prompt' — if TTY and cwd is outside the agents root, ask whether to write
   *   asp-targets.toml; on Y, write it and re-infer.
   * - 'never'  — never prompt; fall through with no projectId.
   */
  registerPolicy?: 'prompt' | 'never'
}

function resolveManagedScopeContext(
  scopeInput: string,
  options: ResolveManagedScopeOptions = {}
): ManagedScopeContext {
  let { parsed, scopeRef, laneRef } = resolveScopeInput(scopeInput)

  if (!parsed.projectId && options.projectIdOverride) {
    ;({ parsed, scopeRef, laneRef } = resolveScopeInput(
      `${scopeInput}@${options.projectIdOverride}`
    ))
  }

  if (!parsed.projectId) {
    const inferredProject = inferProjectIdFromCwd()
    if (inferredProject) {
      ;({ parsed, scopeRef, laneRef } = resolveScopeInput(`${scopeInput}@${inferredProject}`))
    }
  }

  if (!parsed.projectId && (options.registerPolicy ?? 'never') === 'prompt') {
    const registered = maybePromptToRegisterProject()
    if (registered) {
      ;({ parsed, scopeRef, laneRef } = resolveScopeInput(`${scopeInput}@${registered}`))
    }
  }

  // If user explicitly overrode projectId (via --project-id) without also
  // giving --project-root, treat cwd as the project root. This matches the
  // intent of "I'm declaring cwd is project X".
  const projectRootOverride =
    options.projectRootOverride ??
    (options.projectIdOverride ? resolvePath(process.cwd()) : undefined)

  const laneId = laneRef === 'main' ? 'main' : laneRef.slice(5)
  return {
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    scopeRef,
    sessionRef: `${scopeRef}/lane:${laneId}`,
    ...(projectRootOverride ? { projectRootOverride } : {}),
  }
}

/**
 * Interactive first-run hook: if cwd is a plausible project root (not inside the
 * agents root, TTY available) and has no asp-targets.toml marker, ask the user
 * whether to register it. On yes, write a minimal marker and return its id.
 *
 * Returns undefined (silent fallback to current behavior) when:
 * - stdin/stdout isn't a TTY
 * - cwd is at or inside the configured agents root
 * - a marker already exists on the walk-up path (should have been caught upstream)
 * - user declines
 */
function maybePromptToRegisterProject(): string | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined

  const cwd = resolvePath(process.cwd())
  const agentsRoot = getAgentsRoot()
  if (agentsRoot) {
    const agentsRootResolved = resolvePath(agentsRoot)
    if (cwd === agentsRootResolved || cwd.startsWith(`${agentsRootResolved}/`)) {
      return undefined
    }
  }

  // Marker already exists somewhere on the walk-up path — shouldn't reach here,
  // but guard anyway.
  if (findProjectMarker(cwd, { agentsRoot })) return undefined

  const id = basename(cwd)
  process.stderr.write(
    `\nNo project marker found for ${cwd}.\n` +
      `Register as project '${id}' (writes ${PROJECT_MARKER_FILENAME} here)? [Y/n] `
  )

  // Use synchronous read so we don't have to thread async through every caller.
  const answer = readLineSync().trim().toLowerCase()
  if (answer !== '' && answer !== 'y' && answer !== 'yes') {
    process.stderr.write('Skipping project registration.\n\n')
    return undefined
  }

  const markerPath = join(cwd, PROJECT_MARKER_FILENAME)
  try {
    writeFileSync(
      markerPath,
      `# asp-targets.toml — project marker for ${id}\n# Add [targets.<name>] tables to define run targets.\nschema = 1\n`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Failed to write ${markerPath}: ${msg}\n`)
    return undefined
  }

  process.stderr.write(`Wrote ${markerPath}\n\n`)
  return id
}

/**
 * Minimal synchronous stdin read for the registration prompt.
 * Reads bytes until newline or EOF. Blocking; TTY-only caller.
 */
function readLineSync(): string {
  const buf = Buffer.alloc(1)
  const chars: string[] = []
  const fd = 0 // stdin
  try {
    while (true) {
      const n = readSync(fd, buf, 0, 1, null)
      if (n === 0) break
      const ch = buf.toString('utf8', 0, 1)
      if (ch === '\n') break
      chars.push(ch)
    }
  } catch {
    // fall through with whatever we collected
  }
  return chars.join('')
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
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
    agentRoot,
    ...(scope.projectRootOverride !== undefined
      ? { projectRoot: scope.projectRootOverride, cwd: scope.projectRootOverride }
      : {}),
  })
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: scope.agentId,
    agentRoot,
    projectRoot,
  })
  const { provider, harness: harnessString } = resolveAgentHarness(
    agentRoot,
    scope.agentId,
    projectRoot
  )
  const harnessId = harnessStringToHarnessId(harnessString)

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
      ...(harnessId !== undefined ? { id: harnessId } : {}),
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
      // Value-taking passthrough flags must also consume their value.
      if (arg === '--project-id' || arg === '--project-root') {
        if (args[i + 1] === undefined) fatal(`${arg} requires a value`)
        i += 1
      }
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

function printHrcDomainErrorBody(err: unknown): boolean {
  if (!isHrcDomainErrorLike(err)) {
    return false
  }

  throw new Error(
    JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        detail: err.detail ?? {},
      },
    })
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
  } else {
    process.stdout.write(formatServerRuntimeStatus(status))
  }
  if (status.exitCode !== 0) {
    throw new CliStatusExit(status.exitCode)
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

async function cmdSessionDropContinuation(args: string[]): Promise<void> {
  const hostSessionId = requireArg(args, 0, '<hostSessionId>')
  const reason = parseFlag(args, '--reason')

  const client = createClient()
  const result = await client.dropContinuation({
    hostSessionId,
    ...(reason ? { reason } : {}),
  })
  printJson(result)
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
  const transport = parseFlag(args, '--transport')
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    fatal('--transport must be one of: tmux, headless, sdk')
  }
  const status = parseFlag(args, '--status')
  const olderThan = parseFlag(args, '--older-than')
  const scope = parseFlag(args, '--scope')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()
  const runtimes = await client.listRuntimes({
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(transport ? { transport } : {}),
    ...(status
      ? {
          status: status
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        }
      : {}),
    ...(hasFlag(args, '--stale') ? { stale: true } : {}),
    ...(olderThan ? { olderThan } : {}),
    ...(scope ? { scope } : {}),
    ...(jsonOutput ? { json: true } : {}),
  })
  printJson(runtimes)
}

async function cmdRuntimeInspect(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const jsonOutput = hasFlag(args, '--json')
  const client = createClient()
  const result = await client.inspectRuntime({ runtimeId })

  if (jsonOutput) {
    printJson(result)
    return
  }

  printRuntimeInspect(result)
}

function printRuntimeInspect(runtime: InspectRuntimeResponse): void {
  const continuation = runtime.continuation
    ? `${runtime.continuation.provider}:${runtime.continuation.key ?? '(none)'}${
        runtime.continuationStale ? ' (stale)' : ''
      }`
    : '(none)'
  const lines = [
    `runtime ${runtime.runtimeId}`,
    `  scope         ${runtime.scopeRef}`,
    `  lane          ${runtime.laneRef}`,
    `  generation    ${runtime.generation}`,
    `  transport     ${runtime.transport}`,
    `  harness       ${runtime.harness}`,
    `  provider      ${runtime.provider}`,
    `  status        ${runtime.status}`,
    `  createdAt     ${runtime.createdAt} (age: ${formatAgeSec(runtime.createdAgeSec)})`,
    `  lastActivity  ${runtime.lastActivityAt ?? '(none)'} (age: ${
      runtime.lastActivityAgeSec === null ? '(none)' : formatAgeSec(runtime.lastActivityAgeSec)
    })`,
    `  activeRunId   ${runtime.activeRunId ?? '(none)'}`,
    `  wrapperPid    ${runtime.wrapperPid ?? '(none)'}`,
    `  childPid      ${runtime.childPid ?? '(none)'}`,
    `  continuation  ${continuation}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

function formatAgeSec(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

async function cmdRuntimeSweep(args: string[]): Promise<void> {
  const transport = parseFlag(args, '--transport')
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    fatal('--transport must be one of: tmux, headless, sdk')
  }

  const dryRunFlag = hasFlag(args, '--dry-run')
  const yes = hasFlag(args, '--yes')
  const jsonOutput = hasFlag(args, '--json')
  if (!dryRunFlag && !yes && !process.stdout.isTTY) {
    fatal('runtime sweep requires --yes to mutate when stdout is not a TTY')
  }
  if (transport === 'tmux' && !yes && !dryRunFlag) {
    fatal('runtime sweep --transport tmux requires --yes')
  }

  const statusRaw = parseFlag(args, '--status')
  const scope = parseFlag(args, '--scope')
  const request: SweepRuntimesRequest = {
    ...(transport ? { transport } : {}),
    olderThan: parseFlag(args, '--older-than') ?? '24h',
    ...(statusRaw
      ? {
          status: statusRaw
            .split(',')
            .map((status) => status.trim())
            .filter((status) => status.length > 0),
        }
      : {}),
    ...(scope ? { scope } : {}),
    ...(hasFlag(args, '--drop-continuation') ? { dropContinuation: true } : {}),
    dryRun: dryRunFlag || (!yes && Boolean(process.stdout.isTTY)),
    ...(yes ? { yes } : {}),
  }

  const client = createClient()
  const result = await client.sweepRuntimes(request)
  if (jsonOutput) {
    printSweepNdjson(result)
    return
  }

  printSweepHuman(result, request.dryRun === true)
}

function printSweepNdjson(result: SweepRuntimesResponse): void {
  for (const row of result.results) {
    process.stdout.write(`${JSON.stringify(row)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result.summary)}\n`)
}

function printSweepHuman(result: SweepRuntimesResponse, dryRun: boolean): void {
  process.stdout.write(`runtime sweep${dryRun ? ' (dry-run)' : ''}\n`)
  for (const row of result.results) {
    const suffix = row.errorMessage ? ` ${row.errorMessage}` : ''
    process.stdout.write(
      `  ${row.status.padEnd(10)} ${row.runtimeId} ${row.transport} dropContinuation=${
        row.droppedContinuation
      }${suffix}\n`
    )
  }
  process.stdout.write(
    `summary matched=${result.summary.matched} terminated=${result.summary.terminated} skipped=${result.summary.skipped} errors=${result.summary.errors}\n`
  )
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
  try {
    const result = await client.adoptRuntime(runtimeId)
    printJson(result)
  } catch (err) {
    if (printHrcDomainErrorBody(err)) {
      return
    }
    throw err
  }
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
  --project-id <id>    Override the inferred project id (cwd is treated as its root)
  --project-root <dir> Override project root (defaults to cwd when --project-id is set)
  --no-register        Don't prompt to register cwd as a project marker
  -p <text>            Initial prompt to send to the harness
  --prompt-file <path> Read initial prompt from a file
`)
}

async function cmdRun(args: string[]): Promise<void> {
  if (args.length === 0) {
    printManagedScopeUsage('run')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const noAttach = hasFlag(args, '--no-attach')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const prompt = await parseScopePrompt(args, {
    command: 'run',
    passthroughFlags: [
      '--force-restart',
      '--no-attach',
      '--dry-run',
      '--debug',
      '--no-register',
      '--project-id',
      '--project-root',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
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
  if (args.length === 0) {
    printManagedScopeUsage('start')
    return
  }

  const scopeInput = requireArg(args, 0, '<scope>')
  const forceRestart = hasFlag(args, '--force-restart')
  const newSession = hasFlag(args, '--new-session')
  const dryRun = hasFlag(args, '--dry-run')
  const debug = hasFlag(args, '--debug')
  const noRegister = hasFlag(args, '--no-register')
  const projectIdOverride = parseFlag(args, '--project-id')
  const projectRootOverride = parseFlag(args, '--project-root')
  const prompt = await parseScopePrompt(args, {
    command: 'start',
    passthroughFlags: [
      '--force-restart',
      '--new-session',
      '--dry-run',
      '--debug',
      '--no-register',
      '--project-id',
      '--project-root',
    ],
  })

  let sessionRef: string | undefined
  try {
    const scope = resolveManagedScopeContext(scopeInput, {
      projectIdOverride,
      projectRootOverride,
      registerPolicy: dryRun || noRegister ? 'never' : 'prompt',
    })
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
  try {
    const result = await client.capture(runtimeId)
    process.stdout.write(result.text)
    if (!result.text.endsWith('\n')) {
      process.stdout.write('\n')
    }
  } catch (err) {
    if (printHrcDomainErrorBody(err)) {
      return
    }
    throw err
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
  if (args.length === 0) {
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
  try {
    const result = await client.interrupt(runtimeId)
    printJson(result)
  } catch (err) {
    if (printHrcDomainErrorBody(err)) {
      return
    }
    throw err
  }
}

async function cmdTerminate(args: string[]): Promise<void> {
  const runtimeId = requireArg(args, 0, '<runtimeId>')
  const dropContinuation = hasFlag(args, '--drop-continuation')
  const noDropContinuation = hasFlag(args, '--no-drop-continuation')
  if (dropContinuation && noDropContinuation) {
    fatal('--drop-continuation and --no-drop-continuation are mutually exclusive')
  }

  const client = createClient()
  const result = await client.terminate(runtimeId, {
    ...(dropContinuation ? { dropContinuation: true } : {}),
    ...(noDropContinuation ? { dropContinuation: false } : {}),
  })
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
    hrc monitor watch

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
  monitor           Show, watch, and wait on HRC monitor snapshots/events
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
  server status [--json]                     Show daemon/socket/API health state
  server tmux status [--json]         Show HRC tmux socket/session state
  server tmux kill --yes              Kill the HRC tmux server and all interactive runtimes
  session resolve --scope <ref> [--lane <ref>]  Resolve or create a session
  session list [--scope <ref>] [--lane <ref>]   List sessions
  session get <hostSessionId>         Get a session by host session ID
  session clear-context <hostSessionId> [--relaunch]
  session drop-continuation <hostSessionId> [--reason <text>]
  monitor show [selector] [--json]    Show current HRC monitor snapshot
  monitor watch [selector] [--from-seq <n>|--last <n>] [--follow] [--json|--pretty]
                                     Watch HRC monitor event stream
  monitor wait <selector> --until <condition> [--timeout <duration>] [--stall-after <duration>] [--json]
                                     Wait for a monitor condition and exit with its result
  runtime ensure <hostSessionId> [--provider <provider>] [--restart-style <style>]
  runtime list [--host-session-id <id>] [--transport <transport>] [--status <csv>] [--stale] [--older-than <duration>] [--scope <prefix>] [--json]
                                     List runtimes
  runtime inspect <runtimeId> [--json] Inspect one runtime
  runtime sweep [--transport <t>] [--older-than <duration>] [--status <csv>] [--scope <prefix>] [--drop-continuation] [--dry-run|--yes] [--json]
                                     Sweep stale runtimes
  runtime capture <runtimeId>         Capture tmux pane text
  runtime interrupt <runtimeId>       Interrupt a runtime
  runtime terminate <runtimeId> [--drop-continuation|--no-drop-continuation]
                                     Terminate a runtime session
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

// -- Commander dispatch -------------------------------------------------------

function buildProgram(): Command {
  const program = new Command()
    .name('hrc')
    .description('HRC operator CLI')
    .exitOverride((err) => {
      throw err
    })

  program
    .command('info')
    .description('show HRC orientation and first-contact guidance')
    .action(() => {
      printInfo()
    })

  // -- server group (commander, Phase 6 T1) -----------------------------------

  const server = program
    .command('server')
    .description('daemon lifecycle, health, and tmux backend control')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_opts, cmd: Command) => {
      if (cmd.args.length > 0) {
        fatal(`unknown command: server ${cmd.args[0]}`)
      }
      // No-verb fallthrough: bare `hrc server` starts in foreground
      // (preserves legacy behavior where `hrc server [flags]` delegates to start)
      await cmdServerStart(cmd.args, 'foreground')
    })

  server
    .command('start')
    .description('start the HRC server')
    .option('--timeout-ms <n>', 'startup timeout in milliseconds')
    .option('--daemon', 'run as background daemon')
    .option('--foreground', 'run in foreground (default)')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms'],
        booleans: ['daemon', 'foreground'],
      })
      await cmdServerStart(args, 'foreground')
    })

  server
    .command('serve')
    .description('run the server in the foreground for supervisors')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), { strings: [], booleans: [] })
      await cmdServerServe(args)
    })

  server
    .command('stop')
    .description('stop the HRC daemon')
    .option('--timeout-ms <n>', 'shutdown timeout in milliseconds')
    .option('--force', 'force stop')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms'],
        booleans: ['force'],
      })
      await cmdServerStop(args)
    })

  server
    .command('restart')
    .description('restart the HRC daemon')
    .option('--timeout-ms <n>', 'timeout in milliseconds')
    .option('--force', 'force restart')
    .option('--daemon', 'restart as background daemon')
    .option('--foreground', 'restart in foreground')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['timeout-ms'],
        booleans: ['force', 'daemon', 'foreground'],
      })
      await cmdServerRestart(args)
    })

  server
    .command('status')
    .description('show daemon/socket/API health state')
    .option('--json', 'output as JSON')
    .addHelpText(
      'after',
      `
Exit codes:
  0  healthy: daemon socket responds and API health passes
  1  not running: no live daemon process or socket
  2  usage error, or degraded/stale daemon state
  3  local status probe failed
`
    )
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdServerStatus(args)
    })

  const serverTmux = server.command('tmux').description('tmux backend control')

  serverTmux
    .command('status')
    .description('show tmux socket/session state')
    .option('--json', 'output as JSON')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdTmuxStatus(args)
    })

  serverTmux
    .command('kill')
    .description('kill the HRC tmux server')
    .option('--yes', 'confirm destructive operation')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [],
        booleans: ['yes'],
      })
      await cmdTmuxKill(args)
    })

  // -- session group (commander, Phase 6 T2) ---------------------------------

  const session = program.command('session').description('resolve, list, and inspect sessions')

  session
    .command('resolve')
    .description('resolve a session')
    .option('--scope <scope>', 'scope reference')
    .option('--lane <lane>', 'lane reference')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['scope', 'lane'],
        booleans: [],
      })
      await cmdSessionResolve(args)
    })

  session
    .command('list')
    .description('list sessions')
    .option('--scope <scope>', 'scope reference')
    .option('--lane <lane>', 'lane reference')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['scope', 'lane'],
        booleans: [],
      })
      await cmdSessionList(args)
    })

  session
    .command('get')
    .description('get a session by ID')
    .argument('<hostSessionId>', 'host session ID')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdSessionGet(args)
    })

  session
    .command('clear-context')
    .description('clear session context')
    .argument('<hostSessionId>', 'host session ID')
    .option('--relaunch', 'relaunch after clearing')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [],
        booleans: ['relaunch'],
      })
      await cmdSessionClearContext(args)
    })

  session
    .command('drop-continuation')
    .description('drop stored continuation')
    .argument('<hostSessionId>', 'host session ID')
    .option('--reason <reason>', 'reason for dropping')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: ['reason'],
        booleans: [],
      })
      await cmdSessionDropContinuation(args)
    })

  // -- monitor group (MONITOR_PROPOSAL F2a) ----------------------------------

  const monitor = program
    .command('monitor')
    .description('show, watch, and wait on HRC monitor state')

  monitor
    .command('show')
    .description('show current HRC monitor snapshot')
    .argument('[selector]', 'monitor selector')
    .option('--json', 'output structured JSON')
    .action(async (selector, _opts, cmd: Command) => {
      const positionals = selector !== undefined ? [selector] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdMonitorShow(args)
    })

  monitor
    .command('wait')
    .description('wait for a monitor condition')
    .argument('[selector]', 'monitor selector')
    .option('--until <condition>', 'condition to wait for')
    .option('--timeout <duration>', 'maximum wait duration')
    .option('--stall-after <duration>', 'stall threshold duration')
    .option('--json', 'output structured JSON')
    .action(async (selector, _opts, cmd: Command) => {
      const positionals = selector !== undefined ? [selector] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: ['until', 'timeout', 'stall-after'],
        booleans: ['json'],
      })
      await cmdMonitorWait(args)
    })

  // -- runtime group (commander, Phase 6 T2) ----------------------------------

  const runtime = program.command('runtime').description('ensure, inspect, and control runtimes')

  runtime
    .command('ensure')
    .description('ensure a runtime')
    .argument('<hostSessionId>', 'host session ID')
    .option('--provider <provider>', 'provider (anthropic|openai)')
    .option('--restart-style <style>', 'restart style (reuse_pty|fresh_pty)')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: ['provider', 'restart-style'],
        booleans: [],
      })
      await cmdRuntimeEnsure(args)
    })

  runtime
    .command('list')
    .description('list runtimes')
    .option('--host-session-id <id>', 'filter by host session')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status')
    .option('--older-than <duration>', 'filter by age')
    .option('--scope <scope>', 'filter by scope')
    .option('--json', 'output as JSON')
    .option('--stale', 'show only stale runtimes')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['host-session-id', 'transport', 'status', 'older-than', 'scope'],
        booleans: ['json', 'stale'],
      })
      await cmdRuntimeList(args)
    })

  runtime
    .command('inspect')
    .description('inspect a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--json', 'output as JSON')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: ['json'],
      })
      await cmdRuntimeInspect(args)
    })

  runtime
    .command('sweep')
    .description('sweep stale runtimes')
    .option('--transport <transport>', 'filter by transport (tmux|headless|sdk)')
    .option('--status <status>', 'filter by status')
    .option('--scope <scope>', 'filter by scope')
    .option('--older-than <duration>', 'filter by age')
    .option('--dry-run', 'preview without mutating')
    .option('--yes', 'confirm destructive operation')
    .option('--json', 'output as JSON')
    .option('--drop-continuation', 'drop continuation on sweep')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['transport', 'status', 'scope', 'older-than'],
        booleans: ['dry-run', 'yes', 'json', 'drop-continuation'],
      })
      await cmdRuntimeSweep(args)
    })

  runtime
    .command('capture')
    .description('capture live runtime output')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdCapture(args)
    })

  runtime
    .command('interrupt')
    .description('interrupt a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdInterrupt(args)
    })

  runtime
    .command('terminate')
    .description('terminate a runtime')
    .argument('<runtimeId>', 'runtime ID')
    .option('--drop-continuation', 'drop continuation on terminate')
    .option('--no-drop-continuation', 'explicitly preserve continuation')
    .action(async (runtimeId, _opts, cmd: Command) => {
      // Scope the negated-flag scan to the active command path's raw argv,
      // not the full process.argv, to avoid surprise matches from globals.
      // Walk up to the root command and slice from 'terminate' onward.
      let root: Command = cmd
      while (root.parent) root = root.parent
      const fullRaw: string[] = (root as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv
      const terminateIdx = fullRaw.indexOf('terminate')
      const rawArgv = terminateIdx >= 0 ? fullRaw.slice(terminateIdx) : fullRaw
      const args = toLegacyArgv(
        [runtimeId],
        cmd.opts(),
        {
          strings: [],
          booleans: [],
          negatedBooleans: ['drop-continuation'],
        },
        rawArgv
      )
      await cmdTerminate(args)
    })

  runtime
    .command('adopt')
    .description('adopt a dead/stale runtime')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdAdopt(args)
    })

  // -- launch group (commander, Phase 6 T2) -----------------------------------

  const launch = program.command('launch').description('list launches')

  launch
    .command('list')
    .description('list launches')
    .option('--host-session-id <id>', 'filter by host session')
    .option('--runtime-id <id>', 'filter by runtime')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['host-session-id', 'runtime-id'],
        booleans: [],
      })
      await cmdLaunchList(args)
    })

  // -- top-level commands (commander, Phase 6 T2b) -----------------------------

  program
    .command('start')
    .description('start a managed runtime')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--force-restart', 'replace existing runtime with a fresh PTY')
    .option('--new-session', 'rotate to a fresh host session before starting')
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--debug', 'keep tmux shell alive after harness exits')
    .option('--no-register', 'do not prompt to register cwd as a project marker')
    .option('--project-id <id>', 'override the inferred project id')
    .option('--project-root <path>', 'override project root')
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .action(async (_scope, _opts, cmd: Command) => {
      // cmdStart/cmdRun use parseScopePrompt which handles positional
      // prompts, -p, and --prompt-file.  Reconstruct the full legacy
      // argv from commander's parsed positionals + options.
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      let root: Command = cmd
      while (root.parent) root = root.parent
      const fullRaw: string[] = (root as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv
      const verbIdx = fullRaw.indexOf('start')
      const rawArgv = verbIdx >= 0 ? fullRaw.slice(verbIdx + 1) : fullRaw
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['force-restart', 'new-session', 'dry-run', 'debug'],
        negatedBooleans: ['register'],
      })
      await cmdStart(args)
    })

  program
    .command('run')
    .description('launch or reattach and attach')
    .argument('[scope]', 'agent scope (agent, agent@project, or full scope ref)')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .option('--force-restart', 'replace existing runtime with a fresh PTY')
    .option('--no-attach', 'start/ensure without attaching to the tmux session')
    .option('--dry-run', 'local plan preview — no server calls')
    .option('--debug', 'keep tmux shell alive after harness exits')
    .option('--no-register', 'do not prompt to register cwd as a project marker')
    .option('--project-id <id>', 'override the inferred project id')
    .option('--project-root <path>', 'override project root')
    .option('-p <text>', 'initial prompt to send to the harness')
    .option('--prompt-file <path>', 'read initial prompt from a file')
    .action(async (_scope, _opts, cmd: Command) => {
      const positionals: string[] = cmd.args
      const opts = cmd.opts()
      let root: Command = cmd
      while (root.parent) root = root.parent
      const fullRaw: string[] = (root as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv
      const verbIdx = fullRaw.indexOf('run')
      const rawArgv = verbIdx >= 0 ? fullRaw.slice(verbIdx + 1) : fullRaw
      const args = toLegacyArgvForScopeCommand(positionals, opts, rawArgv, {
        strings: ['project-id', 'project-root', 'prompt-file'],
        booleans: ['force-restart', 'dry-run', 'debug'],
        negatedBooleans: ['attach', 'register'],
      })
      await cmdRun(args)
    })

  // -- turn group (commander, Phase 6 T2) -------------------------------------

  const turn = program.command('turn').description('dispatch turns to a session')

  turn
    .command('send')
    .description('send a turn')
    .argument('<hostSessionId>', 'host session ID')
    .option('--prompt <prompt>', 'prompt text')
    .option('--provider <provider>', 'provider (anthropic|openai)')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .option('--follow-latest', 'follow latest session')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: ['prompt', 'provider', 'expected-host-session-id', 'expected-generation'],
        booleans: ['follow-latest'],
      })
      await cmdTurnSend(args)
    })

  // -- inflight group (commander, Phase 6 T2) ---------------------------------

  const inflight = program.command('inflight').description('send in-flight runtime input')

  inflight
    .command('send')
    .description('send input to a run')
    .argument('<runtimeId>', 'runtime ID')
    .option('--run-id <id>', 'run ID')
    .option('--input <input>', 'input text')
    .option('--input-type <type>', 'input type')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: ['run-id', 'input', 'input-type'],
        booleans: [],
      })
      await cmdInflightSend(args)
    })

  // -- top-level commands (commander, Phase 6 T2b) -----------------------------

  program
    .command('capture')
    .description('capture live runtime output')
    .argument('[runtimeId]', 'runtime ID to capture')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const positionals = runtimeId !== undefined ? [runtimeId] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdCapture(args)
    })

  program
    .command('attach')
    .description('attach to a live runtime')
    .argument('[scope]', 'scope or runtime ID to attach to')
    .option('--dry-run', 'local plan preview — no server calls')
    .action(async (scope, _opts, cmd: Command) => {
      const positionals = scope !== undefined ? [scope] : []
      const args = toLegacyArgv(positionals, cmd.opts(), {
        strings: [],
        booleans: ['dry-run'],
      })
      await cmdAttach(args)
    })

  // -- surface group (commander, Phase 6 T2) ----------------------------------

  const surface = program.command('surface').description('manage surface bindings')

  surface
    .command('bind')
    .description('bind a surface')
    .argument('<runtimeId>', 'runtime ID')
    .option('--kind <kind>', 'surface kind')
    .option('--id <id>', 'surface ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: ['kind', 'id'],
        booleans: [],
      })
      await cmdSurfaceBind(args)
    })

  surface
    .command('unbind')
    .description('unbind a surface')
    .option('--kind <kind>', 'surface kind')
    .option('--id <id>', 'surface ID')
    .option('--reason <reason>', 'reason for unbinding')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: ['kind', 'id', 'reason'],
        booleans: [],
      })
      await cmdSurfaceUnbind(args)
    })

  surface
    .command('list')
    .description('list surface bindings')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdSurfaceList(args)
    })

  // -- bridge group (commander, Phase 6 T2) -----------------------------------

  const bridge = program.command('bridge').description('manage low-level local bridge delivery')

  bridge
    .command('target')
    .description('acquire bridge target')
    .option('--bridge <bridge>', 'convenience alias for --transport tmux --target <value>')
    .option('--host-session <id>', 'host session selector')
    .option('--session-ref <ref>', 'session ref selector')
    .option('--transport <transport>', 'bridge transport')
    .option('--target <target>', 'bridge target')
    .option('--runtime-id <id>', 'runtime ID')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [
          'bridge',
          'host-session',
          'session-ref',
          'transport',
          'target',
          'runtime-id',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: [],
      })
      await cmdBridgeTarget(args)
    })

  bridge
    .command('deliver-text')
    .description('deliver text to a bridge')
    .option('--bridge <bridge>', 'bridge ID')
    .option('--text <text>', 'text to deliver')
    .option('--oob-suffix <suffix>', 'out-of-band suffix')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .option('--enter', 'send enter after text')
    .action(async (_opts, cmd: Command) => {
      const args = toLegacyArgv([], cmd.opts(), {
        strings: [
          'bridge',
          'text',
          'oob-suffix',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: ['enter'],
      })
      await cmdBridgeDeliverText(args)
    })

  bridge
    .command('register')
    .description('register a bridge')
    .argument('<hostSessionId>', 'host session ID')
    .option('--transport <transport>', 'bridge transport')
    .option('--target <target>', 'bridge target')
    .option('--runtime-id <id>', 'runtime ID')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (hostSessionId, _opts, cmd: Command) => {
      const args = toLegacyArgv([hostSessionId], cmd.opts(), {
        strings: [
          'transport',
          'target',
          'runtime-id',
          'expected-host-session-id',
          'expected-generation',
        ],
        booleans: [],
      })
      await cmdBridgeRegister(args)
    })

  bridge
    .command('deliver')
    .description('deliver to a bridge')
    .argument('<bridgeId>', 'bridge ID')
    .option('--text <text>', 'text to deliver')
    .option('--expected-host-session-id <id>', 'expected host session ID')
    .option('--expected-generation <n>', 'expected generation')
    .action(async (bridgeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([bridgeId], cmd.opts(), {
        strings: ['text', 'expected-host-session-id', 'expected-generation'],
        booleans: [],
      })
      await cmdBridgeDeliver(args)
    })

  bridge
    .command('list')
    .description('list bridges')
    .argument('<runtimeId>', 'runtime ID')
    .action(async (runtimeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([runtimeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdBridgeList(args)
    })

  bridge
    .command('close')
    .description('close a bridge')
    .argument('<bridgeId>', 'bridge ID')
    .action(async (bridgeId, _opts, cmd: Command) => {
      const args = toLegacyArgv([bridgeId], cmd.opts(), {
        strings: [],
        booleans: [],
      })
      await cmdBridgeClose(args)
    })

  monitor
    .command('watch')
    .description('stream monitor events')
    .argument('[selector]', 'target selector')
    .option('--from-seq <n>', 'replay from sequence number')
    .option('--last <n>', 'replay the last n matching events')
    .option('--follow', 'stream live events after replay')
    .option('--until <condition>', 'exit when condition is met (requires --follow)')
    .option('--timeout <duration>', 'exit after duration without condition match')
    .option('--stall-after <duration>', 'exit after duration of inactivity')
    .option('--json', 'output JSON lines')
    .option('--format <mode>', 'output mode: tree, compact, verbose, json, ndjson')
    .option('--pretty', 'alias for --format=tree')
    .option('--max-lines <n>', 'tree mode: truncate body blocks to n lines')
    .option('--scope-width <n>', 'tree mode: per-row scope badge width in chars')
    .action(async (selector, _opts, cmd: Command) => {
      const args = toLegacyArgv(selector ? [selector] : [], cmd.opts(), {
        strings: [
          'from-seq',
          'last',
          'until',
          'timeout',
          'stall-after',
          'format',
          'max-lines',
          'scope-width',
        ],
        booleans: ['follow', 'json', 'pretty'],
      })
      await cmdMonitorWatch(args)
    })

  return program
}

function normalizeCommanderError(err: CommanderError): Error {
  const unknownCommandMatch = err.message.match(/^error: unknown command '(.+)'$/)
  if (unknownCommandMatch?.[1]) {
    return new CliUsageError(`unknown command: ${unknownCommandMatch[1]}`)
  }
  return new CliUsageError(err.message)
}

function handleCliError(err: unknown, program: Command): never {
  const json = program.opts<{ json?: boolean | undefined }>().json ?? false

  if (err instanceof CommanderError) {
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      process.exit(0)
    }
    exitWithError(normalizeCommanderError(err), { json, binName: 'hrc' })
  }

  if (err instanceof CliUsageError) {
    exitWithError(err, { json, binName: 'hrc' })
  }

  if (err instanceof CliStatusExit) {
    process.exit(err.code)
  }

  if (err instanceof MonitorWaitExit) {
    process.exit(err.code)
  }

  if (err instanceof HrcDomainError) {
    exitWithError(new Error(`[${err.code}] ${err.message}`), { json, binName: 'hrc' })
  }

  exitWithError(err, { json, binName: 'hrc' })
}

async function runProgram(argv: string[]): Promise<void> {
  if (argv.length <= 2) {
    printUsage()
    process.exit(1)
  }

  const program = buildProgram()
  try {
    await program.parseAsync(argv)
  } catch (err) {
    handleCliError(err, program)
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  await runProgram(['node', 'hrc', ...args])
}

if (import.meta.main) {
  await runProgram(process.argv)
}
