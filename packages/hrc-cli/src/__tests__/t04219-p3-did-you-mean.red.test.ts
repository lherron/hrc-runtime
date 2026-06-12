/**
 * RED tests for T-04219 P3 — did-you-mean for unknown subcommands (daedalus REQUIRED #7)
 *
 * These tests are intentionally RED. They verify the did-you-mean contract for hrc-cli.
 * Implementation target: normalizeCommanderError (~line 4294 in cli.ts).
 *
 * ─── What is pinned ───────────────────────────────────────────────────────────
 *
 * #7  Did-you-mean for hrc-cli:
 *     • Unknown top-level command → fuzzy Levenshtein suggestion from top-level siblings
 *     • Unknown nested command → fuzzy suggestion scoped to the PARENT GROUP's siblings
 *       (e.g. `hrc runtime <typo>` suggests runtime subcommands, NOT top-level commands)
 *     • Suggestions MUST NOT execute: exit 2 + suggestion hint on STDERR + empty STDOUT
 *     • In-house Levenshtein (no new dependency): suppresses Commander's built-in double-print
 *     • `hrc resume` is REAL (P2 landed) — must NOT trigger an unknown-command path
 *
 * ─── RED failure modes (before implementation) ────────────────────────────────
 *
 * DOUBLE-PRINT (RED): Commander currently writes to stderr DIRECTLY before throwing,
 *   AND normalizeCommanderError also writes via exitWithError. The in-process stderr
 *   capture therefore contains "unknown command" TWICE. After P3, Commander's direct
 *   output is suppressed; only the hrc-prefixed error handler line appears.
 *
 *   Currently:
 *     error: unknown command 'montior'       ← Commander direct write
 *     (Did you mean monitor?)
 *     hrc: error: unknown command 'montior'  ← error handler (multi-line msg preserved)
 *     (Did you mean monitor?)
 *
 *   After P3:
 *     hrc: unknown command 'montior' — did you mean 'monitor'?
 *
 * NESTED SCOPE (GREEN for Commander's built-in, pinned as regression guard):
 *   Commander already scopes suggestions to siblings. After P3 (in-house), the scope
 *   must still be siblings — not top-level commands.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from 'bun:test'

import { main } from '../cli'

// ---------------------------------------------------------------------------
// Minimal in-process harness (no server needed — all tests are error-path only)
// ---------------------------------------------------------------------------

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, chunks: string[]): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk)
    return
  }
  chunks.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

async function runCli(args: string[]): Promise<CliResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdoutChunks)
    const callback = rest.find((v) => typeof v === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderrChunks)
    const callback = rest.find((v) => typeof v === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args)
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: error.code,
      }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }
}

// ===========================================================================
// §7a: Top-level typos — fuzzy suggestion to top-level siblings
// ===========================================================================

describe('hrc did-you-mean — top-level unknown commands (§7a)', () => {
  it('hrc <unknown> exits code 2', async () => {
    const result = await runCli(['completelyunknown'])
    expect(result.exitCode).toBe(2)
  })

  it('hrc <unknown> stdout is empty (no action side-effect)', async () => {
    const result = await runCli(['completelyunknown'])
    // No command action must have run; all output must be on stderr
    expect(result.stdout).toBe('')
  })

  it('hrc montior → exit 2 + suggestion for monitor', async () => {
    const result = await runCli(['montior'])
    // RED: double-print removed; single clean hint
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/monitor/i)
  })

  it('hrc montior → stderr contains a "did you mean" hint', async () => {
    const result = await runCli(['montior'])
    // RED: after P3, normalizeCommanderError emits a clean single-line hint.
    // Commander currently double-prints: once raw ("(Did you mean monitor?)"),
    // once via the error handler. P3 suppresses Commander's direct output so only
    // the hrc-prefixed handler line remains.
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrc montior → no raw Commander "error:" prefix in stderr (no double-print)', async () => {
    const result = await runCli(['montior'])
    // RED: currently Commander writes "error: unknown command 'montior'" directly
    // to stderr BEFORE the hrc error handler. After P3 Commander's direct output
    // is suppressed (program.configureOutput / addSuggestionHook disabled), so
    // "error: unknown command" WITHOUT the "hrc:" prefix must not appear.
    const lines = result.stderr.split('\n').filter((l) => l.trim().length > 0)
    const rawCommanderLines = lines.filter(
      (l) => /^error: unknown command/.test(l) && !l.startsWith('hrc:')
    )
    // RED: Commander's raw line currently appears; after P3 it is suppressed
    expect(rawCommanderLines).toHaveLength(0)
  })

  it('hrc montior → "unknown command" appears at most once in stderr (no duplicate)', async () => {
    const result = await runCli(['montior'])
    // RED: currently appears twice — once from Commander's direct write, once from
    // the error handler. P3 reduces this to a single occurrence.
    const occurrences = (result.stderr.match(/unknown command/gi) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('hrc runtiem → exit 2 + suggestion for runtime', async () => {
    const result = await runCli(['runtiem'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/runtime/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrc runtiem → suggestion appears exactly once (no double-print)', async () => {
    const result = await runCli(['runtiem'])
    // RED: double-print currently present
    const occurrences = (result.stderr.match(/unknown command/gi) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('hrc attch → exit 2 + suggestion for attach (regression pin)', async () => {
    const result = await runCli(['attch'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/attach/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })
})

// ===========================================================================
// §7b: Nested command typos — suggestion SCOPED to the parent group's siblings
// ===========================================================================

describe('hrc did-you-mean — nested unknown subcommands scoped to siblings (§7b)', () => {
  it('hrc runtime insepct <id> → exit 2', async () => {
    const result = await runCli(['runtime', 'insepct', 'rt-abc'])
    expect(result.exitCode).toBe(2)
  })

  it('hrc runtime insepct <id> → stdout is empty (no side-effect)', async () => {
    const result = await runCli(['runtime', 'insepct', 'rt-abc'])
    // The inspect action must NOT have run (would have tried server connection)
    expect(result.stdout).toBe('')
  })

  it('hrc runtime insepct <id> → stderr contains "inspect" suggestion (sibling match)', async () => {
    const result = await runCli(['runtime', 'insepct', 'rt-abc'])
    expect(result.stderr).toMatch(/inspect/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrc runtime insepct → does NOT suggest a top-level command (scope = runtime siblings)', async () => {
    const result = await runCli(['runtime', 'insepct', 'rt-abc'])
    // The suggestion must come from runtime subcommands, not from top-level commands.
    // "insepct" is close to "inspect" (runtime sibling) and NOT close to any top-level.
    // Regression guard: implementation must NOT use the global command tree for nested typos.
    const topLevelNames = ['session', 'broker', 'launch', 'monitor', 'admin', 'attach', 'capture']
    for (const name of topLevelNames) {
      expect(result.stderr).not.toMatch(new RegExp(`did you mean.*${name}\\b`, 'i'))
    }
  })

  it('hrc runtime insepct → no double-print (suggestion once)', async () => {
    const result = await runCli(['runtime', 'insepct', 'rt-abc'])
    // RED: double-print currently present (Commander + error handler)
    const occurrences = (result.stderr.match(/unknown command/gi) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('hrc session reslove → exit 2 + suggests resolve (session group sibling)', async () => {
    const result = await runCli(['session', 'reslove'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/resolve/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })

  it('hrc session reslove → does NOT suggest a runtime sibling (scope = session siblings)', async () => {
    const result = await runCli(['session', 'reslove'])
    // "reslove" is close to "resolve" (session sibling).
    // Must not suggest runtime subcommands like "inspect" or "terminate".
    const runtimeSiblings = ['inspect', 'terminate', 'sweep', 'interrupt', 'adopt']
    for (const name of runtimeSiblings) {
      expect(result.stderr).not.toMatch(new RegExp(`did you mean.*${name}\\b`, 'i'))
    }
  })

  it('hrc runtime montor → no suggestion (montor is close to monitor, a TOP-LEVEL cmd, not a runtime sibling)', async () => {
    const result = await runCli(['runtime', 'montor'])
    // Scope = runtime siblings only. "montor" is similar to "monitor" (top-level),
    // not to any runtime subcommand. Correct behavior: no suggestion (or fallback message),
    // never "monitor" (which is not a runtime sibling).
    expect(result.exitCode).toBe(2)
    // Must NOT suggest the top-level "monitor" as a sibling of runtime
    expect(result.stderr).not.toMatch(/did you mean.*monitor/i)
  })

  it('hrc runtime lst → exit 2 + suggests list (sibling match)', async () => {
    const result = await runCli(['runtime', 'lst'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/list/i)
    expect(result.stderr).toMatch(/did you mean/i)
  })
})

// ===========================================================================
// §7c: hrc resume is REAL (P2 landed) — must NOT trigger unknown-command path
// ===========================================================================

describe('hrc resume — real command, not an unknown-command path (§7c regression)', () => {
  it('hrc resume --help exits 0 (resume is a real command via P2)', async () => {
    const result = await runCli(['resume', '--help'])
    // This was RED in P2; it is now GREEN. Pin it so P3 does not regress it.
    expect(result.exitCode).toBe(0)
  })

  it('hrc resume --help does NOT contain "unknown command"', async () => {
    const result = await runCli(['resume', '--help'])
    expect(result.stderr).not.toMatch(/unknown command/i)
  })

  it('hrc resume --help stdout mentions "did you mean" only if something else is wrong — not for resume itself', async () => {
    const result = await runCli(['resume', '--help'])
    // Help for a real command must not claim "did you mean X"
    expect(result.stdout).not.toMatch(/did you mean/i)
    expect(result.stderr).not.toMatch(/did you mean/i)
  })
})
