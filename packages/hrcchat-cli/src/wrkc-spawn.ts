/**
 * Thin process boundary for the `hrcchat dm` forwarding shim (T-07612 §9.2).
 *
 * wrkc is a Go binary in the wrkq repo with no HRC dependency, so the only
 * honest way to forward is to exec it. Kept separate from the argv mapping so
 * the mapping stays a pure, testable function.
 */
import { spawn } from 'node:child_process'
import { constants, accessSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { CliUsageError } from 'cli-kit'

import {
  type DmForwardOptions,
  closedRoomRecoveryHint,
  formatForwardNotice,
  mapDmToWrkcSay,
} from './wrkc-forward.js'

export async function forwardDmToWrkc(
  target: string,
  message: string | undefined,
  opts: DmForwardOptions
): Promise<never> {
  let body = message
  let stdinText: string | undefined
  if (opts.file !== undefined) {
    if (body !== undefined) {
      throw new CliUsageError('pass a message body or --file, not both')
    }
    stdinText = readFileSync(opts.file, 'utf8')
    body = '-'
  }

  const plan = mapDmToWrkcSay(target, body, opts)
  if (plan.kind === 'refuse') throw new CliUsageError(plan.message)

  // Checked BEFORE the notice, not after the spawn fails. Printing
  // "forwarded: wrkc say ..." and only then discovering wrkc is missing claims
  // something that did not happen — observed live on a node the flag day
  // activated while the wrkq client was never installed (T-07616).
  if (!isOnPath('wrkc')) {
    throw new CliUsageError(
      'wrkc is not installed; `hrcchat dm` forwards to it and cannot deliver without it. Install wrkq, then retry — nothing was sent.'
    )
  }

  process.stderr.write(formatForwardNotice(plan))

  // stderr is piped rather than inherited ONLY so a closed-room refusal can be
  // followed by its recovery. Everything wrkc writes is passed through verbatim
  // and in order first; nothing is swallowed or rewritten.
  const child = spawn('wrkc', plan.argv, {
    stdio: [stdinText === undefined ? 'inherit' : 'pipe', 'inherit', 'pipe'],
  })
  if (stdinText !== undefined && child.stdin) {
    child.stdin.end(stdinText)
  }
  let stderrText = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString()
    process.stderr.write(chunk)
  })

  return await new Promise<never>((_resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Kept as a backstop for the race where wrkc leaves PATH between the
      // preflight check and the spawn.
      if (err.code === 'ENOENT') {
        reject(
          new CliUsageError(
            'wrkc is not installed; `hrcchat dm` forwards to it and cannot deliver without it. Install wrkq, then retry — nothing was sent.'
          )
        )
        return
      }
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal as NodeJS.Signals)
        return
      }
      if (code !== 0) {
        const hint = closedRoomRecoveryHint(stderrText, plan.argv[1] ?? '<room>')
        if (hint !== undefined) process.stderr.write(hint)
      }
      process.exit(code ?? 0)
    })
  })
}

/** Resolve a bare command name against PATH, the way the spawn will. */
function isOnPath(command: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      // Not here; keep looking.
    }
  }
  return false
}
