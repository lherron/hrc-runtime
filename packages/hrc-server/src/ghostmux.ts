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
