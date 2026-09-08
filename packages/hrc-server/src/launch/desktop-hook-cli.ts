/**
 * Entrypoint for the desktop registration hook helper.
 *
 * Contract with whatever invokes it (the managed overlay hook — wired in the
 * downstream cutover task, not here):
 *   stdin  — the Codex hook JSON (`session_id`, `transcript_path`, `cwd`, `source`)
 *   stdout — one JSON line: `{"status":"registered",…}` or
 *            `{"status":"integration_pending","reason":…,"detail":…}`
 *   exit   — ALWAYS 0 for a well-formed hook payload.
 *
 * The exit code matters. `integration_pending` is a normal, expected state
 * (guardian thread, rollout not yet persisted, project unresolved, daemon
 * restarting), and a nonzero exit would turn each of those into a broken hook in
 * front of a turn Lance is waiting on. Only a payload this helper cannot parse
 * at all is an error.
 */

import { homedir } from 'node:os'

import {
  DESKTOP_REGISTRATION_ENDPOINT,
  type DesktopHookResult,
  desktopScopeCachePath,
  postDesktopRegistration,
  readDesktopScopeCache,
  resolveDesktopHookResult,
  writeDesktopScopeCache,
} from './desktop-hook.js'
import { spoolCallback } from './spool.js'

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  let hookData: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hook payload must be an object')
    }
    hookData = parsed as Record<string, unknown>
  } catch (error) {
    process.stderr.write(`hrc-desktop-hook: invalid hook payload: ${String(error)}\n`)
    process.exit(1)
  }

  const nativeThreadId =
    typeof hookData['session_id'] === 'string' ? hookData['session_id'] : undefined
  if (nativeThreadId === undefined) {
    emit({
      status: 'integration_pending',
      reason: 'no_thread_id',
      detail: 'hook payload carried no session_id',
    })
    return
  }
  const rolloutPath =
    typeof hookData['transcript_path'] === 'string' ? hookData['transcript_path'] : undefined
  const workspaceCwd = typeof hookData['cwd'] === 'string' ? hookData['cwd'] : undefined
  const hookSource = typeof hookData['source'] === 'string' ? hookData['source'] : undefined

  const codexHome = process.env['CODEX_HOME'] ?? `${process.env['HOME'] ?? homedir()}/.codex`
  const cachePath = desktopScopeCachePath(
    codexHome,
    nativeThreadId,
    process.env['HRC_DESKTOP_CACHE_DIR']
  )
  const cached = await readDesktopScopeCache(cachePath)

  const socketPath = process.env['HRC_CALLBACK_SOCKET']
  const payload = {
    nativeThreadId,
    codexHome,
    ...(rolloutPath === undefined ? {} : { rolloutPath }),
    ...(workspaceCwd === undefined ? {} : { workspaceCwd }),
    ...(hookSource === undefined ? {} : { hookSource }),
    ...(process.env['HRC_DESKTOP_BUNDLE'] === undefined
      ? {}
      : { bundleExecutable: process.env['HRC_DESKTOP_BUNDLE'] }),
  }

  const posted =
    socketPath === undefined ? { ok: false } : await postDesktopRegistration(socketPath, payload)

  const result = resolveDesktopHookResult({
    ...(posted.body === undefined ? {} : { response: posted.body }),
    cached,
    now: new Date().toISOString(),
  })

  if (result.status === 'registered' && result.source === 'hrc') {
    // Best effort: a cache we could not write costs one extra callback next
    // time, never a second allocation — the daemon's mapping is authoritative.
    await writeDesktopScopeCache(cachePath, result.cache).catch(() => undefined)
  }

  // Spool an undelivered registration so the daemon reconciles it rather than
  // waiting for Lance to touch this conversation again.
  const spoolDir = process.env['HRC_SPOOL_DIR']
  if (!posted.ok && spoolDir !== undefined) {
    await spoolCallback(spoolDir, `desktop-${nativeThreadId}`, {
      endpoint: DESKTOP_REGISTRATION_ENDPOINT,
      payload,
    }).catch(() => undefined)
  }

  emit(result)
}

function emit(result: DesktopHookResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`hrc-desktop-hook error: ${String(error)}\n`)
  process.exit(1)
})
