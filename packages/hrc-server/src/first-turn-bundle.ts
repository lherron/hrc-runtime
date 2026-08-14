/**
 * `first_turn_missing` diagnostic bundle (T-07235).
 *
 * REDACTION IS BY CONSTRUCTION, not by post-hoc masking of a rendered string:
 * every field is assembled from STRUCTURED persisted request material, and any
 * prompt-bearing value is replaced with `sha256:<hex> (len N)` as it is copied
 * in. The `displayCommand` renderer is deliberately NEVER used on this path —
 * it shell-quotes argv and env verbatim, and the shared prompt-display
 * formatter is readability elision, not a secret boundary. Process env is never
 * captured; only the known prompt-bearing keys appear, always hashed.
 *
 * Assembly is best-effort under a hard wall-clock budget and is generation
 * fenced: the runtime's current generation is re-verified immediately before
 * each live probe, and a rotation records `generation_rotated` for that field
 * rather than capturing successor state. A bundle never mixes identifiers,
 * surfaces, or versions across generations.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA,
  type HrcFirstTurnMissingBundle,
  type HrcFirstTurnWatchRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { GhostmuxManager } from './ghostmux.js'
import type { HrcServerOptions } from './server-types.js'
import { type TmuxManager as ServerTmuxManager, createTmuxManager } from './tmux.js'

/** The only tmux capability the bundle path uses. */
export type TmuxCapturer = Pick<ServerTmuxManager, 'capture'>

/** Env keys that are known to carry prompt text. Nothing else is captured. */
const PROMPT_BEARING_ENV_KEYS = ['ASP_PRIMING_PROMPT'] as const
/** Argv flags whose FOLLOWING element is prompt text. */
const PROMPT_BEARING_FLAGS = new Set(['-p', '--prompt', '--print', '--initial-prompt'])

export function redactPromptValue(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  return `sha256:${hash} (len ${value.length})`
}

type SpecProjection = {
  harness?: { frontend?: unknown; provider?: unknown; driver?: unknown } | undefined
  process?: { command?: unknown; args?: unknown; cwd?: unknown; lockedEnv?: unknown } | undefined
  continuation?: { provider?: unknown; key?: unknown; kind?: unknown } | undefined
  launch?: { initialPrompt?: unknown } | undefined
  sdk?: { modelId?: unknown } | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Build the argv projection with every prompt-bearing element replaced as it is
 * copied. Three independent recognizers, because a prompt reaches argv three
 * ways: as the value of a prompt flag, as a bare positional (`codex "<prompt>"`,
 * `claude … -- <prompt>`), and as an element that happens to equal a known
 * prompt string.
 */
export function redactArgv(args: readonly string[], knownPrompts: readonly string[]): string[] {
  const promptSet = new Set(knownPrompts.filter((prompt) => prompt.length > 0))
  const out: string[] = []
  let redactNext = false
  let afterDoubleDash = false
  for (const arg of args) {
    if (redactNext) {
      out.push(redactPromptValue(arg))
      redactNext = false
      continue
    }
    if (promptSet.has(arg)) {
      out.push(redactPromptValue(arg))
      continue
    }
    if (arg === '--') {
      out.push(arg)
      afterDoubleDash = true
      continue
    }
    if (afterDoubleDash && !arg.startsWith('-')) {
      // Everything a harness receives past `--` is prompt material by contract.
      out.push(redactPromptValue(arg))
      continue
    }
    if (PROMPT_BEARING_FLAGS.has(arg)) {
      out.push(arg)
      redactNext = true
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > 0 && PROMPT_BEARING_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${redactPromptValue(arg.slice(eq + 1))}`)
      continue
    }
    out.push(arg)
  }
  return out
}

function parseSpecProjection(json: string | undefined): SpecProjection | undefined {
  if (json === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? (parsed as SpecProjection) : undefined
  } catch {
    return undefined
  }
}

function buildLaunchShape(
  spec: SpecProjection,
  sessionModel: string | undefined
): NonNullable<HrcFirstTurnMissingBundle['launchShape']> {
  const initialPrompt = asString(spec.launch?.initialPrompt)
  const lockedEnv = isRecord(spec.process?.lockedEnv) ? spec.process.lockedEnv : {}
  const knownPrompts: string[] = []
  if (initialPrompt !== undefined) knownPrompts.push(initialPrompt)
  const promptEnv: Record<string, string> = {}
  for (const key of PROMPT_BEARING_ENV_KEYS) {
    const value = lockedEnv[key]
    if (typeof value === 'string' && value.length > 0) {
      knownPrompts.push(value)
      promptEnv[key] = redactPromptValue(value)
    }
  }

  const rawArgs = Array.isArray(spec.process?.args)
    ? (spec.process.args as unknown[]).filter((arg): arg is string => typeof arg === 'string')
    : []
  const continuationKey = asString(spec.continuation?.key)

  return {
    ...(asString(spec.harness?.frontend) !== undefined
      ? { frontend: asString(spec.harness?.frontend) }
      : {}),
    ...(asString(spec.sdk?.modelId) !== undefined
      ? { model: asString(spec.sdk?.modelId) }
      : sessionModel !== undefined
        ? { model: sessionModel }
        : {}),
    ...(asString(spec.process?.cwd) !== undefined ? { cwd: asString(spec.process?.cwd) } : {}),
    continuation: continuationKey !== undefined ? ('expected' as const) : ('none' as const),
    ...(continuationKey !== undefined ? { continuationKey } : {}),
    argv: redactArgv(rawArgs, knownPrompts),
    promptEnv,
  }
}

function runtimeTmuxSurfaces(runtime: { tmuxJson?: Record<string, unknown> | undefined } | null): {
  socketPath?: string | undefined
  sessionName?: string | undefined
  windowName?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
  hrcRole?: string | undefined
} {
  const tmux = runtime?.tmuxJson
  if (!tmux) return {}
  return {
    ...(asString(tmux['socketPath']) !== undefined
      ? { socketPath: asString(tmux['socketPath']) }
      : {}),
    ...(asString(tmux['sessionName']) !== undefined
      ? { sessionName: asString(tmux['sessionName']) }
      : {}),
    ...(asString(tmux['windowName']) !== undefined
      ? { windowName: asString(tmux['windowName']) }
      : {}),
    ...(asString(tmux['windowId']) !== undefined ? { windowId: asString(tmux['windowId']) } : {}),
    ...(asString(tmux['paneId']) !== undefined ? { paneId: asString(tmux['paneId']) } : {}),
    ...(asString(tmux['hrcRole']) !== undefined ? { hrcRole: asString(tmux['hrcRole']) } : {}),
  }
}

/** Resolve within a bounded budget; a slow probe degrades the bundle, never the daemon. */
async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label}_timeout` }), budgetMs)
  })
  try {
    return await Promise.race([
      work
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        })),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type FirstTurnBundleDeps = {
  db: HrcDatabase
  options: Pick<HrcServerOptions, 'runtimeRoot'>
  ghostmux?: Pick<GhostmuxManager, 'inspectSurface'> | undefined
  /**
   * Pane-capture seam on the LEASED tmux socket. Defaults to a real tmux
   * manager; the server passes its broker factory so the capture always speaks
   * to the runtime's own socket rather than the shared one.
   */
  tmuxManagerFactory?: ((options: { socketPath: string }) => TmuxCapturer) | undefined
  release?: { releaseId?: string | undefined; aspSetVersion?: string | undefined } | undefined
  /** Remaining wall-clock budget for the whole assembly. */
  budgetMs: number
  now: () => string
}

export function firstTurnBundleDir(
  runtimeRoot: string,
  runtimeId: string,
  tripEventSeq: number
): string {
  return join(runtimeRoot, 'artifacts', runtimeId, 'first-turn-missing', String(tripEventSeq))
}

/**
 * Assemble and write the bundle. NEVER throws: a failed or partial assembly
 * degrades diagnosis, never detection — the step-1 durable fact is already
 * complete without it, and every field that could not be built appears in the
 * manifest's `failures` map rather than being silently absent.
 */
export async function assembleFirstTurnBundle(
  deps: FirstTurnBundleDeps,
  watch: HrcFirstTurnWatchRecord
): Promise<{ bundleDir: string; bundle: HrcFirstTurnMissingBundle }> {
  const deadlineMs = Date.now() + deps.budgetMs
  const remaining = (): number => Math.max(0, deadlineMs - Date.now())
  const failures: Record<string, string> = {}
  const trippedAt = watch.firstTurnMissingTrippedAt ?? deps.now()

  const bundle: HrcFirstTurnMissingBundle = {
    schema: HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA,
    correlation: {
      runtimeId: watch.runtimeId,
      scopeRef: watch.scopeRef,
      generation: watch.generation,
      ...(watch.invocationId !== undefined ? { invocationId: watch.invocationId } : {}),
      ...(watch.runId !== undefined ? { runId: watch.runId } : {}),
      hostSessionId: watch.hostSessionId,
    },
    timings: {
      ...(watch.primingDispatchedAt !== undefined
        ? { primingDispatchedAt: watch.primingDispatchedAt }
        : {}),
      ...(watch.firstTurnDeadlineAt !== undefined
        ? { firstTurnDeadlineAt: watch.firstTurnDeadlineAt }
        : {}),
      trippedAt,
    },
    failures,
  }

  const runtime = deps.db.runtimes.getByRuntimeId(watch.runtimeId)
  if (runtime === null) {
    failures['runtime'] = 'runtime_row_absent'
  } else {
    bundle.timings.provisionedAt = runtime.createdAt
    if (watch.primingDispatchedAt !== undefined && watch.firstTurnDeadlineAt !== undefined) {
      const configured =
        Date.parse(watch.firstTurnDeadlineAt) - Date.parse(watch.primingDispatchedAt)
      if (Number.isFinite(configured)) bundle.timings.configuredTimeoutMs = configured
    }
  }

  // ── Launch shape (structured request material only) ─────────────────────────
  const invocation =
    watch.invocationId !== undefined
      ? deps.db.brokerInvocations.getByInvocationId(watch.invocationId)
      : null
  const spec = parseSpecProjection(invocation?.specProjectionJson)
  if (spec === undefined) {
    failures['launchShape'] = 'spec_projection_unavailable'
  } else {
    const session = deps.db.sessions.getByHostSessionId(watch.hostSessionId)
    bundle.launchShape = buildLaunchShape(spec, session?.lastAppliedIntentJson?.harness?.model)
  }

  // ── Versions at trip ────────────────────────────────────────────────────────
  const versions: NonNullable<HrcFirstTurnMissingBundle['versions']> = {}
  if (deps.release?.releaseId !== undefined) versions.hrcReleaseId = deps.release.releaseId
  else failures['hrcReleaseId'] = 'unmanaged_release'
  if (deps.release?.aspSetVersion !== undefined) {
    versions.agentSpacesVersion = deps.release.aspSetVersion
  } else {
    failures['agentSpacesVersion'] = 'unmanaged_release'
  }
  const harnessCommand = asString(spec?.process?.command)
  if (harnessCommand === undefined) {
    failures['harnessVersion'] = 'harness_command_unknown'
  } else {
    const probed = await withBudget(
      probeHarnessVersion(harnessCommand),
      Math.min(2_000, remaining()),
      'harness_version'
    )
    if (probed.ok && probed.value !== undefined) versions.harnessVersion = probed.value
    else failures['harnessVersion'] = probed.ok ? 'no_version_output' : probed.error
  }
  bundle.versions = versions

  // ── Surfaces (generation-fenced live reads) ────────────────────────────────
  const tmuxSurfaces = runtimeTmuxSurfaces(runtime)
  const surfaces: NonNullable<HrcFirstTurnMissingBundle['surfaces']> = {
    ...(tmuxSurfaces.socketPath !== undefined ? { tmuxSocketPath: tmuxSurfaces.socketPath } : {}),
    ...(tmuxSurfaces.sessionName !== undefined
      ? { tmuxSessionName: tmuxSurfaces.sessionName }
      : {}),
    ...(tmuxSurfaces.windowId !== undefined ? { tmuxWindowId: tmuxSurfaces.windowId } : {}),
    ...(tmuxSurfaces.paneId !== undefined ? { tmuxPaneId: tmuxSurfaces.paneId } : {}),
    ...(tmuxSurfaces.hrcRole !== undefined ? { hrcRole: tmuxSurfaces.hrcRole } : {}),
  }

  const ghosttySurfaceId = asString(runtime?.surfaceJson?.['surfaceId'])
  if (ghosttySurfaceId !== undefined) {
    surfaces.ghosttySurfaceId = ghosttySurfaceId
    if (!generationStillCurrent(deps.db, watch)) {
      failures['ghosttyWindowId'] = 'generation_rotated'
    } else if (deps.ghostmux === undefined) {
      failures['ghosttyWindowId'] = 'ghostmux_unavailable'
    } else {
      const inspected = await withBudget(
        deps.ghostmux.inspectSurface(ghosttySurfaceId),
        Math.min(1_500, remaining()),
        'ghostty_inspect'
      )
      if (inspected.ok) {
        const windowId = inspected.value?.windowId
        if (windowId !== undefined) surfaces.ghosttyWindowId = windowId
        else failures['ghosttyWindowId'] = 'surface_not_in_registry'
      } else {
        failures['ghosttyWindowId'] = inspected.error
      }
    }
  }
  bundle.surfaces = surfaces

  // ── Pane capture (runtime-fenced probe on the LEASED tmux socket) ──────────
  if (tmuxSurfaces.socketPath === undefined || tmuxSurfaces.paneId === undefined) {
    failures['paneCapture'] = 'no_leased_tmux_pane'
  } else if (!generationStillCurrent(deps.db, watch)) {
    failures['paneCapture'] = 'generation_rotated'
  } else {
    const socketPath = tmuxSurfaces.socketPath
    const paneId = tmuxSurfaces.paneId
    const capturer = (deps.tmuxManagerFactory ?? createTmuxManager)({ socketPath })
    const captured = await withBudget(
      capturer.capture(paneId),
      Math.min(2_000, remaining()),
      'pane_capture'
    )
    if (captured.ok) {
      bundle.paneCapture = { capturedAt: deps.now(), text: captured.value }
    } else {
      failures['paneCapture'] = captured.error
    }
  }

  const bundleDir = firstTurnBundleDir(
    deps.options.runtimeRoot,
    watch.runtimeId,
    watch.tripEventSeq ?? 0
  )
  await mkdir(bundleDir, { recursive: true, mode: 0o700 })
  await writeFile(join(bundleDir, 'manifest.json'), `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
  })
  if (bundle.paneCapture !== undefined) {
    await writeFile(join(bundleDir, 'pane.txt'), bundle.paneCapture.text, { mode: 0o600 })
  }
  return { bundleDir, bundle }
}

/**
 * Generation fence for live probes: the recorded generation must still be the
 * runtime's current one, or the probe would capture SUCCESSOR state under a
 * predecessor's trip.
 */
function generationStillCurrent(db: HrcDatabase, watch: HrcFirstTurnWatchRecord): boolean {
  const runtime = db.runtimes.getByRuntimeId(watch.runtimeId)
  return runtime !== null && runtime.generation === watch.generation
}

/**
 * Best-effort `<harness> --version`. Auto-update is the recurring trigger class
 * for this failure, so "what changed" has to be pre-baked into the bundle
 * rather than reconstructed days later. Bounded by the caller's budget; the
 * harness argv is NOT reused (only `--version`), so no prompt material is
 * involved.
 */
async function probeHarnessVersion(command: string): Promise<string | undefined> {
  const proc = Bun.spawn([command, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  try {
    const text = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return undefined
    const first = text.split('\n')[0]?.trim()
    return first !== undefined && first.length > 0 ? first : undefined
  } finally {
    proc.kill()
  }
}
