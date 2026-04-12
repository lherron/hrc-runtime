import { rm } from 'node:fs/promises'

import {
  listInheritedEnvKeysToScrub,
  sanitizeTmuxClientEnv,
  sanitizeTmuxServerPath,
} from './launch/env.js'

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

type TmuxExecResult = {
  stdout: string
  stderr: string
}

const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

const WINDOW_NAME = 'main'
const TABS = '\t'

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

function parsePaneState(stdout: string, socketPath: string): TmuxPaneState {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane metadata')
  }

  const [sessionId, windowId, paneId, sessionName] = line.split(TABS)
  if (!sessionId || !windowId || !paneId || !sessionName) {
    throw new Error(`unexpected tmux metadata line: ${line}`)
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

  async capture(paneId: string): Promise<string> {
    const result = await this.exec(['capture-pane', '-t', paneId, '-p'])
    return result.stdout
  }

  getAttachDescriptor(sessionName: string): { argv: string[] } {
    return {
      argv: [this.tmuxBinary, '-S', this.socketPath, 'attach-session', '-t', sessionName],
    }
  }

  async interrupt(paneId: string): Promise<void> {
    await this.exec(['send-keys', '-t', paneId, 'C-c'])
  }

  async terminate(sessionName: string): Promise<void> {
    await this.killSession(sessionName)
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
      if (error instanceof Error && isMissingTargetError(error.message)) {
        return null
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
