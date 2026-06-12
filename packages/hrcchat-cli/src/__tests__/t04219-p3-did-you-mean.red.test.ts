/**
 * RED tests for T-04219 P3 — did-you-mean for unknown subcommands (daedalus REQUIRED #7)
 *
 * These tests are intentionally RED. They verify the did-you-mean contract for hrcchat-cli.
 * Implementation target: the CommanderError catch block in main.ts (~line 313).
 *
 * ─── What is pinned ───────────────────────────────────────────────────────────
 *
 * #7  Did-you-mean for hrcchat-cli:
 *     • HARDCODED PHANTOM MAP wins BEFORE fuzzy Levenshtein:
 *         hrcchat msg      → suggest messages
 *         hrcchat message  → suggest messages  (phantom map wins over Commander's fuzzy)
 *         hrcchat seq      → suggest show       (phantom map; Commander currently suggests "send")
 *     • Fuzzy Levenshtein for ordinary misspellings (e.g. mesagges → messages)
 *     • Suggestions MUST NOT execute anything: exit 2 + hint on STDERR + empty STDOUT
 *     • In-house Levenshtein (no new dependency)
 *
 * ─── RED failure modes (before implementation) ────────────────────────────────
 *
 * PHANTOM MAP (RED):
 *   hrcchat msg      → currently NO suggestion (distance too large for Commander)
 *   hrcchat seq      → currently suggests "send" (Commander fuzzy); should be "show"
 *
 * DOUBLE-PRINT (RED for suggestion cases):
 *   Like hrc-cli, Commander writes to stderr BEFORE throwing. After P3, Commander's
 *   direct output is suppressed; only the hrcchat-prefixed handler line appears.
 *
 *   Currently for `hrcchat seq`:
 *     error: unknown command 'seq'       ← Commander direct write
 *     (Did you mean send?)
 *     hrcchat: error: unknown command 'seq'  ← handler (err.message preserved)
 *     (Did you mean send?)
 *
 *   After P3 for `hrcchat seq`:
 *     hrcchat: unknown command 'seq' — did you mean 'show'?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const MAIN_TS = join(import.meta.dir, '..', 'main.ts')

// ---------------------------------------------------------------------------
// Subprocess harness (hrcchat has no exported main(); run via Bun.spawn)
// ---------------------------------------------------------------------------

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

async function runMain(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ['bun', MAIN_TS, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ASP_PROJECT: 'agent-spaces' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

// ===========================================================================
// §7a: Phantom map — hrcchat-specific aliases that Commander does not know
// ===========================================================================

describe('hrcchat did-you-mean — PHANTOM MAP wins before fuzzy (§7a)', () => {
  // ── hrcchat msg → messages ──

  it('hrcchat msg → exit 2', async () => {
    const result = await runMain(['msg'])
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat msg → stdout is empty (no action side-effect)', async () => {
    const result = await runMain(['msg'])
    // "messages" action must NOT have run
    expect(result.stdout).toBe('')
  })

  it('hrcchat msg → stderr contains "messages" (phantom map suggestion)', async () => {
    const result = await runMain(['msg'])
    // RED: currently no suggestion at all — "msg" is too far from "messages" for
    // Commander's built-in fuzzy. Phantom map must add it explicitly.
    expect(result.stderr).toMatch(/messages/i)
  })

  it('hrcchat msg → stderr contains "did you mean" hint', async () => {
    const result = await runMain(['msg'])
    // RED: no "did you mean" hint currently emitted for "msg"
    expect(result.stderr).toMatch(/did you mean/i)
  })

  // ── hrcchat message → messages ──

  it('hrcchat message → exit 2', async () => {
    const result = await runMain(['message'])
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat message → stdout is empty (no action side-effect)', async () => {
    const result = await runMain(['message'])
    expect(result.stdout).toBe('')
  })

  it('hrcchat message → stderr contains "messages" (phantom map wins over fuzzy)', async () => {
    const result = await runMain(['message'])
    // Commander already suggests "messages" for "message" via fuzzy.
    // Phantom map must also resolve to "messages". Pin that the suggestion is correct.
    expect(result.stderr).toMatch(/messages/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  // ── hrcchat seq → show (WRONG suggestion currently: Commander says "send") ──

  it('hrcchat seq → exit 2', async () => {
    const result = await runMain(['seq'])
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat seq → stdout is empty (no action side-effect)', async () => {
    const result = await runMain(['seq'])
    // "show" action must NOT have run
    expect(result.stdout).toBe('')
  })

  it('hrcchat seq → stderr contains "show" (phantom map overrides fuzzy)', async () => {
    const result = await runMain(['seq'])
    // RED: Commander currently fuzzy-matches "seq" to "send". The phantom map must
    // win: `seq` → `show`. After P3, the suggestion must be "show" not "send".
    expect(result.stderr).toMatch(/\bshow\b/i)
  })

  it('hrcchat seq → stderr does NOT suggest "send" (phantom map replaced fuzzy)', async () => {
    const result = await runMain(['seq'])
    // RED: currently Commander suggests "(Did you mean send?)". After P3 the phantom
    // map fires first and replaces the suggestion with "show". "send" must not appear
    // as the suggestion.
    expect(result.stderr).not.toMatch(/did you mean.*\bsend\b/i)
  })

  it('hrcchat seq → stderr contains "did you mean" hint for show', async () => {
    const result = await runMain(['seq'])
    // RED: currently "did you mean send?" — after P3 "did you mean 'show'?" (or similar)
    expect(result.stderr).toMatch(/did you mean.*\bshow\b/i)
  })
})

// ===========================================================================
// §7b: Ordinary fuzzy misspellings — in-house Levenshtein suggestions
// ===========================================================================

describe('hrcchat did-you-mean — ordinary fuzzy misspellings (§7b)', () => {
  it('hrcchat mesagges → exit 2 + suggestion for messages (fuzzy)', async () => {
    const result = await runMain(['mesagges'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/messages/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrcchat shwo → exit 2 + suggestion for show (fuzzy)', async () => {
    const result = await runMain(['shwo'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/\bshow\b/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrcchat dms → exit 2 + suggestion for dm (fuzzy)', async () => {
    const result = await runMain(['dms'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/\bdm\b/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })
})

// ===========================================================================
// §7c: No side effect — suggestion must not trigger the command action
// ===========================================================================

describe('hrcchat did-you-mean — no side effect contract (§7c)', () => {
  it('hrcchat msg exits 2 (not 0 or 1) — action did not run', async () => {
    const result = await runMain(['msg'])
    // Exit 2 = usage error. Exit 0 = success (action ran). Exit 1 = runtime error.
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat seq exits 2 (not 0 or 1) — show action did not run', async () => {
    const result = await runMain(['seq'])
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat mesagges exits 2 — messages action did not run', async () => {
    const result = await runMain(['mesagges'])
    expect(result.exitCode).toBe(2)
  })

  it('hrcchat unknown-xyz stdout is empty (no output from an action)', async () => {
    // Any unknown command: stdout must be empty regardless of what is in stderr
    const result = await runMain(['unknown-xyz'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
  })
})

// ===========================================================================
// §7d: Double-print suppression — Commander's direct stderr output is suppressed
// ===========================================================================

describe('hrcchat did-you-mean — Commander direct output suppressed (§7d)', () => {
  it('hrcchat seq → "unknown command" appears at most once in stderr (no duplicate)', async () => {
    const result = await runMain(['seq'])
    // RED: currently Commander writes "(Did you mean send?)" directly to stderr AND
    // the error handler also writes via exitWithError. P3 suppresses Commander's direct
    // output; only the hrcchat-prefixed handler line remains.
    const occurrences = (result.stderr.match(/unknown command/gi) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('hrcchat msg → "unknown command" appears at most once in stderr', async () => {
    const result = await runMain(['msg'])
    // RED: Commander direct write + handler write currently = 2 occurrences
    const occurrences = (result.stderr.match(/unknown command/gi) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('hrcchat seq → no raw Commander "error:" prefix line in stderr', async () => {
    const result = await runMain(['seq'])
    // RED: Commander writes "error: unknown command 'seq'" directly. After P3, this
    // raw line (without "hrcchat:" prefix) must not appear.
    const lines = result.stderr.split('\n').filter((l) => l.trim().length > 0)
    const rawCommanderLines = lines.filter(
      (l) => /^error: unknown command/.test(l) && !l.startsWith('hrcchat:')
    )
    // RED: raw Commander line currently present; after P3 it is suppressed
    expect(rawCommanderLines).toHaveLength(0)
  })
})
