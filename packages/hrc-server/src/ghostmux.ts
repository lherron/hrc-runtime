export type RestartStyle = 'reuse_pty' | 'fresh_pty'

export type GhostmuxManagerOptions = {
  ghostmuxBin?: string | undefined
  runner?: GhostmuxRunner | undefined
}

export type GhostmuxExecResult = {
  stdout: string
  stderr: string
}

export type GhostmuxRunner = (args: string[]) => Promise<GhostmuxExecResult>

export type GhostmuxSurfaceState = {
  kind: 'ghostty'
  surfaceId: string
  shortId?: string | undefined
  name?: string | undefined
  title?: string | undefined
  cwd?: string | undefined
  focused?: boolean | undefined
  rows?: number | undefined
  columns?: number | undefined
  anchorSurfaceId?: string | undefined
  createdBy: 'ghostmux'
}

type GhostmuxSplitDirection = 'right' | 'down'

export type GhostmuxRuntimeSurfaceOptions = {
  cwd: string
  title: string
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  scopeRef?: string | undefined
  generation?: number | undefined
  projectId?: string | undefined
}

const CLAUDE_TAB_TITLE = 'Claude Surfaces'
const CLAUDE_TAB_ROLE = 'claude-surfaces'
const CLAUDE_RUNTIME_ROLE = 'claude-runtime'
const HEADLESS_VIEWER_ROLE = 'hrc-headless-viewer'

/** surface_bindings kind for the headless Claude viewer window (T-04439). */
export const HEADLESS_VIEWER_SURFACE_KIND = 'ghostty-headless-viewer'

/**
 * Full Ghostty status-bar triplet. ghostmux `statusbar set` sets all three text
 * fields at once, so callers always supply the whole bar (T-04439).
 */
export type GhostmuxStatusBarSpec = {
  left: string
  center: string
  right: string
  fg?: string | undefined
  bg?: string | undefined
}

export type HeadlessViewerResult =
  | { status: 'created'; surfaceId: string }
  | { status: 'reused'; surfaceId: string }
  | { status: 'failed'; error: string }

/**
 * An old Ghostty / ghostmux without a given subcommand fails with a recognizable
 * capability error rather than a transient surface error. We memo that off for
 * the process so we stop generating background load. Callers keep SEPARATE memo
 * flags per command — a statusbar no-op is not a set-bg failure and vice versa.
 */
function isUnsupportedCommandError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('unknown command') ||
    normalized.includes('unknown subcommand') ||
    normalized.includes('unrecognized') ||
    normalized.includes('not implemented') ||
    normalized.includes('unsupported') ||
    normalized.includes('no such command') ||
    normalized.includes('404')
  )
}

/** Status-bar fields are `|`-delimited on the wire; keep them single-line and `|`-free. */
function sanitizeStatusField(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function getNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key]
  return typeof candidate === 'boolean' ? candidate : undefined
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return {}
  return JSON.parse(trimmed) as unknown
}

export function parseGhostmuxSurfaceState(stdout: string): GhostmuxSurfaceState {
  const parsed = parseJson(stdout)
  const record = isRecord(parsed) ? parsed : {}
  const nested =
    (isRecord(record['terminal']) && record['terminal']) ||
    (isRecord(record['surface']) && record['surface']) ||
    (isRecord(record['pane']) && record['pane']) ||
    record
  const surfaceId = getString(nested, 'id', 'surface_id', 'surfaceId', 'uuid')
  if (!surfaceId) {
    throw new Error(`ghostmux command did not return a surface id: ${stdout.trim() || '<empty>'}`)
  }

  return {
    kind: 'ghostty',
    surfaceId,
    shortId: getString(nested, 'short_id', 'shortId'),
    name: getString(nested, 'name'),
    title: getString(nested, 'title'),
    cwd: getString(nested, 'working_directory', 'cwd'),
    focused: getBoolean(nested, 'focused'),
    rows: getNumber(nested, 'rows'),
    columns: getNumber(nested, 'columns'),
    createdBy: 'ghostmux',
  }
}

function parseGhostmuxSurfaceList(stdout: string): GhostmuxSurfaceState[] {
  const parsed = parseJson(stdout)
  const terminals =
    isRecord(parsed) && Array.isArray(parsed['terminals'])
      ? parsed['terminals']
      : isRecord(parsed) && Array.isArray(parsed['surfaces'])
        ? parsed['surfaces']
        : Array.isArray(parsed)
          ? parsed
          : []
  return terminals
    .filter(isRecord)
    .map((terminal) => parseGhostmuxSurfaceState(JSON.stringify(terminal)))
}

function metadataHasClaudeTabRole(metadata: unknown, projectId?: string | undefined): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== CLAUDE_TAB_ROLE) return false
  if (projectId === undefined) return true
  const metadataProject = metadata['hrc_project']
  return metadataProject === undefined || metadataProject === projectId
}

function metadataHasHeadlessViewerRole(metadata: unknown, scopeRef: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_VIEWER_ROLE) return false
  return metadata['hrc_scope_ref'] === scopeRef
}

function unwrapGhostmuxMetadata(value: unknown): unknown {
  if (!isRecord(value)) return value
  return isRecord(value['data']) ? value['data'] : value
}

function isMissingSurfaceError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('not found') ||
    normalized.includes('no such') ||
    normalized.includes('unknown target') ||
    normalized.includes('missing target')
  )
}

function selectSplitDirection(surface: GhostmuxSurfaceState): GhostmuxSplitDirection {
  const columns = surface.columns ?? 0
  const rows = surface.rows ?? 0
  return columns >= 100 || columns >= rows * 2 ? 'right' : 'down'
}

export class GhostmuxManager {
  /** Set once a recognizable "statusbar unsupported" error is seen (T-04439). */
  private statusBarUnsupported = false
  /** Separate memo: set once `set-bg` is seen to be unsupported (T-04439). */
  private setBgUnsupported = false

  constructor(
    private readonly ghostmuxBinary = 'ghostmux',
    private readonly runner?: GhostmuxRunner | undefined
  ) {}

  async initialize(): Promise<void> {
    await this.exec(['status', '--json'])
  }

  async ensureSurface(
    hostSessionId: string,
    restartStyle: RestartStyle,
    options: GhostmuxRuntimeSurfaceOptions
  ): Promise<GhostmuxSurfaceState> {
    return this.createClaudeRuntimeSurface(hostSessionId, restartStyle, options)
  }

  async ensureClaudeTab(options: {
    cwd: string
    projectId?: string | undefined
  }): Promise<GhostmuxSurfaceState> {
    const existing = await this.findClaudeTab(options.projectId)
    if (existing) return existing

    const created = parseGhostmuxSurfaceState(
      (
        await this.exec([
          'new',
          '--tab',
          '--cwd',
          options.cwd,
          '--title',
          CLAUDE_TAB_TITLE,
          '--json',
        ])
      ).stdout
    )
    await this.setMetadata(
      created.surfaceId,
      {
        hrc_role: CLAUDE_TAB_ROLE,
        ...(options.projectId ? { hrc_project: options.projectId } : {}),
      },
      true
    )
    return created
  }

  async createClaudeRuntimeSurface(
    _hostSessionId: string,
    restartStyle: RestartStyle,
    options: GhostmuxRuntimeSurfaceOptions
  ): Promise<GhostmuxSurfaceState> {
    void restartStyle

    const anchor = await this.ensureClaudeTab({
      cwd: options.cwd,
      projectId: options.projectId,
    })
    await this.equalizePanes(anchor.surfaceId)
    const created = parseGhostmuxSurfaceState(
      (
        await this.exec([
          'new-pane',
          '-t',
          anchor.surfaceId,
          '-d',
          selectSplitDirection(anchor),
          '--cwd',
          options.cwd,
          '--json',
        ])
      ).stdout
    )
    await this.setTitle(created.surfaceId, options.title)
    await this.setMetadata(created.surfaceId, {
      hrc_role: CLAUDE_RUNTIME_ROLE,
      ...(options.runtimeId ? { hrc_runtime_id: options.runtimeId } : {}),
      ...(options.hostSessionId ? { hrc_host_session_id: options.hostSessionId } : {}),
      ...(options.scopeRef ? { hrc_scope_ref: options.scopeRef } : {}),
      ...(options.generation !== undefined ? { hrc_generation: options.generation } : {}),
    })
    await this.equalizePanes(created.surfaceId)
    return {
      ...created,
      title: options.title,
      anchorSurfaceId: anchor.surfaceId,
    }
  }

  async inspectSurface(surfaceId: string): Promise<GhostmuxSurfaceState | null> {
    try {
      const surfaces = parseGhostmuxSurfaceList(
        (await this.exec(['list-surfaces', '--json'])).stdout
      )
      return surfaces.find((surface) => surface.surfaceId === surfaceId) ?? null
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return null
      throw error
    }
  }

  async capture(surfaceId: string): Promise<string> {
    return (await this.exec(['capture-pane', '-t', surfaceId])).stdout
  }

  async interrupt(surfaceId: string): Promise<void> {
    await this.exec(['send-key', '-t', surfaceId, 'C-c'])
  }

  async terminate(surfaceId: string): Promise<void> {
    try {
      await this.exec(['kill-surface', '-t', surfaceId, '--force'])
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return
      throw error
    }
  }

  async equalizePanes(surfaceId: string): Promise<void> {
    try {
      await this.exec(['equalize-panes', '-t', surfaceId])
    } catch (error) {
      if (error instanceof Error && isMissingSurfaceError(error.message)) return
      throw error
    }
  }

  async sendLiteral(surfaceId: string, text: string): Promise<void> {
    if (text.length === 0) return
    await this.exec(['send-keys', '-t', surfaceId, '-l', '--no-enter', text])
  }

  async sendEnter(surfaceId: string): Promise<void> {
    await this.exec(['send-key', '-t', surfaceId, 'Enter'])
  }

  async sendKeys(surfaceId: string, text: string): Promise<void> {
    await this.exec(['send-keys', '-t', surfaceId, '-l', text])
  }

  getAttachDescriptor(surfaceId: string): { argv: string[] } {
    return {
      argv: [this.ghostmuxBinary, 'stream-surface', '-t', surfaceId],
    }
  }

  /**
   * Best-effort: spawn a standalone, unfocused Ghostty window that attaches to a
   * headless broker runtime's TUI, making an otherwise-invisible headless claude
   * run watchable. Deduped per scope — if a live viewer window for this scope
   * already exists, it is reused and NO new window is created (so subsequent turns
   * into the same scope do not stack windows). Never throws: any ghostmux failure
   * (transient surface-realize race, unavailable libghostty API, no Ghostty) is
   * surfaced as { status: 'failed' } so the caller can log and continue headless.
   */
  async ensureHeadlessViewer(options: {
    scopeRef: string
    runtimeId: string
    attachCommand: string
    title: string
    /**
     * Optional initial status-bar triplet. Applied best-effort and OFF the
     * awaited critical path (fire-and-forget) so a slow/failed statusbar write
     * never delays the broker start that awaits this call (daedalus, T-04439).
     */
    statusBar?: GhostmuxStatusBarSpec | undefined
    /**
     * Optional agent-color terminal tint (`set-bg`). Identity, not state —
     * applied once on create/reuse, never per lifecycle event. Same fire-and-
     * forget discipline as the status bar.
     */
    terminalBg?: string | undefined
  }): Promise<HeadlessViewerResult> {
    try {
      const existing = await this.findHeadlessViewer(options.scopeRef)
      if (existing) {
        // The same viewer window can be reused for a later runtime; refresh the
        // recovery metadata so a post-restart resolve still finds the surface by
        // the CURRENT runtime id, then repaint the bar. Both best-effort.
        await this.setMetadata(
          existing.surfaceId,
          {
            hrc_role: HEADLESS_VIEWER_ROLE,
            hrc_scope_ref: options.scopeRef,
            hrc_runtime_id: options.runtimeId,
          },
          true
        ).catch(() => undefined)
        this.applyStatusBarBestEffort(existing.surfaceId, options.statusBar)
        this.applyTerminalBackgroundBestEffort(existing.surfaceId, options.terminalBg)
        return { status: 'reused', surfaceId: existing.surfaceId }
      }

      // `ghostmux new` itself frequently hits the transient libghostty
      // surface_not_realize race under load; ghostmux's own guidance is to retry
      // with backoff (clears in 1-2 tries), so wrap both the window create and the
      // attach send-keys in the same bounded retry.
      const created = await this.withGhostmuxBackoff(async () =>
        parseGhostmuxSurfaceState(
          (await this.exec(['new', '--window', '--title', options.title, '--json'])).stdout
        )
      )
      await this.setMetadata(
        created.surfaceId,
        {
          hrc_role: HEADLESS_VIEWER_ROLE,
          hrc_scope_ref: options.scopeRef,
          hrc_runtime_id: options.runtimeId,
        },
        true
      ).catch(() => undefined)
      await this.withGhostmuxBackoff(() =>
        this.exec(['send-keys', '-t', created.surfaceId, options.attachCommand])
      )
      this.applyStatusBarBestEffort(created.surfaceId, options.statusBar)
      this.applyTerminalBackgroundBestEffort(created.surfaceId, options.terminalBg)
      return { status: 'created', surfaceId: created.surfaceId }
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Find the headless viewer surface bound to a runtime by its stamped Ghostty
   * metadata. The projector's recovery path when the durable surface_binding is
   * missing (e.g. after a DB-less restart) — DB binding is the primary cache.
   */
  async findHeadlessViewerSurfaceByRuntimeId(runtimeId: string): Promise<string | null> {
    try {
      const surfaces = parseGhostmuxSurfaceList(
        (await this.exec(['list-surfaces', '--json'])).stdout
      )
      for (const surface of surfaces) {
        const metadata = await this.getMetadata(surface.surfaceId, true).catch(() => undefined)
        if (
          isRecord(metadata) &&
          metadata['hrc_role'] === HEADLESS_VIEWER_ROLE &&
          metadata['hrc_runtime_id'] === runtimeId
        ) {
          return surface.surfaceId
        }
      }
    } catch {
      // best-effort
    }
    return null
  }

  /**
   * Apply a full status-bar triplet. Public primitive — all status-bar writes
   * go through here. Single attempt (NO multi-second backoff), swallows every
   * failure, and memoizes an unsupported-statusbar capability OFF so old Ghostty
   * stops generating background load (daedalus, T-04439).
   */
  async setStatusBar(surfaceId: string, spec: GhostmuxStatusBarSpec): Promise<void> {
    if (this.statusBarUnsupported) return
    const text = [spec.left, spec.center, spec.right].map(sanitizeStatusField).join('|')
    const args = ['statusbar', 'set', '-t', surfaceId, text]
    if (spec.fg) args.push('--fg', spec.fg)
    if (spec.bg) args.push('--bg', spec.bg)
    try {
      await this.exec(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.statusBarUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /**
   * Set the terminal default background (OSC 11 via `set-bg`) — the agent-color
   * identity channel for headless viewer surfaces, since this Ghostty ignores
   * statusbar bg. Public primitive: single attempt, swallows every failure,
   * memoizes an unsupported `set-bg` capability SEPARATELY from statusbar
   * (daedalus, T-04439).
   */
  async setTerminalBackground(surfaceId: string, hex: string): Promise<void> {
    if (this.setBgUnsupported) return
    try {
      await this.exec(['set-bg', '-t', surfaceId, hex, '--json'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isUnsupportedCommandError(message)) this.setBgUnsupported = true
      // Cosmetic — never propagate.
    }
  }

  /** Fire-and-forget status-bar write; keeps the awaited spawn path clean. */
  private applyStatusBarBestEffort(
    surfaceId: string,
    spec: GhostmuxStatusBarSpec | undefined
  ): void {
    if (!spec) return
    void this.setStatusBar(surfaceId, spec)
  }

  /** Fire-and-forget terminal-tint write; keeps the awaited spawn path clean. */
  private applyTerminalBackgroundBestEffort(surfaceId: string, hex: string | undefined): void {
    if (!hex) return
    void this.setTerminalBackground(surfaceId, hex)
  }

  private async findHeadlessViewer(scopeRef: string): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, true).catch(() => undefined)
      if (metadataHasHeadlessViewerRole(metadata, scopeRef)) return surface
    }
    return null
  }

  // libghostty surface creation/realization races transiently under load; ghostmux
  // itself recommends retrying with the 0.5/1/2/4s backoff schedule before giving up.
  private async withGhostmuxBackoff<T>(operation: () => Promise<T>): Promise<T> {
    const delaysMs = [0, 500, 1000, 2000, 4000]
    let lastError: unknown
    for (const delayMs of delaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        return await operation()
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('ghostmux operation failed')
  }

  private async findClaudeTab(
    projectId?: string | undefined
  ): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, true).catch(() => undefined)
      if (metadataHasClaudeTabRole(metadata, projectId)) return surface
    }
    return (
      surfaces.find(
        (surface) => surface.title === CLAUDE_TAB_TITLE || surface.name === CLAUDE_TAB_TITLE
      ) ?? null
    )
  }

  private async getMetadata(surfaceId: string, window = false): Promise<unknown> {
    return unwrapGhostmuxMetadata(
      parseJson(
        (
          await this.exec([
            'metadata',
            'get',
            '-t',
            surfaceId,
            ...(window ? ['--window'] : []),
            '--json',
          ])
        ).stdout
      )
    )
  }

  private async setMetadata(
    surfaceId: string,
    metadata: Record<string, unknown>,
    window = false
  ): Promise<void> {
    await this.exec([
      'metadata',
      'set',
      '-t',
      surfaceId,
      JSON.stringify(metadata),
      ...(window ? ['--window'] : []),
      '--json',
    ])
  }

  private async setTitle(surfaceId: string, title: string): Promise<void> {
    await this.exec(['set-title', '-t', surfaceId, title])
  }

  private async exec(args: string[]): Promise<GhostmuxExecResult> {
    if (this.runner) {
      return this.runner(args)
    }

    const proc = Bun.spawn([this.ghostmuxBinary, ...args], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      const rendered = stderr.trim() || stdout.trim() || `ghostmux exited with status ${exitCode}`
      throw new Error(rendered)
    }

    return { stdout, stderr }
  }
}

export function createGhostmuxManager(options: GhostmuxManagerOptions = {}): GhostmuxManager {
  return new GhostmuxManager(options.ghostmuxBin, options.runner)
}
