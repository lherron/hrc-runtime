import type { Command } from 'commander'

import { renderCommandRoster } from '../command-roster.js'

// Curated prose. The COMMANDS roster is NOT listed here — it is generated from the live registry by
// buildInfoText() so it can never drift (this block previously omitted `turn`). Inline command
// examples in this prose are validated by scripts/check-cli-surface.ts: every `hrcchat <cmd>` /
// `hrc <cmd>` and `--flag` must resolve to a real registered command/option.
const INFO_HEAD = `hrcchat — RETIRED (T-07612 flag day)

WHAT HAPPENED
  wrkq owns collaboration; HRC owns execution. Talk that must survive every
  runtime that carried it is a wrkq room, reached with \`wrkc\`. Anything that
  references a pid, pane, run or turn stayed with \`hrc\`. hrcchat sat across
  that line, so it is gone.

  Only \`wrkc say --to\` fires. A say with no --to is a room log entry and
  nobody is presented. Run \`wrkc info\` for the room and envelope model.

WHERE EVERYTHING WENT  (every verb on the left was an hrcchat verb)
  dm <t> <body>        ->  wrkc say <t> --to <t> <body>
  dm <t> --reply-to X  ->  wrkc say <room> --to <sender>   (reply IS the ack)
  dm human <body>      ->  wrkc say lance --to lance <body>
  dm <t> --wait        ->  wrkc say <t> --to <t> --wait
  dm <t> --steer       ->  wrkc say <t> --to <t> --urgent
  dm <t> --follow <d>  ->  hrc monitor watch EN-xxxxx
  show                 ->  wrkc show <EN-xxxxx|room>
  thread               ->  wrkc log <room>
  messages             ->  wrkc ls / wrkc log <room>
  summon               ->  hrc summon
  send                 ->  hrc send
  peek                 ->  hrc peek
  doctor               ->  hrc doctor
  turn                 ->  hrc turn
  trace                ->  gone with the federation message path it traced
  who                  ->  hrc target locate / wrkc members <room>

  hrcmail is deleted outright: \`wrkc inbox\`, \`wrkc defer\`, \`wrkc show\`,
  \`wrkc ls --dead\`.

DM IS A FORWARDING SHIM, NOT A HOME
  \`hrcchat dm\` still runs: it maps its arguments onto \`wrkc say\`, prints what
  it forwarded on stderr, and execs wrkc. It is removed at the end of the
  burn-in window, and every other verb already exits 2 with its replacement.
  Fix your scripts now.

ENVIRONMENT VARIABLES
  HRC_SESSION_REF   Caller scope handle; wrkc reads the same variable
  ASP_PROJECT       Default project context for target resolution

`

/** Full `hrcchat info` text: curated prose + a COMMANDS roster generated from the live registry. */
export function buildInfoText(program: Command): string {
  return `${INFO_HEAD}
COMMANDS
${renderCommandRoster(program)}
`
}

export function cmdInfo(program: Command): void {
  process.stdout.write(buildInfoText(program))
}
