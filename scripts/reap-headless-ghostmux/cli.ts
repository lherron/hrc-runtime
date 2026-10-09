import {
  HEADLESS_PANE_ROLE,
  MIN_IDLE_MINUTES,
  type Options,
  PANELESS_MIN_IDLE_HOURS,
} from './types'

export function usage(): never {
  console.log(`Usage:
  scripts/reap-headless-ghostmux.sh [--dry-run] [--simulate] [--yes]
  bun scripts/reap-headless-ghostmux.ts [--dry-run] [--simulate] [--yes]

Find Ghostty headless-agent panes by their durable metadata role (hrc_role ==
PANE_ROLE), print HRC status, ask for confirmation, then reap each eligible
broker-tmux runtime over the broker RPC channel via 'hrc runtime terminate
--no-drop-continuation --reason operator_reap' (continuation preserved).

This script decides WHICH idle runtimes to terminate. It does not touch panes:
hrc-viewer owns pane lifecycle and reaps each surface itself after its linger
window, including panes whose runtime died while the viewer was down.

Discovery is by metadata role, NOT title — the consolidated "Headless Sessions"
window (T-05237) renamed pane titles to '<proj> · <task> · <agent>', so the old
title regex no longer matched. TITLE_REGEX remains an OPTIONAL secondary filter.

Eligible = surface resolves to one runtime with controllerKind=harness-broker,
a tmux TUI window (transport=tmux, OR transport=headless with a leased-tmux
substrate + presentation.kind=tmux-tui — the codex app-server viewer pane),
scope task is NOT primary, status=ready, NO active run, latest turn=completed,
and latest runtime activity strictly more than ${MIN_IDLE_MINUTES} minutes ago.

Paneless runtimes: a live broker whose Ghostty pane is gone never shows up in
pane discovery, so the sweep also reads ready runtimes from the HRC DB that
have no pane. They pass the same guards, but must be idle strictly more than
${PANELESS_MIN_IDLE_HOURS} hours, and are reaped with --source reap-paneless-inventory.

Environment:
  PANE_ROLE            Default: ${HEADLESS_PANE_ROLE} (ghostmux hrc_role metadata)
  TITLE_REGEX          Optional extra title filter (default: none)
  HRC_DB_PATH          Default: /Users/lherron/praesidium/var/state/hrc/state.sqlite

Options:
  --dry-run            Print intended reap/ghostmux actions without running them.
  --simulate           Run against built-in fake panes; implies dry-run.
  -y, --yes            Skip the interactive confirmation before reaping.
  --timing             Print a phase + subprocess-spawn timing ledger to stderr.

Every run appends a timing record to <state>/metrics/script-YYYY-MM-DD.ndjson
(14-day retention) regardless of --timing; the flag only adds the stderr report.
Set REAP_TIMING=1 to enable the report without passing the flag.`)
  process.exit(0)
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    simulate: false,
    assumeYes: false,
    paneRole: process.env.PANE_ROLE ?? HEADLESS_PANE_ROLE,
    titleRegex: process.env.TITLE_REGEX ?? '',
    // Per-runtime ceiling on `hrc runtime terminate`. A wedged broker never acks
    // the dispose RPC, and neither the SDK fetch nor `hrc` itself has a timeout —
    // so without this the whole SEQUENTIAL sweep freezes on one bad pane. 0
    // disables the bound (legacy hang-forever behavior).
    reapTimeoutMs: Math.round(Number(process.env.REAP_TIMEOUT_SECONDS ?? '20') * 1000),
    hrcDbPath: process.env.HRC_DB_PATH ?? '/Users/lherron/praesidium/var/state/hrc/state.sqlite',
    timing: process.env.REAP_TIMING === '1',
  }

  for (const arg of argv) {
    if (arg === '--timing') {
      options.timing = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--simulate') {
      options.simulate = true
      options.dryRun = true
    } else if (arg === '-y' || arg === '--yes') {
      options.assumeYes = true
    } else if (arg === '-h' || arg === '--help') {
      usage()
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(options.reapTimeoutMs) || options.reapTimeoutMs < 0) {
    throw new Error('REAP_TIMEOUT_SECONDS must be a non-negative number')
  }
  return options
}
