import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import {
  listInheritedEnvKeysToScrub,
  sanitizeTmuxClientEnv,
  sanitizeTmuxServerPath,
} from './launch/index.js'

export type RestartStyle = 'reuse_pty' | 'fresh_pty'
export type TmuxManagerOptions = {
  socketPath: string
  tmuxBin?: string | undefined
}

export type TmuxPaneState = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}

/**
 * Liveness of the foreground process inside a leased pane. A broker runtime is
 * only truly live when its harness (launched as the pane root via `exec bun …`,
 * which re-execs to bun/node/codex/claude) is still running. If the harness
 * exited — or its `exec` launch never landed (e.g. the paste/Enter raced and the
 * pane was left at a bare shell) — the pane sits at a shell prompt or goes dead.
 * `alive` distinguishes those: it is true only when the pane is not dead and its
 * foreground command is NOT an interactive shell.
 */
export type TmuxPaneLiveness = {
  alive: boolean
  dead: boolean
  currentCommand: string
}

type TmuxExecResult = {
  stdout: string
  stderr: string
}

export class TmuxCommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number
  ) {
    super(`tmux command timed out after ${timeoutMs}ms: ${command}`)
    this.name = 'TmuxCommandTimeoutError'
  }
}

export function isTmuxCommandTimeoutError(error: unknown): error is TmuxCommandTimeoutError {
  return error instanceof TmuxCommandTimeoutError
}

const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

const WINDOW_NAME = 'main'
const SEND_KEYS_ENTER_DELAY_MS = 1_000

// Match the metadata format we request: session_id, window_id, pane_id, session_name.
// tmux separates the fields with the tab we pass in the -F string, but falls back to
// `_` when the locale is unset (C/POSIX) — this happens under launchd, which does not
// inherit LANG from the user shell. Both separators are accepted.
const PANE_METADATA_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)[\t_](.+)$/

function sessionNameFor(hostSessionId: string): string {
  return `hrc-${hostSessionId.slice(0, 12)}`
}

function isMissingTargetError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('no server running on') ||
    normalized.includes("can't find session") ||
    normalized.includes("can't find pane") ||
    normalized.includes("can't find window")
  )
}

function isServerGoneError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('error connecting') ||
    normalized.includes('no such file or directory') ||
    normalized.includes('no server running')
  )
}

function parseVersion(stdout: string, stderr: string): { major: number; minor: number } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
  }
}

export function parsePaneState(stdout: string, socketPath: string): TmuxPaneState {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane metadata')
  }

  const match = PANE_METADATA_PATTERN.exec(line)
  if (!match) {
    throw new Error(`unexpected tmux metadata line: ${line}`)
  }

  const [, sessionId, windowId, paneId, sessionName] = match

  if (!sessionName || !sessionId || !windowId || !paneId) {
    throw new Error(`tmux metadata regex captured empty groups in line: ${line}`)
  }

  return {
    socketPath,
    sessionName,
    windowName: WINDOW_NAME,
    sessionId,
    windowId,
    paneId,
  }
}

// Interactive shells a leased pane falls back to when the harness exits or never
// launched. A login shell is reported with a leading dash (`-zsh`), stripped here.
const SHELL_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'ash',
  'login',
])

function isShellCommand(command: string): boolean {
  const normalized = command.replace(/^-/, '').toLowerCase()
  return SHELL_COMMANDS.has(normalized)
}

export function parsePaneLiveness(stdout: string): TmuxPaneLiveness {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    // No metadata returned for an existing pane: treat as not live so the caller
    // relaunches rather than reusing an unknowable pane.
    return { alive: false, dead: false, currentCommand: '' }
  }

  // We request `#{pane_dead}<sep>#{pane_current_command}`; tmux uses the tab we
  // pass, but falls back to `_` under a C/POSIX locale (launchd), so accept both.
  const [deadField = '', ...commandParts] = line.split(/[\t_]/)
  const currentCommand = commandParts.join('_').trim()
  const dead = deadField.trim() === '1'
  const alive = !dead && currentCommand.length > 0 && !isShellCommand(currentCommand)
  return { alive, dead, currentCommand }
}

/**
 * Parse `#{pane_pid}<sep>#{pane_dead}<sep>#{pane_current_command}`. tmux uses the
 * tab we request, but falls back to `_` under a C/POSIX locale (launchd), so
 * accept both. The command field is last so any internal separators stay with it.
 */
export function parsePaneProcess(
  stdout: string
): { command: string; pid: number; dead: boolean } | null {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    return null
  }

  const [pidField = '', deadField = '', ...commandParts] = line.split(/[\t_]/)
  const command = commandParts.join('_').trim()
  const pid = Number.parseInt(pidField.trim(), 10)
  const dead = deadField.trim() === '1'
  return { command, pid: Number.isFinite(pid) ? pid : 0, dead }
}

export class TmuxManager {
  constructor(
    private readonly socketPath: string,
    private readonly tmuxBinary = 'tmux'
  ) {}

  async initialize(): Promise<void> {
    await this.checkVersion()
    await this.startServer()
    await this.scrubServerEnvironment()
  }

  async ensurePane(hostSessionId: string, restartStyle: RestartStyle): Promise<TmuxPaneState> {
    const sessionName = sessionNameFor(hostSessionId)

    if (restartStyle === 'fresh_pty') {
      const existing = await this.inspectSession(sessionName)
      if (existing) {
        const retiredSessionName = `${sessionName}-retired-${Date.now()}`
        await this.exec(['rename-session', '-t', `=${sessionName}`, retiredSessionName])
        try {
          const created = await this.createNamedSession(sessionName)
          await this.killSession(retiredSessionName)
          return created
        } catch (error) {
          await this.killSession(retiredSessionName)
          throw error
        }
      }

      return this.createNamedSession(sessionName)
    }

    const existing = await this.inspectSession(sessionName)
    if (existing) {
      return existing
    }

    return this.createNamedSession(sessionName)
  }

  async checkVersion(): Promise<void> {
    let result: TmuxExecResult
    try {
      result = await this.execRaw(['-V'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`tmux not found or unavailable: ${message}`)
    }

    const version = parseVersion(result.stdout, result.stderr)
    const supported =
      version.major > MIN_SUPPORTED_TMUX_VERSION.major ||
      (version.major === MIN_SUPPORTED_TMUX_VERSION.major &&
        version.minor >= MIN_SUPPORTED_TMUX_VERSION.minor)

    if (!supported) {
      throw new Error(`unsupported tmux version ${version.major}.${version.minor}; need 3.2+`)
    }
  }

  async createSession(hostSessionId: string): Promise<TmuxPaneState> {
    await this.startServer()
    return this.createNamedSession(sessionNameFor(hostSessionId))
  }

  /**
   * Create (or re-use) a named lease session on this socket and return its pane.
   * Used by the broker pane-lease allocator, which owns the session name
   * (`hrc-<driver>-<runtimeId>`) deterministically from the runtime id.
   */
  async createLeaseSession(sessionName: string): Promise<TmuxPaneState> {
    await this.startServer()
    const existing = await this.inspectSession(sessionName)
    if (existing) {
      return existing
    }
    return this.createNamedSession(sessionName)
  }

  async capture(paneId: string): Promise<string> {
    const result = await this.exec(['capture-pane', '-t', paneId, '-p'])
    return result.stdout
  }

  /**
   * Create a NAMED window whose pane root process IS `command`, launched
   * exec-form (`new-window … '<command>'`) so the broker runs as the pane's
   * foreground process — NOT a shell receiving pasted keys. Creates the session
   * if it does not yet exist (the named window becomes the session's first
   * window). T-01812 Phase 3: the per-runtime btmux lease now hosts a 'broker'
   * window (this) and a 'tui' window under ONE socket/session.
   */
  async createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<TmuxPaneState> {
    await this.startServer()
    const pane = await this.createNamedWindow(input.sessionName, input.windowName, input.command)
    // The pane launches via the shell, which `exec`s into the command. Wait for
    // that hand-off to land so the pane root is the launched binary (NOT the
    // transient shell) before we return — callers inspect the process identity
    // immediately for broker-pid/liveness, and a bare shell is a launch failure.
    await this.waitForPaneCommandSettled(pane.paneId)
    return pane
  }

  /**
   * Idempotent named-window create/inspect. Returns the existing window pane
   * when present, otherwise creates a bare (shell) window. Used for the TUI
   * lease window the driver attaches to.
   */
  async createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<TmuxPaneState> {
    await this.startServer()
    const existing = await this.inspectWindow(input)
    if (existing) {
      return existing
    }
    return this.createNamedWindow(input.sessionName, input.windowName, undefined)
  }

  /**
   * Inspect a window BY NAME — replaces the hardcoded `:main` assumption so the
   * manager can resolve the distinct 'broker' and 'tui' windows of a durable
   * broker lease. Returns `null` when the window/session/server is gone.
   */
  async inspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<TmuxPaneState | null> {
    try {
      const result = await this.exec([
        'list-panes',
        '-t',
        `=${input.sessionName}:${input.windowName}`,
        '-F',
        '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}',
      ])
      const base = parsePaneState(result.stdout, this.socketPath)
      return { ...base, windowName: input.windowName }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return null
      }
      throw error
    }
  }

  /**
   * Resolve the running process identity of a specific pane (pane_current_command
   * + pane_pid + pane_dead). Used to prove a broker window's pane root is the
   * exec'd broker binary, and to capture broker pid for persisted identity.
   * Returns `null` when the pane/server is gone.
   */
  async inspectPaneProcess(
    paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null> {
    try {
      const result = await this.exec([
        'display-message',
        '-p',
        '-t',
        paneId,
        '-F',
        '#{pane_pid}\t#{pane_dead}\t#{pane_current_command}',
      ])
      return parsePaneProcess(result.stdout)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return null
      }
      throw error
    }
  }

  private async createNamedWindow(
    sessionName: string,
    windowName: string,
    command: string | undefined
  ): Promise<TmuxPaneState> {
    const exists = await this.sessionExists(sessionName)
    const args: string[] = exists ? ['new-window', '-d'] : ['new-session', '-d']
    const sanitizedPath = sanitizeTmuxServerPath(process.env['PATH'])
    if (sanitizedPath) {
      args.push('-e', `PATH=${sanitizedPath}`)
    }
    args.push('-P')
    if (exists) {
      args.push('-t', `=${sessionName}:`)
    } else {
      args.push('-s', sessionName)
    }
    args.push('-n', windowName, '-F', '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}')
    if (command !== undefined) {
      args.push(command)
    }
    const result = await this.exec(args)
    const base = parsePaneState(result.stdout, this.socketPath)
    return { ...base, windowName }
  }

  private async waitForPaneCommandSettled(paneId: string): Promise<void> {
    const deadlineMs = 2_000
    const stepMs = 25
    const start = performance.now()
    for (;;) {
      const proc = await this.inspectPaneProcess(paneId)
      if (!proc) {
        return
      }
      if (proc.dead || !isShellCommand(proc.command)) {
        return
      }
      if (performance.now() - start >= deadlineMs) {
        return
      }
      await delay(stepMs)
    }
  }

  private async sessionExists(sessionName: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', `=${sessionName}`])
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return false
      }
      throw error
    }
  }

  getAttachDescriptor(sessionName: string): { argv: string[] } {
    return {
      argv: [this.tmuxBinary, '-S', this.socketPath, 'attach-session', '-t', sessionName],
    }
  }

  async hasAttachedClient(
    target: string,
    options: {
      activeWindowId?: string | undefined
      activeWindowName?: string | undefined
    } = {}
  ): Promise<boolean> {
    try {
      const format =
        options.activeWindowId !== undefined
          ? '#{window_id}'
          : options.activeWindowName !== undefined
            ? '#{window_name}'
            : '#{client_tty}'
      const result = await this.exec(['list-clients', '-t', target, '-F', format])
      const values = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (options.activeWindowId !== undefined) {
        return values.includes(options.activeWindowId)
      }
      if (options.activeWindowName !== undefined) {
        return values.includes(options.activeWindowName)
      }
      return values.length > 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return false
      }
      throw error
    }
  }

  async waitForAttachedClient(
    target: string,
    options: {
      timeoutMs?: number | undefined
      intervalMs?: number | undefined
      activeWindowId?: string | undefined
      activeWindowName?: string | undefined
    } = {}
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5_000
    const intervalMs = options.intervalMs ?? 25
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if (await this.hasAttachedClient(target, options)) {
        return
      }
      await delay(intervalMs)
    }
    throw new Error(`tmux target has no attached client: ${target}`)
  }

  async interrupt(paneId: string): Promise<void> {
    await this.exec(['send-keys', '-t', paneId, 'C-c'])
  }

  async terminate(sessionName: string): Promise<void> {
    await this.killSession(sessionName)
  }

  /**
   * Kill the entire tmux server bound to this socket (and remove the socket).
   * Used to tear down a per-runtime lease server so it cannot leak. Tolerates
   * an already-absent server.
   */
  async killServer(): Promise<void> {
    try {
      await this.exec(['kill-server'])
    } catch (error) {
      // Killing the last session already exits the server and removes the
      // socket, so kill-server can race to a gone/absent server. Tolerate both
      // "no server running" and the connect-failure that a removed socket yields.
      const message = error instanceof Error ? error.message : String(error)
      if (!isMissingTargetError(message) && !isServerGoneError(message)) {
        throw error
      }
    } finally {
      // tmux may leave a stale socket file behind after the server exits; remove
      // it so the lease socket is fully reclaimed.
      await rm(this.socketPath, { force: true }).catch(() => undefined)
    }
  }

  async sendLiteral(paneId: string, text: string): Promise<void> {
    if (text.length === 0) {
      return
    }

    await this.exec(['send-keys', '-l', '-t', paneId, text])
  }

  async sendEnter(paneId: string): Promise<void> {
    await this.exec(['send-keys', '-t', paneId, 'Enter'])
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    await this.sendLiteral(paneId, keys)
    // Match the broker's interactive tmux input path: give TUIs time to
    // classify the literal paste before Enter arrives.
    await delay(SEND_KEYS_ENTER_DELAY_MS)
    await this.sendEnter(paneId)
  }

  async inspectSession(sessionName: string): Promise<TmuxPaneState | null> {
    try {
      const result = await this.exec([
        'list-panes',
        '-t',
        `=${sessionName}:${WINDOW_NAME}`,
        '-F',
        '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}',
      ])
      return parsePaneState(result.stdout, this.socketPath)
    } catch (error) {
      // A missing target OR a gone/absent server (removed socket) both mean the
      // session does not exist — surface that as `null`, not a throw.
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return null
      }
      throw error
    }
  }

  /**
   * Probe the foreground liveness of a single pane. Returns `null` when the pane
   * (or its server/socket) is gone — the caller treats that the same as a dead
   * pane. Used by broker-runtime liveness reconciliation: a leased tmux session
   * can outlive the harness process inside it, so session existence alone is not
   * proof the runtime is reusable.
   */
  async inspectPaneLiveness(paneId: string): Promise<TmuxPaneLiveness | null> {
    try {
      const result = await this.exec([
        'display-message',
        '-p',
        '-t',
        paneId,
        '-F',
        '#{pane_dead}\t#{pane_current_command}',
      ])
      return parsePaneLiveness(result.stdout)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return null
      }
      throw error
    }
  }

  /**
   * List the names of every session on this socket. Returns an empty array when
   * the server/socket is gone (treated as "no sessions"). Used by the startup
   * orphan-lease sweep to detect leaked `hrc-`-named lease sessions.
   */
  async listSessionNames(options: { timeoutMs?: number | undefined } = {}): Promise<string[]> {
    try {
      const args = ['list-sessions', '-F', '#{session_name}']
      const result =
        options.timeoutMs === undefined
          ? await this.exec(args)
          : await this.execWithTimeout(args, options.timeoutMs)
      return result.stdout
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    } catch (error) {
      if (isTmuxCommandTimeoutError(error)) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingTargetError(message) || isServerGoneError(message)) {
        return []
      }
      throw error
    }
  }

  private async createNamedSession(sessionName: string): Promise<TmuxPaneState> {
    const args = ['new-session', '-d']
    const sanitizedPath = sanitizeTmuxServerPath(process.env['PATH'])
    if (sanitizedPath) {
      args.push('-e', `PATH=${sanitizedPath}`)
    }
    args.push(
      '-P',
      '-s',
      sessionName,
      '-n',
      WINDOW_NAME,
      '-F',
      '#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}'
    )

    const result = await this.exec(args)

    return parsePaneState(result.stdout, this.socketPath)
  }

  private async scrubServerEnvironment(): Promise<void> {
    for (const key of listInheritedEnvKeysToScrub(process.env)) {
      try {
        await this.exec(['set-environment', '-gu', key])
      } catch {
        // Best effort: keep startup resilient if a key is already absent.
      }
    }
  }

  private async killSession(sessionName: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', `=${sessionName}`])
    } catch (error) {
      if (error instanceof Error && isMissingTargetError(error.message)) {
        return
      }
      throw error
    }
  }

  private async startServer(): Promise<void> {
    try {
      await this.exec(['start-server'])
    } catch (_error) {
      await rm(this.socketPath, { force: true }).catch(() => undefined)
      await this.exec(['start-server'])
    }
  }

  private async exec(args: string[]): Promise<TmuxExecResult> {
    return this.execRaw(['-S', this.socketPath, ...args])
  }

  private async execWithTimeout(args: string[], timeoutMs: number): Promise<TmuxExecResult> {
    return this.execRawWithTimeout(['-S', this.socketPath, ...args], timeoutMs)
  }

  private async execRawWithTimeout(args: string[], timeoutMs: number): Promise<TmuxExecResult> {
    return await new Promise((resolve, reject) => {
      execFile(
        this.tmuxBinary,
        args,
        {
          encoding: 'utf8',
          env: sanitizeTmuxClientEnv(process.env),
          killSignal: 'SIGKILL',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutMs,
        },
        (error, stdout, stderr) => {
          const command = [this.tmuxBinary, ...args].join(' ')
          const timedOut =
            typeof error === 'object' &&
            error !== null &&
            'killed' in error &&
            error.killed === true &&
            'signal' in error &&
            error.signal === 'SIGKILL'
          if (timedOut) {
            reject(new TmuxCommandTimeoutError(command, timeoutMs))
            return
          }

          if (error) {
            const rendered = stderr.trim() || stdout.trim() || error.message
            reject(new Error(rendered))
            return
          }

          resolve({ stdout, stderr })
        }
      )
    })
  }

  private async execRaw(args: string[]): Promise<TmuxExecResult> {
    const proc = Bun.spawn([this.tmuxBinary, ...args], {
      env: sanitizeTmuxClientEnv(process.env),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      const rendered = stderr.trim() || stdout.trim() || `tmux exited with status ${exitCode}`
      throw new Error(rendered)
    }

    return { stdout, stderr }
  }
}

export function createTmuxManager(options: TmuxManagerOptions): TmuxManager {
  return new TmuxManager(options.socketPath, options.tmuxBin)
}
