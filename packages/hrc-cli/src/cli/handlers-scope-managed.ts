import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'

import { formatDiagnosticDuration } from 'hrc-core'
import type {
  DispatchTurnRequest,
  HrcRuntimeIntent,
  PhaseObservationSink,
  PhaseRecord,
  RunDiagnostics,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { renderRunDiagnostics } from './run-diagnostics-render.js'

export type ManagedStartClient = Pick<HrcClient, 'dispatchTurn' | 'startRuntime'>

const CLEAR_LINE = '\r\x1b[2K'

/** Renderer lines for completed phases, in the renderer's own vocabulary. */
function renderPhaseLines(phases: PhaseRecord[]): string[] {
  const lines: string[] = []
  renderRunDiagnostics({ releases: {}, ids: {}, phases }, { write: (line) => lines.push(line) })
  return lines.slice(0, -1)
}

export type LiveRunPhaseStream = {
  /** A client-side phase is now in progress; a TTY shows a live elapsed counter. */
  begin(id: string): void
  /** A phase completed: clear the counter and print its lines (with any children). */
  complete: PhaseObservationSink
  /** Erase the in-place counter. Must run before anything else owns the terminal. */
  clear(): void
  /** Print what was not already streamed: remaining phases, envelope, and the total. */
  finish(diagnostics: RunDiagnostics, options?: { totalLabel?: 'total' | 'ready' }): void
}

/**
 * `hrc run -v` streams client-side phases as they complete (T-08708 AC3).
 * Server substeps arrive atomically as children of `prepare-run`. Off a TTY
 * only plain completed lines are written. Rendering never alters the run: every
 * entry point swallows its own errors.
 */
export function createLiveRunPhaseStream(
  options: {
    output?: { isTTY?: boolean; write(chunk: string): unknown }
    now?: () => number
    every?: (fn: () => void, ms: number) => () => void
  } = {}
): LiveRunPhaseStream {
  const output = options.output ?? process.stderr
  const tty = output.isTTY === true
  const now = options.now ?? (() => performance.now())
  const every =
    options.every ??
    ((fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  const streamed: string[] = []
  let stopTicker: (() => void) | undefined
  let inPlace = false

  const guard =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args)
      } catch {
        // Diagnostics output must never change the run's outcome.
      }
    }
  const clear = (): void => {
    const stop = stopTicker
    stopTicker = undefined
    stop?.()
    if (!inPlace) return
    inPlace = false
    output.write(CLEAR_LINE)
  }
  const writeLines = (lines: string[]): void => {
    if (lines.length > 0) output.write(`${lines.join('\n')}\n`)
  }

  return {
    begin: guard((id: string) => {
      clear()
      if (!tty) return
      const startedAt = now()
      const inProgress = (renderPhaseLines([{ id, status: 'ok' }])[0] ?? `  ✓ ${id}`).replace(
        '✓',
        '…'
      )
      const paint = (): void => {
        inPlace = true
        output.write(`${CLEAR_LINE}${inProgress}  ${formatDiagnosticDuration(now() - startedAt)}`)
      }
      paint()
      stopTicker = every(guard(paint), 100)
    }),
    complete: guard((phase: Readonly<PhaseRecord>) => {
      clear()
      const lines = renderPhaseLines([phase as PhaseRecord])
      streamed.push(...lines)
      writeLines(lines)
    }),
    clear: guard(clear),
    finish: guard((diagnostics: RunDiagnostics, finishOptions = {}) => {
      clear()
      const lines: string[] = []
      renderRunDiagnostics(diagnostics, { ...finishOptions, write: (line) => lines.push(line) })
      const total = lines.pop()
      const phaseLines = renderPhaseLines(diagnostics.phases)
      const envelope = lines
        .slice(0, lines.length - phaseLines.length)
        .filter((line) => line !== '')
      const alreadyStreamed = streamed.every((line, index) => phaseLines[index] === line)
      const remaining = alreadyStreamed ? phaseLines.slice(streamed.length) : phaseLines
      writeLines([...remaining, ...envelope, ...(total === undefined ? [] : [total])])
    }),
  }
}

const CLIENT_RUN_PHASES = ['resolve-scope', 'create-session', 'prepare-run', 'attach'] as const

/**
 * The timeline of a run whose client operation threw (T-08708 AC5): completed
 * steps, the in-flight step as failed with its duration (server-supplied
 * phases, when present, as its children), and later client steps not-reached.
 */
export function failedRunPhases(
  completed: readonly PhaseRecord[],
  failed: { id: string; ms: number },
  serverPhases: readonly PhaseRecord[]
): PhaseRecord[] {
  const failedIndex = CLIENT_RUN_PHASES.indexOf(failed.id as (typeof CLIENT_RUN_PHASES)[number])
  return [
    ...completed,
    {
      id: failed.id,
      status: 'error',
      ms: failed.ms,
      ...(serverPhases.length === 0 ? {} : { children: [...serverPhases] }),
    },
    ...(failedIndex < 0 ? [] : CLIENT_RUN_PHASES.slice(failedIndex + 1)).map(
      (id): PhaseRecord => ({
        id,
        status: 'not-reached',
        reason: `not reached after ${failed.id}`,
      })
    ),
  ]
}

/**
 * A local CLI start is a HUMAN typing at a terminal (T-07236).
 *
 * The dispatch source is what knows the cause, so it states it explicitly here
 * rather than leaving HRC to guess later. `os.userInfo()` is the invoking user,
 * not ambient configuration: this is the identity of the process the human just
 * ran. It falls back to a bare `human` kind if the OS cannot name the user —
 * the KIND is the part any policy reads, and it is known either way.
 */
export function localCliDispatchOrigin(): DispatchTurnRequest['origin'] {
  let username: string | undefined
  try {
    username = userInfo().username
  } catch {
    username = undefined
  }
  return {
    actor: username !== undefined && username.length > 0 ? `human:${username}` : 'human',
    kind: 'human',
  }
}

export type StartFollowCommand = {
  purpose: string
  cmd: string
}

/** Build copy-pasteable supervision commands from the authoritative resolved scope. */
export function buildStartFollowCommands(scopeRef: string): StartFollowCommand[] {
  const taskId = /:task:([^:]+)(?::role:|$)/.exec(scopeRef)?.[1]
  if (taskId !== undefined && taskId !== 'primary') {
    return [
      {
        purpose: 'live room feed (milestone cadence)',
        cmd: `hrc monitor watch ${taskId} --follow`,
      },
      {
        purpose: 'block until the task lands',
        cmd: `wrkq monitor wait ${taskId} --until all-terminal`,
      },
    ]
  }

  return [
    {
      purpose: 'live room feed (milestone cadence)',
      cmd: `hrc monitor watch scope:${scopeRef} --follow`,
    },
  ]
}

export function printStartFollowHint(
  follow: readonly StartFollowCommand[],
  stage?: 'accepted' | 'turn_started' | 'terminal'
): void {
  const headline =
    stage === 'turn_started'
      ? 'turn started — follow with:'
      : stage === 'terminal'
        ? 'turn terminal — inspect with:'
        : 'accepted detached — follow with:'
  process.stderr.write(
    `${headline}\n${follow.map(({ purpose, cmd }) => `  ${cmd}  # ${purpose}`).join('\n')}\n`
  )
}

export async function executeManagedStart(
  client: ManagedStartClient,
  input: {
    hostSessionId: string
    intent: HrcRuntimeIntent
    prompt?: string | undefined
    restartStyle: 'reuse_pty' | 'fresh_pty'
    waitFor?: NonNullable<DispatchTurnRequest['waitFor']> | undefined
    idempotencyKey?: string | undefined
  }
) {
  const prompt = input.prompt
  if (prompt === undefined || prompt.length === 0) {
    return client.startRuntime({
      hostSessionId: input.hostSessionId,
      intent: input.intent,
      restartStyle: input.restartStyle,
    })
  }

  if (input.restartStyle === 'fresh_pty') {
    await client.startRuntime({
      hostSessionId: input.hostSessionId,
      intent: { ...input.intent, initialPrompt: undefined },
      restartStyle: input.restartStyle,
    })
  }

  const result = await client.dispatchTurn({
    hostSessionId: input.hostSessionId,
    idempotencyKey: input.idempotencyKey ?? `hrc-start-${randomUUID()}`,
    prompt,
    runtimeIntent: input.intent,
    origin: localCliDispatchOrigin(),
    waitFor: input.waitFor ?? 'accepted',
    waitForCompletion: input.waitFor === 'terminal',
  })
  const execution = (
    result as typeof result & {
      execution?: { state?: string; errorMessage?: string | undefined } | undefined
    }
  ).execution
  if (execution?.state === 'failed') {
    throw new Error(
      execution.errorMessage ?? `input "${prompt}" was not delivered by the target runtime`
    )
  }
  if (result.stage === 'terminal' && result.outcome !== 'completed') {
    throw new Error(
      result.error?.message ?? `turn ${result.runId} ended with ${result.outcome ?? result.status}`
    )
  }
  return result
}

export function printManagedScopeUsage(command: 'run' | 'start' | 'resume'): void {
  // `resume` is an exact alias of `run`; it renders run's option surface but
  // under its own usage banner so `hrc resume` (no args) self-describes.
  const isRunLike = command === 'run' || command === 'resume'
  const summary =
    command === 'start'
      ? 'Resolve a session and start its managed runtime without attaching.'
      : 'Launch or reattach an agent harness in a managed tmux session.'
  const attachSummary = isRunLike
    ? '\n  By default, rerunning the same scope reattaches to the existing\n  runtime and preserves the PTY/context. Use --force-restart to\n  replace the runtime with a fresh PTY.\n'
    : ''
  const noAttachOption = isRunLike
    ? '  --attach-only        Reattach to the existing runtime without starting one\n'
    : ''
  const newSessionOption =
    command !== 'resume'
      ? '  --new-session        Rotate to a fresh host session before starting\n'
      : ''
  const startOnlyOptions =
    command === 'start'
      ? '  --viewer-window <key> Place the session viewer tab in the keyed window\n' +
        '  --no-viewer          Run headless with no operator viewer or terminal (codex:\n' +
        '                       prepares through aspd when configured); refused if the\n' +
        '                       scope already has a live viewer or TUI\n' +
        '  --app-server-viewer  Run codex on the headless app-server with the attachable\n' +
        '                       tmux renderer viewer (prepares through aspd when\n' +
        '                       configured; the default where the codex redirect is\n' +
        '                       off); refused against a live runtime without it\n' +
        '  --on-conflict suffix  Claim the next free roster slot instead of :primary\n' +
        '  --on-conflict reject  Claim exactly this scope, or refuse if it is occupied\n'
      : ''
  const cwdOption =
    command === 'start'
      ? '  --cwd <path>        Set execution cwd without changing the resolved project root\n'
      : ''
  const verboseOption = isRunLike
    ? '  -v, --verbose       Show the full run phase timeline on stderr\n'
    : ''

  process.stdout.write(`Usage: hrc ${command} <scope> [options]

  ${summary}

  <scope>  Agent scope: agent, agent@project, or full scope ref.
           When run from a project directory, the project is inferred
           automatically (e.g. "larry" becomes "larry@agent-spaces").${attachSummary}

Options:
  --force-restart      Replace the runtime with a fresh PTY; preserve the conversation
${noAttachOption}${newSessionOption}${startOnlyOptions}  --dry-run            Daemon plan preview — no side effects
${verboseOption}  --debug              Keep tmux shell alive after harness exits
  --project-id <id>    Override the inferred project id (cwd is treated as its root)
  --project-root <dir> Override project root (defaults to cwd when --project-id is set)
${cwdOption}  --no-register        Don't prompt to register cwd as a project marker
  -p <text>            Initial prompt to send to the harness
  --prompt-file <path> Read initial prompt from a file
  --wait[=completed]   Wait for the prompt turn to complete
`)
}
