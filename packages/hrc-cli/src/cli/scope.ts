import { readSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'

import type { HrcHarness, HrcRuntimeIntent } from 'hrc-core'
import {
  applyProvisionDirectives,
  harnessFrontendToHrcHarness,
  resolveProfileAwareScopeInput,
  resolveAgentHarness as resolveSdkAgentHarness,
} from 'hrc-sdk'
import type { ProfileAwareResolvedScopeInput, ResolvedAgentHarness } from 'hrc-sdk'
import {
  PROJECT_MARKER_FILENAME,
  buildRuntimeBundleRef,
  findProjectMarker,
  getAgentsRoot,
  inferProjectIdFromCwd,
  resolveAgentPlacementPaths,
} from 'spaces-config'

import { fatal, formatAgentNotFound, writePlacementWarnings } from './shared.js'

export function createDefaultRuntimeIntent(
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
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      id: provider === 'anthropic' ? 'claude-code' : 'codex-cli',
      interactive: true,
    },
    execution: {
      preferredMode,
    },
  }
}

type AgentHarnessResolution = ResolvedAgentHarness

export function harnessStringToHarnessId(harness: string | undefined): HrcHarness | undefined {
  return harnessFrontendToHrcHarness(harness)
}

export function resolveAgentHarness(
  agentRoot: string,
  agentName: string,
  projectRoot?: string
): AgentHarnessResolution {
  return resolveSdkAgentHarness({ agentRoot, agentId: agentName, projectRoot })
}

export type ManagedScopeContext = {
  agentId: string
  projectId?: string | undefined
  projectOrigin: ProfileAwareResolvedScopeInput['projectOrigin']
  scopeRef: string
  laneRef: string
  sessionRef: string
  /** Placement selected before the authoritative profile was read. */
  placement?: ProfileAwareResolvedScopeInput['placement'] | undefined
  /**
   * T-07398 — the handle's `+` directive block, out-of-band from the canonical
   * identity above (`scopeRef` is byte-identical with and without it). Carried
   * so the assembled intent can hand it to the daemon; absent when the input
   * carried no block.
   */
  directives?: ProfileAwareResolvedScopeInput['directives'] | undefined
  /** Explicit projectRoot override (from --project-root or inferred from --project-id + cwd). */
  projectRootOverride?: string | undefined
}

export type ExecAttachDescriptor = {
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
   * Explicit execution cwd (from --cwd). This is deliberately independent of
   * projectRoot: project resolution and harness composition still use the
   * target project's root, while the launched process starts here.
   */
  cwdOverride?: string | undefined
  /**
   * Registration policy for first-run in an unmarked dir:
   * - 'prompt' — if TTY and cwd is outside the agents root, ask whether to write
   *   asp-targets.toml; on Y, write it and re-infer.
   * - 'never'  — never prompt; fall through with no projectId.
   */
  registerPolicy?: 'prompt' | 'never'
}

/**
 * Decide the fallback projectId for a bare `<agent>` scope from the two
 * ambient signals: ASP_PROJECT (caller env) and the cwd-inferred project.
 *
 * Default precedence is ASP_PROJECT → cwd. The exception: for an INTERACTIVE
 * (TTY) invocation where the cwd resolves to a registered project that DIFFERS
 * from ASP_PROJECT, the physical cwd wins — a human standing in project X and
 * typing `hrc run <agent>` means X, and a stale ASP_PROJECT must not silently
 * hijack it. Non-interactive callers (agent runtimes, scripts; no TTY) keep
 * ASP_PROJECT authoritative regardless of cwd, since ASP_PROJECT is their
 * canonical scope.
 *
 * Pure and exported for unit testing — the env/cwd/TTY reads and the stderr
 * note live in resolveDefaultProjectId.
 */
export function chooseDefaultProjectId(input: {
  aspProject: string | undefined
  cwdProject: string | undefined
  interactive: boolean
}): { projectId: string | undefined; cwdOverrodeAsp: boolean } {
  const { aspProject, cwdProject, interactive } = input
  if (
    interactive &&
    aspProject !== undefined &&
    cwdProject !== undefined &&
    aspProject !== cwdProject
  ) {
    return { projectId: cwdProject, cwdOverrodeAsp: true }
  }
  return { projectId: aspProject ?? cwdProject, cwdOverrodeAsp: false }
}

function resolveDefaultProjectId(): string | undefined {
  const aspProject = process.env['ASP_PROJECT']
  const cwdProject = inferProjectIdFromCwd()
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const { projectId, cwdOverrodeAsp } = chooseDefaultProjectId({
    aspProject,
    cwdProject,
    interactive,
  })
  if (cwdOverrodeAsp) {
    process.stderr.write(
      `[hrc] cwd is project '${cwdProject}' but ASP_PROJECT='${aspProject}'; using '${cwdProject}'. ` +
        `Pass '<agent>@${aspProject}' or --project-id ${aspProject} to target ASP_PROJECT instead.\n`
    )
  }
  return projectId
}

export function resolveManagedScopeContext(
  scopeInput: string,
  options: ResolveManagedScopeOptions = {}
): ManagedScopeContext {
  const cwdOverride = validateManagedCwdOverride(options.cwdOverride)
  // Compose projectId fallback in caller-spec order:
  //   explicit --project-id → ASP_PROJECT (caller env) → cwd inference → register prompt
  // The shared agent-scope resolver fills the task default ("primary") once a
  // projectId is known.
  //
  // Only synthesize a fallback project — and apply the ASP_PROJECT/cwd conflict
  // resolution in resolveDefaultProjectId — when the input has no explicit
  // project. An explicit `agent@project` always wins and must never trigger a
  // spurious cwd-override note.
  //
  // Detect an explicit project structurally rather than by resolving: "@" is the
  // only way to write a project in a handle and ":project:" the only way in a
  // raw ScopeRef. We must NOT resolve-to-probe here, because the project-deferred
  // shorthand (`clod:zed`) throws by design when no project is available — that
  // throw would pre-empt the register prompt below.
  const hasExplicitProject = scopeInput.includes('@') || /(^|:)project:/.test(scopeInput)
  const projectOrigin: ProfileAwareResolvedScopeInput['projectOrigin'] =
    hasExplicitProject || options.projectIdOverride !== undefined ? 'explicit' : 'inferred'
  let projectIdHint: string | undefined = hasExplicitProject
    ? undefined
    : (options.projectIdOverride ?? resolveDefaultProjectId())

  if (
    projectIdHint === undefined &&
    !hasExplicitProject &&
    (options.registerPolicy ?? 'never') === 'prompt'
  ) {
    const registered = maybePromptToRegisterProject()
    if (registered) {
      projectIdHint = registered
    }
  }

  // If user explicitly overrode projectId (via --project-id) without also
  // giving --project-root, treat cwd as the project root. This matches the
  // intent of "I'm declaring cwd is project X".
  const projectRootOverride =
    options.projectRootOverride ??
    (options.projectIdOverride ? resolvePath(process.cwd()) : undefined)

  const resolved = resolveProfileAwareScopeInput(scopeInput, {
    scope: projectIdHint !== undefined ? { projectId: projectIdHint } : {},
    placement:
      projectRootOverride !== undefined
        ? { projectRoot: projectRootOverride, cwd: projectRootOverride }
        : {},
    projectOrigin,
  })

  const { parsed, scopeRef, laneRef, placement: resolvedPlacement, directives } = resolved
  const placement =
    cwdOverride === undefined ? resolvedPlacement : { ...resolvedPlacement, cwd: cwdOverride }

  const laneId = laneRef === 'main' ? 'main' : laneRef.slice(5)
  return {
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    projectOrigin,
    scopeRef,
    laneRef: laneId === 'main' ? 'main' : `lane:${laneId}`,
    sessionRef: `${scopeRef}/lane:${laneId}`,
    placement,
    ...(directives === undefined ? {} : { directives }),
    ...(projectRootOverride ? { projectRootOverride } : {}),
  }
}

function validateManagedCwdOverride(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (!isAbsolute(cwd)) {
    throw new Error(`--cwd must be an absolute path: ${cwd}`)
  }
  try {
    if (statSync(cwd).isDirectory()) return cwd
  } catch {
    // Fall through to the single actionable validation error below.
  }
  throw new Error(`--cwd does not exist or is not a directory: ${cwd}`)
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
  const paths =
    scope.placement ??
    resolveAgentPlacementPaths({
      agentId: scope.agentId,
      ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
      ...(scope.projectRootOverride !== undefined
        ? { projectRoot: scope.projectRootOverride, cwd: scope.projectRootOverride }
        : {}),
    })
  writePlacementWarnings(paths.warnings)
  const agentRoot = paths.agentRoot
  if (!agentRoot) {
    throw new Error(formatAgentNotFound(scope.agentId, paths.searchedAgentRoots))
  }
  const projectRoot = paths.projectRoot
  const cwd = paths.cwd ?? agentRoot
  const bundle = buildRuntimeBundleRef({
    agentName: scope.agentId,
    agentRoot,
    projectRoot,
  })
  // T-07398: the directive overlay is the FINAL step, and the provider/harness
  // id follow the OVERLAID harness — `+harness=codex` must actually change what
  // launches. The rule itself lives once in hrc-sdk; this assembler only feeds
  // it the merge and the handle's block.
  const merged = resolveAgentHarness(agentRoot, scope.agentId, projectRoot)
  const overlaid = applyProvisionDirectives(merged, scope.directives)
  const provider = overlaid.provider
  const harnessId = overlaid.harnessId ?? (provider === 'anthropic' ? 'claude-code' : 'codex-cli')

  return {
    placement: {
      agentRoot,
      ...(projectRoot ? { projectRoot } : {}),
      cwd,
      runMode: 'task' as const,
      bundle,
      correlation: {
        sessionRef: {
          scopeRef: scope.scopeRef,
          laneRef: scope.laneRef,
        },
      },
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
    // No block at all when nothing was declared or directed, so an empty
    // `provision` is never mistaken for a deliberate empty declaration.
    ...(Object.keys(overlaid.provision).length === 0 ? {} : { provision: overlaid.provision }),
  }
}

export function buildManagedRunIntent(
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

export function buildManagedStartIntent(
  scope: ManagedScopeContext,
  options: {
    prompt?: string | undefined
    debug?: boolean | undefined
    /**
     * `--viewer-window <key>` (T-07118). Placement hint for the provisioned
     * session's viewer tab; absent ⇒ the implicit default window. Not offered on
     * `hrc run`, whose interactive session lives in the invoking terminal.
     */
    viewerWindow?: string | undefined
  } = {}
): HrcRuntimeIntent {
  const intent = buildManagedRuntimeIntent(scope, {
    ...options,
    preferredMode: 'headless',
  })
  return {
    ...intent,
    harness: {
      ...intent.harness,
      // `hrc start` provisions without attaching an operator terminal whether
      // or not it also dispatches an initial prompt. Harness-specific server
      // normalizers (notably Claude's interactive broker redirect) can opt the
      // detached request back into an interactive runtime shape deliberately.
      interactive: false,
    },
    ...(options.viewerWindow !== undefined
      ? { presentation: { viewerWindow: options.viewerWindow } }
      : {}),
  }
}

export function buildManagedAttachIntent(scope: ManagedScopeContext): HrcRuntimeIntent {
  return buildManagedRuntimeIntent(scope, {
    preferredMode: 'interactive',
  })
}

/**
 * Passthrough flags that consume the NEXT argv token as their value.
 *
 * Declared once, next to the parser that honours it. A value-taking flag missing
 * from this set does not fail loudly — its value is silently read as a positional
 * prompt, which surfaces as a baffling "accepts at most one positional prompt"
 * (T-07118). Any new `--flag <value>` added to a scope command belongs here.
 */
const VALUE_TAKING_PASSTHROUGH_FLAGS = new Set([
  '--project-id',
  '--project-root',
  '--cwd',
  '--wait',
  '--idempotency-key',
  '--viewer-window',
  '--on-conflict',
  '--host-session',
])

export async function parseScopePrompt(
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
      // Value-taking passthrough flags must also consume their value, or the
      // value lands in the positional-prompt slot.
      if (VALUE_TAKING_PASSTHROUGH_FLAGS.has(arg)) {
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
