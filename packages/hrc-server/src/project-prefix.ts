/**
 * Short project prefixes for headless-viewer presentation (T-05237).
 *
 * The full projectId is too wide for a Ghostty tab label or the status-bar
 * center field, so every project gets a compact prefix. Presentation only — the
 * canonical `hrc_tab_key` and all topology authority use the FULL projectId; this
 * map only shortens what humans read.
 *
 * The curated map always wins; unknown projects (ASP-only spaces, P-id projects)
 * fall back to a deterministic derivation so a new project still renders sanely.
 */
const PROJECT_PREFIXES: Readonly<Record<string, string>> = {
  'agent-control-plane': 'acp',
  'agent-spaces': 'asp',
  'hrc-runtime': 'hrc',
  'agent-loop': 'loop',
  agents: 'agents',
  archagent: 'arch',
  capture: 'cap',
  'control-plane': 'cpl',
  'dnd-friends': 'dnd',
  explainer: 'exp',
  ghostmux: 'gmx',
  jobhunt: 'job',
  'media-ingest': 'ingest',
  praesidium: 'prs',
  'project-util': 'pju',
  rex: 'rex',
  safoundry: 'safoundry',
  'semantic-capabilities': 'scp',
  taskboard: 'board',
  wrkq: 'wrkq',
  'zed-rpc': 'zrp',
  zedctl: 'zed',
}

/**
 * Deterministic fallback for a projectId not in the curated map:
 * - `P-00223` (and other `P-<digits>` ids) → `p223` (letter + trailing digits)
 * - hyphenated slug → initials of each part (`voice-control` → `vc`)
 * - single word → first 3 chars (`knowledge` → `kno`)
 */
function deriveProjectPrefix(projectId: string): string {
  const trimmed = projectId.trim()
  if (!trimmed) return 'proj'
  const pid = /^P-?0*(\d+)$/i.exec(trimmed)
  if (pid) return `p${pid[1]}`
  const parts = trimmed.split(/[-_]/).filter(Boolean)
  if (parts.length > 1) {
    return parts
      .map((p) => p[0] ?? '')
      .join('')
      .toLowerCase()
  }
  return trimmed.slice(0, 3).toLowerCase()
}

/** Short, human-readable prefix for a projectId (curated map, else derived). */
export function shortenProjectId(projectId: string | undefined): string {
  if (!projectId) return ''
  return PROJECT_PREFIXES[projectId] ?? deriveProjectPrefix(projectId)
}
