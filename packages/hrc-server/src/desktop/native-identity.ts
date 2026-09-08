/**
 * Canonical native identity for a Codex DESKTOP conversation (T-08294 §4).
 *
 * The registration key is `(local desktop installation/home identity, native
 * thread UUID)` and NOTHING else. Everything a desktop conversation can change
 * while staying the same conversation — bundle version, title, workspace cwd,
 * which observer is attached — is deliberately excluded here. If any of those
 * leaked into identity, a thread that was renamed or reopened elsewhere would
 * register a SECOND time and be handed a second permanent address, which is the
 * exact failure the permanent-address requirement exists to prevent.
 *
 * Everything in this module reads the native evidence only. No ambient env is
 * consulted: `ASP_PROJECT` / `ASP_SCOPE_REF` inherited by whatever process
 * happens to call us are precisely how T-07514 put a desktop thread for
 * `clients/hrc-ios` under `project:praesidium`.
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/** The one persona desktop conversations may register as (contract §1: Stella only). */
export const DESKTOP_AGENT_ID = 'stella'

/** The one lane a desktop conversation occupies. */
export const DESKTOP_LANE_REF = 'main'

/**
 * Codex rollout session ids are UUIDs (v7 in the observed corpus). Accepting a
 * looser shape would let a caller register an arbitrary string as a "thread"
 * and burn a permanent readable name on it.
 */
const NATIVE_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isNativeThreadId(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_THREAD_ID.test(value)
}

/**
 * Canonicalize a filesystem path for identity use: absolute, symlink-resolved,
 * normalized.
 *
 * Symlink resolution is not cosmetic. `~/praesidium/hrc-ios` is a symlink to
 * `~/praesidium/clients/hrc-ios` on the observed host, and the desktop app and
 * the wrkq registry name that directory differently. Two spellings of one home
 * would be two identities and therefore two permanent addresses for one
 * conversation.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    // A path that does not exist yet still has a stable canonical spelling.
    return absolute
  }
}

/** True when `child` is `parent` or lives beneath it, on canonical paths. */
export function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

export type DesktopHomeIdentity = {
  /** Canonical Codex home — the local desktop installation identity. */
  readonly homeIdentity: string
  /**
   * Effective canonical SQLite home. Equal to `homeIdentity` in the ordinary
   * case; kept separate because §4 requires helpers to use the same storage
   * resolution desktop uses, and a divergence must be visible rather than
   * assumed away.
   */
  readonly sqliteHome: string
}

/**
 * Resolve the desktop installation identity.
 *
 * Order is deliberate: an explicit home reported by the helper wins, because the
 * helper runs inside desktop's own process tree and therefore knows the home
 * desktop actually opened. Falling back to the rollout path is the only other
 * evidence that comes from desktop itself — a rollout lives at
 * `<codexHome>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, so the home is four
 * levels up. `HOME`-derived `~/.codex` is the LAST resort and is flagged, since
 * it is an inference about the caller rather than an observation of desktop.
 */
export function resolveDesktopHomeIdentity(input: {
  readonly codexHome?: string | undefined
  readonly sqliteHome?: string | undefined
  readonly rolloutPath?: string | undefined
  readonly homeDir?: string | undefined
}): DesktopHomeIdentity | { readonly unresolved: string } {
  const explicit = input.codexHome?.trim()
  const fromRollout =
    explicit === undefined || explicit.length === 0
      ? codexHomeFromRolloutPath(input.rolloutPath)
      : undefined
  const fromHomeDir =
    explicit === undefined || explicit.length === 0
      ? fromRollout === undefined && input.homeDir !== undefined
        ? resolve(input.homeDir, '.codex')
        : undefined
      : undefined
  const candidate =
    explicit !== undefined && explicit.length > 0 ? explicit : (fromRollout ?? fromHomeDir)
  if (candidate === undefined || !isAbsolute(candidate)) {
    return { unresolved: 'codex home could not be resolved from helper report or rollout path' }
  }
  const homeIdentity = canonicalPath(candidate)
  const declaredSqliteHome = input.sqliteHome?.trim()
  return {
    homeIdentity,
    sqliteHome:
      declaredSqliteHome !== undefined && declaredSqliteHome.length > 0
        ? canonicalPath(declaredSqliteHome)
        : homeIdentity,
  }
}

/** `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` → `<home>`. */
function codexHomeFromRolloutPath(rolloutPath: string | undefined): string | undefined {
  if (rolloutPath === undefined || rolloutPath.trim().length === 0) return undefined
  const parts = resolve(rolloutPath).split(sep)
  // …/sessions/yyyy/mm/dd/<file> — the home is five segments above the file.
  const sessionsIndex = parts.lastIndexOf('sessions')
  if (sessionsIndex <= 0) return undefined
  return parts.slice(0, sessionsIndex).join(sep) || sep
}

/**
 * The durable primary key. Hashing rather than concatenating keeps the key a
 * fixed-width opaque token, so a home path containing the separator cannot
 * collide with a different (home, thread) pair.
 */
export function desktopRegistrationKey(homeIdentity: string, nativeThreadId: string): string {
  return createHash('sha256')
    .update(homeIdentity, 'utf8')
    .update('\0')
    .update(nativeThreadId.toLowerCase(), 'utf8')
    .digest('hex')
}

/**
 * The first record of a Codex rollout: `{"type":"session_meta","payload":{…}}`.
 *
 * Only the fields registration is allowed to depend on are modelled. `cwd`,
 * `originator`, `source` and `thread_source` are admission and project
 * evidence; `cli_version` is compatibility metadata and is explicitly NOT part
 * of identity (§4).
 */
export type DesktopSessionMeta = {
  readonly sessionId: string
  readonly cwd?: string | undefined
  readonly originator?: string | undefined
  /** A plain string for a top-level conversation; an object for a spawned subagent. */
  readonly source?: unknown
  readonly threadSource?: string | undefined
  readonly cliVersion?: string | undefined
}

export function parseDesktopSessionMeta(firstLine: string): DesktopSessionMeta | undefined {
  let record: unknown
  try {
    record = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const envelope = record as Record<string, unknown>
  if (envelope['type'] !== 'session_meta') return undefined
  const payload = envelope['payload']
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const fields = payload as Record<string, unknown>
  const sessionId = fields['session_id'] ?? fields['id']
  if (!isNativeThreadId(sessionId)) return undefined
  return {
    sessionId,
    ...(typeof fields['cwd'] === 'string' ? { cwd: fields['cwd'] } : {}),
    ...(typeof fields['originator'] === 'string' ? { originator: fields['originator'] } : {}),
    source: fields['source'],
    ...(typeof fields['thread_source'] === 'string'
      ? { threadSource: fields['thread_source'] }
      : {}),
    ...(typeof fields['cli_version'] === 'string' ? { cliVersion: fields['cli_version'] } : {}),
  }
}

export type DesktopThreadAdmission =
  | { readonly admitted: true; readonly meta: DesktopSessionMeta }
  | { readonly admitted: false; readonly reason: string; readonly detail: string }

/**
 * Admit ONLY the main desktop conversation (§4: "accepts only the main desktop
 * conversation (originator/source), excluding guardian and other spawned
 * subagents").
 *
 * The three predicates below were scored against the 400 most recent rollouts in
 * the observed Codex home rather than invented, because a discriminator that
 * cannot fail teaches nobody anything:
 *
 * Scored over the 400 most recent rollouts in `~/.codex/sessions` (2026-09-08):
 *   thread_source='user' + source='vscode' + desktop originator → 44 admitted,
 *     every one a top-level desktop conversation.
 *   `thread_source` alone rejects 344 of the 400: 'subagent' (228),
 *     absent (81 — the `harness-broker` CLI runtimes), 'automation' (20),
 *     'guardian_review' (15). Of the 56 that survive it, 12 are non-desktop
 *     surfaces (`codex_exec` with source `exec`, `codex-tui` with source `cli`).
 *   `source` is independently decisive on the subagent family: all 243
 *     spawned-subagent rollouts carry an OBJECT (`{"subagent":{…}}`) where a
 *     top-level conversation carries the string `"vscode"`, so the TYPE of this
 *     field alone separates the two families even if `thread_source` moves.
 *
 * Desktop spells its originator two ways in that corpus — `Codex Desktop` and
 * `codex_work_desktop` — so the originator test is a case-insensitive substring
 * rather than an equality against one spelling. It still fails CLOSED: a future
 * desktop that renames its originator refuses registration with a nameable
 * reason instead of silently adopting whatever turned up.
 */
export function admitDesktopThread(meta: DesktopSessionMeta): DesktopThreadAdmission {
  if (typeof meta.source !== 'string') {
    return {
      admitted: false,
      reason: 'spawned_subagent',
      detail: `session_meta.source is ${
        meta.source === undefined ? 'absent' : 'an object'
      }; only a top-level desktop conversation carries a string source`,
    }
  }
  if (meta.source !== 'vscode') {
    return {
      admitted: false,
      reason: 'non_desktop_source',
      detail: `session_meta.source is "${meta.source}", not the desktop surface "vscode"`,
    }
  }
  if (meta.threadSource !== 'user') {
    return {
      admitted: false,
      reason: 'non_user_thread',
      detail: `session_meta.thread_source is ${
        meta.threadSource === undefined ? 'absent' : `"${meta.threadSource}"`
      }; only "user" is the main conversation`,
    }
  }
  const originator = meta.originator ?? ''
  if (!originator.toLowerCase().includes('desktop')) {
    return {
      admitted: false,
      reason: 'non_desktop_originator',
      detail: `session_meta.originator is ${
        meta.originator === undefined ? 'absent' : `"${meta.originator}"`
      }; expected a desktop originator`,
    }
  }
  return { admitted: true, meta }
}

/**
 * Archived history is out of scope by contract ("No recursive adoption of
 * archived session history"). A rollout that has been moved into the archive is
 * not a live conversation, and adopting one would mint a permanent address for a
 * thread nobody can reopen.
 */
export function isArchivedRolloutPath(rolloutPath: string, homeIdentity: string): boolean {
  return isSameOrInside(
    canonicalPath(rolloutPath),
    canonicalPath(`${homeIdentity}/archived_sessions`)
  )
}
