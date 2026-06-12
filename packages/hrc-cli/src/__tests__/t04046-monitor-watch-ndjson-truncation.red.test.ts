/**
 * RED test — T-04046: `hrc monitor watch --last N --format ndjson` calls
 * process.exit() before stdout drains, truncating the final line on large payloads.
 *
 * ── Root cause ────────────────────────────────────────────────────────────────
 * `cmdMonitorWatch` (CLI mode) calls `process.exit(exitCode)` immediately after
 * the last `process.stdout.write(largeJsonLine\n)`. When stdout is an OS pipe,
 * write() returns false (the kernel pipe buffer is full; the write is deferred to
 * libuv). process.exit() kills the process before the deferred write completes,
 * so the reader sees a truncated last line. Downstream `jq` exits 5.
 *
 * ── Why drain-seam (not live-integration) ────────────────────────────────────
 * A live subprocess via `Bun.spawn(..., {stdout: 'pipe'})` uses Bun's internal
 * streaming mechanism, NOT the OS pipe. In that context, `process.stdout.write()`
 * returns `true` synchronously even for 300 KB payloads, so process.exit() never
 * races the write. The truncation only manifests on a real OS pipe (shell `|`).
 *
 * The drain-seam test avoids this by injecting a synthetic `process.stdout.write`
 * that returns `false` for large payloads (exactly as a saturated OS pipe does)
 * and records whether `process.exit()` was called while a drain was still pending.
 *
 * ── What makes this RED ───────────────────────────────────────────────────────
 * With the current code:
 *   1. `writer.write(largeEvent)` → `process.stdout.write(200KB)` → returns false
 *      (pending drain count = 1)
 *   2. `writer.flush()` → no-op for ndjson format
 *   3. `runWatch()` returns 0 → `cmdMonitorWatch` calls `process.exit(0)`
 *   4. Our mock detects pendingDrains > 0 and sets `exitCalledWithPendingDrain = true`
 * The assertion `expect(exitCalledWithPendingDrain).toBe(false)` FAILS → RED.
 *
 * After the fix (drain stdout before process.exit), the code must await the 'drain'
 * event (or equivalent) before exiting, so pendingDrains = 0 at process.exit time.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Tests monitor-watch.ts lines 107–122 (the CLI-mode process.exit call sites).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { cmdMonitorWatch } from '../monitor-watch'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A payload with LARGE_CONTENT_CHARS characters produces a serialized JSON line
 * of ~200 KB — well above the 64 KB macOS pipe buffer. The mock stdout.write()
 * returns false for strings longer than LARGE_WRITE_THRESHOLD, simulating what
 * a saturated OS pipe does for writes larger than the kernel buffer.
 */
const LARGE_CONTENT_CHARS = 200_000
const LARGE_WRITE_THRESHOLD = 1_000 // bytes; realistic OS pipes use 64 KB

const SCOPE_REF = 'agent:test:project:t04046-drain-seam'
const HOST_SESSION_ID = 'hs-t04046-drain-01'

// ---------------------------------------------------------------------------
// Test fixture state
// ---------------------------------------------------------------------------

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | null = null

function serverOpts(): HrcServerOptions {
  return { runtimeRoot, stateRoot, socketPath, lockPath, spoolDir, dbPath, tmuxSocketPath }
}

beforeEach(async () => {
  tmpDir = await mkdtemp('/tmp/hrc-t04046-drain-')
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })

  // A live HRC server is required so that buildLiveMonitorState() can connect
  // via discoverSocket() → client.getStatus(). Without it the CLI exits with a
  // connection error before writing any NDJSON lines.
  server = await createHrcServer(serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }

  // Kill any broker-tmux servers that may have been created during the test.
  const socketsToKill = [tmuxSocketPath]
  try {
    const btmuxDir = join(runtimeRoot, 'btmux')
    for (const entry of await readdir(btmuxDir)) {
      if (entry.endsWith('.sock')) socketsToKill.push(join(btmuxDir, entry))
    }
  } catch {
    /* no btmux allocations — fine */
  }
  for (const sock of socketsToKill) {
    const p = Bun.spawn(['tmux', '-S', sock, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await p.exited.catch(() => undefined)
  }

  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Database seeding helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString()
}

/**
 * Insert the session row that hrc_events' foreign-key constraint requires.
 * Must be called once before any seedSmallEvent / seedLargeEvent calls.
 */
function seedSession(): void {
  const db = openHrcDatabase(dbPath)
  try {
    db.sessions.insert({
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: ts(),
      updatedAt: ts(),
      ancestorScopeRefs: [],
    })
  } finally {
    db.close()
  }
}

/** Insert one small event (<1 KB serialized). */
function seedSmallEvent(index: number): void {
  const db = openHrcDatabase(dbPath)
  try {
    db.hrcEvents.append({
      ts: ts(),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.started',
      payload: { index, note: 'small seed event for T-04046' },
    })
  } finally {
    db.close()
  }
}

/**
 * Insert one large event whose serialized JSON line exceeds the OS pipe buffer.
 *
 * The payload mirrors a realistic `turn.message` `message_end` event with a
 * long assistant response — the kind of event reported in T-04046.
 */
function seedLargeEvent(): void {
  const db = openHrcDatabase(dbPath)
  try {
    db.hrcEvents.append({
      ts: ts(),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      category: 'turn',
      eventKind: 'turn.message',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          // 200 000 chars → ~200 KB serialized JSON line, well above the 64 KB
          // macOS pipe buffer. This payload triggers the write-returns-false path.
          content: 'A'.repeat(LARGE_CONTENT_CHARS),
        },
      },
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// CLI exit sentinel (mirrors the pattern used in monitor-watch.test.ts)
// ---------------------------------------------------------------------------

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
    this.name = 'CliExit'
  }
}

// ---------------------------------------------------------------------------
// Drain-seam integration test
// ---------------------------------------------------------------------------

describe('T-04046 [RED] — CLI mode calls process.exit() before stdout drains', () => {
  it('process.exit() is not called while a large stdout write is still pending [RED]', async () => {
    /**
     * STRATEGY: drain-seam test
     *
     * We run cmdMonitorWatch in CLI mode (no deps injection) so that it uses
     * the real `defaultDeps()` path — including `stdout: process.stdout` and
     * the `process.exit()` call sites at monitor-watch.ts:111/117/122.
     *
     * We monkey-patch `process.stdout.write` to return `false` for large chunks
     * (simulating a saturated OS pipe) and track whether `process.exit()` is
     * called while those writes are still pending.
     *
     * RED: the current code calls process.exit() synchronously after the last
     * write without checking the return value or awaiting a 'drain' event, so
     * `pendingDrains > 0` at process.exit() time.
     */

    // Seed: parent session (FK) + 2 small events + 1 large event as the tail.
    seedSession()
    seedSmallEvent(1)
    seedSmallEvent(2)
    seedLargeEvent()

    // ── Instrumented stdout mock ──────────────────────────────────────────
    let pendingDrains = 0
    let exitCalledWithPendingDrain = false

    const origWrite = process.stdout.write.bind(process.stdout)
    const origExit = process.exit
    // Point the CLI's env-driven path resolution at our test server / DB
    const origEnvRuntime = process.env['HRC_RUNTIME_DIR']
    const origEnvState = process.env['HRC_STATE_DIR']

    process.env['HRC_RUNTIME_DIR'] = runtimeRoot
    process.env['HRC_STATE_DIR'] = stateRoot

    /**
     * Slow stdout mock: returns `false` for any chunk larger than
     * LARGE_WRITE_THRESHOLD bytes, exactly as a full OS pipe kernel buffer
     * does. Schedules the drain callback as a macrotask (setImmediate) to
     * ensure it cannot fire before the synchronous process.exit() call.
     */
    process.stdout.write = ((
      chunk: string | ArrayBufferView | ArrayBuffer,
      encodingOrCallback?: unknown,
      callback?: () => void
    ): boolean => {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as ArrayBufferView).toString('utf8')
      const cb =
        typeof encodingOrCallback === 'function' ? (encodingOrCallback as () => void) : callback

      if (text.length > LARGE_WRITE_THRESHOLD) {
        // Simulate a saturated OS pipe: data is queued, returns false.
        pendingDrains++
        setImmediate(() => {
          pendingDrains--
          cb?.()
        })
        return false
      }

      // Small writes complete synchronously.
      cb?.()
      return true
    }) as typeof process.stdout.write

    /**
     * process.exit mock: records whether any writes were still pending at exit
     * time, then throws CliExit so the test can continue cleanly.
     */
    process.exit = ((code?: number) => {
      if (pendingDrains > 0) {
        exitCalledWithPendingDrain = true
      }
      throw new CliExit(code ?? 0)
    }) as typeof process.exit

    // ── Run cmdMonitorWatch in CLI mode ───────────────────────────────────
    try {
      // Invoke without deps → CLI mode → uses process.stdout + process.exit
      await cmdMonitorWatch(['--last', '3', '--format', 'ndjson'])
    } catch (err) {
      if (!(err instanceof CliExit)) throw err
      // CliExit is expected (the mock throws instead of killing the process)
    } finally {
      // Restore all mocked globals unconditionally
      process.stdout.write = origWrite as typeof process.stdout.write
      process.exit = origExit
      process.env['HRC_RUNTIME_DIR'] = origEnvRuntime
      process.env['HRC_STATE_DIR'] = origEnvState
    }

    // ── RED assertion ─────────────────────────────────────────────────────
    // Currently FAILS: the last write (the large event) returns false (pending),
    // but process.exit(0) is called immediately after without awaiting the drain
    // callback. `exitCalledWithPendingDrain` is set to true → assertion fails.
    //
    // After the fix (drain stdout before exiting), process.exit() is only called
    // once the drain callback fires, so `exitCalledWithPendingDrain` stays false.
    expect(exitCalledWithPendingDrain).toBe(false)
  }, 30_000) // Allow time for the HRC server round-trip in buildLiveMonitorState().
})
