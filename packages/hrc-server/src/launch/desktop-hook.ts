/**
 * The desktop registration hook helper (T-08294 §4).
 *
 * Runs inside the desktop app's own hook execution, so it is the only thing in
 * the system that observes desktop's real Codex home and thread id first-hand.
 * Three properties are contractual and each one is a failure mode if dropped:
 *
 *  - **Bounded.** It sits in front of a turn Lance is waiting on. A daemon that
 *    is down, restarting or slow must cost a fixed, small delay — never the
 *    turn. Hence {@link DEFAULT_CALLBACK_TIMEOUT_MS} and a hard abort.
 *  - **Spools.** A registration that could not be delivered is written to the
 *    existing launch spool rather than dropped, so the daemon reconciles it
 *    instead of waiting for the conversation to be touched again.
 *  - **Reuses, never mints.** On any failure the helper falls back to the
 *    PREVIOUSLY ESTABLISHED cache for this thread. It never invents a friendly
 *    name locally: the cache is a projection of HRC's allocation, not a second
 *    allocator, and a locally minted name would be a second permanent address
 *    for one conversation. With no cache and no daemon the answer is
 *    `integration_pending`, which the managed hook reports as-is while keeping
 *    its existing UUID-style behavior.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'

export const DESKTOP_REGISTRATION_ENDPOINT = '/v1/internal/desktop/register'
export const DEFAULT_CALLBACK_TIMEOUT_MS = 1_500

/** The hook payload Codex writes to stdin for SessionStart / UserPromptSubmit. */
export type DesktopHookInput = {
  readonly session_id?: unknown
  readonly transcript_path?: unknown
  readonly cwd?: unknown
  readonly source?: unknown
}

export type DesktopScopeCacheEntry = {
  readonly scopeRef: string
  readonly agentId: string
  readonly projectId: string
  readonly slotToken: string
  readonly laneRef: string
  readonly hostSessionId: string
  readonly nativeThreadId: string
  readonly homeIdentity: string
  readonly projectRoot: string
  readonly registeredAt: string
  /** When this projection was last written locally. Never an allocation input. */
  readonly cachedAt: string
}

export type DesktopHookResult =
  | {
      readonly status: 'registered'
      readonly cache: DesktopScopeCacheEntry
      readonly source: 'hrc' | 'cache'
    }
  | { readonly status: 'integration_pending'; readonly reason: string; readonly detail: string }

/** `<codexHome>/hrc-desktop-scopes/<threadId>.json`, overridable for tests. */
export function desktopScopeCachePath(
  codexHome: string,
  nativeThreadId: string,
  overrideDir?: string | undefined
): string {
  const dir = overrideDir ?? join(codexHome, 'hrc-desktop-scopes')
  return join(resolve(dir), `${nativeThreadId}.json`)
}

export async function readDesktopScopeCache(
  path: string
): Promise<DesktopScopeCacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const entry = parsed as Record<string, unknown>
    return typeof entry['scopeRef'] === 'string' && typeof entry['nativeThreadId'] === 'string'
      ? (entry as unknown as DesktopScopeCacheEntry)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the cache atomically. A hook that dies mid-write must not leave a
 * truncated projection behind — the next run would read it as "no cache" at
 * best and as a corrupt scope at worst.
 */
export async function writeDesktopScopeCache(
  path: string,
  entry: DesktopScopeCacheEntry
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await rename(temp, path)
}

export type DesktopRegistrationPost = {
  readonly ok: boolean
  readonly body?: unknown
}

/**
 * POST the registration with a hard deadline.
 *
 * `launch/callback-client.ts` deliberately has no timeout — its callers are the
 * launch wrapper's own lifecycle events, where blocking is correct. This path
 * is in front of a human's turn, so it needs one, and it needs the response
 * BODY (the scope projection) rather than just a delivered/undelivered boolean.
 */
export function postDesktopRegistration(
  socketPath: string,
  payload: object,
  timeoutMs: number = DEFAULT_CALLBACK_TIMEOUT_MS
): Promise<DesktopRegistrationPost> {
  return new Promise((resolvePromise) => {
    const body = JSON.stringify(payload)
    let settled = false
    const settle = (result: DesktopRegistrationPost): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const req = request(
      {
        socketPath,
        path: DESKTOP_REGISTRATION_ENDPOINT,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
          try {
            settle({ ok, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) })
          } catch {
            settle({ ok: false })
          }
        })
      }
    )
    const timer = setTimeout(() => {
      req.destroy()
      settle({ ok: false })
    }, timeoutMs)
    timer.unref?.()
    req.on('close', () => clearTimeout(timer))
    req.on('error', () => settle({ ok: false }))
    req.write(body)
    req.end()
  })
}

/**
 * Turn a daemon response (or its absence) into the helper's answer.
 *
 * Split out from the CLI so the fallback ORDER is testable without a socket:
 * a fresh `registered` beats the cache, the cache beats a pending/failed
 * response, and nothing ever synthesizes a scope.
 */
export function resolveDesktopHookResult(input: {
  readonly response?: unknown
  readonly cached?: DesktopScopeCacheEntry | undefined
  readonly now: string
}): DesktopHookResult {
  const response = input.response
  if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>
    if (record['status'] === 'registered') {
      const cache = record['cache']
      if (cache !== null && typeof cache === 'object' && !Array.isArray(cache)) {
        const projection = cache as Record<string, unknown>
        if (typeof projection['scopeRef'] === 'string') {
          return {
            status: 'registered',
            source: 'hrc',
            cache: { ...(projection as unknown as DesktopScopeCacheEntry), cachedAt: input.now },
          }
        }
      }
    }
    if (record['status'] === 'pending' && input.cached === undefined) {
      return {
        status: 'integration_pending',
        reason: typeof record['reason'] === 'string' ? record['reason'] : 'pending',
        detail: typeof record['detail'] === 'string' ? record['detail'] : '',
      }
    }
  }
  if (input.cached !== undefined) {
    // An ESTABLISHED cache outlives a daemon outage AND a transient pending
    // answer. Contract §4: hooks "can use a previously established cache".
    return { status: 'registered', source: 'cache', cache: input.cached }
  }
  return {
    status: 'integration_pending',
    reason: 'hrc_unreachable',
    detail: 'no registration response and no established scope cache for this thread',
  }
}
