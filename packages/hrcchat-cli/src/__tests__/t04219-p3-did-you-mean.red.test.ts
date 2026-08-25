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

  it('hrcchat msg rejects once with the phantom messages suggestion', async () => {
    const result = await runMain(['msg'])
    expect(result.exitCode).toBe(2)
    // "messages" action must NOT have run
    expect(result.stdout).toBe('')
    // RED: currently no suggestion at all — "msg" is too far from "messages" for
    // Commander's built-in fuzzy. Phantom map must add it explicitly.
    expect(result.stderr).toMatch(/messages/i)
    // RED: no "did you mean" hint currently emitted for "msg"
    expect(result.stderr).toMatch(/did you mean/i)
    expect((result.stderr.match(/unknown command/gi) ?? []).length).toBe(1)
  })

  // ── hrcchat seq → show (WRONG suggestion currently: Commander says "send") ──

  it('hrcchat seq rejects once with show, never send, and no raw Commander line', async () => {
    const result = await runMain(['seq'])
    expect(result.exitCode).toBe(2)
    // "show" action must NOT have run
    expect(result.stdout).toBe('')
    // RED: Commander currently fuzzy-matches "seq" to "send". The phantom map must
    // win: `seq` → `show`. After P3, the suggestion must be "show" not "send".
    expect(result.stderr).toMatch(/\bshow\b/i)
    // RED: currently Commander suggests "(Did you mean send?)". After P3 the phantom
    // map fires first and replaces the suggestion with "show". "send" must not appear
    // as the suggestion.
    expect(result.stderr).not.toMatch(/did you mean.*\bsend\b/i)
    // RED: currently "did you mean send?" — after P3 "did you mean 'show'?" (or similar)
    expect(result.stderr).toMatch(/did you mean.*\bshow\b/i)
    expect((result.stderr.match(/unknown command/gi) ?? []).length).toBe(1)
    const rawCommanderLines = result.stderr
      .split('\n')
      .filter((line) => /^error: unknown command/.test(line) && !line.startsWith('hrcchat:'))
    expect(rawCommanderLines).toHaveLength(0)
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
