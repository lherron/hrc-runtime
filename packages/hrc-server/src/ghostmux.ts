import { parseScopeRef } from 'agent-scope'

import { shortenProjectId } from './project-prefix.js'

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

/**
 * Consolidated headless-viewer presentation (T-05237). Replaces the old
 * one-standalone-window-per-scope model (role `hrc-headless-viewer`): a single
 * global "Headless Sessions" window holds one tab per canonical `hrc_tab_key`,
 * and one agent pane per `(tabKey, agentId)`.
 *
 * INVARIANT (daedalus #10810): HRC owns this topology ONLY through Ghostty
 * metadata — never via `list-surfaces` topology, window titles, tab labels, cwd,
 * or focused state, which are presentation only.
 */
const HEADLESS_SESSIONS_WINDOW_TITLE = 'Headless Sessions'
/** Window-level metadata role stamped on the global parent window. */
const HEADLESS_SESSIONS_WINDOW_ROLE = 'headless-sessions-window'
/** Surface-level role for the non-runtime-owned anchor pane (never reaped). */
const HEADLESS_WINDOW_ANCHOR_ROLE = 'headless-window-anchor'
/** Surface-level role for a runtime-owned agent viewer pane. */
const HEADLESS_AGENT_PANE_ROLE = 'headless-agent-pane'

/** surface_bindings kind for a headless agent viewer pane (T-04439, T-05237). */
export const HEADLESS_VIEWER_SURFACE_KIND = 'ghostty-headless-viewer'

/** Decomposition of a scope ref into the canonical headless tab grouping (T-05237). */
export type HeadlessTabIdentity = {
  /** Canonical grouping key — the ONLY value matching may key on. */
  tabKey: string
  agentId: string
  taskId?: string | undefined
  projectId?: string | undefined
  /** Human display label for the tab/pane title (presentation only). */
  label: string
}

function safeParseScopeRef(
  scopeRef: string
): { agentId?: string; projectId?: string; taskId?: string } | null {
  try {
    return parseScopeRef(scopeRef) as {
      agentId?: string
      projectId?: string
      taskId?: string
    }
  } catch {
    return null
  }
}

/** A real wrkq task scope is `T-` followed by digits (e.g. `T-05237`). */
function isRealTaskId(taskId: string | undefined): taskId is string {
  return typeof taskId === 'string' && /^T-\d+/.test(taskId)
}

/** Keep a scope fragment safe inside a `:`-delimited metadata key. */
function sanitizeKeyFragment(value: string): string {
  return value.replace(/[\s:|]+/g, '-').trim() || 'unknown'
}

/**
 * Canonical tab grouping for a headless viewer pane (T-05237, daedalus C1).
 *
 * - Real task scope (`T-XXXXX`):  `task:<T-XXXXX>`        label `<T-XXXXX>`
 * - Non-task / `primary` scope:   `project:<proj>:primary` label `<proj> · primary`
 *   where `<proj>` is the projectId, else an agent-root qualifier, so two
 *   `primary` sessions from different projects NEVER collide.
 * - Unparseable ref:              `unparsed:<sanitized>`  label `<raw>`
 *
 * Matching MUST use `tabKey`, never a bare `primary` or a human label.
 */
export function deriveHeadlessTabIdentity(scopeRef: string): HeadlessTabIdentity {
  const parsed = safeParseScopeRef(scopeRef)
  if (!parsed?.agentId) {
    const safe = sanitizeKeyFragment(scopeRef)
    return { tabKey: `unparsed:${safe}`, agentId: 'unknown', label: scopeRef || safe }
  }
  const agentId = parsed.agentId
  // Label uses the SHORT project prefix (presentation only); the tabKey keeps the
  // full projectId so topology grouping stays canonical (daedalus C1/C2).
  if (isRealTaskId(parsed.taskId)) {
    const prefix = shortenProjectId(parsed.projectId)
    return {
      tabKey: `task:${parsed.taskId}`,
      agentId,
      taskId: parsed.taskId,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      label: prefix ? `${prefix} · ${parsed.taskId}` : parsed.taskId,
    }
  }
  const qualifier = parsed.projectId
    ? sanitizeKeyFragment(parsed.projectId)
    : `agent-root-${sanitizeKeyFragment(agentId)}`
  const prefix = parsed.projectId ? shortenProjectId(parsed.projectId) : `~${agentId}`
  return {
    tabKey: `project:${qualifier}:primary`,
    agentId,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    label: `${prefix} · primary`,
  }
}

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
  | { status: 'created'; surfaceId: string; tabKey: string }
  | { status: 'reused'; surfaceId: string; tabKey: string }
  | { status: 'failed'; error: string }

/** Outcome of a runtime-fenced agent-pane reap (T-05237, daedalus C4). */
export type HeadlessReapResult =
  | { status: 'reaped'; surfaceId: string; tabCollapsed: boolean }
  | { status: 'skipped'; reason: string }
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

function metadataIsWindowAnchor(metadata: unknown): boolean {
  return isRecord(metadata) && metadata['hrc_role'] === HEADLESS_WINDOW_ANCHOR_ROLE
}

function metadataIsAgentPaneForTab(metadata: unknown, tabKey: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) return false
  return metadata['hrc_tab_key'] === tabKey
}

function metadataIsAgentPaneFor(metadata: unknown, tabKey: string, agentId: string): boolean {
  if (!metadataIsAgentPaneForTab(metadata, tabKey)) return false
  return (metadata as Record<string, unknown>)['hrc_agent_id'] === agentId
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
  /**
   * In-process keyed serialization for headless viewer find-or-create (T-05237,
   * daedalus concurrency condition). Two concurrent dispatches for the same tab
   * key (or the shared window) would otherwise both miss-then-create, producing a
   * duplicate tab/window. Each create path re-checks live metadata AFTER it owns
   * the lock. Sufficient for the launchd-singleton hrc-server; no cross-process
   * lock is needed because metadata is reconciled on restart.
   */
  private readonly headlessLocks = new Map<string, Promise<void>>()

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
   * Best-effort: place a headless broker runtime's TUI viewer as a PANE inside the
   * single global "Headless Sessions" window — one tab per canonical `hrc_tab_key`,
   * one pane per `(tabKey, agentId)` (T-05237). Replaces the prior
   * one-standalone-window-per-scope model that proliferated windows and exhausted
   * the pty pool. Reuse rebinds the pane's `hrc_runtime_id` to the CURRENT runtime
   * (daedalus C5) BEFORE the caller's lifecycle projection can target it. Never
   * throws: any ghostmux failure is surfaced as { status: 'failed' } so the caller
   * logs and continues headless.
   *
   * Topology authority is Ghostty metadata ONLY (daedalus invariant): titles, tab
   * labels, cwd, and focus are presentation and are never read for decisions.
   */
  async ensureHeadlessViewer(options: {
    scopeRef: string
    runtimeId: string
    attachCommand: string
    /** Optional explicit pane-title override; default is `<label> · <agent>`. */
    title?: string | undefined
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
    const identity = deriveHeadlessTabIdentity(options.scopeRef)
    const paneTitle = options.title ?? `${identity.label} · ${identity.agentId}`
    // Serialize per tab key: concurrent same-task dispatches must not both
    // miss-then-create a duplicate tab. The critical section re-checks live
    // metadata AFTER acquiring the lock (daedalus concurrency condition).
    return this.withHeadlessLock(`tab:${identity.tabKey}`, async () => {
      try {
        const existing = await this.findAgentPane(identity.tabKey, identity.agentId)
        if (existing) {
          // Reuse: rebind the pane to the CURRENT runtime (daedalus C5) so a stale
          // terminal event for a prior runtime cannot reap this pane, then repaint.
          await this.stampAgentPaneMetadata(existing.surfaceId, identity, {
            scopeRef: options.scopeRef,
            runtimeId: options.runtimeId,
          }).catch(() => undefined)
          // Refresh the title on reuse too, so a reused pane always reflects the
          // current label (e.g. after a label-format change). Safe: the pane is
          // blocked in `tmux attach`, so this set-title is not clobbered.
          await this.exec(['set-title', '-t', existing.surfaceId, paneTitle]).catch(() => undefined)
          this.applyStatusBarBestEffort(existing.surfaceId, options.statusBar)
          this.applyTerminalBackgroundBestEffort(existing.surfaceId, options.terminalBg)
          return {
            status: 'reused' as const,
            surfaceId: existing.surfaceId,
            tabKey: identity.tabKey,
          }
        }

        const anchor = await this.ensureHeadlessWindow()
        // An existing pane for this tab key is a valid split target — any live
        // pane in the tab puts the new pane in the same Ghostty tab.
        const tabPane = await this.findTaskTab(identity.tabKey)

        // `ghostmux new`/`new-pane` transiently hit the libghostty surface_not_realize
        // race under load; ghostmux's guidance is bounded backoff (clears in 1-2 tries).
        const created = await this.withGhostmuxBackoff(async () =>
          parseGhostmuxSurfaceState(
            tabPane
              ? (
                  await this.exec([
                    'new-pane',
                    '-t',
                    tabPane.surfaceId,
                    '-d',
                    selectSplitDirection(tabPane),
                    '--json',
                  ])
                ).stdout
              : (
                  await this.exec([
                    'new',
                    '--tab',
                    '--parent',
                    anchor.surfaceId,
                    '--title',
                    paneTitle,
                    '--json',
                  ])
                ).stdout
          )
        )
        await this.stampAgentPaneMetadata(created.surfaceId, identity, {
          scopeRef: options.scopeRef,
          runtimeId: options.runtimeId,
        }).catch(() => undefined)
        // Order matters (T-05237): send the (blocking) attach command FIRST, then
        // set the title as the LAST write. The pane then stays blocked inside
        // `tmux attach` so no shell precmd/OSC-7 fires to overwrite the label.
        await this.withGhostmuxBackoff(() =>
          this.exec(['send-keys', '-t', created.surfaceId, options.attachCommand])
        )
        await this.exec(['set-title', '-t', created.surfaceId, paneTitle]).catch(() => undefined)
        await this.equalizePanes(created.surfaceId)
        this.applyStatusBarBestEffort(created.surfaceId, options.statusBar)
        this.applyTerminalBackgroundBestEffort(created.surfaceId, options.terminalBg)
        return { status: 'created' as const, surfaceId: created.surfaceId, tabKey: identity.tabKey }
      } catch (error) {
        return {
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  /**
   * Runtime-bound, fenced reap of a terminating runtime's agent viewer pane
   * (T-05237, daedalus C4). Kills the surface ONLY if its live metadata still maps
   * it to `runtimeId` AND the role is `headless-agent-pane` — never by tab/agent
   * alone, so a stale terminal event cannot kill a pane already rebound to a newer
   * runtime. Never kills the window anchor. If the killed pane was the tab's last
   * live agent pane, the tab collapses with it (killing the last pane closes the
   * Ghostty tab). Best-effort: never throws.
   */
  async reapHeadlessAgentPane(surfaceId: string, runtimeId: string): Promise<HeadlessReapResult> {
    try {
      const metadata = await this.getMetadata(surfaceId, false).catch(() => undefined)
      if (!isRecord(metadata) || metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) {
        return { status: 'skipped', reason: 'not_agent_pane' }
      }
      if (metadata['hrc_runtime_id'] !== runtimeId) {
        // Rebound to a newer runtime — the fence: do NOT reap.
        return { status: 'skipped', reason: 'runtime_rebound' }
      }
      const tabKey =
        typeof metadata['hrc_tab_key'] === 'string' ? metadata['hrc_tab_key'] : undefined
      await this.terminate(surfaceId)
      // After the kill, did any sibling agent pane for this tab survive?
      let tabCollapsed = false
      if (tabKey) {
        const sibling = await this.findTaskTab(tabKey).catch(() => null)
        tabCollapsed = sibling === null
      }
      return { status: 'reaped', surfaceId, tabCollapsed }
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Find the headless agent viewer pane bound to a runtime by its stamped Ghostty
   * metadata. The projector's recovery path when the durable surface_binding is
   * missing (e.g. after a DB-less restart) — DB binding is the primary cache.
   */
  async findHeadlessViewerSurfaceByRuntimeId(runtimeId: string): Promise<string | null> {
    try {
      const surfaces = parseGhostmuxSurfaceList(
        (await this.exec(['list-surfaces', '--json'])).stdout
      )
      for (const surface of surfaces) {
        const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
        if (
          isRecord(metadata) &&
          metadata['hrc_role'] === HEADLESS_AGENT_PANE_ROLE &&
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

  /**
   * Serialize an async critical section by key (T-05237). Tasks for the same key
   * run strictly in submission order; distinct keys run concurrently. The chain
   * never rejects (errors are isolated to each task's own returned promise), so a
   * failed find-or-create cannot wedge later calls for the same key.
   */
  private withHeadlessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.headlessLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.headlessLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  /**
   * Find-or-create the single global "Headless Sessions" window, returning its
   * anchor surface (the stable `--parent` target for new task tabs). The anchor is
   * non-runtime-owned and is never reaped. Serialized on a shared window lock so
   * two concurrent first-dispatches cannot create two windows.
   */
  private ensureHeadlessWindow(): Promise<GhostmuxSurfaceState> {
    return this.withHeadlessLock('headless-window', async () => {
      const existing = await this.findWindowAnchor()
      if (existing) return existing
      const created = await this.withGhostmuxBackoff(async () =>
        parseGhostmuxSurfaceState(
          (
            await this.exec([
              'new',
              '--window',
              '--title',
              HEADLESS_SESSIONS_WINDOW_TITLE,
              '--json',
            ])
          ).stdout
        )
      )
      // Surface-level role identifies the anchor pane; window-level role marks the
      // whole window. Both best-effort.
      await this.setMetadata(
        created.surfaceId,
        { hrc_role: HEADLESS_WINDOW_ANCHOR_ROLE },
        false
      ).catch(() => undefined)
      await this.setMetadata(
        created.surfaceId,
        { hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE },
        true
      ).catch(() => undefined)
      return created
    })
  }

  private async findWindowAnchor(): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsWindowAnchor(metadata)) return surface
    }
    return null
  }

  /** Any live agent pane sharing this tab key — a valid split target for the tab. */
  private async findTaskTab(tabKey: string): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsAgentPaneForTab(metadata, tabKey)) return surface
    }
    return null
  }

  /** The live agent pane for `(tabKey, agentId)`, if one exists. */
  private async findAgentPane(
    tabKey: string,
    agentId: string
  ): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsAgentPaneFor(metadata, tabKey, agentId)) return surface
    }
    return null
  }

  /** Stamp/refresh the canonical agent-pane metadata (surface-level). */
  private async stampAgentPaneMetadata(
    surfaceId: string,
    identity: HeadlessTabIdentity,
    binding: { scopeRef: string; runtimeId: string }
  ): Promise<void> {
    await this.setMetadata(
      surfaceId,
      {
        hrc_role: HEADLESS_AGENT_PANE_ROLE,
        hrc_tab_key: identity.tabKey,
        hrc_agent_id: identity.agentId,
        ...(identity.projectId ? { hrc_project: identity.projectId } : {}),
        ...(identity.taskId ? { hrc_task_id: identity.taskId } : {}),
        hrc_scope_ref: binding.scopeRef,
        hrc_runtime_id: binding.runtimeId,
      },
      false
    )
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
