/**
 * Task-id grammar (wrkq named subtasks, `docs/named-subtasks-proposal.md` rev 5,
 * *ID grammar*). The one TypeScript definition: ACP and taskboard import or
 * mirror it against `hrc-core/fixtures/task-id-grammar.json`.
 *
 * ```text
 * task-id      = base-id | subtask-id
 * base-id      = "T-" 5DIGIT
 * subtask-id   = base-id "." subtask-slug
 * subtask-slug = %x61-7A *( %x61-7A / DIGIT / "-" ) ( %x61-7A / DIGIT )
 * ```
 *
 * The whole id is at most 64 characters (the scope token limit).
 */

export const TASK_ID_MAX_LENGTH = 64

const BASE_ID_SOURCE = 'T-\\d{5}'
const SUBTASK_SLUG_SOURCE = '[a-z](?:[a-z0-9-]*[a-z0-9])?'

const TASK_ID_ANCHORED = new RegExp(`^(${BASE_ID_SOURCE})(?:\\.(${SUBTASK_SLUG_SOURCE}))?$`)

/**
 * Prose matcher: `see T-12345.` (sentence end) and `T-12345.Next` read as the
 * owner, `T-12345.render-preview` as the subtask. Global; clone before reuse.
 */
export const TASK_ID_PROSE_PATTERN_SOURCE = `\\b${BASE_ID_SOURCE}(?:\\.${SUBTASK_SLUG_SOURCE})?\\b`

export type ParsedTaskId = {
  /** The full id: the owner id for a task, the composite id for a subtask. */
  id: string
  /** The owning task id (`T-12345`); equals `id` for an ordinary task. */
  ownerId: string
  /** Present only for a subtask id. */
  slug?: string
}

/** Parse an exact task or subtask id; `undefined` for anything else. */
export function parseTaskId(value: string): ParsedTaskId | undefined {
  if (value.length > TASK_ID_MAX_LENGTH) return undefined
  const match = TASK_ID_ANCHORED.exec(value)
  if (!match) return undefined
  const ownerId = match[1] as string
  const slug = match[2]
  return slug === undefined ? { id: value, ownerId } : { id: value, ownerId, slug }
}

export function isTaskId(value: string): boolean {
  return parseTaskId(value) !== undefined
}

/** The owner of an exact task or subtask id; `undefined` when `value` is neither. */
export function taskOwnerId(value: string): string | undefined {
  return parseTaskId(value)?.ownerId
}

/**
 * Task ids mentioned in prose, in order, as written. A match the grammar
 * refuses (over 64 characters) resolves to its owner rather than vanishing.
 */
export function findTaskIds(text: string): string[] {
  return [...text.matchAll(new RegExp(TASK_ID_PROSE_PATTERN_SOURCE, 'g'))].map((match) => {
    const parsed = parseTaskId(match[0])
    return parsed ? parsed.id : match[0].slice(0, match[0].indexOf('.'))
  })
}

/**
 * Owner task ids named in a branch name or worktree path — today's worktree
 * matching, deliberately owner-only: subtasks never get their own worktree in
 * v1, so a `T-12345.slug` token in a branch or path reads as `T-12345`. The
 * digit-run edges (not word boundaries) are historical and tolerate `work/XT-…Z`.
 */
export function ownerTaskTokens(value: string): string[] {
  return [...value.matchAll(/(?<!\d)T-\d+(?!\d)/g)].map((match) => match[0])
}
