import { buildScopeRef, normalizeLaneRef, parseScopeRef } from 'agent-scope'

import { shortenProjectId } from './project-prefix.js'

export type GhostmuxManagerOptions = {
  ghostmuxBin?: string | undefined
  runner?: GhostmuxRunner | undefined
  commandTimeoutMs?: number | undefined
}

export type GhostmuxExecResult = {
  stdout: string
  stderr: string
}

export type GhostmuxRunner = (args: string[]) => Promise<GhostmuxExecResult>

export const DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS = 5_000

export class GhostmuxCommandTimeoutError extends Error {
  override readonly name = 'GhostmuxCommandTimeoutError'
  readonly code = 'ghostmux_command_timeout'

  constructor(
    readonly args: readonly string[],
    readonly timeoutMs: number
  ) {
    super(`ghostmux ${args.join(' ')} timed out after ${timeoutMs}ms`)
  }
}

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
  /**
   * First-class managed-window id this surface CURRENTLY resides in (T-07121).
   * Live property, never cacheable: a tab dragged between windows changes it.
   * Absent on builds without the windows API.
   */
  windowId?: string | undefined
  createdBy: 'ghostmux'
}

/** A first-class managed window as answered by `new --window` / `list-windows`. */
export type GhostmuxWindowState = {
  windowId: string
  /** `false` when `--find-or-create-by` matched an existing window (T-07121). */
  created: boolean
  terminalIds: string[]
}

type GhostmuxSplitDirection = 'right' | 'down'

/**
 * Consolidated headless-viewer presentation (T-05237, T-06321). Replaces the old
 * one-standalone-window-per-scope model (role `hrc-headless-viewer`): a single
 * global "Headless Sessions" window holds one tab per canonical `hrc_tab_key`,
 * and one agent pane per canonical `hrc_pane_key` — the normalized
 * `(scopeRef, laneRef)` HRC session identity, so same-agent role/lane seats on one
 * task get distinct panes (T-06321).
 *
 * INVARIANT (daedalus #10810): HRC owns this topology ONLY through Ghostty
 * metadata — never via `list-surfaces` topology, window titles, tab labels, cwd,
 * or focused state, which are presentation only.
 *
 * AMENDED (T-07118): tab identity is the COMPOSITE `(windowKey, tabKey)` pair.
 * All live panes for one canonical pair share one Ghostty tab, and a given
 * `hrc_tab_key` may appear in at most one tab PER KEYED WINDOW. Pane identity
 * (`hrc_pane_key`) stays global, so at most one live viewer pane per HRC session
 * still holds and reuse still wins over placement.
 *
 * AMENDED (T-07121): on a build that serves the first-class windows API, the
 * keyed window is a real managed window found-or-created atomically by its
 * `hrc_window_key` metadata — no anchor pane, no N+1 metadata sweep, no
 * closeable identity carrier. Placement authority splits: pane METADATA remains
 * logical identity, and the first-class `windowId` is physical RESIDENCY. That
 * does not weaken the daedalus #10810 invariant — `windowId` is API topology,
 * not presentation; titles, tab labels, cwd, and focus stay forbidden. Old
 * builds (404 on the windows API) keep the full legacy anchor path unchanged.
 */
const HEADLESS_SESSIONS_WINDOW_TITLE = 'Headless Sessions'
/** Window-level metadata role stamped on the global parent window. */
const HEADLESS_SESSIONS_WINDOW_ROLE = 'headless-sessions-window'
/** Surface-level role for the non-runtime-owned anchor pane (never reaped). */
const HEADLESS_WINDOW_ANCHOR_ROLE = 'headless-window-anchor'
/** Surface-level role for a runtime-owned agent viewer pane. */
const HEADLESS_AGENT_PANE_ROLE = 'headless-agent-pane'

/**
 * Implicit window key for every pane placed without a `viewerWindow` hint
 * (T-07118). Metadata written before this change carries NO `hrc_window_key`,
 * so an ABSENT key must read as this value — that is what makes today's live
 * topology match without a restamp, and what makes an absent hint a byte-for-
 * byte no-op.
 */
export const DEFAULT_HEADLESS_WINDOW_KEY = 'default'

/** Keep a caller-supplied window key inside the safe metadata-key alphabet. */
export function normalizeWindowKey(windowKey: string | undefined): string {
  const trimmed = (windowKey ?? '').trim()
  if (trimmed.length === 0) return DEFAULT_HEADLESS_WINDOW_KEY
  return sanitizeKeyFragment(trimmed)
}

/** Read the effective window key off live metadata (absent ⇒ implicit default). */
function metadataWindowKey(metadata: unknown): string {
  if (!isRecord(metadata)) return DEFAULT_HEADLESS_WINDOW_KEY
  const raw = metadata['hrc_window_key']
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_HEADLESS_WINDOW_KEY
}

/** Presentation-only window title derived from the key. */
function headlessWindowTitle(windowKey: string): string {
  return windowKey === DEFAULT_HEADLESS_WINDOW_KEY
    ? HEADLESS_SESSIONS_WINDOW_TITLE
    : `${HEADLESS_SESSIONS_WINDOW_TITLE} · ${windowKey}`
}

/** surface_bindings kind for a headless agent viewer pane (T-04439, T-05237). */
export const HEADLESS_VIEWER_SURFACE_KIND = 'ghostty-headless-viewer'

/** Decomposition of a scope ref into the canonical headless tab grouping (T-05237). */
export type HeadlessTabIdentity = {
  /** Canonical grouping key — the ONLY value the TAB grouping may key on. */
  tabKey: string
  agentId: string
  taskId?: string | undefined
  projectId?: string | undefined
  /** Human display label for the tab/pane title (presentation only). */
  label: string
}

/**
 * Full HRC-session identity for a headless viewer PANE (T-06321). A task still
 * owns one tab (`tab.tabKey`), but distinct role-qualified scopes or distinct
 * lanes under that task get distinct panes keyed by `paneKey`, derived from the
 * normalized `(scopeRef, laneRef)` pair. `agentId` is presentation metadata, not
 * uniqueness authority.
 */
export type HeadlessSessionIdentity = {
  /** Tab grouping — one tab per canonical task/project key (unchanged). */
  tab: HeadlessTabIdentity
  /** Canonical pane uniqueness key from normalized `(scopeRef, laneRef)`. */
  paneKey: string
  /** Normalized lane ref (`main` or `lane:<id>`). */
  laneRef: string
  /** Role name when the scope is role-qualified (title + operator diagnosis). */
  roleName?: string | undefined
}

type ParsedScope = {
  agentId?: string
  projectId?: string
  taskId?: string
  roleName?: string
}

function safeParseScopeRef(scopeRef: string): ParsedScope | null {
  try {
    return parseScopeRef(scopeRef) as ParsedScope
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
 * - Non-task scope with a named token (e.g. a T-07118 roster slot such as
 *   `primary-nova`): `project:<proj>:<token>` label `<proj> · <token>` — each
 *   named scope owns its OWN tab (T-07142), so a new widget session opens a
 *   new tab instead of splitting a pane into the shared primary tab.
 * - Bare `primary` / taskless scope: `project:<proj>:primary` label
 *   `<proj> · primary`, where `<proj>` is the projectId, else an agent-root
 *   qualifier, so two `primary` sessions from different projects NEVER collide.
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
  const scopeToken = parsed.taskId ? sanitizeKeyFragment(parsed.taskId) : 'primary'
  return {
    tabKey: `project:${qualifier}:${scopeToken}`,
    agentId,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    label: `${prefix} · ${scopeToken}`,
  }
}

/**
 * Canonical pane uniqueness key from the full normalized HRC session identity
 * `(scopeRef, laneRef)` (T-06321). A role-qualified scope keeps its `role:` segment
 * and distinct lanes append distinct `lane` refs, so tester/implementer/observer
 * scopes for the same agent+task — and distinct lanes for one scope — never collapse
 * to one pane. Falls back to the sanitized raw ref for an unparseable scope so it
 * never throws.
 */
function deriveHeadlessPaneKey(
  parsed: ParsedScope | null,
  laneRef: string,
  rawScopeRef: string
): string {
  if (!parsed?.agentId) {
    return `unparsed:${sanitizeKeyFragment(rawScopeRef)}#${laneRef}`
  }
  const canonicalScope = buildScopeRef({
    agentId: parsed.agentId,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    ...(parsed.roleName ? { roleName: parsed.roleName } : {}),
  })
  return `${canonicalScope}#${laneRef}`
}

/**
 * Derive the full headless-viewer session identity (T-06321): the tab grouping
 * (unchanged from T-05237) plus the canonical pane key and normalized lane. Lane
 * identity is threaded from the caller rather than reconstructed/defaulted inside
 * the presentation layer; an omitted lane normalizes to `main`.
 */
export function deriveHeadlessSessionIdentity(
  scopeRef: string,
  laneRef?: string | undefined
): HeadlessSessionIdentity {
  const parsed = safeParseScopeRef(scopeRef)
  const tab = deriveHeadlessTabIdentity(scopeRef)
  const lane = normalizeLaneRef(laneRef)
  return {
    tab,
    paneKey: deriveHeadlessPaneKey(parsed, lane, scopeRef),
    laneRef: lane,
    ...(parsed?.roleName ? { roleName: parsed.roleName } : {}),
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

/**
 * Where a viewer tab for a window key gets created (T-07121).
 *
 * - `managed`: a first-class window resolved by `find-or-create-by` — new tabs
 *   use `new --tab --window-id`, and `windowId` is the residency fence for
 *   split-target candidates.
 * - `anchor`: the legacy path on an old build — the window's anchor pane is the
 *   `--parent` target and there is no residency fence to apply.
 */
type HeadlessWindowTarget =
  | { kind: 'managed'; windowId: string }
  | { kind: 'anchor'; anchor: GhostmuxSurfaceState }

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

/**
 * A ScriptableGhostty without the first-class windows API answers 404, which
 * ghostmux renders as a distinct capability error (never `window_not_found`). An
 * older ghostmux without the `list-windows`/`--window-id` surface at all fails as
 * an unknown command. Both mean the same thing to HRC: stay on the legacy anchor
 * path (T-07121).
 */
function isWindowsApiUnsupportedError(message: string): boolean {
  return (
    message.toLowerCase().includes('does not support the windows api') ||
    isUnsupportedCommandError(message)
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
    windowId: getString(nested, 'window_id', 'windowId'),
    createdBy: 'ghostmux',
  }
}

/**
 * Parse the WINDOW object answered by `ghostmux new --window [--find-or-create-by]`
 * (T-07121). `id` is a window id — NOT a surface id — and `created` reports
 * whether find-or-create missed. Feeding the window id to a `-t`/`--parent`
 * surface target fails with "Terminal not found"; it is only ever a `--window-id`.
 */
export function parseGhostmuxWindowState(stdout: string): GhostmuxWindowState {
  const parsed = parseJson(stdout)
  const record = isRecord(parsed) ? parsed : {}
  const windowId = getString(record, 'id', 'window_id', 'windowId')
  if (!windowId) {
    throw new Error(`ghostmux command did not return a window id: ${stdout.trim() || '<empty>'}`)
  }
  const terminalIds = Array.isArray(record['terminal_ids'])
    ? record['terminal_ids'].filter((id): id is string => typeof id === 'string')
    : []
  return {
    windowId,
    created: record['created'] === true,
    terminalIds,
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

function metadataIsWindowAnchor(metadata: unknown, windowKey: string): boolean {
  if (!isRecord(metadata) || metadata['hrc_role'] !== HEADLESS_WINDOW_ANCHOR_ROLE) return false
  return metadataWindowKey(metadata) === windowKey
}

/**
 * Window-FENCED tab membership (T-07118). Tab identity is the composite
 * `(windowKey, tabKey)` pair: a console-keyed pane must never find (and split
 * into) a same-tabKey pane living in the default window.
 */
function metadataIsAgentPaneForTab(metadata: unknown, windowKey: string, tabKey: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) return false
  if (metadata['hrc_tab_key'] !== tabKey) return false
  return metadataWindowKey(metadata) === windowKey
}

/**
 * Pane identity stays GLOBAL (unchanged, daedalus): at most one live viewer
 * pane per HRC session, so reuse wins over placement — a hinted respawn rebinds
 * the existing pane rather than minting a second brain's window.
 */
function metadataIsAgentPaneWithKey(metadata: unknown, tabKey: string, paneKey: string): boolean {
  if (!isRecord(metadata)) return false
  if (metadata['hrc_role'] !== HEADLESS_AGENT_PANE_ROLE) return false
  if (metadata['hrc_tab_key'] !== tabKey) return false
  return metadata['hrc_pane_key'] === paneKey
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
   * Windows-API capability, probed at most once per daemon process (T-07121).
   * `undefined` until a DEFINITIVE answer is seen; a transient probe failure
   * (socket down, timeout) is never memoized, it just takes the legacy path for
   * that call and re-probes later.
   */
  private windowsApiSupported: boolean | undefined
  /** In-flight probe, so concurrent first dispatches issue exactly one. */
  private windowsApiProbe: Promise<boolean> | undefined
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
    private readonly runner?: GhostmuxRunner | undefined,
    commandTimeoutMs = DEFAULT_GHOSTMUX_COMMAND_TIMEOUT_MS
  ) {
    this.commandTimeoutMs = Math.max(1, Math.trunc(commandTimeoutMs))
  }

  private readonly commandTimeoutMs: number

  async initialize(): Promise<void> {
    await this.exec(['status', '--json'])
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
   * one pane per canonical `hrc_pane_key`, the normalized `(scopeRef, laneRef)` HRC
   * session identity (T-05237, T-06321). Same-agent tester/implementer/observer
   * seats — or distinct lanes — on one task therefore get distinct panes in the same
   * task tab. Replaces the prior one-standalone-window-per-scope model that
   * proliferated windows and exhausted the pty pool. Reuse rebinds the pane's
   * `hrc_runtime_id` to the CURRENT runtime (daedalus C5) BEFORE the caller's
   * lifecycle projection can target it. Never throws: any ghostmux failure is
   * surfaced as { status: 'failed' } so the caller logs and continues headless.
   *
   * Topology authority is Ghostty metadata ONLY (daedalus invariant): titles, tab
   * labels, cwd, and focus are presentation and are never read for decisions.
   */
  async ensureHeadlessViewer(options: {
    scopeRef: string
    /**
     * HRC lane ref for this session (`main` or `lane:<id>`). Threaded from the
     * runtime rather than defaulted here so distinct lanes get distinct panes
     * (T-06321). Omitted/undefined normalizes to `main`.
     */
    laneRef?: string | undefined
    runtimeId: string
    attachCommand: string
    /**
     * Optional explicit pane-title override; default is `<label> · <agent>`, plus
     * ` · <role>` for a role-qualified scope.
     */
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
    /**
     * Optional window placement key (T-07118). Absent/empty ⇒ the implicit
     * default key, i.e. today's single "Headless Sessions" window.
     */
    windowKey?: string | undefined
  }): Promise<HeadlessViewerResult> {
    const identity = deriveHeadlessSessionIdentity(options.scopeRef, options.laneRef)
    const tab = identity.tab
    const windowKey = normalizeWindowKey(options.windowKey)
    const baseTitle = `${tab.label} · ${tab.agentId}`
    const paneTitle =
      options.title ?? (identity.roleName ? `${baseTitle} · ${identity.roleName}` : baseTitle)
    // Serialize per COMPOSITE tab key `(windowKey, tabKey)` (T-07118): concurrent
    // same-task dispatches must not both miss-then-create a duplicate tab, and two
    // differently-keyed windows must not serialize against each other. The critical
    // section re-checks live metadata AFTER acquiring the lock (daedalus concurrency
    // condition). Distinct panes within one tab still serialize under this key, which
    // is correct: the first create makes the tab, later ones split the existing pane.
    return this.withHeadlessLock(`tab:${windowKey}:${tab.tabKey}`, async () => {
      try {
        const existing = await this.findAgentPaneByKey(tab.tabKey, identity.paneKey)
        if (existing) {
          // Reuse: rebind the pane to the CURRENT runtime (daedalus C5) so a stale
          // terminal event for a prior runtime cannot reap this pane, then repaint.
          // Pane lookup is deliberately GLOBAL: reuse wins over placement, so a
          // newly-hinted respawn adopts the live pane wherever it already lives.
          await this.stampAgentPaneMetadata(existing.surfaceId, identity, {
            scopeRef: options.scopeRef,
            runtimeId: options.runtimeId,
            windowKey,
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
            tabKey: tab.tabKey,
          }
        }

        // ORDER IS MANDATORY (T-07121, daedalus #17988): find-or-create the keyed
        // window FIRST, then evaluate split-target candidates against the window it
        // returned. Reversing it re-admits the stale-key hazard the residency fence
        // exists to close.
        const target = await this.ensureHeadlessWindow(windowKey)
        // An existing pane for this composite `(windowKey, tabKey)` identity is a
        // valid split target — any live pane in that tab puts the new pane in the
        // same Ghostty tab. The window fence is what keeps a console-keyed pane
        // from splitting into a same-tabKey tab in the default window; on the
        // managed path the RESIDENCY fence additionally rejects a pane that wears
        // the right key but physically lives in another window.
        const tabPane = await this.findTaskTab(
          windowKey,
          tab.tabKey,
          target.kind === 'managed' ? target.windowId : undefined
        )

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
              : (await this.exec(this.newTabArgs(target, paneTitle))).stdout
          )
        )
        await this.stampAgentPaneMetadata(created.surfaceId, identity, {
          scopeRef: options.scopeRef,
          runtimeId: options.runtimeId,
          windowKey,
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
        return { status: 'created' as const, surfaceId: created.surfaceId, tabKey: tab.tabKey }
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
      const windowKey = metadataWindowKey(metadata)
      await this.terminate(surfaceId)
      // After the kill, did any sibling agent pane for this COMPOSITE tab survive?
      let tabCollapsed = false
      if (tabKey) {
        const sibling = await this.findTaskTab(windowKey, tabKey).catch(() => null)
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

  /** Argv for a fresh viewer tab in the keyed window (T-07121). */
  private newTabArgs(target: HeadlessWindowTarget, paneTitle: string): string[] {
    const placement =
      target.kind === 'managed'
        ? ['--window-id', target.windowId]
        : ['--parent', target.anchor.surfaceId]
    return ['new', '--tab', ...placement, '--title', paneTitle, '--json']
  }

  /**
   * Whether this ScriptableGhostty serves the first-class windows API (T-07121).
   * Probed at most once per daemon process with the cheapest read on the surface
   * (`list-windows`); a 404 / unknown-command answer memoizes the capability OFF
   * and every keyed-window call stays on the legacy anchor path forever after.
   */
  private async supportsWindowsApi(): Promise<boolean> {
    if (this.windowsApiSupported !== undefined) return this.windowsApiSupported
    this.windowsApiProbe ??= this.probeWindowsApi()
    const supported = await this.windowsApiProbe
    // A transient failure left the capability undecided — drop the memoized probe
    // so the next dispatch asks again rather than being pinned to legacy.
    if (this.windowsApiSupported === undefined) this.windowsApiProbe = undefined
    return supported
  }

  private async probeWindowsApi(): Promise<boolean> {
    try {
      await this.exec(['list-windows', '--json'])
      this.windowsApiSupported = true
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isWindowsApiUnsupportedError(message)) {
        this.windowsApiSupported = false
        return false
      }
      return false
    }
  }

  /**
   * Resolve the keyed window to place viewer tabs in.
   *
   * On a windows-API build this is ONE atomic call: `new --window
   * --find-or-create-by '{"hrc_window_key": <key>}'`. A hit returns the oldest
   * matching window with its metadata untouched; a miss creates one carrying the
   * key. Because the server is the arbiter, no HRC-side window lock is needed —
   * concurrent dispatches for different tab keys in one window converge on the
   * same window id. Legacy builds keep the locked anchor find-or-create.
   */
  private async ensureHeadlessWindow(windowKey: string): Promise<HeadlessWindowTarget> {
    if (await this.supportsWindowsApi()) {
      try {
        const window = await this.withGhostmuxBackoff(async () =>
          parseGhostmuxWindowState(
            (
              await this.exec([
                'new',
                '--window',
                '--find-or-create-by',
                JSON.stringify({ hrc_window_key: windowKey }),
                '--metadata',
                JSON.stringify({
                  hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE,
                  hrc_window_key: windowKey,
                }),
                '--title',
                headlessWindowTitle(windowKey),
                '--json',
              ])
            ).stdout
          )
        )
        return { kind: 'managed', windowId: window.windowId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // The build changed under a live daemon (Ghostty downgraded/restarted old).
        // Re-memoize OFF and fall through to legacy rather than failing the viewer.
        if (!isWindowsApiUnsupportedError(message)) throw error
        this.windowsApiSupported = false
      }
    }
    return { kind: 'anchor', anchor: await this.ensureLegacyWindowAnchor(windowKey) }
  }

  /**
   * LEGACY (pre-windows-API builds only): find-or-create the keyed "Headless
   * Sessions" window by its anchor surface — the stable `--parent` target for new
   * task tabs. The anchor is non-runtime-owned and is never reaped. Serialized on
   * a shared window lock so two concurrent first-dispatches cannot create two
   * windows; the managed path needs no such lock because find-or-create is atomic.
   */
  private ensureLegacyWindowAnchor(windowKey: string): Promise<GhostmuxSurfaceState> {
    return this.withHeadlessLock(`window:${windowKey}`, async () => {
      const existing = await this.findWindowAnchor(windowKey)
      if (existing) return existing
      const created = await this.withGhostmuxBackoff(async () =>
        this.resolveCreatedWindowAnchor(
          (
            await this.exec([
              'new',
              '--window',
              '--title',
              headlessWindowTitle(windowKey),
              '--json',
            ])
          ).stdout
        )
      )
      // Surface-level role identifies the anchor pane; window-level role marks the
      // whole window. Both carry the window key so a later find-or-create resolves
      // the SAME keyed window (T-07118). Both best-effort.
      await this.setMetadata(
        created.surfaceId,
        { hrc_role: HEADLESS_WINDOW_ANCHOR_ROLE, hrc_window_key: windowKey },
        false
      ).catch(() => undefined)
      await this.setMetadata(
        created.surfaceId,
        { hrc_role: HEADLESS_SESSIONS_WINDOW_ROLE, hrc_window_key: windowKey },
        true
      ).catch(() => undefined)
      return created
    })
  }

  /**
   * Resolve the anchor SURFACE of a just-created window.
   *
   * `ghostmux new --window --json` answers with a WINDOW object, not a surface:
   * its `id` is a window id and the real anchor surface is `terminal_ids[0]`.
   * (`new --tab` and `new-pane` both answer with surfaces — this shape is unique
   * to `--window`.) Feeding that window id back as a `-t`/`--parent` target fails
   * with "Terminal not found", so every viewer placed into a freshly created
   * window silently failed. Latent before T-07118 because the one global window
   * effectively always pre-existed; routine now that any new window key must
   * create its window. Caught by the live smoke, not by any unit test.
   *
   * Falls back to the old surface-shaped parse so an older ghostmux that really
   * does answer with a surface keeps working.
   */
  private async resolveCreatedWindowAnchor(stdout: string): Promise<GhostmuxSurfaceState> {
    const parsed = parseJson(stdout)
    const record = isRecord(parsed) ? parsed : {}
    const terminalIds = record['terminal_ids']
    const anchorId =
      Array.isArray(terminalIds) && typeof terminalIds[0] === 'string' && terminalIds[0].length > 0
        ? terminalIds[0]
        : parseGhostmuxSurfaceState(stdout).surfaceId
    // Re-read the live surface so split-direction sizing sees real dimensions.
    const live = await this.inspectSurface(anchorId).catch(() => null)
    return live ?? { kind: 'ghostty', surfaceId: anchorId, createdBy: 'ghostmux' }
  }

  private async findWindowAnchor(windowKey: string): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsWindowAnchor(metadata, windowKey)) return surface
    }
    return null
  }

  /**
   * Any live agent pane sharing this COMPOSITE `(windowKey, tabKey)` identity — a
   * valid split target for that tab in that window (T-07118).
   *
   * RESIDENCY FENCE (T-07121, daedalus #17988): when `residentWindowId` is given
   * (the managed window find-or-create just returned), a candidate must ALSO
   * physically live in that window. After an upstream managed+managed hand-merge
   * the losing registry entry dissolves but its PANES survive inside the winner
   * still wearing the old `hrc_window_key`; metadata alone would send the next
   * hinted session splitting into that stale tab in the wrong window while the
   * freshly created keyed window sat empty. Residency is read from the
   * first-class `window_id`, never cached — a dragged tab changes it. A candidate
   * whose residency cannot be read fails the fence, and the stale metadata is
   * left in place: it is inert, because pane reuse is keyed on `hrc_pane_key`.
   */
  private async findTaskTab(
    windowKey: string,
    tabKey: string,
    residentWindowId?: string | undefined
  ): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      if (residentWindowId !== undefined && surface.windowId !== residentWindowId) continue
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsAgentPaneForTab(metadata, windowKey, tabKey)) return surface
    }
    return null
  }

  /** The live agent pane for `(tabKey, paneKey)`, if one exists (T-06321). */
  private async findAgentPaneByKey(
    tabKey: string,
    paneKey: string
  ): Promise<GhostmuxSurfaceState | null> {
    const surfaces = parseGhostmuxSurfaceList((await this.exec(['list-surfaces', '--json'])).stdout)
    for (const surface of surfaces) {
      const metadata = await this.getMetadata(surface.surfaceId, false).catch(() => undefined)
      if (metadataIsAgentPaneWithKey(metadata, tabKey, paneKey)) return surface
    }
    return null
  }

  /**
   * Stamp/refresh the canonical agent-pane metadata (surface-level). The uniqueness
   * authority is `hrc_pane_key` (normalized `(scopeRef, laneRef)`); `hrc_window_key`
   * + `hrc_tab_key` are the composite TAB grouping authority (T-07118); `hrc_agent_id`
   * and `hrc_role_name` are presentation/diagnosis metadata. Also records the exact
   * session identity (scope/lane/role) and the current runtime binding (T-06321).
   */
  private async stampAgentPaneMetadata(
    surfaceId: string,
    identity: HeadlessSessionIdentity,
    binding: { scopeRef: string; runtimeId: string; windowKey: string }
  ): Promise<void> {
    const tab = identity.tab
    await this.setMetadata(
      surfaceId,
      {
        hrc_role: HEADLESS_AGENT_PANE_ROLE,
        hrc_window_key: binding.windowKey,
        hrc_tab_key: tab.tabKey,
        hrc_pane_key: identity.paneKey,
        hrc_agent_id: tab.agentId,
        hrc_lane_ref: identity.laneRef,
        ...(identity.roleName ? { hrc_role_name: identity.roleName } : {}),
        ...(tab.projectId ? { hrc_project: tab.projectId } : {}),
        ...(tab.taskId ? { hrc_task_id: tab.taskId } : {}),
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
      return await this.withCommandTimeout(args, this.runner(args))
    }

    const proc = Bun.spawn([this.ghostmuxBinary, ...args], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = new Response(proc.stdout).text()
    const stderr = new Response(proc.stderr).text()
    const exitCode = this.withCommandTimeout(args, proc.exited, async () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // The process may have exited concurrently with the deadline.
      }
      await proc.exited.catch(() => undefined)
    })
    const [renderedStdout, renderedStderr, renderedExitCode] = await Promise.all([
      stdout,
      stderr,
      exitCode,
    ])

    if (renderedExitCode !== 0) {
      const rendered =
        renderedStderr.trim() ||
        renderedStdout.trim() ||
        `ghostmux exited with status ${renderedExitCode}`
      throw new Error(rendered)
    }

    return { stdout: renderedStdout, stderr: renderedStderr }
  }

  private withCommandTimeout<T>(
    args: string[],
    operation: Promise<T>,
    onTimeout?: (() => void | Promise<void>) | undefined
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void Promise.resolve()
          .then(() => onTimeout?.())
          .catch(() => undefined)
          .finally(() => {
            // The timeout is authoritative. Cleanup errors and a concurrent
            // process exit must never replace the typed deadline failure.
            reject(new GhostmuxCommandTimeoutError(args, this.commandTimeoutMs))
          })
      }, this.commandTimeoutMs)
      operation.then(
        (value) => {
          if (timedOut) return
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          if (timedOut) return
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }
}

export function createGhostmuxManager(options: GhostmuxManagerOptions = {}): GhostmuxManager {
  return new GhostmuxManager(options.ghostmuxBin, options.runner, options.commandTimeoutMs)
}
